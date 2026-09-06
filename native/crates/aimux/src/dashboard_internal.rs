use crate::dashboard_client::{
    ProjectServiceEndpoint, execute_dashboard_action, fetch_desktop_state,
    resolve_project_service_endpoint,
};
use crate::dashboard_controller::{DashboardController, DashboardControllerEffect};
use crate::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use crate::dashboard_navigation::DashboardEntryRef;
use crate::dashboard_readiness::mark_native_dashboard_ready;
use crate::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use crate::dashboard_terminal::{DashboardTerminalGuard, read_dashboard_key};
use anyhow::{Context, Result};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct NativeDashboardOptions {
    pub project_root: PathBuf,
    pub desktop_state_file: Option<PathBuf>,
    pub cols: usize,
    pub rows: usize,
    pub once: bool,
}

struct DashboardSnapshotLoad {
    snapshot: DesktopStateSnapshot,
    endpoint: Option<ProjectServiceEndpoint>,
}

pub fn run_native_dashboard_internal(options: NativeDashboardOptions) -> Result<()> {
    let mut controller = None;
    let mut ready_marked = false;
    let mut scroll_offset = 0;
    let mut latest_snapshot = None;
    let mut latest_endpoint = None;
    let mut render_now = true;
    let mut last_render = Instant::now();
    let mut stdout = io::stdout();
    let mut stdin = io::stdin();
    let _terminal = if options.once {
        None
    } else {
        Some(DashboardTerminalGuard::enter(&mut stdout).context("enter dashboard terminal")?)
    };

    loop {
        if render_now || last_render.elapsed() >= Duration::from_secs(1) {
            let loaded = load_dashboard_snapshot(&options)?;
            let controller =
                controller.get_or_insert_with(|| DashboardController::new(&loaded.snapshot));
            let frame =
                render_dashboard_snapshot(&options, controller, &loaded.snapshot, scroll_offset);
            stdout.write_all(frame.frame.as_bytes())?;
            stdout.flush()?;
            scroll_offset = frame.scroll_offset;
            if !ready_marked {
                let _ = mark_native_dashboard_ready(&options.project_root);
                ready_marked = true;
            }
            latest_snapshot = Some(loaded.snapshot);
            latest_endpoint = loaded.endpoint;
            render_now = false;
            last_render = Instant::now();
            if options.once {
                return Ok(());
            }
        }

        if let Some(key) = read_dashboard_key(&mut stdin).context("read dashboard key")? {
            let Some(snapshot) = latest_snapshot.as_ref() else {
                render_now = true;
                thread::sleep(Duration::from_millis(50));
                continue;
            };
            let controller = controller.get_or_insert_with(|| DashboardController::new(snapshot));
            match controller.handle_key(snapshot, key) {
                DashboardControllerEffect::Quit => return Ok(()),
                DashboardControllerEffect::Request(request) => {
                    if let Some(endpoint) = latest_endpoint.as_ref() {
                        if let Err(error) = execute_dashboard_action(endpoint, &request) {
                            controller.footer_message = Some(error.to_string());
                        }
                    } else {
                        controller.footer_message =
                            Some("Dashboard action requires a project-service endpoint".into());
                    }
                    render_now = true;
                }
                DashboardControllerEffect::Render => {
                    render_now = true;
                }
                DashboardControllerEffect::Ignored => {}
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn render_dashboard_snapshot(
    options: &NativeDashboardOptions,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    scroll_offset: usize,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    controller.navigation.clamp(snapshot);
    let (selected_session_id, selected_service_id) =
        match controller.navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => (Some(session.id.as_str()), None),
            Some(DashboardEntryRef::Service(service)) => (None, Some(service.id.as_str())),
            None => (None, None),
        };
    let focused_worktree_path = controller.navigation.focused_worktree_path(snapshot);
    render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: options.cols,
        rows: options.rows,
        nav_level: controller.navigation.level,
        selected_session_id,
        selected_service_id,
        focused_worktree_path,
        runtime_label: Some("native"),
        version: None,
        is_dev_runtime: cfg!(debug_assertions),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset,
        footer_message: controller.footer_message.as_deref(),
    })
}

fn load_dashboard_snapshot(options: &NativeDashboardOptions) -> Result<DashboardSnapshotLoad> {
    if let Some(path) = options.desktop_state_file.as_ref() {
        let contents = fs::read_to_string(path)
            .with_context(|| format!("read desktop-state snapshot {}", path.display()))?;
        return Ok(DashboardSnapshotLoad {
            snapshot: parse_desktop_state_snapshot(&contents)
                .context("parse desktop-state snapshot")?,
            endpoint: None,
        });
    }
    let endpoint = resolve_project_service_endpoint(&options.project_root)?;
    let snapshot = fetch_desktop_state(&endpoint).context("request project desktop-state")?;
    Ok(DashboardSnapshotLoad {
        snapshot,
        endpoint: Some(endpoint),
    })
}

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}
