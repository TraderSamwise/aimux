use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, DaemonRequestInit,
    execute_loopback_json_request, request_daemon_json,
};
use crate::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use crate::dashboard_navigation::{DashboardEntryRef, DashboardNavigationState};
use crate::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use crate::project_api_contract::routes;
use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
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
    let projects = request_daemon_json(
        "/projects",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Get),
            timeout_ms: Some(2_000),
            ..DaemonRequestInit::default()
        },
    )
    .context("request daemon projects")?;
    let endpoint = find_project_service_endpoint(&projects, &options.project_root)?;
    fetch_desktop_state(&endpoint).context("request project desktop-state")
}

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectServiceEndpoint {
    host: String,
    port: u16,
}

fn find_project_service_endpoint(
    projects: &Value,
    project_root: &Path,
) -> Result<ProjectServiceEndpoint> {
    let root_text = project_root.to_string_lossy();
    let project = projects
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|projects| {
            projects.iter().find(|project| {
                string_field(project, "projectRoot")
                    .or_else(|| string_field(project, "path"))
                    .as_deref()
                    == Some(root_text.as_ref())
            })
        })
        .ok_or_else(|| anyhow!("project is not registered with the daemon: {}", root_text))?;
    let endpoint = project
        .get("serviceEndpoint")
        .ok_or_else(|| anyhow!("project service endpoint is unavailable for {}", root_text))?;
    let host = string_field(endpoint, "host")
        .filter(|host| host == "127.0.0.1" || host == "localhost")
        .ok_or_else(|| anyhow!("project service endpoint must be loopback"))?;
    let port = endpoint
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| anyhow!("project service endpoint port is invalid"))?;
    Ok(ProjectServiceEndpoint { host, port })
}

fn fetch_desktop_state(endpoint: &ProjectServiceEndpoint) -> Result<DesktopStateSnapshot> {
    let response = execute_loopback_json_request(&DaemonJsonRequest {
        url: format!(
            "http://{}:{}{}",
            endpoint.host,
            endpoint.port,
            routes::DESKTOP_STATE
        ),
        method: DaemonHttpMethod::Get,
        headers: BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]),
        body: None,
        timeout_ms: Some(2_000),
    })
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("desktop-state request failed: {}", response.status));
    }
    serde_json::from_value(response.json).context("parse desktop-state response")
}

fn map_transport_error(error: CoreCommandTransportError) -> anyhow::Error {
    anyhow!(error.to_string())
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
