use crate::dashboard_client::{fetch_desktop_state, resolve_project_service_endpoint};
use crate::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use crate::dashboard_navigation::{DashboardEntryRef, DashboardNavigationState};
use crate::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct NativeDashboardOptions {
    pub project_root: PathBuf,
    pub desktop_state_file: Option<PathBuf>,
    pub cols: usize,
    pub rows: usize,
    pub once: bool,
}

pub fn run_native_dashboard_internal(options: NativeDashboardOptions) -> Result<()> {
    let mut navigation = None;
    loop {
        let snapshot = load_dashboard_snapshot(&options)?;
        let navigation = navigation.get_or_insert_with(|| DashboardNavigationState::new(&snapshot));
        navigation.clamp(&snapshot);
        let (selected_session_id, selected_service_id) = match navigation.selected_entry(&snapshot)
        {
            Some(DashboardEntryRef::Session(session)) => (Some(session.id.as_str()), None),
            Some(DashboardEntryRef::Service(service)) => (None, Some(service.id.as_str())),
            None => (None, None),
        };
        let focused_worktree_path = navigation.focused_worktree_path(&snapshot);
        let frame = render_dashboard_frame(&DashboardRenderInput {
            snapshot: &snapshot,
            cols: options.cols,
            rows: options.rows,
            nav_level: navigation.level,
            selected_session_id,
            selected_service_id,
            focused_worktree_path,
            runtime_label: Some("native"),
            version: None,
            is_dev_runtime: cfg!(debug_assertions),
            hide_offline_agents: false,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
        });
        print!("{}", frame.frame);
        if options.once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn load_dashboard_snapshot(options: &NativeDashboardOptions) -> Result<DesktopStateSnapshot> {
    if let Some(path) = options.desktop_state_file.as_ref() {
        let contents = fs::read_to_string(path)
            .with_context(|| format!("read desktop-state snapshot {}", path.display()))?;
        return parse_desktop_state_snapshot(&contents).context("parse desktop-state snapshot");
    }
    let endpoint = resolve_project_service_endpoint(&options.project_root)?;
    fetch_desktop_state(&endpoint).context("request project desktop-state")
}

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}
