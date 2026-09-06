use crate::core_cli_routing::{
    CoreHostRestartArgs, parse_core_dashboard_reload_args, parse_core_runtime_restart_args,
};
use crate::core_command_contract::CORE_API_ROUTES;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use super::{CoreCliPlanError, CoreLoopActorContext};

pub(super) fn project_payload(project_root: String) -> Value {
    json!({ "projectRoot": project_root })
}

pub(super) fn project_restart_payload(project_root: String, options: CoreHostRestartArgs) -> Value {
    json!({ "projectRoot": project_root, "serve": options.serve })
}

pub(super) fn dashboard_reload_payload(
    project_root: String,
    args: &[String],
) -> Result<Value, CoreCliPlanError> {
    let parsed = parse_core_dashboard_reload_args(args).ok_or_else(|| {
        CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "error: invalid dashboard-reload arguments",
        }
    })?;
    Ok(dashboard_text_payload(
        project_root,
        parsed.open,
        parsed.client_tty,
        parsed.current_client_session,
    ))
}

pub(super) fn runtime_restart_payload(
    current_project_root: String,
    args: &[String],
    resolve_project_root: impl Fn(&str) -> String,
) -> Result<(Value, bool), CoreCliPlanError> {
    let parsed = parse_core_runtime_restart_args(args).ok_or_else(|| {
        CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "error: invalid restart-runtime arguments",
        }
    })?;
    if parsed.open && parsed.json {
        return Err(CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "Error: restart-runtime --open cannot be combined with --json",
        });
    }
    let project_root = parsed
        .project_root
        .as_deref()
        .map(resolve_project_root)
        .unwrap_or(current_project_root);
    Ok((
        dashboard_text_payload(
            project_root,
            parsed.open,
            parsed.client_tty,
            parsed.current_client_session,
        ),
        parsed.json,
    ))
}

pub(super) fn dashboard_text_payload(
    project_root: String,
    open: bool,
    client_tty: Option<String>,
    current_client_session: Option<String>,
) -> Value {
    let mut payload = serde_json::Map::from_iter([("projectRoot".to_owned(), json!(project_root))]);
    if open {
        payload.insert("open".into(), Value::Bool(true));
    }
    if let Some(client_tty) = client_tty {
        payload.insert("clientTty".into(), Value::String(client_tty));
    }
    if let Some(current_client_session) = current_client_session {
        payload.insert(
            "currentClientSession".into(),
            Value::String(current_client_session),
        );
    }
    Value::Object(payload)
}

pub(super) fn host_agent_read_text_path(
    project: &str,
    session_id: &str,
    start_line: i64,
) -> String {
    format!(
        "{}?project={}&sessionId={}&startLine={}",
        CORE_API_ROUTES.host_agent_read_text,
        encode_query_component(project),
        encode_query_component(session_id),
        start_line
    )
}

pub(super) fn host_agent_stream_text_path(
    project: &str,
    session_id: &str,
    start_line: i64,
    interval_ms: i64,
) -> String {
    format!(
        "{}?project={}&sessionId={}&startLine={}&intervalMs={}",
        CORE_API_ROUTES.host_agent_stream_text,
        encode_query_component(project),
        encode_query_component(session_id),
        start_line,
        interval_ms
    )
}

pub(super) fn agent_ps_text_path(project: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.agent_ps_text,
        encode_query_component(project)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn agent_list_text_path(project: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.agent_list_text,
        encode_query_component(project)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn notification_list_text_path(
    project: &str,
    unread: bool,
    session_id: Option<&str>,
    json: bool,
) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.notification_list_text,
        encode_query_component(project)
    );
    if unread {
        path.push_str("&unread=1");
    }
    if let Some(session_id) = session_id {
        path.push_str("&sessionId=");
        path.push_str(&encode_query_component(session_id));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) struct OutlineListTextPathArgs<'a> {
    pub(super) project: &'a str,
    pub(super) entry_id: Option<&'a str>,
    pub(super) session: Option<&'a str>,
    pub(super) worktree: Option<&'a str>,
    pub(super) status: Option<&'a str>,
    pub(super) search: Option<&'a str>,
    pub(super) limit: Option<&'a str>,
    pub(super) json: bool,
}

pub(super) fn outline_list_text_path(args: OutlineListTextPathArgs<'_>) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.outline_list_text,
        encode_query_component(args.project)
    );
    if let Some(entry_id) = args.entry_id {
        push_text_query(&mut path, "entryId", entry_id);
    }
    if let Some(session) = args.session {
        push_text_query(&mut path, "session", session);
    }
    if let Some(worktree) = args.worktree {
        push_text_query(&mut path, "worktree", worktree);
    }
    if let Some(status) = args.status {
        push_text_query(&mut path, "status", status);
    }
    if let Some(search) = args.search {
        push_text_query(&mut path, "search", search);
    }
    if let Some(limit) = args.limit {
        push_text_query(&mut path, "limit", limit);
    }
    if args.json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

pub(super) fn task_list_text_path(
    project: &str,
    session: Option<&str>,
    status: Option<&str>,
    json: bool,
) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.task_list_text,
        encode_query_component(project)
    );
    if let Some(session) = session {
        path.push_str("&session=");
        path.push_str(&encode_query_component(session));
    }
    if let Some(status) = status {
        path.push_str("&status=");
        path.push_str(&encode_query_component(status));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn task_show_text_path(project: &str, task_id: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}&taskId={}",
        CORE_API_ROUTES.task_show_text,
        encode_query_component(project),
        encode_query_component(task_id)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn thread_list_text_path(project: &str, session: Option<&str>, json: bool) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.thread_list_text,
        encode_query_component(project)
    );
    if let Some(session) = session {
        path.push_str("&session=");
        path.push_str(&encode_query_component(session));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn thread_show_text_path(project: &str, thread_id: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}&threadId={}",
        CORE_API_ROUTES.thread_show_text,
        encode_query_component(project),
        encode_query_component(thread_id)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn project_text_path(base: &str, project: &str, json: bool) -> String {
    let mut path = format!("{base}?project={}", encode_query_component(project));
    if json {
        path.push_str("&json=1");
    }
    path
}

pub(super) fn text_route_path(path: &str, json: bool) -> String {
    if json {
        format!("{path}?json=1")
    } else {
        path.to_owned()
    }
}

pub(super) fn metadata_text_path(project: &str, args: &[String]) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.metadata_text,
        encode_query_component(project)
    );
    for arg in args {
        path.push_str("&arg=");
        path.push_str(&encode_query_component(arg));
    }
    path
}

pub(super) fn resolve_cwd_path(cwd: &str, path: &str) -> String {
    let path = PathBuf::from(path);
    let resolved = if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    };
    normalize_path_syntax(resolved)
        .to_string_lossy()
        .into_owned()
}

fn normalize_path_syntax(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}

pub(super) fn push_text_query(path: &mut String, name: &str, value: &str) {
    if path.contains('?') {
        path.push('&');
    } else {
        path.push('?');
    }
    path.push_str(name);
    path.push('=');
    path.push_str(&encode_query_component(value));
}

pub(super) fn doctor_disk_text_path(
    project: Option<&str>,
    include_active: bool,
    json: bool,
) -> String {
    let mut path = CORE_API_ROUTES.doctor_disk_text.to_owned();
    if let Some(project) = project {
        push_text_query(&mut path, "project", project);
    }
    if include_active {
        push_text_query(&mut path, "includeActive", "1");
    }
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

pub(super) fn doctor_project_text_path(route: &str, project_root: &str, json: bool) -> String {
    let mut path = route.to_owned();
    push_text_query(&mut path, "projectRoot", project_root);
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

pub(super) fn doctor_tmux_text_path(
    project_root: &str,
    session: Option<&str>,
    window_id: Option<&str>,
    json: bool,
) -> String {
    let mut path = CORE_API_ROUTES.doctor_tmux_text.to_owned();
    push_text_query(&mut path, "projectRoot", project_root);
    if let Some(session) = session {
        push_text_query(&mut path, "session", session);
    }
    if let Some(window_id) = window_id {
        push_text_query(&mut path, "windowId", window_id);
    }
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

pub(super) fn loop_actor_payload(
    actor: &CoreLoopActorContext,
    default_source: &str,
) -> serde_json::Map<String, Value> {
    let Some(session_id) = actor.session_id.clone() else {
        return serde_json::Map::from_iter([(
            "source".into(),
            Value::String(default_source.to_owned()),
        )]);
    };
    let source = if actor.overseer { "overseer" } else { "agent" };
    let mut payload = serde_json::Map::from_iter([
        ("source".into(), Value::String(source.into())),
        ("updatedBy".into(), Value::String(session_id.clone())),
        ("updatedBySessionId".into(), Value::String(session_id)),
    ]);
    if actor.overseer {
        payload.insert("updatedByRole".into(), Value::String("overseer".into()));
    } else if let Some(tool) = actor.tool.as_ref() {
        payload.insert("updatedByRole".into(), Value::String(tool.clone()));
    }
    payload
}

pub(super) fn encode_query_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
