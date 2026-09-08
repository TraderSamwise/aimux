use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::atomic_write::write_text_atomic_fast;
use crate::daemon_state::load_metadata_state;
use crate::dashboard_ui_state::DashboardUiStatePersistence;
use crate::paths::basename_like_node_posix;
use crate::project_api_contract::routes;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};
use crate::tmux::refresh_status_argv;

use super::desktop_state::{DesktopStateInput, build_desktop_state};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};

const STATUSLINE_STALE_MS: u128 = 8_000;

pub fn route_statusline_refresh_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST")
        || project_service_pathname(path) != routes::STATUSLINE_REFRESH
    {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let input = StatuslineRefreshInput {
        session_id: trimmed_string(body.get("sessionId")),
        force: body.get("force").and_then(Value::as_bool) == Some(true),
    };
    Some(match refresh_project_statusline(context, input) {
        Ok(()) => ProjectServiceDispatchResponse::json(200, json!({ "ok": true })),
        Err(error) => {
            ProjectServiceDispatchResponse::json(500, json!({ "ok": false, "error": error }))
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatuslineRefreshInput {
    pub session_id: Option<String>,
    pub force: bool,
}

pub fn refresh_project_statusline(
    context: &ProjectServiceRequestContext,
    input: StatuslineRefreshInput,
) -> Result<(), String> {
    refresh_project_statusline_with_tmux_refresh(context, input, refresh_tmux_status)
}

pub fn refresh_project_statusline_with_tmux_refresh(
    context: &ProjectServiceRequestContext,
    input: StatuslineRefreshInput,
    mut refresh_status: impl FnMut(&[String]),
) -> Result<(), String> {
    let project_state_dir = context.project_state_dir();
    if input.force {
        invalidate_tmux_statusline_artifacts(&project_state_dir);
    }
    let snapshot = build_statusline_snapshot(context)?;
    write_statusline_snapshot(&project_state_dir, &snapshot)?;
    write_precomputed_tmux_statusline_files(
        &project_state_dir,
        &context.project_root().to_string_lossy(),
        &snapshot,
        input.session_id.as_deref(),
    )?;
    let argv = refresh_status_argv();
    refresh_status(&argv);
    Ok(())
}

fn refresh_tmux_status(args: &[String]) {
    let _ = Command::new("tmux").args(args).status();
}

pub fn build_statusline_snapshot(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    let project_state_dir = context.project_state_dir();
    let metadata = load_metadata_state(&project_state_dir);
    let desktop_state = if let Some(desktop_state) = context.desktop_state.as_ref() {
        desktop_state.clone()
    } else {
        let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
        let exchange = read_runtime_exchange(runtime_exchange_path(&project_state_dir));
        build_desktop_state(DesktopStateInput {
            project_root: context.project_root().to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata.sessions,
            exchange: &exchange,
        })
    };
    let sessions = statusline_sessions(array_field(&desktop_state, "sessions"), "agent")
        .into_iter()
        .chain(statusline_sessions(
            array_field(&desktop_state, "services"),
            "service",
        ))
        .collect::<Vec<_>>();
    let teammates = statusline_sessions(array_field(&desktop_state, "teammates"), "agent");
    let known_ids = sessions
        .iter()
        .chain(teammates.iter())
        .filter_map(|session| string_field(session, "id").map(str::to_owned))
        .collect::<BTreeSet<_>>();
    let mut snapshot = Map::new();
    snapshot.insert(
        "project".into(),
        Value::String(
            basename_like_node_posix(&context.project_root().to_string_lossy()).to_owned(),
        ),
    );
    snapshot.insert(
        "dashboardScreen".into(),
        Value::String(
            string_field(&desktop_state, "dashboardScreen")
                .unwrap_or("dashboard")
                .to_owned(),
        ),
    );
    snapshot.insert("sessions".into(), Value::Array(sessions));
    snapshot.insert("teammates".into(), Value::Array(teammates));
    snapshot.insert(
        "tasks".into(),
        desktop_state
            .get("tasks")
            .cloned()
            .unwrap_or_else(|| json!({ "pending": 0, "assigned": 0 })),
    );
    snapshot.insert(
        "controlPlane".into(),
        desktop_state
            .get("controlPlane")
            .cloned()
            .unwrap_or_else(|| json!({ "daemonAlive": false, "projectServiceAlive": true })),
    );
    snapshot.insert(
        "flash".into(),
        desktop_state.get("flash").cloned().unwrap_or(Value::Null),
    );
    snapshot.insert(
        "metadata".into(),
        Value::Object(project_statusline_metadata(&metadata.sessions, &known_ids)),
    );
    snapshot.insert("updatedAt".into(), Value::String(now_iso()));
    Ok(Value::Object(snapshot))
}

fn write_statusline_snapshot(
    project_state_dir: impl AsRef<Path>,
    snapshot: &Value,
) -> Result<(), String> {
    let mut text = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
    text.push('\n');
    write_text_atomic_fast(project_state_dir.as_ref().join("statusline.json"), text)
        .map_err(|error| error.to_string())
}

fn write_precomputed_tmux_statusline_files(
    project_state_dir: impl AsRef<Path>,
    project_root: &str,
    snapshot: &Value,
    client_session: Option<&str>,
) -> Result<(), String> {
    let status_dir = tmux_statusline_dir(project_state_dir.as_ref());
    fs::create_dir_all(&status_dir).map_err(|error| error.to_string())?;
    write_statusline_text(
        &status_dir,
        "top-dashboard.txt",
        &render_tmux_statusline(
            snapshot,
            project_root,
            "top",
            RenderOptions {
                current_window: Some("dashboard"),
                current_path: Some(project_root),
                ..RenderOptions::default()
            },
        ),
    )?;
    let dashboard_bottom = render_tmux_statusline(
        snapshot,
        project_root,
        "bottom",
        RenderOptions {
            current_window: Some("dashboard"),
            current_path: Some(project_root),
            ..RenderOptions::default()
        },
    );
    write_statusline_text(&status_dir, "bottom-dashboard.txt", &dashboard_bottom)?;
    if let Some(client_session) = client_session.filter(|value| !value.trim().is_empty()) {
        let client_snapshot = client_dashboard_screen(project_state_dir.as_ref(), client_session)
            .map(|screen| {
                let mut snapshot = snapshot.clone();
                snapshot["dashboardScreen"] = Value::String(screen.to_owned());
                snapshot
            })
            .unwrap_or_else(|| snapshot.clone());
        let client_dashboard_bottom = render_tmux_statusline(
            &client_snapshot,
            project_root,
            "bottom",
            RenderOptions {
                current_window: Some("dashboard"),
                current_path: Some(project_root),
                ..RenderOptions::default()
            },
        );
        write_statusline_text(
            &status_dir,
            &format!("bottom-dashboard-{client_session}.txt"),
            &client_dashboard_bottom,
        )?;
    }
    for entry in array_field(snapshot, "sessions")
        .into_iter()
        .chain(array_field(snapshot, "teammates"))
    {
        let Some(window_id) = string_field(&entry, "tmuxWindowId") else {
            continue;
        };
        let options = RenderOptions {
            current_window: string_field(&entry, "windowName"),
            current_window_id: Some(window_id),
            current_path: string_field(&entry, "worktreePath").or(Some(project_root)),
            ..RenderOptions::default()
        };
        write_statusline_text(
            &status_dir,
            &format!("top-{window_id}.txt"),
            &render_tmux_statusline(snapshot, project_root, "top", options),
        )?;
        write_statusline_text(
            &status_dir,
            &format!("bottom-{window_id}.txt"),
            &render_tmux_statusline(snapshot, project_root, "bottom", options),
        )?;
    }
    Ok(())
}

fn write_statusline_text(status_dir: &Path, name: &str, content: &str) -> Result<(), String> {
    write_text_atomic_fast(status_dir.join(name), format!("{content}\n"))
        .map_err(|error| error.to_string())
}

fn invalidate_tmux_statusline_artifacts(project_state_dir: impl AsRef<Path>) {
    let status_dir = tmux_statusline_dir(project_state_dir);
    let Ok(entries) = fs::read_dir(status_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("top-") || name.starts_with("bottom-") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn tmux_statusline_dir(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("tmux-statusline")
}

fn client_dashboard_screen(project_state_dir: &Path, client_session: &str) -> Option<&'static str> {
    DashboardUiStatePersistence::new(project_state_dir, client_session)
        .ok()
        .and_then(|state| state.load_screen())
        .map(|screen| screen.as_str())
}

fn statusline_sessions(sessions: Vec<Value>, kind: &str) -> Vec<Value> {
    sessions
        .into_iter()
        .filter_map(|session| {
            let id = string_field(&session, "id")?;
            let mut item = Map::new();
            insert_string(&mut item, "id", id);
            insert_string(&mut item, "kind", kind);
            insert_string(
                &mut item,
                "tool",
                string_field(&session, "command")
                    .or_else(|| string_field(&session, "tool"))
                    .unwrap_or(id),
            );
            for key in [
                "label",
                "launchCommandLine",
                "tmuxWindowId",
                "tmuxWindowIndex",
                "headline",
                "status",
                "role",
                "active",
                "worktreePath",
                "semantic",
                "team",
                "overseer",
                "scribe",
            ] {
                insert_value(&mut item, key, session.get(key).cloned());
            }
            insert_string(
                &mut item,
                "windowName",
                string_field(&session, "command")
                    .or_else(|| string_field(&session, "label"))
                    .unwrap_or(id),
            );
            Some(Value::Object(item))
        })
        .collect()
}

fn project_statusline_metadata(
    metadata: &BTreeMap<String, Value>,
    known_ids: &BTreeSet<String>,
) -> Map<String, Value> {
    metadata
        .iter()
        .filter(|(session_id, _)| known_ids.contains(*session_id))
        .map(|(session_id, value)| (session_id.clone(), value.clone()))
        .collect()
}

#[derive(Clone, Copy, Default)]
struct RenderOptions<'a> {
    current_window: Option<&'a str>,
    current_window_id: Option<&'a str>,
    current_path: Option<&'a str>,
    width: Option<i64>,
}

pub fn render_tmux_statusline_contract(input: &Value) -> Value {
    let options = input.get("options").unwrap_or(&Value::Null);
    json!({
        "text": render_tmux_statusline(
            input.get("data").unwrap_or(&Value::Null),
            string_field(input, "projectRoot").unwrap_or_default(),
            string_field(input, "line").unwrap_or("top"),
            RenderOptions {
                current_window: string_field(options, "currentWindow"),
                current_window_id: string_field(options, "currentWindowId"),
                current_path: string_field(options, "currentPath"),
                width: number_field(options, "width"),
            },
        )
    })
}

fn render_tmux_statusline(
    snapshot: &Value,
    project_root: &str,
    line: &str,
    options: RenderOptions<'_>,
) -> String {
    if line == "top" {
        render_top_line(snapshot, project_root, options)
    } else {
        render_bottom_line(snapshot, project_root, options)
    }
}

fn render_top_line(snapshot: &Value, project_root: &str, options: RenderOptions<'_>) -> String {
    let mut segments = vec![
        format!("aimux {}", basename_like_node_posix(project_root)),
        render_control_plane(snapshot),
    ];
    if let Some(context) = render_active_context(snapshot, project_root, options) {
        segments.push(context);
    }
    if let Some(tasks) = render_tasks(snapshot) {
        segments.push(tasks);
    }
    if let Some(metadata) = render_active_metadata(snapshot, project_root, options) {
        segments.push(metadata);
    }
    segments.extend(render_plugin_segments(
        snapshot,
        project_root,
        "top",
        options,
    ));
    let joined = segments.join("  \u{00b7}  ");
    match options.width {
        Some(width) => trim_text(&joined, width.saturating_sub(2).max(24) as usize),
        None => joined,
    }
}

fn render_bottom_line(snapshot: &Value, project_root: &str, options: RenderOptions<'_>) -> String {
    let max_width = options
        .width
        .map(|width| width.saturating_sub(2).max(24))
        .unwrap_or(i64::MAX);
    if options
        .current_window
        .is_some_and(|window| window.starts_with("dashboard"))
    {
        return choose_statusline_segments(
            render_dashboard_screens(string_field(snapshot, "dashboardScreen")),
            "  \u{00b7}  ",
            max_width,
        )
        .join("  \u{00b7}  ");
    }
    let focused_teammate = resolve_focused_teammate(snapshot, project_root, options);
    let focused_overseer = focused_teammate
        .is_none()
        .then(|| resolve_focused_control_session(snapshot, project_root, options, "overseer"))
        .flatten();
    let focused_scribe = (focused_teammate.is_none() && focused_overseer.is_none())
        .then(|| resolve_focused_control_session(snapshot, project_root, options, "scribe"))
        .flatten();

    let chips = if let Some(overseer) = focused_overseer {
        vec![render_control_session_segment(overseer, "overseer")]
    } else if let Some(scribe) = focused_scribe {
        vec![render_control_session_segment(scribe, "scribe")]
    } else if focused_teammate.is_some() {
        resolve_focused_teammate_group(snapshot, project_root, options)
            .into_iter()
            .map(|session| {
                render_teammate_chip(
                    session,
                    string_field(session, "id")
                        == focused_teammate.and_then(|session| string_field(session, "id")),
                )
            })
            .collect::<Vec<_>>()
    } else {
        resolve_scoped_sessions(snapshot, project_root, options)
            .into_iter()
            .map(|(session, is_current)| render_session_chip(session, is_current))
            .collect::<Vec<_>>()
    };

    let mut detail_parts = Vec::new();
    if let Some(headline) = render_exact_headline(snapshot, project_root, options) {
        detail_parts.push(headline);
    }
    if focused_teammate.is_some() {
        detail_parts.push(tmux_style("team plane", "cyan"));
    } else if let Some(teammates) = render_teammate_segment(snapshot, project_root, options) {
        detail_parts.push(teammates);
    }
    detail_parts.extend(render_plugin_segments(
        snapshot,
        project_root,
        "bottom",
        options,
    ));
    let chosen_chips = choose_statusline_segments(chips, "  \u{00b7}  ", max_width);
    let chip_text = chosen_chips.join("  \u{00b7}  ");
    let detail = detail_parts.join("  \u{00b7}  ");
    if detail.is_empty() {
        chip_text
    } else if chip_text.is_empty() {
        detail
    } else if visible_segment_length(&chip_text)
        + visible_segment_length("  |  ")
        + visible_segment_length(&detail)
        <= max_width
    {
        format!("{chip_text}  |  {detail}")
    } else {
        chip_text
    }
}

fn choose_statusline_segments(
    segments: Vec<String>,
    separator: &str,
    max_width: i64,
) -> Vec<String> {
    if max_width == i64::MAX {
        return segments;
    }
    let mut chosen = Vec::new();
    let mut used = 0_i64;
    for segment in segments {
        let next = visible_segment_length(&segment)
            + if chosen.is_empty() {
                0
            } else {
                visible_segment_length(separator)
            };
        if used + next > max_width {
            break;
        }
        used += next;
        chosen.push(segment);
    }
    chosen
}

fn visible_segment_length(segment: &str) -> i64 {
    let mut output = 0_i64;
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '#' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for inner in chars.by_ref() {
                if inner == ']' {
                    break;
                }
            }
            continue;
        }
        output += 1;
    }
    output
}

fn render_control_plane(snapshot: &Value) -> String {
    if is_statusline_stale(snapshot) {
        return "ctl stale".to_owned();
    }
    let control = snapshot.get("controlPlane").and_then(Value::as_object);
    if control
        .and_then(|control| control.get("projectServiceAlive"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        "ctl svc\u{2193}".to_owned()
    } else if control
        .and_then(|control| control.get("daemonAlive"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        "ctl daemon\u{2193}".to_owned()
    } else {
        "ctl ok".to_owned()
    }
}

fn render_dashboard_screens(active_screen: Option<&str>) -> Vec<String> {
    let active = active_screen.unwrap_or("dashboard");
    [
        ("dashboard", "Dashboard", "d"),
        ("coordination", "Coordination", "c"),
        ("project", "Project", "p"),
        ("library", "Library", "l"),
        ("topology", "Topology", "t"),
        ("graveyard", "Graveyard", "g"),
    ]
    .into_iter()
    .map(|(key, label, hotkey)| {
        if key == active {
            format!("#[fg=black,bg=yellow] {label} #[default]")
        } else {
            render_dashboard_screen_hotkey(label, hotkey)
        }
    })
    .collect()
}

fn render_tasks(snapshot: &Value) -> Option<String> {
    let tasks = snapshot.get("tasks")?;
    let pending = number_field(tasks, "pending").unwrap_or_default();
    let assigned = number_field(tasks, "assigned").unwrap_or_default();
    (pending != 0 || assigned != 0).then(|| format!("tasks {pending}/{assigned}"))
}

fn render_active_context(
    snapshot: &Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<String> {
    if options
        .current_window
        .is_some_and(|window| window.starts_with("dashboard"))
    {
        return None;
    }
    let session_id = resolve_exact_current_session_id(snapshot, project_root, options)?;
    let metadata = snapshot
        .get("metadata")
        .and_then(|metadata| metadata.get(session_id))
        .unwrap_or(&Value::Null);
    let context = metadata.get("context").and_then(Value::as_object);
    let worktree = options
        .current_path
        .map(basename_like_node_posix)
        .or_else(|| context.and_then(|context| string_field_value(context.get("worktreeName"))))
        .map(|value| trim_text(value, 16));
    let branch = context.and_then(|context| {
        string_field_value(context.get("branch")).map(|value| trim_text(value, 18))
    });
    let pr = context
        .and_then(|context| context.get("pr"))
        .and_then(render_pr_context);
    let service = metadata
        .get("derived")
        .and_then(|derived| derived.get("services"))
        .and_then(Value::as_array)
        .and_then(|services| services.first())
        .and_then(render_service_context);
    let parts = if let (Some(worktree), Some(branch)) = (worktree.clone(), branch.clone()) {
        let mut parts = vec![format!("{worktree}@{branch}")];
        parts.extend([pr, service].into_iter().flatten());
        parts
    } else {
        [worktree, branch, pr, service]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    };
    (!parts.is_empty()).then(|| parts.join("  \u{00b7}  "))
}

fn render_active_metadata(
    snapshot: &Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<String> {
    let session_id = resolve_exact_current_session_id(snapshot, project_root, options)?;
    let active_session = find_statusline_session(snapshot, session_id);
    let metadata = snapshot.get("metadata")?.get(session_id)?;
    if let Some(label) = active_session
        .and_then(|session| session.get("semantic"))
        .and_then(|semantic| semantic.get("presentation"))
        .and_then(|presentation| string_field(presentation, "statusLabel"))
        .filter(|label| *label != "idle" && *label != "offline")
    {
        return Some(label.to_owned());
    }
    if let Some(unread_count) = active_session
        .and_then(|session| session.get("semantic"))
        .and_then(|semantic| semantic.get("notifications"))
        .and_then(|notifications| number_field(notifications, "unreadCount"))
        .filter(|count| *count > 0)
    {
        return Some(format!("{unread_count} unread"));
    }
    if let Some(new_count) = active_session
        .and_then(|session| session.get("semantic"))
        .and_then(|semantic| number_field(semantic, "activityNewCount"))
        .filter(|count| *count > 0)
    {
        return Some(format!("new {new_count}"));
    }
    if let Some(status) = metadata
        .get("status")
        .and_then(|status| string_field(status, "text"))
    {
        return Some(trim_text(status, 28));
    }
    if let Some(progress) = metadata.get("progress")
        && let (Some(current), Some(total)) = (
            number_field(progress, "current"),
            number_field(progress, "total"),
        )
        && total > 0
    {
        let label = string_field(progress, "label").unwrap_or("plan");
        let pct = ((current as f64 / total as f64) * 100.0)
            .round()
            .clamp(0.0, 100.0) as i64;
        return Some(trim_text(&format!("{label} {current}/{total} {pct}%"), 28));
    }
    metadata
        .get("logs")
        .and_then(Value::as_array)
        .and_then(|logs| logs.last())
        .and_then(|log| string_field(log, "message"))
        .map(|message| trim_text(message, 28))
}

fn render_plugin_segments(
    snapshot: &Value,
    project_root: &str,
    line: &str,
    options: RenderOptions<'_>,
) -> Vec<String> {
    let Some(session_id) = resolve_exact_current_session_id(snapshot, project_root, options) else {
        return Vec::new();
    };
    snapshot
        .get("metadata")
        .and_then(|metadata| metadata.get(session_id))
        .and_then(|metadata| metadata.get("statusline"))
        .and_then(|statusline| statusline.get(line))
        .and_then(Value::as_array)
        .map(|segments| segments.iter().filter_map(render_plugin_segment).collect())
        .unwrap_or_default()
}

fn render_plugin_segment(segment: &Value) -> Option<String> {
    let text = trim_text(string_field(segment, "text")?, 18);
    Some(
        match string_field(segment, "tone").and_then(segment_tone_color) {
            Some(color) => tmux_style(&text, color),
            None => text,
        },
    )
}

fn segment_tone_color(tone: &str) -> Option<&'static str> {
    match tone {
        "info" => Some("cyan"),
        "success" => Some("green"),
        "warn" => Some("yellow"),
        "error" => Some("red"),
        _ => None,
    }
}

fn render_dashboard_screen_hotkey(label: &str, hotkey: &str) -> String {
    let lower = label.to_ascii_lowercase();
    let Some(index) = lower.find(&hotkey.to_ascii_lowercase()) else {
        return label.to_owned();
    };
    let end = index + hotkey.len();
    format!(
        "{}#[fg=yellow,bold]{}#[default]{}",
        &label[..index],
        &label[index..end],
        &label[end..]
    )
}

fn render_service_context(service: &Value) -> Option<String> {
    if let Some(port) = number_field(service, "port") {
        return Some(format!(":{port}"));
    }
    string_field(service, "url")
        .map(strip_http_scheme)
        .map(|url| trim_text(url, 18))
}

fn render_pr_context(pr: &Value) -> Option<String> {
    let number = pr.get("number").and_then(Value::as_i64)?;
    let label = format!("PR #{number}");
    if pr
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.trim().is_empty())
    {
        Some(render_status_range("pr", &label))
    } else {
        Some(label)
    }
}

fn render_status_range(range: &str, label: &str) -> String {
    format!("#[range=user|{range}]{label}#[norange]")
}

fn resolve_scoped_sessions<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Vec<(&'a Value, bool)> {
    let scoped_path = resolve_scoped_worktree_path(snapshot, project_root, options.current_path);
    let mut agents = Vec::new();
    let mut services = Vec::new();
    for session in statusline_session_group(snapshot, "sessions")
        .into_iter()
        .filter(|session| is_live_footer_session(session))
        .filter(|session| !is_project_control_session(session))
        .filter(|session| {
            normalize_path(string_field(session, "worktreePath"), project_root) == scoped_path
        })
    {
        if string_field(session, "kind") == Some("service") {
            services.push(session);
        } else {
            agents.push(session);
        }
    }
    agents
        .into_iter()
        .chain(services)
        .take(5)
        .map(|session| {
            let is_current = options
                .current_window_id
                .map(|window_id| string_field(session, "tmuxWindowId") == Some(window_id))
                .unwrap_or_else(|| session.get("active").and_then(Value::as_bool) == Some(true));
            (session, is_current)
        })
        .collect()
}

fn resolve_focused_teammate<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<&'a Value> {
    let exact_id = resolve_exact_current_session_id(snapshot, project_root, options)?;
    statusline_session_group(snapshot, "teammates")
        .into_iter()
        .find(|session| {
            string_field(session, "id") == Some(exact_id) && is_live_footer_session(session)
        })
}

fn resolve_focused_teammate_group<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Vec<&'a Value> {
    let Some(focused) = resolve_focused_teammate(snapshot, project_root, options) else {
        return Vec::new();
    };
    let Some(parent_session_id) = string_field_from_path(focused, &["team", "parentSessionId"])
    else {
        return Vec::new();
    };
    let mut teammates = statusline_session_group(snapshot, "teammates")
        .into_iter()
        .filter(|session| {
            string_field_from_path(session, &["team", "parentSessionId"]) == Some(parent_session_id)
        })
        .filter(|session| is_live_footer_session(session))
        .collect::<Vec<_>>();
    teammates.sort_by(compare_teammate_sessions);
    teammates.truncate(5);
    teammates
}

fn resolve_current_teammates<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Vec<&'a Value> {
    let Some(parent_session_id) = resolve_exact_current_session_id(snapshot, project_root, options)
    else {
        return Vec::new();
    };
    let Some(parent_session) = statusline_session_group(snapshot, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id") == Some(parent_session_id))
    else {
        return Vec::new();
    };
    if string_field_from_path(parent_session, &["team", "parentSessionId"]).is_some() {
        return Vec::new();
    }
    let mut teammates = statusline_session_group(snapshot, "teammates")
        .into_iter()
        .filter(|session| {
            string_field_from_path(session, &["team", "parentSessionId"]) == Some(parent_session_id)
        })
        .filter(|session| is_live_footer_session(session))
        .collect::<Vec<_>>();
    teammates.sort_by(compare_teammate_sessions);
    teammates.truncate(5);
    teammates
}

fn resolve_focused_control_session<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
    control_kind: &str,
) -> Option<&'a Value> {
    let exact_id = resolve_exact_current_session_id(snapshot, project_root, options)?;
    statusline_session_group(snapshot, "sessions")
        .into_iter()
        .find(|session| {
            string_field(session, "id") == Some(exact_id)
                && is_control_session_kind(session, control_kind)
                && is_live_footer_session(session)
        })
}

fn render_session_chip(session: &Value, is_current: bool) -> String {
    let identity = trim_text(&compact_session_title(session), 18);
    let hint = render_session_compact_hint(session);
    let badge = if hint
        .as_deref()
        .is_some_and(|hint| hint.contains(" unread") || hint.contains(" new"))
    {
        None
    } else {
        render_semantic_badge(session.get("semantic"))
    };
    let label = trim_text(
        &[Some(identity), hint, badge]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" "),
        28,
    );
    if is_current {
        tmux_invert(&format!(" {label} "), "yellow")
    } else {
        label
    }
}

fn render_teammate_chip(session: &Value, is_current: bool) -> String {
    let identity = trim_text(&teammate_label(session), 18);
    let hint = render_session_compact_hint(session);
    let badge = if hint
        .as_deref()
        .is_some_and(|hint| hint.contains(" unread") || hint.contains(" new"))
    {
        None
    } else {
        render_semantic_badge(session.get("semantic"))
    };
    let label = trim_text(
        &[Some(identity), hint, badge]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" "),
        28,
    );
    if is_current {
        tmux_invert(&format!(" {label} "), "cyan")
    } else {
        tmux_style(&label, "cyan")
    }
}

fn render_teammate_segment(
    snapshot: &Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<String> {
    let teammates = resolve_current_teammates(snapshot, project_root, options);
    if teammates.is_empty() {
        return None;
    }
    let labels = teammates
        .iter()
        .take(3)
        .map(|teammate| {
            let identity = teammate_label(teammate);
            let hint = render_session_compact_hint(teammate)
                .or_else(|| semantic_status_label(teammate))
                .or_else(|| string_field(teammate, "status").map(str::to_owned));
            trim_text(
                &[Some(identity), hint]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" "),
                24,
            )
        })
        .collect::<Vec<_>>();
    let more = if teammates.len() > labels.len() {
        format!(" +{}", teammates.len() - labels.len())
    } else {
        String::new()
    };
    Some(format!("team: {}{more}", labels.join(", ")))
}

fn render_control_session_segment(session: &Value, label: &str) -> String {
    let hint = render_session_compact_hint(session)
        .or_else(|| semantic_status_label(session))
        .or_else(|| string_field(session, "status").map(str::to_owned));
    let detail = trim_text(
        &[Some(compact_session_title(session)), hint]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" "),
        28,
    );
    if detail.is_empty() {
        tmux_style(label, "cyan")
    } else {
        format!("{}  {detail}", tmux_style(label, "cyan"))
    }
}

fn render_exact_headline(
    snapshot: &Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<String> {
    let session_id = resolve_exact_current_session_id(snapshot, project_root, options)?;
    find_statusline_session(snapshot, session_id)
        .and_then(|session| string_field(session, "headline"))
        .map(str::trim)
        .filter(|headline| !headline.is_empty())
        .map(|headline| trim_text(headline, 42))
}

fn find_statusline_session<'a>(snapshot: &'a Value, session_id: &str) -> Option<&'a Value> {
    all_statusline_sessions(snapshot)
        .into_iter()
        .find(|session| string_field(session, "id") == Some(session_id))
}

fn resolve_exact_current_session_id<'a>(
    snapshot: &'a Value,
    project_root: &str,
    options: RenderOptions<'_>,
) -> Option<&'a str> {
    if let Some(window_id) = options.current_window_id {
        return all_statusline_sessions(snapshot)
            .into_iter()
            .find(|session| string_field(session, "tmuxWindowId") == Some(window_id))
            .and_then(|session| string_field(session, "id"));
    }
    let current_window = options.current_window?;
    let scoped_path = resolve_scoped_worktree_path(snapshot, project_root, options.current_path);
    let mut visible_matches = statusline_session_group(snapshot, "sessions")
        .into_iter()
        .filter(|session| {
            session_matches_scoped_window(session, &scoped_path, current_window, project_root)
        })
        .collect::<Vec<_>>();
    if visible_matches.len() == 1 {
        return visible_matches
            .pop()
            .and_then(|session| string_field(session, "id"));
    }
    if visible_matches.len() > 1 {
        return None;
    }
    let mut teammate_matches = statusline_session_group(snapshot, "teammates")
        .into_iter()
        .filter(|session| {
            session_matches_scoped_window(session, &scoped_path, current_window, project_root)
        })
        .collect::<Vec<_>>();
    (teammate_matches.len() == 1)
        .then(|| teammate_matches.remove(0))
        .and_then(|session| string_field(session, "id"))
}

fn resolve_scoped_worktree_path(
    snapshot: &Value,
    project_root: &str,
    current_path: Option<&str>,
) -> String {
    let normalized_current = normalize_path(current_path, project_root);
    all_statusline_sessions(snapshot)
        .into_iter()
        .map(|session| normalize_path(string_field(session, "worktreePath"), project_root))
        .filter(|path| {
            normalized_current == *path || normalized_current.starts_with(&format!("{path}/"))
        })
        .max_by_key(String::len)
        .unwrap_or(normalized_current)
}

fn all_statusline_sessions(snapshot: &Value) -> Vec<&Value> {
    let mut sessions = Vec::new();
    if let Some(entries) = snapshot.get("sessions").and_then(Value::as_array) {
        sessions.extend(entries);
    }
    if let Some(entries) = snapshot.get("teammates").and_then(Value::as_array) {
        sessions.extend(entries);
    }
    sessions
}

fn statusline_session_group<'a>(snapshot: &'a Value, key: &str) -> Vec<&'a Value> {
    snapshot
        .get(key)
        .and_then(Value::as_array)
        .map(|entries| entries.iter().collect())
        .unwrap_or_default()
}

fn session_matches_scoped_window(
    session: &Value,
    scoped_path: &str,
    current_window: &str,
    project_root: &str,
) -> bool {
    normalize_path(string_field(session, "worktreePath"), project_root) == scoped_path
        && (string_field(session, "windowName") == Some(current_window)
            || string_field(session, "label") == Some(current_window)
            || string_field(session, "tool") == Some(current_window))
}

fn compact_session_title(session: &Value) -> String {
    if string_field(session, "kind") == Some("service")
        && let Some(command) =
            string_field(session, "launchCommandLine").filter(|value| !value.trim().is_empty())
    {
        return command.to_owned();
    }
    let is_service = string_field(session, "kind") == Some("service");
    let tool = string_field(session, "tool").unwrap_or_else(|| {
        if is_service {
            "service"
        } else {
            string_field(session, "id").unwrap_or("session")
        }
    });
    let label = if is_service {
        string_field(session, "label")
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .unwrap_or(tool)
    } else {
        string_field(session, "label")
            .filter(|label| !is_autogenerated_label(label, tool))
            .unwrap_or(tool)
    };
    if is_service {
        return format!("{label}[svc]");
    }
    if let Some(role) = string_field(session, "role") {
        format!("{label}({role})")
    } else {
        label.to_owned()
    }
}

fn is_project_control_session(session: &Value) -> bool {
    session.get("projectControl").and_then(Value::as_bool) == Some(true)
        || is_control_session_kind(session, "overseer")
        || is_control_session_kind(session, "scribe")
}

fn is_control_session_kind(session: &Value, control_kind: &str) -> bool {
    let flag = match control_kind {
        "overseer" => "overseer",
        "scribe" => "scribe",
        _ => return false,
    };
    session.get("overseer").and_then(Value::as_bool) == Some(true) && control_kind == "overseer"
        || session.get("scribe").and_then(Value::as_bool) == Some(true) && control_kind == "scribe"
        || string_field(session, "role") == Some(control_kind)
        || string_field_from_path(session, &["team", "role"]) == Some(control_kind)
        || session.get(flag).and_then(Value::as_bool) == Some(true)
}

fn is_live_footer_session(session: &Value) -> bool {
    !matches!(string_field(session, "status"), Some("offline" | "exited"))
}

fn teammate_label(session: &Value) -> String {
    string_field_from_path(session, &["team", "label"])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            string_field(session, "label")
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            string_field_from_path(session, &["team", "role"])
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_owned)
        .unwrap_or_else(|| compact_session_title(session))
}

fn render_session_compact_hint(session: &Value) -> Option<String> {
    session
        .get("semantic")
        .and_then(|semantic| semantic.get("presentation"))
        .and_then(|presentation| string_field(presentation, "compactHint"))
        .map(str::to_owned)
}

fn semantic_status_label(session: &Value) -> Option<String> {
    session
        .get("semantic")
        .and_then(|semantic| semantic.get("presentation"))
        .and_then(|presentation| string_field(presentation, "statusLabel"))
        .map(str::to_owned)
}

fn render_semantic_badge(semantic: Option<&Value>) -> Option<String> {
    let semantic = semantic?;
    let attention = semantic
        .get("user")
        .and_then(|user| string_field(user, "attention"));
    match attention {
        Some("error") => return Some("\u{2717}".to_owned()),
        Some("needs_input" | "needs_response") => return Some("?".to_owned()),
        Some("blocked") => return Some("!".to_owned()),
        _ => {}
    }
    let label = semantic
        .get("user")
        .and_then(|user| string_field(user, "label"));
    match label {
        Some("done") => Some("\u{2713}".to_owned()),
        Some("working") => Some("\u{21bb}".to_owned()),
        Some("starting") => Some("\u{2026}".to_owned()),
        _ => None,
    }
}

fn compare_teammate_sessions(left: &&Value, right: &&Value) -> std::cmp::Ordering {
    teammate_order(left)
        .cmp(&teammate_order(right))
        .then_with(|| teammate_created_at(left).cmp(teammate_created_at(right)))
        .then_with(|| {
            string_field(left, "id")
                .unwrap_or("")
                .cmp(string_field(right, "id").unwrap_or(""))
        })
}

fn teammate_order(session: &Value) -> u64 {
    session
        .get("team")
        .and_then(|team| team.get("order"))
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX)
}

fn teammate_created_at(session: &Value) -> &str {
    string_field(session, "createdAt").unwrap_or("\u{10ffff}")
}

fn is_autogenerated_label(label: &str, tool: &str) -> bool {
    let label = label.trim().to_ascii_lowercase();
    let tool = tool.trim().to_ascii_lowercase();
    label.is_empty() || tool.is_empty() || label == tool || label.starts_with(&format!("{tool}-"))
}

fn normalize_path(path: Option<&str>, project_root: &str) -> String {
    path.map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or(project_root)
        .to_owned()
}

fn trim_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    if max <= 1 {
        return text.chars().take(max).collect();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "\u{2026}"
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string_field_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn string_field_from_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn strip_http_scheme(value: &str) -> &str {
    value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or(value)
}

fn tmux_style(text: &str, color: &str) -> String {
    format!("#[fg={color}]{text}#[default]")
}

fn tmux_invert(text: &str, color: &str) -> String {
    format!("#[fg=black,bg={color}]{text}#[default]")
}

fn is_statusline_stale(snapshot: &Value) -> bool {
    let Some(updated_at) = string_field(snapshot, "updatedAt").and_then(parse_iso_millis) else {
        return true;
    };
    now_epoch_millis().saturating_sub(updated_at) > STATUSLINE_STALE_MS
}

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis_text) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some()
        || hour > 23
        || minute > 59
        || second > 59
        || millis_text.len() > 3
    {
        return None;
    }
    let mut millis = millis_text.parse::<u128>().ok()?;
    for _ in 0..(3 - millis_text.len()) {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.to_owned(), value);
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn control_plane_marks_old_or_invalid_snapshots_stale() {
        assert_eq!(
            render_control_plane(&json!({ "updatedAt": "2026-01-01T00:00:00.000Z" })),
            "ctl stale"
        );
        assert_eq!(
            render_control_plane(&json!({ "updatedAt": "bad-date" })),
            "ctl stale"
        );
    }

    #[test]
    fn control_plane_keeps_fresh_snapshots_ok() {
        assert_eq!(
            render_control_plane(&json!({
                "updatedAt": now_iso(),
                "controlPlane": { "daemonAlive": true, "projectServiceAlive": true }
            })),
            "ctl ok"
        );
    }

    #[test]
    fn name_only_exact_resolution_prefers_visible_sessions_before_teammates() {
        let snapshot = json!({
            "sessions": [
                {
                    "id": "parent",
                    "tool": "claude",
                    "windowName": "claude",
                    "worktreePath": "/repo",
                    "status": "running"
                }
            ],
            "teammates": [
                {
                    "id": "reviewer",
                    "tool": "claude",
                    "windowName": "claude",
                    "worktreePath": "/repo",
                    "status": "running"
                }
            ]
        });
        assert_eq!(
            resolve_exact_current_session_id(
                &snapshot,
                "/repo",
                RenderOptions {
                    current_window: Some("claude"),
                    current_path: Some("/repo"),
                    ..RenderOptions::default()
                }
            ),
            Some("parent")
        );
    }

    #[test]
    fn bottom_line_renders_scoped_agents_semantics_and_headline() {
        let snapshot = json!({
            "sessions": [
                {
                    "id": "a",
                    "kind": "agent",
                    "tool": "codex",
                    "label": "coder",
                    "windowName": "coder",
                    "tmuxWindowId": "@1",
                    "role": "coder",
                    "status": "running",
                    "active": true,
                    "headline": "Fix auth flow",
                    "worktreePath": "/repo",
                    "semantic": semantic("running", "needs_input", "on you", 0)
                },
                {
                    "id": "b",
                    "kind": "agent",
                    "tool": "claude",
                    "status": "idle",
                    "windowName": "claude",
                    "worktreePath": "/repo",
                    "semantic": semantic("done", "none", Value::Null, 0)
                }
            ],
            "metadata": {
                "a": { "derived": { "attention": "needs_input", "unseenCount": 3 } },
                "b": { "derived": { "activity": "done" } }
            }
        });

        let rendered = render_bottom_line(
            &snapshot,
            "/repo",
            RenderOptions {
                current_window: Some("coder"),
                current_window_id: Some("@1"),
                current_path: Some("/repo"),
                ..RenderOptions::default()
            },
        );

        assert!(rendered.contains("#[fg=black,bg=yellow] coder(coder) on you ? #[default]"));
        assert!(rendered.contains("claude \u{2713}"));
        assert!(rendered.contains("  |  Fix auth flow"));
    }

    #[test]
    fn bottom_line_keeps_parent_teammates_as_detail_segment() {
        let snapshot = json!({
            "sessions": [
                {
                    "id": "parent",
                    "kind": "agent",
                    "tool": "claude",
                    "role": "coder",
                    "windowName": "claude",
                    "tmuxWindowId": "@1",
                    "worktreePath": "/repo",
                    "status": "running"
                },
                {
                    "id": "service",
                    "kind": "service",
                    "tool": "shell",
                    "windowName": "shell",
                    "tmuxWindowId": "@2",
                    "worktreePath": "/repo",
                    "status": "running"
                }
            ],
            "teammates": [
                {
                    "id": "reviewer",
                    "kind": "agent",
                    "tool": "codex",
                    "role": "reviewer",
                    "label": "review",
                    "windowName": "codex",
                    "tmuxWindowId": "@9",
                    "worktreePath": "/repo",
                    "status": "running",
                    "team": { "teamId": "team-1", "parentSessionId": "parent", "role": "reviewer", "label": "review", "order": 1 }
                },
                {
                    "id": "other",
                    "kind": "agent",
                    "tool": "claude",
                    "windowName": "claude",
                    "tmuxWindowId": "@10",
                    "worktreePath": "/repo",
                    "status": "running",
                    "team": { "teamId": "team-2", "parentSessionId": "other-parent", "role": "coder", "label": "other" }
                }
            ]
        });

        let rendered = render_bottom_line(
            &snapshot,
            "/repo",
            RenderOptions {
                current_window: Some("claude"),
                current_window_id: Some("@1"),
                current_path: Some("/repo"),
                ..RenderOptions::default()
            },
        );

        assert!(rendered.contains("#[fg=black,bg=yellow] claude(coder) #[default]"));
        assert!(rendered.contains("shell[svc]"));
        assert!(rendered.contains("team: review running"));
        assert!(!rendered.contains("other"));
        assert!(rendered.find("claude(coder)").unwrap() < rendered.find("shell[svc]").unwrap());
        assert!(rendered.find("shell[svc]").unwrap() < rendered.find("team:").unwrap());
    }

    #[test]
    fn bottom_line_renders_focused_teammate_plane() {
        let snapshot = json!({
            "sessions": [
                {
                    "id": "parent",
                    "kind": "agent",
                    "tool": "claude",
                    "role": "coder",
                    "windowName": "claude",
                    "tmuxWindowId": "@1",
                    "worktreePath": "/repo",
                    "status": "running"
                },
                {
                    "id": "service",
                    "kind": "service",
                    "tool": "shell",
                    "windowName": "shell",
                    "tmuxWindowId": "@2",
                    "worktreePath": "/repo",
                    "status": "running"
                }
            ],
            "teammates": [
                {
                    "id": "reviewer",
                    "kind": "agent",
                    "tool": "codex",
                    "role": "reviewer",
                    "label": "review",
                    "windowName": "codex",
                    "tmuxWindowId": "@9",
                    "worktreePath": "/repo",
                    "status": "running",
                    "headline": "Review the parser patch",
                    "semantic": semantic("running", "needs_input", "on you", 0),
                    "team": { "teamId": "team-1", "parentSessionId": "parent", "role": "reviewer", "label": "review", "order": 1 }
                },
                {
                    "id": "implementer",
                    "kind": "agent",
                    "tool": "codex",
                    "role": "implementer",
                    "label": "impl",
                    "windowName": "codex",
                    "tmuxWindowId": "@11",
                    "worktreePath": "/repo",
                    "status": "running",
                    "semantic": semantic("idle", "none", "4 new", 4),
                    "team": { "teamId": "team-1", "parentSessionId": "parent", "role": "implementer", "label": "impl", "order": 2 }
                },
                {
                    "id": "other",
                    "kind": "agent",
                    "tool": "claude",
                    "windowName": "claude",
                    "tmuxWindowId": "@10",
                    "worktreePath": "/repo",
                    "status": "running",
                    "team": { "teamId": "team-2", "parentSessionId": "other-parent", "role": "coder", "label": "other" }
                }
            ],
            "metadata": {
                "reviewer": {
                    "statusline": { "bottom": [{ "id": "bottom", "text": "review-bottom" }] }
                }
            }
        });

        let rendered = render_bottom_line(
            &snapshot,
            "/repo",
            RenderOptions {
                current_window: Some("codex"),
                current_window_id: Some("@9"),
                current_path: Some("/repo"),
                ..RenderOptions::default()
            },
        );

        assert!(rendered.contains("#[fg=black,bg=cyan] review on you ? #[default]"));
        assert!(rendered.contains("#[fg=cyan]impl 4 new#[default]"));
        assert!(!rendered.contains("shell[svc]"));
        assert!(rendered.contains("Review the parser patch"));
        assert!(rendered.contains("review-bottom"));
        assert!(rendered.contains("team plane"));
        assert!(!rendered.contains("other"));
    }

    fn semantic(
        status_label: &str,
        attention: &str,
        compact_hint: impl Into<Value>,
        activity_new_count: i64,
    ) -> Value {
        json!({
            "runtime": {
                "lifecycle": "running",
                "isAlive": true,
                "canEnter": true,
                "canReceiveInput": true,
                "canInterrupt": true
            },
            "user": {
                "label": status_label,
                "attention": attention,
                "source": "runtime"
            },
            "notifications": { "unreadCount": 0 },
            "orchestration": {
                "pressure": "none",
                "assignedTask": false,
                "canBeAssignedWork": true
            },
            "presentation": {
                "statusLabel": status_label,
                "compactHint": compact_hint.into(),
                "attentionScore": 0
            },
            "attention": attention,
            "activityNewCount": activity_new_count,
            "threadUnreadCount": 0,
            "pendingDeliveryCount": 0,
            "waitingOnMeCount": 0,
            "waitingOnThemCount": 0,
            "blockedCount": 0,
            "familyCount": 0,
            "hasActiveTask": false
        })
    }
}
