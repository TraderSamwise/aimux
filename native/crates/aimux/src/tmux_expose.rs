use crate::atomic_write::write_json_atomic;
use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};
use crate::daemon_state::get_daemon_base_url;
use crate::expose_socket::parse_positive_header_integer;
use crate::project_api_contract::routes;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
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
pub struct TmuxExposeOptions {
    pub project_root: PathBuf,
    pub project_state_dir: PathBuf,
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
    pub current_window: Option<String>,
    pub current_window_id: Option<String>,
    pub current_path: Option<String>,
    pub pane_id: Option<String>,
    pub aimux_home: Option<String>,
    pub daemon_endpoint: Option<String>,
    pub metadata_endpoint: Option<String>,
    pub selection_file: Option<PathBuf>,
    pub columns: Option<usize>,
    pub rows: Option<usize>,
    pub expose_config: ExposeConfig,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExposeKey {
    Char(char),
    Enter,
    Tab,
    Escape,
    Ctrl(char),
    Up,
    Down,
    Left,
    Right,
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

pub fn parse_expose_args<S: AsRef<str>>(raw_args: &[S]) -> Result<TmuxExposeOptions, String> {
    let mut project_root = None;
    let mut project_state_dir = None;
    let mut options = TmuxExposeOptions::default();
    let mut index = usize::from(raw_args.first().map(AsRef::as_ref) == Some("expose"));
    while index < raw_args.len() {
        let arg = raw_args[index].as_ref();
        let (name, inline_value) = arg.split_once('=').unwrap_or((arg, ""));
        let value = if inline_value.is_empty() {
            match name {
                "--project-root"
                | "--project-state-dir"
                | "--current-client-session"
                | "--client-tty"
                | "--current-window"
                | "--current-window-id"
                | "--current-path"
                | "--pane-id"
                | "--aimux-home" => {
                    index += 1;
                    raw_args
                        .get(index)
                        .map(AsRef::as_ref)
                        .ok_or_else(|| format!("{name} requires a value"))?
                }
                _ => return Err(format!("unknown expose option: {name}")),
            }
        } else {
            inline_value
        };
        match name {
            "--project-root" => project_root = Some(resolve_path(value)),
            "--project-state-dir" => project_state_dir = Some(resolve_path(value)),
            "--current-client-session" => options.current_client_session = Some(value.to_owned()),
            "--client-tty" => options.client_tty = Some(value.to_owned()),
            "--current-window" => options.current_window = Some(value.to_owned()),
            "--current-window-id" => options.current_window_id = Some(value.to_owned()),
            "--current-path" => options.current_path = Some(value.to_owned()),
            "--pane-id" => options.pane_id = Some(value.to_owned()),
            "--aimux-home" => options.aimux_home = Some(value.to_owned()),
            _ => return Err(format!("unknown expose option: {name}")),
        }
        index += 1;
    }
    options.project_root = project_root.ok_or("--project-root is required")?;
    options.project_state_dir = project_state_dir.ok_or("--project-state-dir is required")?;
    Ok(options)
}

pub fn tmux_expose_options_from_socket_header(
    header: &[String],
    fallback_project_root: impl AsRef<Path>,
    fallback_project_state_dir: impl AsRef<Path>,
) -> TmuxExposeOptions {
    let value = |index: usize| {
        header
            .get(index)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    TmuxExposeOptions {
        project_root: value(0)
            .map(PathBuf::from)
            .unwrap_or_else(|| fallback_project_root.as_ref().to_path_buf()),
        project_state_dir: value(1)
            .map(PathBuf::from)
            .unwrap_or_else(|| fallback_project_state_dir.as_ref().to_path_buf()),
        current_client_session: value(2),
        client_tty: value(3),
        current_window: value(4),
        current_window_id: value(5),
        current_path: value(6),
        pane_id: value(7),
        aimux_home: value(8),
        daemon_endpoint: value(13),
        selection_file: value(14).map(PathBuf::from),
        columns: parse_positive_header_integer(header.get(11).map(String::as_str)),
        rows: parse_positive_header_integer(header.get(12).map(String::as_str)),
        ..TmuxExposeOptions::default()
    }
}

pub fn run_tmux_expose(options: TmuxExposeOptions) -> i32 {
    let mut client = SystemExposeHttpClient;
    let mut input = std::io::stdin();
    let mut output = std::io::stdout();
    run_tmux_expose_with_client(options, &mut input, &mut output, &mut client)
}

pub fn run_tmux_expose_with_client(
    options: TmuxExposeOptions,
    input: &mut impl Read,
    output: &mut impl Write,
    client: &mut impl ExposeHttpClient,
) -> i32 {
    let context = FastControlContext {
        project_root: options.project_root.to_string_lossy().into_owned(),
        current_path: options.current_path.clone(),
        current_window: options.current_window.clone(),
        current_window_id: options.current_window_id.clone(),
        current_client_session: options.current_client_session.clone(),
        client_tty: options.client_tty.clone(),
    };
    let deps = LoadExposeScopeDeps {
        daemon_endpoint: options.daemon_endpoint.clone(),
        metadata_endpoint: options.metadata_endpoint.clone(),
    };
    let cross_project = options
        .current_window
        .as_deref()
        .is_some_and(is_meta_dashboard_window_name);
    let mut scope = initial_expose_scope(cross_project, &context, &options.expose_config);
    let mut view = match load_expose_scope_items_with(
        scope,
        &context,
        &options.project_state_dir,
        &deps,
        client,
    ) {
        Ok(view) => view,
        Err(error) => {
            let _ = writeln!(output, "aimux expose: {error}");
            return 1;
        }
    };
    let mut sort_mode = read_expose_ui_state(&options.project_state_dir).sort_mode;
    let mut items = order_items(&view.items, sort_mode);
    let mut index = 0_usize;
    let mut leader_pending = false;
    let _ = render_plain_expose(output, &view, &items, index);
    let mut buffer = [0_u8; 8192];
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) => return finish_plain_expose(output, 0),
            Ok(count) => count,
            Err(_) => return finish_plain_expose(output, 1),
        };
        for key in parse_key_events(&buffer[..count]) {
            if matches!(
                key,
                ExposeKey::Char('q') | ExposeKey::Escape | ExposeKey::Ctrl('c')
            ) {
                return finish_plain_expose(output, 0);
            }
            if leader_pending {
                leader_pending = false;
                if key == ExposeKey::Char('d') {
                    return finish_plain_expose(output, 76);
                }
            }
            if key == ExposeKey::Ctrl('a') {
                leader_pending = true;
                continue;
            }
            if key == ExposeKey::Char('r') {
                let selected_window_id = item_window_id(items.get(index)).map(str::to_owned);
                sort_mode = if sort_mode == ExposeSortMode::RecentOutput {
                    ExposeSortMode::Default
                } else {
                    ExposeSortMode::RecentOutput
                };
                let _ =
                    write_expose_ui_state(&options.project_state_dir, ExposeUiState { sort_mode });
                items = order_items(&view.items, sort_mode);
                index = selected_window_id
                    .and_then(|window_id| {
                        items
                            .iter()
                            .position(|item| item_window_id(Some(item)) == Some(window_id.as_str()))
                    })
                    .unwrap_or_else(|| index.min(items.len().saturating_sub(1)));
                let _ = render_plain_expose(output, &view, &items, index);
                continue;
            }
            if key == ExposeKey::Char('g') {
                scope = next_expose_scope(scope);
                if let Ok(next_view) = load_expose_scope_items_with(
                    scope,
                    &context,
                    &options.project_state_dir,
                    &deps,
                    client,
                ) {
                    view = next_view;
                    items = order_items(&view.items, sort_mode);
                    index = index.min(items.len().saturating_sub(1));
                    let _ = render_plain_expose(output, &view, &items, index);
                }
                continue;
            }
            if key == ExposeKey::Char('O') {
                match load_overseer_expose_item_with(
                    &context,
                    &options.project_state_dir,
                    &deps,
                    client,
                ) {
                    Ok(Some(item)) => {
                        if focus_or_select(&options, &context, &deps, client, &item) {
                            return finish_plain_expose(output, 0);
                        }
                        let _ = render_plain_expose(output, &view, &items, index);
                    }
                    _ => {
                        let _ = render_plain_expose(output, &view, &items, index);
                    }
                }
                continue;
            }
            if let ExposeKey::Char(ch) = key
                && ('1'..='9').contains(&ch)
            {
                let target = ch as usize - '1' as usize;
                if target < items.len().min(9) {
                    index = target;
                    if focus_or_select(&options, &context, &deps, client, &items[index]) {
                        return finish_plain_expose(output, 0);
                    }
                    if let Ok(next_view) = load_expose_scope_items_with(
                        scope,
                        &context,
                        &options.project_state_dir,
                        &deps,
                        client,
                    ) {
                        view = next_view;
                        items = order_items(&view.items, sort_mode);
                    }
                    let _ = render_plain_expose(output, &view, &items, index);
                }
                continue;
            }
            if matches!(key, ExposeKey::Enter) {
                if let Some(item) = items.get(index)
                    && focus_or_select(&options, &context, &deps, client, item)
                {
                    return finish_plain_expose(output, 0);
                }
                continue;
            }
            if items.is_empty() {
                continue;
            }
            let previous = index;
            match key {
                ExposeKey::Right | ExposeKey::Tab | ExposeKey::Char('l') | ExposeKey::Char('n') => {
                    index = (index + 1) % items.len()
                }
                ExposeKey::Left | ExposeKey::Char('h') | ExposeKey::Char('p') => {
                    index = (index + items.len() - 1) % items.len()
                }
                ExposeKey::Down | ExposeKey::Char('j') => {
                    index = (index + 3).min(items.len().saturating_sub(1))
                }
                ExposeKey::Up | ExposeKey::Char('k') => index = index.saturating_sub(3),
                _ => {}
            }
            if previous != index {
                let _ = render_plain_expose(output, &view, &items, index);
            }
        }
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

fn focus_or_select(
    options: &TmuxExposeOptions,
    context: &FastControlContext,
    deps: &LoadExposeScopeDeps,
    client: &mut impl ExposeHttpClient,
    item: &Value,
) -> bool {
    if write_selected_window(
        options.selection_file.as_deref(),
        &options.project_root,
        item,
    ) {
        return true;
    }
    focus_expose_item_with(item, context, &options.project_state_dir, deps, client).unwrap_or(false)
}

fn finish_plain_expose(output: &mut impl Write, code: i32) -> i32 {
    let _ = write!(output, "\x1b[?25h");
    let _ = output.flush();
    code
}

fn render_plain_expose(
    output: &mut impl Write,
    view: &ExposeScopeView,
    items: &[Value],
    selected_index: usize,
) -> std::io::Result<()> {
    write!(output, "\x1b[2J\x1b[H\x1b[?25l")?;
    writeln!(output, "aimux expose - {}", view.scope_label)?;
    if items.is_empty() {
        writeln!(output, "No sessions.")?;
    }
    for (index, item) in items.iter().take(9).enumerate() {
        let prefix = if index == selected_index { ">" } else { " " };
        let number = index + 1;
        let label = item.get("label").and_then(Value::as_str).unwrap_or("?");
        let project = item
            .get("projectName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let worktree = item
            .get("exposeContext")
            .and_then(|context| context.get("worktree"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let window_id = item_window_id(Some(item)).unwrap_or("");
        let context = [project, worktree]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
        if context.is_empty() {
            writeln!(output, "{prefix} {number}. {label}  {window_id}")?;
        } else {
            writeln!(output, "{prefix} {number}. {label}  {context}  {window_id}")?;
        }
    }
    writeln!(output, "q close  enter open  g scope  r sort  O overseer")?;
    output.flush()
}

fn order_items(items: &[Value], sort_mode: ExposeSortMode) -> Vec<Value> {
    let mut ordered = items.to_vec();
    if sort_mode != ExposeSortMode::RecentOutput {
        return ordered;
    }
    ordered.sort_by(|left, right| {
        let left_timestamp = item_recency_at(left);
        let right_timestamp = item_recency_at(right);
        right_timestamp
            .cmp(left_timestamp)
            .then_with(|| item_recent_rank(left).cmp(&item_recent_rank(right)))
    });
    ordered
}

fn item_recency_at(item: &Value) -> &str {
    item.get("metadata")
        .and_then(|metadata| metadata.get("recencyAt"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn item_recent_rank(item: &Value) -> i64 {
    item.get("recentRank")
        .and_then(Value::as_i64)
        .unwrap_or(i64::MAX)
}

fn item_window_id(item: Option<&Value>) -> Option<&str> {
    item.and_then(|item| item.get("target"))
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
}

fn parse_key_events(bytes: &[u8]) -> Vec<ExposeKey> {
    let mut events = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            0x01 => {
                events.push(ExposeKey::Ctrl('a'));
                index += 1;
            }
            0x03 => {
                events.push(ExposeKey::Ctrl('c'));
                index += 1;
            }
            b'\r' | b'\n' => {
                events.push(ExposeKey::Enter);
                index += 1;
            }
            b'\t' => {
                events.push(ExposeKey::Tab);
                index += 1;
            }
            0x1b if bytes.get(index + 1) == Some(&b'[') => {
                let key = match bytes.get(index + 2).copied() {
                    Some(b'A') => Some(ExposeKey::Up),
                    Some(b'B') => Some(ExposeKey::Down),
                    Some(b'C') => Some(ExposeKey::Right),
                    Some(b'D') => Some(ExposeKey::Left),
                    _ => None,
                };
                if let Some(key) = key {
                    events.push(key);
                    index += 3;
                } else {
                    events.push(ExposeKey::Escape);
                    index += 1;
                }
            }
            0x1b => {
                events.push(ExposeKey::Escape);
                index += 1;
            }
            byte if byte.is_ascii() => {
                events.push(ExposeKey::Char(byte as char));
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }
    events
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

fn resolve_path(path: &str) -> PathBuf {
    lexical_resolve(path)
}

fn is_dashboard_window_name(value: &str) -> bool {
    matches!(value, "dashboard" | "meta-dashboard") || value.starts_with("dashboard:")
}

fn is_meta_dashboard_window_name(value: &str) -> bool {
    value == "meta-dashboard"
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
