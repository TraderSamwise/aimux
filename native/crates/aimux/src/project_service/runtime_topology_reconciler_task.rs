use serde_json::{Map, Value, json};
use std::path::Path;

use crate::runtime_topology::{runtime_topology_path, update_runtime_topology};
use crate::runtime_topology_sessions::reconcile_runtime_topology_sessions;
use crate::tmux::{TmuxManagedWindow, TmuxRuntimeManager};

use super::scheduler::PeriodicTask;

const DEFAULT_INTERVAL_MS: i64 = 2_000;
const QUICK_UNPRESERVED_EXIT_MS: i128 = 10_000;

pub trait RuntimeTopologySessionReconcileDeps {
    fn list_project_managed_windows(&mut self, project_root: &Path) -> Vec<TmuxManagedWindow>;
    fn now_iso(&mut self) -> String;
}

pub struct SystemRuntimeTopologySessionReconcileDeps;

impl RuntimeTopologySessionReconcileDeps for SystemRuntimeTopologySessionReconcileDeps {
    fn list_project_managed_windows(&mut self, project_root: &Path) -> Vec<TmuxManagedWindow> {
        TmuxRuntimeManager::new().list_project_managed_windows(project_root)
    }

    fn now_iso(&mut self) -> String {
        now_iso()
    }
}

pub fn reconcile_project_runtime_topology_sessions(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
) -> Result<Value, String> {
    let mut deps = SystemRuntimeTopologySessionReconcileDeps;
    reconcile_project_runtime_topology_sessions_with_deps(
        project_root.as_ref(),
        project_state_dir.as_ref(),
        &mut deps,
    )
}

pub fn reconcile_project_runtime_topology_sessions_with_deps(
    project_root: &Path,
    project_state_dir: &Path,
    deps: &mut impl RuntimeTopologySessionReconcileDeps,
) -> Result<Value, String> {
    let project_root_text = project_root.to_string_lossy().into_owned();
    let now = deps.now_iso();
    let mut incoming = Vec::new();
    let mut removed_session_ids = Vec::new();
    for window in deps.list_project_managed_windows(project_root) {
        if window.target.pane_dead == Some(true) {
            if let Some(session_id) = session_id(&window.metadata)
                && should_drop_dead_window(&window.metadata, &now)
            {
                removed_session_ids.push(session_id);
            } else if let Some(session) = session_state_from_window(&window, "offline", &now) {
                incoming.push(session);
            }
            continue;
        }
        if let Some(session) = session_state_from_window(&window, "live", &now) {
            incoming.push(session);
        }
    }
    update_runtime_topology(runtime_topology_path(project_state_dir), |mut topology| {
        reconcile_runtime_topology_sessions(
            &mut topology,
            &incoming,
            &removed_session_ids,
            &project_root_text,
            &now,
        )
    })
}

pub struct RuntimeTopologyReconcilerTask;

impl PeriodicTask for RuntimeTopologyReconcilerTask {
    fn name(&self) -> &str {
        "runtime-topology-session-reconciler"
    }

    fn interval_ms(&self) -> i64 {
        DEFAULT_INTERVAL_MS
    }

    fn run(&mut self, context: &super::router::ProjectServiceRequestContext) {
        let _ = reconcile_project_runtime_topology_sessions(
            context.project_root(),
            context.project_state_dir(),
        );
    }

    fn run_immediately(&self) -> bool {
        true
    }
}

pub fn runtime_topology_reconciler_task() -> Box<dyn PeriodicTask> {
    Box::new(RuntimeTopologyReconcilerTask)
}

fn session_state_from_window(
    window: &TmuxManagedWindow,
    lifecycle: &str,
    now: &str,
) -> Option<Value> {
    let metadata = &window.metadata;
    if metadata.get("kind").and_then(Value::as_str) != Some("agent") {
        return None;
    }
    let session_id = session_id(metadata)?;
    let tool_config_key = string_field(metadata, "toolConfigKey")
        .or_else(|| string_field(metadata, "tool"))
        .or_else(|| string_field(metadata, "command"))
        .unwrap_or_else(|| "unknown".to_owned());
    let command = string_field(metadata, "command").unwrap_or_else(|| tool_config_key.clone());
    let mut session = Map::new();
    session.insert("id".into(), Value::String(session_id));
    session.insert("tool".into(), Value::String(tool_config_key.clone()));
    session.insert("toolConfigKey".into(), Value::String(tool_config_key));
    session.insert("command".into(), Value::String(command));
    session.insert(
        "args".into(),
        metadata
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    session.insert("lifecycle".into(), Value::String(lifecycle.to_owned()));
    session.insert(
        "createdAt".into(),
        Value::String(string_field(metadata, "createdAt").unwrap_or_else(|| now.to_owned())),
    );
    for key in [
        "backendSessionId",
        "team",
        "worktreePath",
        "label",
        "headline",
    ] {
        if let Some(value) = metadata.get(key).cloned().filter(|value| !value.is_null()) {
            session.insert(key.into(), value);
        }
    }
    if lifecycle == "offline" {
        session.insert(
            "freshRelaunchAllowed".into(),
            Value::Bool(!session.contains_key("backendSessionId")),
        );
    } else {
        session.insert("tmuxTarget".into(), tmux_target_json(window));
    }
    Some(Value::Object(session))
}

fn should_drop_dead_window(metadata: &Value, now: &str) -> bool {
    if metadata
        .get("backendSessionId")
        .and_then(Value::as_str)
        .is_some()
    {
        return false;
    }
    let Some(created_at) = metadata.get("createdAt").and_then(Value::as_str) else {
        return false;
    };
    let Some(age_ms) = timestamp_age_ms(created_at, now) else {
        return false;
    };
    age_ms < QUICK_UNPRESERVED_EXIT_MS
}

fn timestamp_age_ms(created_at: &str, now: &str) -> Option<i128> {
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};
    let created = OffsetDateTime::parse(created_at, &Rfc3339).ok()?;
    let now = OffsetDateTime::parse(now, &Rfc3339).ok()?;
    Some((now - created).whole_milliseconds())
}

fn tmux_target_json(window: &TmuxManagedWindow) -> Value {
    json!({
        "sessionName": window.target.session_name,
        "windowId": window.target.window_id,
        "windowIndex": window.target.window_index,
        "windowName": window.target.window_name,
    })
}

fn session_id(metadata: &Value) -> Option<String> {
    string_field(metadata, "sessionId")
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
