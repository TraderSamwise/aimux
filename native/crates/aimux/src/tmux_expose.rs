use crate::atomic_write::write_json_atomic;
use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};
use crate::daemon_state::get_daemon_base_url;
use crate::expose_socket::parse_positive_header_integer;
use crate::project_api_contract::routes;
use crate::project_service::switchable_agents::agent_status_chip;
use crate::project_service::usage::parse_recency_timestamp;
use crate::tmux::{CapturePaneOptions, TmuxRuntimeManager, TmuxTarget};
use crate::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, read_hot_expose_scope_view, write_hot_expose_scope_view,
};
use crate::tmux_expose_preview_sanitize::sanitize_expose_preview_output;
use crate::tui_render::text::{truncate_ansi, wrap_text};
use crate::tui_render::theme::{Tone, pill, style, visible_width};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EXPOSE_HTTP_TIMEOUT_MS: u64 = 4_000;
pub const EXPOSE_CLIENT_TTL_MS: &str = "10000";
pub const RELAUNCH_ON_RESIZE_EXIT: i32 = 75;
pub const OPEN_DASHBOARD_FROM_EXPOSE_EXIT: i32 = 76;
const CAPTURE_LINES: i64 = 40;
const ITEM_RELOAD_EVERY_TICKS: u64 = 5;
const INPUT_QUIET_BEFORE_REFRESH_MS: u64 = 120;
const RESIZE_CHECK_DURING_INPUT_MS: u64 = 1000;
const CLIENT_SIZE_QUERY_TIMEOUT_MS: u64 = 500;
const GAP: i64 = 1;
const MIN_TILE_WIDTH: i64 = 30;
const MIN_TILE_HEIGHT: i64 = 5;
const RESET: &str = "\x1b[0m";
const TITLE_ROW: i64 = 1;
const CONTENT_LEFT: i64 = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub tile_cols: i64,
    pub tile_width: i64,
    pub tile_height: i64,
    pub body_lines: i64,
    pub visible_count: i64,
    pub grid_top_row: i64,
    pub grid_height: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileContext {
    pub worktree: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileHeader {
    pub rule_title: String,
    pub header_rows: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct DrawTileInput<'a> {
    pub item: &'a Value,
    pub preview: &'a [String],
    pub badge: i64,
    pub selected: bool,
    pub top: i64,
    pub left: i64,
    pub width: i64,
    pub layout: &'a GridLayout,
    pub context: &'a TileContext,
    pub options: &'a TmuxExposeOptions,
}

struct RenderTileAtInput<'a> {
    tile_index: usize,
    selected_index: usize,
    layout: &'a GridLayout,
    items: &'a [Value],
    captures: &'a BTreeMap<String, String>,
    tones: &'a BTreeMap<String, i64>,
    view: &'a ExposeScopeView,
    options: &'a TmuxExposeOptions,
}

#[derive(Debug, Clone, Copy)]
struct RenderGridExposeState {
    sort_mode: ExposeSortMode,
    loading: bool,
}

pub trait ExposeHttpClient {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String>;
}

pub trait ExposeTmuxCapture {
    fn capture_target(&mut self, item: &Value) -> Result<String, String>;
}

pub trait ExposeClientSizeProbe {
    fn query_client_size(&mut self, client_tty: Option<&str>) -> String;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposeInputEvent {
    Data(usize),
    Timeout,
    End,
    Error,
}

pub trait ExposeInputSource {
    fn read_timeout(&mut self, buffer: &mut [u8], timeout: Duration) -> ExposeInputEvent;
}

#[derive(Debug, Default)]
pub struct SystemExposeClientSizeProbe;

impl ExposeClientSizeProbe for SystemExposeClientSizeProbe {
    fn query_client_size(&mut self, client_tty: Option<&str>) -> String {
        let Some(client_tty) = client_tty.filter(|value| !value.trim().is_empty()) else {
            return String::new();
        };
        let Some(listing) = tmux_list_clients_with_timeout() else {
            return String::new();
        };
        match_client_size(&listing, client_tty)
    }
}

struct BlockingExposeInput<'a, R: Read> {
    inner: &'a mut R,
}

impl<R: Read> ExposeInputSource for BlockingExposeInput<'_, R> {
    fn read_timeout(&mut self, buffer: &mut [u8], _timeout: Duration) -> ExposeInputEvent {
        match self.inner.read(buffer) {
            Ok(0) => ExposeInputEvent::End,
            Ok(count) => ExposeInputEvent::Data(count),
            Err(_) => ExposeInputEvent::Error,
        }
    }
}

#[cfg(unix)]
struct StdinPollingInput {
    stdin: std::io::Stdin,
}

#[cfg(unix)]
impl Default for StdinPollingInput {
    fn default() -> Self {
        Self {
            stdin: std::io::stdin(),
        }
    }
}

#[cfg(unix)]
impl ExposeInputSource for StdinPollingInput {
    fn read_timeout(&mut self, buffer: &mut [u8], timeout: Duration) -> ExposeInputEvent {
        let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut fd, 1, timeout_ms) };
        if ready == 0 {
            return ExposeInputEvent::Timeout;
        }
        if ready < 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                ExposeInputEvent::Timeout
            } else {
                ExposeInputEvent::Error
            };
        }
        match self.stdin.read(buffer) {
            Ok(0) => ExposeInputEvent::End,
            Ok(count) => ExposeInputEvent::Data(count),
            Err(_) => ExposeInputEvent::Error,
        }
    }
}

#[cfg(not(unix))]
struct StdinPollingInput {
    stdin: std::io::Stdin,
}

#[cfg(not(unix))]
impl Default for StdinPollingInput {
    fn default() -> Self {
        Self {
            stdin: std::io::stdin(),
        }
    }
}

#[cfg(not(unix))]
impl ExposeInputSource for StdinPollingInput {
    fn read_timeout(&mut self, buffer: &mut [u8], _timeout: Duration) -> ExposeInputEvent {
        match self.stdin.read(buffer) {
            Ok(0) => ExposeInputEvent::End,
            Ok(count) => ExposeInputEvent::Data(count),
            Err(_) => ExposeInputEvent::Error,
        }
    }
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

#[derive(Default)]
pub struct SystemExposeTmuxCapture {
    tmux: TmuxRuntimeManager,
}

impl ExposeTmuxCapture for SystemExposeTmuxCapture {
    fn capture_target(&mut self, item: &Value) -> Result<String, String> {
        let target = tmux_target_from_item(item);
        self.tmux.capture_target(
            &target,
            CapturePaneOptions {
                start_line: Some(-CAPTURE_LINES),
                end_line: None,
                include_escapes: true,
            },
        )
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

fn default_expose_scope_view(scope: ExposeScope) -> ExposeScopeView {
    ExposeScopeView {
        scope,
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
        items: Vec::new(),
    }
}

pub fn balanced_cols(count: i64) -> i64 {
    if count <= 3 {
        return count.max(1);
    }
    (count as f64).sqrt().ceil() as i64
}

pub fn compute_layout(item_count: i64, cols: i64, rows: i64) -> GridLayout {
    let grid_top_row = 1;
    let footer_row = rows - 1;
    let grid_height = (footer_row - grid_top_row).max(1);
    let fit_cols = ((cols + GAP) / (MIN_TILE_WIDTH + GAP)).max(1);
    let tile_cols = balanced_cols(item_count).min(fit_cols).max(1);
    let needed_rows = ((item_count as f64) / (tile_cols as f64)).ceil() as i64;
    let max_tile_rows = (grid_height / MIN_TILE_HEIGHT).max(1);
    let tile_rows = needed_rows.min(max_tile_rows).max(1);
    let tile_width = ((cols - (tile_cols - 1) * GAP) / tile_cols).max(4);
    let tile_height = grid_height / tile_rows;
    GridLayout {
        tile_cols,
        tile_width,
        tile_height,
        body_lines: (tile_height - 3).max(1),
        visible_count: item_count.min(tile_cols * tile_rows),
        grid_top_row,
        grid_height,
    }
}

pub fn match_client_size(listing: &str, client_tty: &str) -> String {
    let wanted = path_basename(client_tty);
    for line in listing.split('\n') {
        let mut parts = line.split_whitespace();
        let Some(tty) = parts.next() else {
            continue;
        };
        let Some(size) = parts.next() else {
            continue;
        };
        if tty == client_tty || path_basename(tty) == wanted {
            return size.to_owned();
        }
    }
    String::new()
}

pub fn refresh_delay_ms(count: usize) -> u64 {
    if count > 8 {
        return 1000;
    }
    if count > 4 {
        return 500;
    }
    250
}

pub fn expose_preview_footer_crop_rows(visible_line_count: i64) -> i64 {
    if visible_line_count <= 0 {
        return 0;
    }
    if visible_line_count <= 8 {
        return 3;
    }
    if visible_line_count <= 11 {
        return 2;
    }
    if visible_line_count <= 14 {
        return 1;
    }
    0
}

pub fn crop_expose_preview_footer<T: Clone>(lines: &[T], visible_line_count: i64) -> Vec<T> {
    let count = visible_line_count.max(0) as usize;
    if count == 0 {
        return Vec::new();
    }
    let desired_drop = expose_preview_footer_crop_rows(count as i64) as usize;
    let drop = desired_drop.min(lines.len().saturating_sub(count));
    let source_len = lines.len().saturating_sub(drop);
    lines[source_len.saturating_sub(count)..source_len].to_vec()
}

pub fn tile_preview(raw: &str, count: i64) -> Vec<String> {
    let lines = sanitize_expose_preview_output(raw);
    let mut tail = crop_expose_preview_footer(&lines, count);
    let target = count.max(0) as usize;
    while tail.len() < target {
        tail.push(String::new());
    }
    tail
}

pub fn build_tile_header(
    text_w: i64,
    width: i64,
    title_left: &str,
    context: &str,
    pill_str: &str,
    detail: &str,
    inset: i64,
) -> TileHeader {
    let pad = " ".repeat(inset.max(0) as usize);
    let content_w = (text_w - inset).max(1) as usize;
    let title_max = (width - 6).max(0) as usize;
    let mut header_rows = Vec::new();
    let mut rule_title = title_left.to_owned();
    if !context.is_empty() {
        let wide = format!("{title_left}  {}", style(context, Tone::Muted));
        if visible_width(&wide) <= title_max {
            rule_title = wide;
        } else {
            for line in wrap_text(context, content_w) {
                header_rows.push(format!("{pad}{}", style(&line, Tone::Muted)));
            }
        }
    }
    rule_title = truncate_ansi(&rule_title, title_max);
    let status_row = [pill_str, if detail.is_empty() { "" } else { detail }]
        .into_iter()
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value == detail {
                style(value, Tone::Muted)
            } else {
                value.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("  ");
    if !status_row.is_empty() {
        header_rows.push(format!("{pad}{status_row}"));
    }
    TileHeader {
        rule_title,
        header_rows,
    }
}

pub fn fit_header_rows(header_rows: &[String], capacity: i64, has_pill: bool) -> Vec<String> {
    let capacity = capacity.max(0) as usize;
    if header_rows.len() <= capacity {
        return header_rows.to_vec();
    }
    if !has_pill {
        return header_rows.iter().take(capacity).cloned().collect();
    }
    let Some(pill_row) = header_rows.last() else {
        return Vec::new();
    };
    let mut fitted = header_rows
        .iter()
        .take(header_rows.len().saturating_sub(1))
        .take(capacity.saturating_sub(1))
        .cloned()
        .collect::<Vec<_>>();
    if capacity > 0 {
        fitted.push(pill_row.clone());
    }
    fitted
}

pub fn draw_tile(input: DrawTileInput<'_>) -> String {
    let DrawTileInput {
        item,
        preview,
        badge,
        selected,
        top,
        left,
        width,
        layout,
        context,
        options,
    } = input;
    let inner_w = (width - 2).max(1);
    let text_w = (inner_w - 1).max(0);
    let metadata = item.get("metadata").unwrap_or(&Value::Null);
    let kind = agent_status_kind(metadata);
    let tone = kind.as_deref().and_then(state_border).unwrap_or("38;5;39");
    let bd = if selected {
        format!("\x1b[1;{tone}m")
    } else {
        format!("\x1b[{tone}m")
    };
    let box_chars = if selected {
        ("╔", "╗", "╚", "╝", "═", "║")
    } else {
        ("╭", "╮", "╰", "╯", "─", "│")
    };
    let badge_label = if badge <= 9 {
        badge.to_string()
    } else {
        "·".to_owned()
    };
    let marker = if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    };
    let window_id = item
        .get("target")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str);
    let here = if window_id == options.current_window_id.as_deref() {
        style(" (here)", Tone::Muted)
    } else {
        String::new()
    };
    let badge_str = if selected {
        style(&badge_label, Tone::Accent)
    } else {
        toned(&badge_label, context.tone)
    };
    let project_str = context
        .project
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|project| style(&format!("{project} / "), Tone::Muted))
        .unwrap_or_default();
    let label = item.get("label").and_then(Value::as_str).unwrap_or("?");
    let lead = if !context.worktree.is_empty() {
        format!("{project_str}{}", toned(&context.worktree, context.tone))
    } else {
        style(label, Tone::Strong)
    };
    let trailing = if !context.worktree.is_empty() {
        label
    } else {
        ""
    };
    let title_left = format!("{marker}{badge_str} {lead}{here}");
    let pill_str = render_agent_status_pill(metadata);
    let rel = metadata
        .get("recencyAt")
        .and_then(Value::as_str)
        .and_then(format_relative_recency)
        .unwrap_or_default();
    let recency = if !rel.is_empty() {
        metadata
            .get("recencyLabel")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|label| format!("{label} {rel}"))
            .unwrap_or(rel)
    } else {
        String::new()
    };
    let status_text = metadata
        .get("statusText")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_owned();
    let detail = [recency.as_str(), status_text.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let inset = visible_width(&marker) as i64;
    let header = build_tile_header(
        text_w,
        width,
        &title_left,
        trailing,
        &pill_str,
        &detail,
        inset,
    );
    let body_capacity = (layout.tile_height - 2).max(1);
    let fitted_header = fit_header_rows(
        &header.header_rows,
        body_capacity,
        !pill_str.is_empty() || !detail.is_empty(),
    );
    let preview_limit = (body_capacity - fitted_header.len() as i64).max(0) as usize;
    let mut body_rows = fitted_header;
    body_rows.extend(preview.iter().take(preview_limit).cloned());
    while body_rows.len() < body_capacity as usize {
        body_rows.push(String::new());
    }

    let title_sep = if visible_width(&header.rule_title) > 0 {
        " "
    } else {
        ""
    };
    let dash_count =
        (width - 3 - visible_width(&header.rule_title) as i64 - title_sep.len() as i64).max(0);
    let mut rows = Vec::new();
    rows.push(format!(
        "{}{} {RESET}{}{}{}{}{}{RESET}",
        bd,
        box_chars.0,
        header.rule_title,
        title_sep,
        bd,
        box_chars.4.repeat(dash_count as usize),
        box_chars.1
    ));
    for content in body_rows {
        let text = truncate_ansi(&content, text_w.max(0) as usize);
        let pad = (text_w - visible_width(&text) as i64).max(0);
        rows.push(format!(
            "{}{}{RESET} {}{}{}{}{RESET}",
            bd,
            box_chars.5,
            text,
            " ".repeat(pad as usize),
            bd,
            box_chars.5
        ));
    }
    rows.push(format!(
        "{}{}{}{}{RESET}",
        bd,
        box_chars.2,
        box_chars.4.repeat(inner_w as usize),
        box_chars.3
    ));

    let mut output = String::new();
    for (index, row) in rows.iter().enumerate() {
        output.push_str(&format!("\x1b[{};{}H{}", top + index as i64, left, row));
    }
    output
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
    let mut capture = SystemExposeTmuxCapture::default();
    let mut size_probe = SystemExposeClientSizeProbe;
    let mut input = StdinPollingInput::default();
    let mut output = std::io::stdout();
    run_tmux_expose_with_drivers(
        options,
        &mut input,
        &mut output,
        &mut client,
        &mut capture,
        &mut size_probe,
    )
}

pub fn run_tmux_expose_with_client(
    options: TmuxExposeOptions,
    input: &mut impl Read,
    output: &mut impl Write,
    client: &mut impl ExposeHttpClient,
) -> i32 {
    let mut capture = SystemExposeTmuxCapture::default();
    run_tmux_expose_with_client_and_capture(options, input, output, client, &mut capture)
}

pub fn run_tmux_expose_with_client_and_capture(
    options: TmuxExposeOptions,
    input: &mut impl Read,
    output: &mut impl Write,
    client: &mut impl ExposeHttpClient,
    capture: &mut impl ExposeTmuxCapture,
) -> i32 {
    let mut input = BlockingExposeInput { inner: input };
    run_tmux_expose_with_input_source(options, &mut input, output, client, capture)
}

pub fn run_tmux_expose_with_input_source(
    options: TmuxExposeOptions,
    input: &mut impl ExposeInputSource,
    output: &mut impl Write,
    client: &mut impl ExposeHttpClient,
    capture: &mut impl ExposeTmuxCapture,
) -> i32 {
    let mut size_probe = SystemExposeClientSizeProbe;
    run_tmux_expose_with_drivers(options, input, output, client, capture, &mut size_probe)
}

pub fn run_tmux_expose_with_drivers(
    options: TmuxExposeOptions,
    input: &mut impl ExposeInputSource,
    output: &mut impl Write,
    client: &mut impl ExposeHttpClient,
    capture: &mut impl ExposeTmuxCapture,
    size_probe: &mut impl ExposeClientSizeProbe,
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
    let mut view_stale = false;
    let mut loading = false;
    let mut view = if let Some(hot_view) = read_hot_expose_scope_view(
        &options.project_state_dir,
        &hot_snapshot_key_for_scope(&options, scope),
    ) {
        view_stale = true;
        hot_view
    } else {
        loading = true;
        default_expose_scope_view(scope)
    };
    let mut sort_mode = read_expose_ui_state(&options.project_state_dir).sort_mode;
    let mut items = order_items(&view, &options.project_root, sort_mode);
    let mut index = selected_or_current_index(&items, None, options.current_window_id.as_deref());
    let mut leader_pending = false;
    let mut pending_keys: Vec<ExposeKey> = Vec::new();
    let mut captures = seed_preview_snapshots(&items);
    let mut refresh_tick = 0_u64;
    let client_baseline = match (options.columns, options.rows) {
        (Some(columns), Some(rows)) => format!("{columns}x{rows}"),
        _ => size_probe.query_client_size(options.client_tty.as_deref()),
    };
    let mut last_input_at: Option<Instant> = None;
    let mut last_resize_check_at = Some(Instant::now());
    let mut static_size = expose_terminal_size_label(&options);
    let mut render_state = RenderGridExposeState { sort_mode, loading };
    let mut layout = render_grid_expose(
        output,
        &view,
        &items,
        &captures,
        index,
        &options,
        render_state,
    )
    .unwrap_or_else(|_| compute_layout(items.len() as i64, 80, 24));
    if !loading && refresh_captures(&items, &mut captures, capture) {
        layout = render_grid_expose(
            output,
            &view,
            &items,
            &captures,
            index,
            &options,
            render_state,
        )
        .unwrap_or(layout);
        static_size = expose_terminal_size_label(&options);
    }
    let mut buffer = [0_u8; 8192];
    loop {
        let keys = if !loading && !pending_keys.is_empty() {
            std::mem::take(&mut pending_keys)
        } else {
            let count = match input.read_timeout(
                &mut buffer,
                Duration::from_millis(refresh_delay_ms(items.len())),
            ) {
                ExposeInputEvent::End => return finish_plain_expose(output, 0),
                ExposeInputEvent::Error => return finish_plain_expose(output, 1),
                ExposeInputEvent::Timeout => {
                    let now = Instant::now();
                    let input_quiet = !loading
                        && last_input_at.is_some_and(|last_input_at| {
                            now.duration_since(last_input_at).as_millis()
                                < u128::from(INPUT_QUIET_BEFORE_REFRESH_MS)
                        });
                    if input_quiet {
                        if last_resize_check_at.is_none() {
                            last_resize_check_at = Some(now);
                        }
                        if last_resize_check_at.is_some_and(|last_check| {
                            now.duration_since(last_check).as_millis()
                                >= u128::from(RESIZE_CHECK_DURING_INPUT_MS)
                        }) {
                            last_resize_check_at = Some(now);
                            if should_relaunch_for_resize(
                                size_probe,
                                options.client_tty.as_deref(),
                                &client_baseline,
                            ) {
                                return finish_plain_expose(output, RELAUNCH_ON_RESIZE_EXIT);
                            }
                        }
                        continue;
                    }
                    last_resize_check_at = Some(now);
                    if should_relaunch_for_resize(
                        size_probe,
                        options.client_tty.as_deref(),
                        &client_baseline,
                    ) {
                        return finish_plain_expose(output, RELAUNCH_ON_RESIZE_EXIT);
                    }
                    refresh_tick += 1;
                    let reloaded = loading || refresh_tick >= ITEM_RELOAD_EVERY_TICKS;
                    let mut changed = false;
                    if reloaded {
                        refresh_tick = 0;
                        let selected_window_id =
                            item_window_id(items.get(index)).map(str::to_owned);
                        if let Ok(next_view) = load_expose_scope_items_with(
                            scope,
                            &context,
                            &options.project_state_dir,
                            &deps,
                            client,
                        ) {
                            view = next_view;
                            view_stale = false;
                            loading = false;
                            write_loaded_hot_snapshot(&options, scope, &view);
                            items = order_items(&view, &options.project_root, sort_mode);
                            captures = seed_preview_snapshots(&items);
                            index = selected_or_current_index(
                                &items,
                                selected_window_id.as_deref(),
                                options.current_window_id.as_deref(),
                            );
                            changed = true;
                        }
                    }
                    render_state = RenderGridExposeState { sort_mode, loading };
                    if !loading && refresh_captures(&items, &mut captures, capture) {
                        changed = true;
                    }
                    let size_now = expose_terminal_size_label(&options);
                    if changed || size_now != static_size {
                        layout = render_grid_expose(
                            output,
                            &view,
                            &items,
                            &captures,
                            index,
                            &options,
                            render_state,
                        )
                        .unwrap_or(layout);
                        static_size = size_now;
                    }
                    continue;
                }
                ExposeInputEvent::Data(count) => count,
            };
            let keys = parse_key_events(&buffer[..count]);
            if !keys.is_empty() {
                let now = Instant::now();
                last_input_at = Some(now);
                if !client_baseline.is_empty()
                    && last_resize_check_at.is_some_and(|last_check| {
                        now.duration_since(last_check).as_millis()
                            >= u128::from(RESIZE_CHECK_DURING_INPUT_MS)
                    })
                {
                    last_resize_check_at = Some(now);
                    if should_relaunch_for_resize(
                        size_probe,
                        options.client_tty.as_deref(),
                        &client_baseline,
                    ) {
                        return finish_plain_expose(output, RELAUNCH_ON_RESIZE_EXIT);
                    }
                }
            }
            keys
        };
        for key in keys {
            if matches!(
                key,
                ExposeKey::Char('q') | ExposeKey::Escape | ExposeKey::Ctrl('c')
            ) {
                return finish_plain_expose(output, 0);
            }
            if leader_pending {
                leader_pending = false;
                if key == ExposeKey::Char('d') {
                    return finish_plain_expose(output, OPEN_DASHBOARD_FROM_EXPOSE_EXIT);
                }
            }
            if key == ExposeKey::Ctrl('a') {
                leader_pending = true;
                continue;
            }
            if loading {
                pending_keys.push(key);
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
                render_state = RenderGridExposeState { sort_mode, loading };
                items = order_items(&view, &options.project_root, sort_mode);
                captures = seed_preview_snapshots(&items);
                index = selected_window_id
                    .and_then(|window_id| {
                        items
                            .iter()
                            .position(|item| item_window_id(Some(item)) == Some(window_id.as_str()))
                    })
                    .unwrap_or_else(|| index.min(items.len().saturating_sub(1)));
                layout = render_grid_expose(
                    output,
                    &view,
                    &items,
                    &captures,
                    index,
                    &options,
                    render_state,
                )
                .unwrap_or(layout);
                static_size = expose_terminal_size_label(&options);
                continue;
            }
            if key == ExposeKey::Char('g') {
                scope = next_expose_scope(scope);
                let selected_window_id = item_window_id(items.get(index)).map(str::to_owned);
                if let Some(hot_view) = read_hot_expose_scope_view(
                    &options.project_state_dir,
                    &hot_snapshot_key_for_scope(&options, scope),
                ) {
                    view = hot_view;
                    view_stale = true;
                    render_state = RenderGridExposeState { sort_mode, loading };
                    items = order_items(&view, &options.project_root, sort_mode);
                    captures = seed_preview_snapshots(&items);
                    index = index.min(items.len().saturating_sub(1));
                    layout = render_grid_expose(
                        output,
                        &view,
                        &items,
                        &captures,
                        index,
                        &options,
                        render_state,
                    )
                    .unwrap_or(layout);
                    static_size = expose_terminal_size_label(&options);
                } else if let Ok(next_view) = load_expose_scope_items_with(
                    scope,
                    &context,
                    &options.project_state_dir,
                    &deps,
                    client,
                ) {
                    view = next_view;
                    view_stale = false;
                    render_state = RenderGridExposeState { sort_mode, loading };
                    write_loaded_hot_snapshot(&options, scope, &view);
                    items = order_items(&view, &options.project_root, sort_mode);
                    captures = seed_preview_snapshots(&items);
                    index = selected_or_current_index(
                        &items,
                        selected_window_id.as_deref(),
                        options.current_window_id.as_deref(),
                    );
                    let _ = refresh_captures(&items, &mut captures, capture);
                    layout = render_grid_expose(
                        output,
                        &view,
                        &items,
                        &captures,
                        index,
                        &options,
                        render_state,
                    )
                    .unwrap_or(layout);
                    static_size = expose_terminal_size_label(&options);
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
                        if focus_or_select(&options, &context, &deps, client, &item, view_stale) {
                            return finish_plain_expose(output, 0);
                        }
                        layout = render_grid_expose(
                            output,
                            &view,
                            &items,
                            &captures,
                            index,
                            &options,
                            render_state,
                        )
                        .unwrap_or(layout);
                        static_size = expose_terminal_size_label(&options);
                    }
                    _ => {
                        layout = render_grid_expose(
                            output,
                            &view,
                            &items,
                            &captures,
                            index,
                            &options,
                            render_state,
                        )
                        .unwrap_or(layout);
                        static_size = expose_terminal_size_label(&options);
                    }
                }
                continue;
            }
            if let ExposeKey::Char(ch) = key
                && ('1'..='9').contains(&ch)
            {
                let target = ch as usize - '1' as usize;
                let visible_count = (layout.visible_count.max(0) as usize).min(items.len());
                if target < visible_count.min(9) {
                    index = target;
                    if focus_or_select(&options, &context, &deps, client, &items[index], view_stale)
                    {
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
                        view_stale = false;
                        render_state = RenderGridExposeState { sort_mode, loading };
                        write_loaded_hot_snapshot(&options, scope, &view);
                        items = order_items(&view, &options.project_root, sort_mode);
                        captures = seed_preview_snapshots(&items);
                        let _ = refresh_captures(&items, &mut captures, capture);
                    }
                    layout = render_grid_expose(
                        output,
                        &view,
                        &items,
                        &captures,
                        index,
                        &options,
                        render_state,
                    )
                    .unwrap_or(layout);
                    static_size = expose_terminal_size_label(&options);
                }
                continue;
            }
            if matches!(key, ExposeKey::Enter) {
                if let Some(item) = items.get(index)
                    && focus_or_select(&options, &context, &deps, client, item, view_stale)
                {
                    return finish_plain_expose(output, 0);
                }
                continue;
            }
            if items.is_empty() {
                continue;
            }
            let previous = index;
            let visible_count = (layout.visible_count.max(0) as usize).min(items.len());
            let tile_cols = layout.tile_cols.max(1) as usize;
            match key {
                ExposeKey::Right | ExposeKey::Tab | ExposeKey::Char('l') | ExposeKey::Char('n') => {
                    index = (index + 1) % visible_count
                }
                ExposeKey::Left | ExposeKey::Char('h') | ExposeKey::Char('p') => {
                    index = (index + visible_count - 1) % visible_count
                }
                ExposeKey::Down | ExposeKey::Char('j') => {
                    if index + tile_cols < visible_count {
                        index += tile_cols;
                    }
                }
                ExposeKey::Up | ExposeKey::Char('k') => {
                    if index >= tile_cols {
                        index -= tile_cols;
                    }
                }
                _ => {}
            }
            if previous != index {
                layout = render_grid_expose(
                    output,
                    &view,
                    &items,
                    &captures,
                    index,
                    &options,
                    render_state,
                )
                .unwrap_or(layout);
                static_size = expose_terminal_size_label(&options);
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

fn seed_preview_snapshots(items: &[Value]) -> BTreeMap<String, String> {
    let mut captures = BTreeMap::new();
    for item in items {
        let Some(window_id) = item_window_id(Some(item)) else {
            continue;
        };
        let Some(output) = item
            .get("previewSnapshot")
            .and_then(|snapshot| snapshot.get("output"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        captures.insert(window_id.to_owned(), output.to_owned());
    }
    captures
}

fn refresh_captures(
    items: &[Value],
    captures: &mut BTreeMap<String, String>,
    capture: &mut impl ExposeTmuxCapture,
) -> bool {
    if items.is_empty() {
        return false;
    }
    let mut changed = false;
    for item in items {
        let Some(window_id) = item_window_id(Some(item)) else {
            continue;
        };
        let next = capture
            .capture_target(item)
            .unwrap_or_else(|_| captures.get(window_id).cloned().unwrap_or_default());
        if captures.get(window_id).map(String::as_str) != Some(next.as_str()) {
            changed = true;
        }
        captures.insert(window_id.to_owned(), next);
    }
    changed
}

fn focus_or_select(
    options: &TmuxExposeOptions,
    context: &FastControlContext,
    deps: &LoadExposeScopeDeps,
    client: &mut impl ExposeHttpClient,
    item: &Value,
    view_stale: bool,
) -> bool {
    if !view_stale
        && write_selected_window(
            options.selection_file.as_deref(),
            &options.project_root,
            item,
        )
    {
        return true;
    }
    focus_expose_item_with(item, context, &options.project_state_dir, deps, client).unwrap_or(false)
}

fn write_loaded_hot_snapshot(
    options: &TmuxExposeOptions,
    scope: ExposeScope,
    view: &ExposeScopeView,
) {
    write_hot_expose_scope_view(
        &options.project_state_dir,
        hot_snapshot_key_for_scope(options, scope),
        view.clone(),
        None,
    );
}

fn selected_or_current_index(
    items: &[Value],
    selected_window_id: Option<&str>,
    current_window_id: Option<&str>,
) -> usize {
    selected_window_id
        .and_then(|window_id| find_window_index(items, window_id))
        .or_else(|| current_window_id.and_then(|window_id| find_window_index(items, window_id)))
        .unwrap_or(0)
}

fn find_window_index(items: &[Value], window_id: &str) -> Option<usize> {
    items
        .iter()
        .position(|item| item_window_id(Some(item)) == Some(window_id))
}

fn should_relaunch_for_resize(
    size_probe: &mut impl ExposeClientSizeProbe,
    client_tty: Option<&str>,
    client_baseline: &str,
) -> bool {
    if client_baseline.is_empty() {
        return false;
    }
    let current_size = size_probe.query_client_size(client_tty);
    !current_size.is_empty() && current_size != client_baseline
}

fn tmux_list_clients_with_timeout() -> Option<String> {
    let mut child = Command::new("tmux")
        .args([
            "list-clients",
            "-F",
            "#{client_tty} #{client_width}x#{client_height}",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started_at = Instant::now();
    loop {
        if child.try_wait().ok()?.is_some() {
            let output = child.wait_with_output().ok()?;
            if !output.status.success() {
                return None;
            }
            return Some(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        if started_at.elapsed() >= Duration::from_millis(CLIENT_SIZE_QUERY_TIMEOUT_MS) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn hot_snapshot_key_for_scope(
    options: &TmuxExposeOptions,
    scope: ExposeScope,
) -> HotExposeScopeKey {
    HotExposeScopeKey {
        project_root: options.project_root.to_string_lossy().into_owned(),
        scope,
        worktree_key: (scope == ExposeScope::Worktree).then(|| {
            resolve_scoped_worktree_path(&options.project_root, options.current_path.as_deref())
        }),
        launch_window_id: (scope == ExposeScope::Worktree)
            .then(|| options.current_window_id.clone())
            .flatten(),
    }
}

fn finish_plain_expose(output: &mut impl Write, code: i32) -> i32 {
    let _ = write!(output, "\x1b[?25h");
    let _ = output.flush();
    code
}

fn render_grid_expose(
    output: &mut impl Write,
    view: &ExposeScopeView,
    items: &[Value],
    captures: &BTreeMap<String, String>,
    selected_index: usize,
    options: &TmuxExposeOptions,
    state: RenderGridExposeState,
) -> std::io::Result<GridLayout> {
    let sort_mode = state.sort_mode;
    let loading = state.loading;
    let (cols, rows) = expose_terminal_size(options);
    let layout = compute_layout(items.len() as i64, cols, rows);
    let visible_count = (layout.visible_count.max(0) as usize).min(items.len());
    let selected_index = selected_index.min(visible_count.saturating_sub(1));
    let hidden = items.len().saturating_sub(visible_count);
    let more = if hidden > 0 {
        format!("   +{hidden} more (use ^A s)")
    } else {
        String::new()
    };
    let zoom = if view.scope == ExposeScope::Global {
        ""
    } else {
        " · g zoom out"
    };
    let sort_label = if sort_mode == ExposeSortMode::RecentOutput {
        "recent output"
    } else {
        "default order"
    };
    let title = truncate_ansi(
        &format!(
            "\x1b[1mExposé · {} ({}) · {sort_label}{RESET}",
            view.scope_label,
            items.len()
        ),
        cols.saturating_sub(2) as usize,
    );
    let help = truncate_ansi(
        &format!(
            "\x1b[2m1-9 open · ↑↓←→/n/p move · Enter open · r sort · O overseer · ^A d dashboard{zoom} · q/Esc close{more}{RESET}"
        ),
        cols.saturating_sub(2) as usize,
    );
    let mut rendered = "\x1b[?2026h\x1b[2J".to_owned();
    rendered.push_str(&format!("\x1b[{TITLE_ROW};{}H{title}", CONTENT_LEFT + 1));
    if visible_count == 0 {
        let message = if loading {
            "Loading sessions...".to_owned()
        } else {
            format!("No active agents in {}.", view.scope_label)
        };
        let message_col = CONTENT_LEFT + ((cols - message.chars().count() as i64) / 2).max(0);
        let message_row = (rows / 2).max(1);
        rendered.push_str(&format!(
            "\x1b[{message_row};{message_col}H\x1b[2m{message}{RESET}"
        ));
    } else {
        let tones = assign_value_worktree_tones(items, &options.project_root);
        for tile_index in 0..visible_count {
            rendered.push_str(&render_tile_at(RenderTileAtInput {
                tile_index,
                selected_index,
                layout: &layout,
                items,
                captures,
                tones: &tones,
                view,
                options,
            }));
        }
    }
    rendered.push_str(&format!(
        "\x1b[{rows};{}H{help}\x1b[?2026l",
        CONTENT_LEFT + 1
    ));
    output.write_all(rendered.as_bytes())?;
    output.flush()?;
    Ok(layout)
}

fn expose_terminal_size_label(options: &TmuxExposeOptions) -> String {
    let (cols, rows) = expose_terminal_size(options);
    format!("{cols}x{rows}")
}

fn expose_terminal_size(options: &TmuxExposeOptions) -> (i64, i64) {
    if let Some(size) = stdout_terminal_size() {
        return size;
    }
    (
        options.columns.unwrap_or(80) as i64,
        options.rows.unwrap_or(24) as i64,
    )
}

#[cfg(unix)]
fn stdout_terminal_size() -> Option<(i64, i64)> {
    let mut winsize = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let status = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) };
    if status == 0 && winsize.ws_col > 0 && winsize.ws_row > 0 {
        return Some((i64::from(winsize.ws_col), i64::from(winsize.ws_row)));
    }
    None
}

#[cfg(not(unix))]
fn stdout_terminal_size() -> Option<(i64, i64)> {
    None
}

fn render_tile_at(input: RenderTileAtInput<'_>) -> String {
    let RenderTileAtInput {
        tile_index,
        selected_index,
        layout,
        items,
        captures,
        tones,
        view,
        options,
    } = input;
    let row_offset = (tile_index as i64 / layout.tile_cols) * layout.tile_height;
    let column = tile_index as i64 % layout.tile_cols;
    let top = TITLE_ROW + layout.grid_top_row + row_offset;
    let left = CONTENT_LEFT + column * (layout.tile_width + GAP);
    let item = &items[tile_index];
    let raw = item_window_id(Some(item))
        .and_then(|window_id| captures.get(window_id).map(String::as_str))
        .or_else(|| {
            item.get("previewSnapshot")
                .and_then(|snapshot| snapshot.get("output"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let preview = tile_preview(raw, layout.body_lines);
    let context = tile_context_for_value(item, view.sublabel, &options.project_root, tones);
    draw_tile(DrawTileInput {
        item,
        preview: &preview,
        badge: tile_index as i64 + 1,
        selected: tile_index == selected_index,
        top,
        left,
        width: layout.tile_width,
        layout,
        context: &context,
        options,
    })
}

fn order_items(
    view: &ExposeScopeView,
    _project_root: &Path,
    sort_mode: ExposeSortMode,
) -> Vec<Value> {
    let items = &view.items;
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

fn assign_value_worktree_tones(items: &[Value], project_root: &Path) -> BTreeMap<String, i64> {
    let mut tones = BTreeMap::new();
    for item in items {
        let root = item
            .get("projectRoot")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| project_root.to_path_buf());
        let key = value_worktree_tone_key(item, &root);
        tones
            .entry(key.clone())
            .or_insert_with(|| worktree_color_code_for_path(&key));
    }
    tones
}

fn tile_context_for_value(
    item: &Value,
    sublabel: ExposeSublabel,
    project_root: &Path,
    tones: &BTreeMap<String, i64>,
) -> TileContext {
    if sublabel == ExposeSublabel::None {
        return TileContext {
            worktree: String::new(),
            project: None,
            tone: None,
        };
    }
    let root = item
        .get("projectRoot")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.to_path_buf());
    let key = value_worktree_tone_key(item, &root);
    let project = if sublabel == ExposeSublabel::ProjectWorktree {
        item.get("projectName")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    TileContext {
        worktree: short_value_worktree(item, &root),
        project,
        tone: tones.get(&key).copied(),
    }
}

fn short_value_worktree(item: &Value, project_root: &Path) -> String {
    let Some(worktree_path) = item
        .get("metadata")
        .and_then(|metadata| metadata.get("worktreePath"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return "main".into();
    };
    if lexical_resolve(worktree_path) == lexical_resolve(project_root) {
        return "main".into();
    }
    Path::new(worktree_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(worktree_path)
        .to_owned()
}

fn value_worktree_tone_key(item: &Value, project_root: &Path) -> String {
    let path = item
        .get("metadata")
        .and_then(|metadata| metadata.get("worktreePath"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.to_path_buf());
    lexical_resolve(path).to_string_lossy().into_owned()
}

fn resolve_scoped_worktree_path(project_root: &Path, current_path: Option<&str>) -> String {
    let root = lexical_resolve(project_root);
    let current = current_path
        .map(lexical_resolve)
        .unwrap_or_else(|| root.clone());
    if current == root || current.starts_with(&root) {
        if let Ok(relative) = current.strip_prefix(&root) {
            let mut components = relative.components();
            if components.next() == Some(std::path::Component::Normal(".aimux".as_ref()))
                && components.next() == Some(std::path::Component::Normal("worktrees".as_ref()))
                && let Some(std::path::Component::Normal(name)) = components.next()
            {
                return root
                    .join(".aimux")
                    .join("worktrees")
                    .join(name)
                    .to_string_lossy()
                    .into_owned();
            }
        }
        return root.to_string_lossy().into_owned();
    }
    current.to_string_lossy().into_owned()
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

fn tmux_target_from_item(item: &Value) -> TmuxTarget {
    let target = item.get("target").unwrap_or(&Value::Null);
    TmuxTarget {
        session_name: target
            .get("sessionName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        window_id: target
            .get("windowId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        window_index: target
            .get("windowIndex")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        window_name: target
            .get("windowName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        pane_dead: target.get("paneDead").and_then(Value::as_bool),
    }
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

fn toned(text: &str, tone: Option<i64>) -> String {
    tone.map_or_else(
        || style(text, Tone::Strong),
        |tone| {
            format!(
                "\x1b[1;{}m{text}{RESET}",
                worktree_color_ansi_for_code(tone)
            )
        },
    )
}

fn worktree_color_ansi_for_code(code: i64) -> String {
    let r = (code >> 16) & 0xff;
    let g = (code >> 8) & 0xff;
    let b = code & 0xff;
    format!("38;2;{r};{g};{b}")
}

fn worktree_color_code_for_path(path: &str) -> i64 {
    worktree_color_code_for_key(
        Some(&format!("path:{}", clean_worktree_color_part(path))),
        "default",
    )
}

fn clean_worktree_color_part(value: &str) -> String {
    let trimmed = value.trim();
    let mut output = String::with_capacity(trimmed.len());
    let mut previous_slash = false;
    for character in trimmed.chars() {
        let next = if character == '\\' { '/' } else { character };
        if next == '/' {
            if previous_slash {
                continue;
            }
            previous_slash = true;
        } else {
            previous_slash = false;
        }
        output.push(next);
    }
    output
}

fn worktree_color_code_for_key(key: Option<&str>, fallback_key: &str) -> i64 {
    let source = format!(
        "aimux-worktree-color-rgb:v7490:{}",
        key.unwrap_or(fallback_key)
    );
    let hash = mix32(stable_string_hash(&source));
    let (r, g, b) = boosted_rgb_from_hash(hash);
    ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

fn stable_string_hash(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn mix32(value: u32) -> u32 {
    let mut hash = value;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

fn boosted_rgb_from_hash(hash: u32) -> (i64, i64, i64) {
    let mut r = 80 + i64::from((hash & 0xff) % 156);
    let mut g = 80 + i64::from(((hash >> 8) & 0xff) % 156);
    let mut b = 80 + i64::from(((hash >> 16) & 0xff) % 156);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max - min < 80 {
        if max == r {
            r = (r + 70).min(255);
        } else if max == g {
            g = (g + 70).min(255);
        } else {
            b = (b + 70).min(255);
        }
        if min == r {
            r = (r - 45).max(65);
        } else if min == g {
            g = (g - 45).max(65);
        } else {
            b = (b - 45).max(65);
        }
    }
    (r, g, b)
}

fn agent_status_kind(metadata: &Value) -> Option<String> {
    agent_status_chip(metadata)
        .and_then(|chip| chip.get("kind").and_then(Value::as_str).map(str::to_owned))
}

fn render_agent_status_pill(metadata: &Value) -> String {
    let Some(chip) = agent_status_chip(metadata) else {
        return String::new();
    };
    let Some(kind) = chip.get("kind").and_then(Value::as_str) else {
        return String::new();
    };
    let Some(label) = chip.get("label").and_then(Value::as_str) else {
        return String::new();
    };
    pill(&label.to_uppercase(), status_tone(kind))
}

fn status_tone(kind: &str) -> Tone {
    match kind {
        "working" => Tone::Work,
        "ready" => Tone::Ready,
        "idle" => Tone::Idle,
        "offline" | "serviceOff" => Tone::Muted,
        "needs" => Tone::Attention,
        "error" => Tone::Danger,
        "done" | "service" => Tone::Done,
        "blocked" => Tone::Blocked,
        _ => Tone::Muted,
    }
}

fn state_border(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "working" => "38;5;38",
        "ready" => "38;5;75",
        "idle" => "38;5;108",
        "offline" => "38;5;244",
        "needs" => "38;5;179",
        "error" => "38;5;174",
        "done" => "38;5;71",
        "blocked" => "38;5;176",
        _ => return None,
    })
}

fn format_relative_recency(value: &str) -> Option<String> {
    let timestamp = parse_recency_timestamp(value)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let delta_seconds = now.saturating_sub(timestamp) / 1000;
    if delta_seconds < 15 {
        return Some("just now".into());
    }
    if delta_seconds < 60 {
        return Some(format!("{delta_seconds}s ago"));
    }
    let minutes = delta_seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h ago"));
    }
    let days = hours / 24;
    if days < 7 {
        return Some(format!("{days}d ago"));
    }
    let weeks = days / 7;
    if weeks < 5 {
        return Some(format!("{weeks}w ago"));
    }
    let months = days / 30;
    if months < 12 {
        return Some(format!("{months}mo ago"));
    }
    Some(format!("{}y ago", days / 365))
}

fn path_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
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
