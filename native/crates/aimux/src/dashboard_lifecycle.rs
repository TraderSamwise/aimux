use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

use crate::runtime_topology::{empty_runtime_topology, list_topology_session_states};
use crate::runtime_topology_sessions::{
    move_topology_session_to_graveyard, upsert_topology_session,
};

const NOW: &str = "2026-09-07T00:00:00.000Z";
const INITIAL_AT: &str = "2026-05-25T00:00:00.000Z";

pub fn run_dashboard_lifecycle_contract_case(case: &Value) -> Value {
    let input = &case["input"];
    let mut topology = empty_runtime_topology();
    let mut host = LifecycleHost::from_input(input);
    for seed in input["topologySessions"].as_array().into_iter().flatten() {
        upsert_topology_session(
            &mut topology,
            &seed["session"],
            seed["status"].as_str().unwrap_or("running"),
            "<repo>",
            INITIAL_AT,
        );
    }

    let session_id = input["sessionId"].as_str().unwrap_or_default();
    let (result, error) = match input["action"].as_str() {
        Some("stop") => match stop_agent(&mut host, &mut topology, session_id) {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        },
        _ => match send_agent_to_graveyard(&mut host, &mut topology, session_id) {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        },
    };
    let immediate = snapshot(&host, &topology);
    host.drain_scheduled_kills();
    let after_timers = snapshot(&host, &topology);
    let mut output = Map::new();
    if let Some(result) = result {
        output.insert("result".into(), result);
    }
    if let Some(error) = error {
        output.insert("error".into(), Value::String(error));
    }
    output.insert("immediate".into(), immediate);
    output.insert("afterTimers".into(), after_timers);
    normalize(Value::Object(output))
}

fn stop_agent(
    host: &mut LifecycleHost,
    topology: &mut Value,
    session_id: &str,
) -> Result<Value, String> {
    let runtime = host.resolve_lifecycle_runtime(session_id);
    if let Some(runtime) = runtime {
        if host.graveyard_after_stop_session_ids.contains(session_id) {
            return Err(format!(
                "Session \"{session_id}\" is being sent to graveyard"
            ));
        }
        if host.stopping_session_ids.contains(session_id) {
            return Ok(json!({ "sessionId": session_id, "status": "offline" }));
        }
        let offline_entry = host.runtime_to_topology_session_state(&runtime);
        upsert_topology_session(topology, &offline_entry, "offline", "<repo>", NOW);
        host.cache_offline_session(&offline_entry);
        host.stopping_session_ids.insert(session_id.to_owned());
        host.forget_runtime_session(session_id);
        host.schedule_runtime_kill(runtime, session_id);
        notify_lifecycle_change(host);
        host.debug(format!("stopped session {session_id} -> offline"));
        return Ok(json!({ "sessionId": session_id, "status": "offline" }));
    }

    let existing = find_topology_session(topology, session_id);
    if existing
        .as_ref()
        .and_then(|session| string_field(session, "status"))
        .as_deref()
        == Some("offline")
    {
        host.cache_offline_session(existing.as_ref().expect("existing offline"));
        return Ok(json!({ "sessionId": session_id, "status": "offline" }));
    }
    if existing
        .as_ref()
        .and_then(|session| string_field(session, "status"))
        .is_some_and(|status| is_live_topology_status(&status))
    {
        let tmux_target = host.resolve_live_tmux_target_for_session(session_id);
        mark_topology_session_offline(host, topology, existing.as_ref().expect("existing live"));
        if let Some(target) = tmux_target {
            host.stopping_session_ids.insert(session_id.to_owned());
            host.schedule_tmux_target_kill(target, session_id);
        }
        notify_lifecycle_change(host);
        host.debug(format!(
            "reconciled unowned live session {session_id} -> offline"
        ));
        return Ok(json!({ "sessionId": session_id, "status": "offline" }));
    }
    if existing
        .as_ref()
        .and_then(|session| string_field(session, "status"))
        .as_deref()
        == Some("graveyard")
    {
        return Err(format!("Session \"{session_id}\" is already in graveyard"));
    }
    Err(format!("Unknown session \"{session_id}\""))
}

fn send_agent_to_graveyard(
    host: &mut LifecycleHost,
    topology: &mut Value,
    session_id: &str,
) -> Result<Value, String> {
    let runtime = host.resolve_lifecycle_runtime(session_id);
    let existing = find_topology_session(topology, session_id);
    let existing_status = existing
        .as_ref()
        .and_then(|session| string_field(session, "status"));
    let previous_status = if runtime.is_some()
        || existing_status
            .as_ref()
            .is_some_and(|status| is_live_topology_status(status))
    {
        "running"
    } else {
        "offline"
    };

    if existing_status.as_deref() == Some("graveyard") {
        return Ok(
            json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        );
    }

    if runtime.is_none()
        && existing_status
            .as_ref()
            .is_some_and(|status| is_live_topology_status(status))
    {
        let tmux_target = host.resolve_live_tmux_target_for_session(session_id);
        if move_topology_session_to_graveyard(topology, session_id, NOW, None).is_none() {
            return Err(format!("Unable to graveyard session \"{session_id}\""));
        }
        host.remove_offline_session_cache(session_id);
        if let Some(target) = tmux_target {
            host.graveyard_after_stop_session_ids
                .insert(session_id.to_owned());
            host.stopping_session_ids.insert(session_id.to_owned());
            host.schedule_tmux_target_kill(target, session_id);
        }
        notify_lifecycle_change(host);
        host.debug(format!(
            "reconciled unowned live session {session_id} -> graveyard"
        ));
        return Ok(
            json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        );
    }

    if let Some(runtime) = runtime {
        if existing.is_none() {
            let running = host.runtime_to_topology_session_state(&runtime);
            upsert_topology_session(topology, &running, "running", "<repo>", NOW);
        }
        if move_topology_session_to_graveyard(topology, session_id, NOW, None).is_none() {
            return Err(format!("Unable to graveyard session \"{session_id}\""));
        }
        host.remove_offline_session_cache(session_id);
        host.graveyard_after_stop_session_ids
            .insert(session_id.to_owned());
        host.stopping_session_ids.insert(session_id.to_owned());
        host.forget_runtime_session(session_id);
        host.schedule_runtime_kill(runtime, session_id);
        notify_lifecycle_change(host);
        host.debug(format!("graveyarded session {session_id}"));
        return Ok(
            json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        );
    }

    if existing.is_none() {
        return Err(format!("Unknown session \"{session_id}\""));
    }
    if move_topology_session_to_graveyard(topology, session_id, NOW, None).is_none() {
        return Err(format!("Unable to graveyard session \"{session_id}\""));
    }
    host.remove_offline_session_cache(session_id);
    notify_lifecycle_change(host);
    host.debug(format!("graveyarded session {session_id}"));
    Ok(json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }))
}

#[derive(Debug, Clone)]
struct RuntimeSession {
    id: String,
    command: String,
    start_time: Option<String>,
    backend_session_id: Option<String>,
    team: Option<Value>,
    transport_kind: Option<String>,
    tmux_target: Option<Value>,
}

#[derive(Debug, Clone)]
enum ScheduledKill {
    Runtime {
        runtime: RuntimeSession,
        session_id: String,
    },
    TmuxTarget {
        target: Value,
        session_id: String,
    },
}

#[derive(Debug, Clone)]
struct LifecycleHost {
    mode: String,
    sessions: Vec<RuntimeSession>,
    offline_sessions: Vec<Value>,
    stopping_session_ids: BTreeSet<String>,
    graveyard_after_stop_session_ids: BTreeSet<String>,
    session_tmux_targets: BTreeMap<String, Value>,
    session_tool_keys: BTreeMap<String, String>,
    session_original_args: BTreeMap<String, Vec<String>>,
    session_worktree_paths: BTreeMap<String, String>,
    labels: BTreeMap<String, String>,
    headlines: BTreeMap<String, String>,
    managed_windows: Vec<Value>,
    dead_window_ids: BTreeSet<String>,
    calls: Vec<String>,
    tmux_kill_targets: Vec<Value>,
    runtime_kill_calls: usize,
    scheduled_kills: Vec<ScheduledKill>,
}

impl LifecycleHost {
    fn from_input(input: &Value) -> Self {
        Self {
            mode: string_field(input, "mode").unwrap_or_else(|| "project-service".into()),
            sessions: array_field(input, "sessions")
                .into_iter()
                .map(|value| runtime_from_value(&value))
                .collect(),
            offline_sessions: array_field(input, "offlineSessions"),
            stopping_session_ids: string_set(input, "stoppingSessionIds"),
            graveyard_after_stop_session_ids: string_set(input, "graveyardAfterStopSessionIds"),
            session_tmux_targets: value_map(input, "sessionTmuxTargets"),
            session_tool_keys: string_map(input, "sessionToolKeys"),
            session_original_args: string_vec_map(input, "sessionOriginalArgs"),
            session_worktree_paths: string_map(input, "sessionWorktreePaths"),
            labels: string_map(input, "labels"),
            headlines: string_map(input, "headlines"),
            managed_windows: array_field(input, "managedWindows"),
            dead_window_ids: string_set(input, "deadWindowIds"),
            calls: Vec::new(),
            tmux_kill_targets: Vec::new(),
            runtime_kill_calls: 0,
            scheduled_kills: Vec::new(),
        }
    }

    fn find_runtime(&self, session_id: &str) -> Option<&RuntimeSession> {
        self.sessions
            .iter()
            .find(|session| session.id == session_id)
    }

    fn resolve_lifecycle_runtime(&mut self, session_id: &str) -> Option<RuntimeSession> {
        if let Some(runtime) = self.find_runtime(session_id) {
            return Some(runtime.clone());
        }
        self.calls.push("restoreTmuxSessionsFromTopology".into());
        if let Some(runtime) = self.find_runtime(session_id) {
            return Some(runtime.clone());
        }
        self.calls.push("syncSessionsFromTopology".into());
        self.find_runtime(session_id).cloned()
    }

    fn runtime_to_topology_session_state(&self, runtime: &RuntimeSession) -> Value {
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(runtime.id.clone()));
        entry.insert("tool".into(), Value::String(runtime.command.clone()));
        entry.insert(
            "toolConfigKey".into(),
            Value::String(
                self.session_tool_keys
                    .get(&runtime.id)
                    .cloned()
                    .unwrap_or_else(|| runtime.command.clone()),
            ),
        );
        entry.insert("command".into(), Value::String(runtime.command.clone()));
        entry.insert(
            "args".into(),
            Value::Array(
                self.session_original_args
                    .get(&runtime.id)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        entry.insert("lifecycle".into(), Value::String("offline".into()));
        insert_optional(&mut entry, "createdAt", runtime.start_time.clone());
        insert_optional(
            &mut entry,
            "backendSessionId",
            runtime.backend_session_id.clone(),
        );
        insert_optional_value(&mut entry, "team", runtime.team.clone());
        insert_optional(
            &mut entry,
            "worktreePath",
            self.session_worktree_paths.get(&runtime.id).cloned(),
        );
        insert_optional(&mut entry, "label", self.labels.get(&runtime.id).cloned());
        insert_optional(
            &mut entry,
            "headline",
            self.headlines.get(&runtime.id).cloned(),
        );
        entry.insert(
            "freshRelaunchAllowed".into(),
            Value::Bool(runtime.backend_session_id.is_none()),
        );
        Value::Object(entry)
    }

    fn cache_offline_session(&mut self, entry: &Value) {
        let Some(id) = string_field(entry, "id") else {
            return;
        };
        let mut offline = entry.clone();
        if let Value::Object(map) = &mut offline {
            map.insert("lifecycle".into(), Value::String("offline".into()));
            map.insert("status".into(), Value::String("offline".into()));
        }
        if let Some(existing) = self
            .offline_sessions
            .iter_mut()
            .find(|session| string_field(session, "id").as_deref() == Some(id.as_str()))
        {
            merge_object(existing, &offline);
        } else {
            self.offline_sessions.push(offline);
        }
    }

    fn remove_offline_session_cache(&mut self, session_id: &str) {
        self.offline_sessions
            .retain(|session| string_field(session, "id").as_deref() != Some(session_id));
    }

    fn forget_runtime_session(&mut self, session_id: &str) {
        self.sessions.retain(|session| session.id != session_id);
        self.session_tmux_targets.remove(session_id);
        self.session_tool_keys.remove(session_id);
        self.session_original_args.remove(session_id);
        self.session_worktree_paths.remove(session_id);
    }

    fn resolve_live_tmux_target_for_session(&mut self, session_id: &str) -> Option<Value> {
        if let Some(cached) = self.session_tmux_targets.get(session_id).cloned()
            && self.tmux_window_alive(&cached)
        {
            return Some(cached);
        }
        for window in &self.managed_windows {
            let metadata = window.get("metadata").unwrap_or(&Value::Null);
            if string_field(metadata, "kind").as_deref() != Some("agent")
                || string_field(metadata, "sessionId").as_deref() != Some(session_id)
            {
                continue;
            }
            let target = window.get("target").cloned().unwrap_or(Value::Null);
            if self.tmux_window_alive(&target) {
                self.session_tmux_targets
                    .insert(session_id.to_owned(), target.clone());
                return Some(target);
            }
        }
        None
    }

    fn tmux_window_alive(&self, target: &Value) -> bool {
        let Some(window_id) = string_field(target, "windowId") else {
            return true;
        };
        !self.dead_window_ids.contains(&window_id)
    }

    fn schedule_runtime_kill(&mut self, runtime: RuntimeSession, session_id: &str) {
        self.scheduled_kills.push(ScheduledKill::Runtime {
            runtime,
            session_id: session_id.to_owned(),
        });
    }

    fn schedule_tmux_target_kill(&mut self, target: Value, session_id: &str) {
        self.scheduled_kills.push(ScheduledKill::TmuxTarget {
            target,
            session_id: session_id.to_owned(),
        });
    }

    fn drain_scheduled_kills(&mut self) {
        for kill in std::mem::take(&mut self.scheduled_kills) {
            match kill {
                ScheduledKill::Runtime {
                    runtime,
                    session_id,
                } => {
                    if runtime.transport_kind.as_deref() == Some("tmux") {
                        if let Some(target) = runtime.tmux_target {
                            self.tmux_kill_targets.push(target);
                        }
                    } else {
                        self.runtime_kill_calls += 1;
                    }
                    clear_terminating_session_tracking(self, &session_id);
                }
                ScheduledKill::TmuxTarget { target, session_id } => {
                    self.tmux_kill_targets.push(target);
                    clear_terminating_session_tracking(self, &session_id);
                }
            }
        }
    }

    fn debug(&mut self, message: String) {
        self.calls.push(format!("debug:session:{message}"));
    }
}

fn mark_topology_session_offline(host: &mut LifecycleHost, topology: &mut Value, existing: &Value) {
    let mut offline_entry = existing.clone();
    if let Value::Object(map) = &mut offline_entry {
        map.insert("lifecycle".into(), Value::String("offline".into()));
        map.insert("status".into(), Value::String("offline".into()));
    }
    upsert_topology_session(topology, &offline_entry, "offline", "<repo>", NOW);
    host.cache_offline_session(&offline_entry);
}

fn clear_terminating_session_tracking(host: &mut LifecycleHost, session_id: &str) {
    host.stopping_session_ids.remove(session_id);
    host.graveyard_after_stop_session_ids.remove(session_id);
    notify_lifecycle_change(host);
}

fn notify_lifecycle_change(host: &mut LifecycleHost) {
    host.calls.push("invalidateDesktopStateSnapshot".into());
    if host.mode != "project-service" {
        host.calls.push("writeStatuslineFile".into());
        if host.mode == "dashboard" {
            host.calls.push("renderCurrentDashboardView".into());
        }
        host.calls.push("updateContextWatcherSessions".into());
    }
    host.calls.push("metadataNotify".into());
}

fn snapshot(host: &LifecycleHost, topology: &Value) -> Value {
    let status_groups = ["starting", "running", "idle", "offline", "graveyard"]
        .into_iter()
        .map(|status| {
            (
                status.to_owned(),
                Value::Array(list_topology_session_states(topology, Some(&[status]))),
            )
        })
        .collect::<Map<_, _>>();
    json!({
        "host": {
            "sessions": host.sessions.iter().map(|session| Value::String(session.id.clone())).collect::<Vec<_>>(),
            "offlineSessions": host.offline_sessions.iter().map(offline_session_snapshot).collect::<Vec<_>>(),
            "stoppingSessionIds": host.stopping_session_ids.iter().cloned().map(Value::String).collect::<Vec<_>>(),
            "graveyardAfterStopSessionIds": host.graveyard_after_stop_session_ids.iter().cloned().map(Value::String).collect::<Vec<_>>(),
            "sessionTmuxTargets": host.session_tmux_targets.keys().cloned().map(Value::String).collect::<Vec<_>>(),
            "calls": host.calls,
            "tmuxKillTargets": host.tmux_kill_targets,
            "runtimeKillCalls": host.runtime_kill_calls,
        },
        "topology": Value::Object(status_groups),
    })
}

fn offline_session_snapshot(session: &Value) -> Value {
    let mut output = Map::new();
    for key in [
        "id",
        "status",
        "backendSessionId",
        "worktreePath",
        "label",
        "headline",
        "freshRelaunchAllowed",
    ] {
        if let Some(value) = session.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    Value::Object(output)
}

fn find_topology_session(topology: &Value, session_id: &str) -> Option<Value> {
    list_topology_session_states(
        topology,
        Some(&[
            "running",
            "idle",
            "starting",
            "planned",
            "offline",
            "graveyard",
        ]),
    )
    .into_iter()
    .find(|session| string_field(session, "id").as_deref() == Some(session_id))
}

fn is_live_topology_status(status: &str) -> bool {
    matches!(status, "running" | "idle" | "starting" | "planned")
}

fn runtime_from_value(value: &Value) -> RuntimeSession {
    RuntimeSession {
        id: string_field(value, "id").unwrap_or_default(),
        command: string_field(value, "command")
            .or_else(|| string_field(value, "toolConfigKey"))
            .or_else(|| string_field(value, "tool"))
            .unwrap_or_else(|| "codex".into()),
        start_time: string_field(value, "startTime"),
        backend_session_id: string_field(value, "backendSessionId"),
        team: value.get("team").cloned(),
        transport_kind: string_field(value, "transportKind"),
        tmux_target: value.get("tmuxTarget").cloned(),
    }
}

fn normalize(value: Value) -> Value {
    match value {
        Value::String(value) => {
            if looks_like_iso_timestamp(&value) {
                Value::String("<ts>".into())
            } else {
                Value::String(value)
            }
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        other => other,
    }
}

fn looks_like_iso_timestamp(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(23) == Some(&b'Z')
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_set(value: &Value, key: &str) -> BTreeSet<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn string_map(value: &Value, key: &str) -> BTreeMap<String, String> {
    value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn value_map(value: &Value, key: &str) -> BTreeMap<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn string_vec_map(value: &Value, key: &str) -> BTreeMap<String, Vec<String>> {
    value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .map(|(key, value)| {
            (
                key.clone(),
                value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            )
        })
        .collect()
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn insert_optional_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}

fn merge_object(existing: &mut Value, next: &Value) {
    if let (Value::Object(existing), Value::Object(next)) = (existing, next) {
        for (key, value) in next {
            existing.insert(key.clone(), value.clone());
        }
    }
}
