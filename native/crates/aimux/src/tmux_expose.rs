use crate::atomic_write::write_json_atomic;
use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};
use crate::daemon_state::get_daemon_base_url;
use crate::project_api_contract::routes;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const EXPOSE_HTTP_TIMEOUT_MS: u64 = 4_000;
pub const EXPOSE_CLIENT_TTL_MS: &str = "10000";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExposeScope {
    Worktree,
    Project,
    Global,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExposeSublabel {
    None,
    Worktree,
    ProjectWorktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExposeSortMode {
    Default,
    RecentOutput,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExposeConfig {
    pub initial_scope: Option<ExposeScope>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FastControlContext {
    pub project_root: String,
    pub current_path: Option<String>,
    pub current_window: Option<String>,
    pub current_window_id: Option<String>,
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExposeScopeView {
    pub scope: ExposeScope,
    pub items: Vec<Value>,
    pub scope_label: String,
    pub sublabel: ExposeSublabel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposeHttpRequest {
    pub method: DaemonHttpMethod,
    pub body: Option<Value>,
    pub timeout_ms: u64,
}

pub trait ExposeHttpClient {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String>;
}

#[derive(Debug, Default)]
pub struct SystemExposeHttpClient;

impl ExposeHttpClient for SystemExposeHttpClient {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String> {
        let body = match request.body {
            Some(body) => Some(serde_json::to_string(&body).map_err(|error| error.to_string())?),
            None => None,
        };
        let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
        if body.is_some() {
            headers.insert("content-type".to_owned(), "application/json".to_owned());
        }
        let response = execute_loopback_json_request(&DaemonJsonRequest {
            url: url.to_owned(),
            method: request.method,
            headers,
            body,
            timeout_ms: Some(request.timeout_ms),
        })
        .map_err(|error| error.to_string())?;
        if !(200..300).contains(&response.status)
            || response.json.get("ok").and_then(Value::as_bool) == Some(false)
        {
            return Err(daemon_json_error(response.status, &response.json));
        }
        Ok(response.json)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadExposeScopeDeps {
    pub daemon_endpoint: Option<String>,
    pub metadata_endpoint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeUiState {
    pub sort_mode: ExposeSortMode,
}

impl Default for ExposeUiState {
    fn default() -> Self {
        Self {
            sort_mode: ExposeSortMode::Default,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExposeUiStateFile {
    version: u8,
    sort_mode: ExposeSortMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialExposeUiStateFile {
    sort_mode: Option<ExposeSortMode>,
}

pub fn next_expose_scope(scope: ExposeScope) -> ExposeScope {
    match scope {
        ExposeScope::Worktree => ExposeScope::Project,
        ExposeScope::Project | ExposeScope::Global => ExposeScope::Global,
    }
}

pub fn initial_expose_scope(
    cross_project: bool,
    context: &FastControlContext,
    config: &ExposeConfig,
) -> ExposeScope {
    if cross_project {
        return ExposeScope::Global;
    }
    let initial_scope = config.initial_scope.unwrap_or(ExposeScope::Worktree);
    if initial_scope != ExposeScope::Worktree {
        return initial_scope;
    }
    if context
        .current_window_id
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return ExposeScope::Project;
    }
    if context
        .current_window
        .as_deref()
        .is_some_and(is_dashboard_window_name)
    {
        return ExposeScope::Project;
    }
    ExposeScope::Worktree
}

pub fn load_expose_scope_items(
    scope: ExposeScope,
    context: &FastControlContext,
    project_state_dir: impl AsRef<Path>,
    deps: &LoadExposeScopeDeps,
) -> Result<ExposeScopeView, String> {
    let mut client = SystemExposeHttpClient;
    load_expose_scope_items_with(scope, context, project_state_dir, deps, &mut client)
}

pub fn load_expose_scope_items_with(
    scope: ExposeScope,
    context: &FastControlContext,
    project_state_dir: impl AsRef<Path>,
    deps: &LoadExposeScopeDeps,
    client: &mut impl ExposeHttpClient,
) -> Result<ExposeScopeView, String> {
    if scope == ExposeScope::Global {
        let endpoint = deps
            .daemon_endpoint
            .clone()
            .map(Ok)
            .unwrap_or_else(|| get_daemon_base_url(None))?;
        let url = url_with_query(
            &endpoint,
            CORE_API_ROUTES.expose_items,
            common_expose_query(),
        );
        let items = request_expose_items(&url, client);
        return Ok(ExposeScopeView {
            scope,
            items,
            scope_label: "all projects".into(),
            sublabel: ExposeSublabel::ProjectWorktree,
        });
    }

    let endpoint = project_service_endpoint(project_state_dir, deps)?;
    let mut query = vec![
        (
            "scope".into(),
            if scope == ExposeScope::Worktree {
                "worktree".into()
            } else {
                "all".into()
            },
        ),
        ("labelFormat".into(), "raw".into()),
    ];
    query.extend(common_expose_query());
    append_focus_context_query(&mut query, context);
    let url = url_with_query(&endpoint, routes::controls::SWITCHABLE_AGENTS, query);
    let items = request_expose_items(&url, client);
    Ok(ExposeScopeView {
        scope,
        items,
        scope_label: if scope == ExposeScope::Worktree {
            "this worktree".into()
        } else {
            "all worktrees".into()
        },
        sublabel: if scope == ExposeScope::Worktree {
            ExposeSublabel::None
        } else {
            ExposeSublabel::Worktree
        },
    })
}

pub fn load_overseer_expose_item_with(
    context: &FastControlContext,
    project_state_dir: impl AsRef<Path>,
    deps: &LoadExposeScopeDeps,
    client: &mut impl ExposeHttpClient,
) -> Result<Option<Value>, String> {
    let endpoint = project_service_endpoint(project_state_dir, deps)?;
    let mut query = vec![
        ("scope".into(), "all".into()),
        ("labelFormat".into(), "raw".into()),
    ];
    query.extend(common_expose_query());
    query.push(("includeOverseer".into(), "1".into()));
    append_focus_context_query(&mut query, context);
    let url = url_with_query(&endpoint, routes::controls::SWITCHABLE_AGENTS, query);
    Ok(request_expose_items(&url, client)
        .into_iter()
        .find(|item| item.get("overseer").and_then(Value::as_bool) == Some(true)))
}

pub fn focus_expose_item_with(
    item: &Value,
    context: &FastControlContext,
    project_state_dir: impl AsRef<Path>,
    deps: &LoadExposeScopeDeps,
    client: &mut impl ExposeHttpClient,
) -> Result<bool, String> {
    let project_root = item.get("projectRoot").and_then(Value::as_str);
    let endpoint = if project_root.is_some() {
        deps.daemon_endpoint
            .clone()
            .map(Ok)
            .unwrap_or_else(|| get_daemon_base_url(None))?
    } else {
        project_service_endpoint(project_state_dir, deps)?
    };
    let route = if project_root.is_some() {
        CORE_API_ROUTES.expose_focus
    } else {
        routes::controls::FOCUS_WINDOW
    };
    let window_id = item
        .get("target")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut body = Map::new();
    body.insert("windowId".into(), Value::String(window_id.into()));
    if let Some(project_root) = project_root {
        body.insert("projectRoot".into(), Value::String(project_root.into()));
    }
    if let Some(value) = context.current_client_session.as_ref() {
        body.insert("currentClientSession".into(), Value::String(value.clone()));
    }
    if let Some(value) = context.client_tty.as_ref() {
        body.insert("clientTty".into(), Value::String(value.clone()));
    }
    body.insert("focus".into(), Value::Bool(true));
    let response = client.request_json(
        &url_with_query(&endpoint, route, std::iter::empty::<(String, String)>()),
        ExposeHttpRequest {
            method: DaemonHttpMethod::Post,
            body: Some(Value::Object(body)),
            timeout_ms: EXPOSE_HTTP_TIMEOUT_MS,
        },
    )?;
    Ok(response.get("ok").and_then(Value::as_bool) == Some(true))
}

pub fn write_selected_window(
    selection_file: Option<&Path>,
    current_project_root: &Path,
    item: &Value,
) -> bool {
    let Some(selection_file) = selection_file else {
        return false;
    };
    if let Some(project_root) = item.get("projectRoot").and_then(Value::as_str)
        && lexical_resolve(project_root) != lexical_resolve(current_project_root)
    {
        return false;
    }
    let Some(window_id) = item
        .get("target")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    fs::write(selection_file, format!("{window_id}\n")).is_ok()
}

pub fn read_expose_ui_state(project_state_dir: impl AsRef<Path>) -> ExposeUiState {
    let path = expose_ui_state_path(project_state_dir);
    let Ok(text) = fs::read_to_string(path) else {
        return ExposeUiState::default();
    };
    let Ok(parsed) = serde_json::from_str::<PartialExposeUiStateFile>(&text) else {
        return ExposeUiState::default();
    };
    ExposeUiState {
        sort_mode: parsed.sort_mode.unwrap_or(ExposeSortMode::Default),
    }
}

pub fn write_expose_ui_state(
    project_state_dir: impl AsRef<Path>,
    state: ExposeUiState,
) -> Result<(), String> {
    write_json_atomic(
        expose_ui_state_path(project_state_dir),
        &ExposeUiStateFile {
            version: 1,
            sort_mode: state.sort_mode,
        },
    )
    .map_err(|error| error.to_string())
}

fn request_expose_items(url: &str, client: &mut impl ExposeHttpClient) -> Vec<Value> {
    let response = client.request_json(
        url,
        ExposeHttpRequest {
            method: DaemonHttpMethod::Get,
            body: None,
            timeout_ms: EXPOSE_HTTP_TIMEOUT_MS,
        },
    );
    let Ok(response) = response else {
        return Vec::new();
    };
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn project_service_endpoint(
    project_state_dir: impl AsRef<Path>,
    deps: &LoadExposeScopeDeps,
) -> Result<String, String> {
    if let Some(endpoint) = deps.metadata_endpoint.as_ref() {
        return Ok(endpoint.clone());
    }
    fs::read_to_string(project_state_dir.as_ref().join("metadata-api.txt"))
        .map(|value| value.trim().to_owned())
        .map_err(|error| error.to_string())
}

fn common_expose_query() -> Vec<(String, String)> {
    vec![
        ("includePreview".into(), "1".into()),
        ("clientKind".into(), "expose".into()),
        (
            "clientId".into(),
            format!("tmux-expose:{}", std::process::id()),
        ),
        ("clientTtlMs".into(), EXPOSE_CLIENT_TTL_MS.into()),
    ]
}

fn append_focus_context_query(query: &mut Vec<(String, String)>, context: &FastControlContext) {
    for (key, value) in [
        ("currentClientSession", &context.current_client_session),
        ("currentWindow", &context.current_window),
        ("currentWindowId", &context.current_window_id),
        ("currentPath", &context.current_path),
    ] {
        if let Some(value) = value.as_deref()
            && !value.trim().is_empty()
        {
            query.push((key.into(), value.into()));
        }
    }
}

fn url_with_query(
    endpoint: &str,
    path: &str,
    query: impl IntoIterator<Item = (String, String)>,
) -> String {
    let mut url = format!(
        "{}{}",
        endpoint.trim_end_matches('/'),
        if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/{path}")
        }
    );
    let pairs = query
        .into_iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                encode_uri_component(&key),
                encode_uri_component(&value)
            )
        })
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        url.push('?');
        url.push_str(&pairs.join("&"));
    }
    url
}

fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn expose_ui_state_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("expose-ui-state.json")
}

fn is_dashboard_window_name(value: &str) -> bool {
    matches!(value, "dashboard" | "meta-dashboard") || value.starts_with("dashboard:")
}

fn lexical_resolve(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn daemon_json_error(status: u16, response: &Value) -> String {
    response
        .get("error")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            CoreCommandTransportError::DaemonRequest {
                status,
                message: format!("daemon request failed: {status}"),
            }
            .to_string()
        })
}
