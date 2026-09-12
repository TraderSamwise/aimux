use crate::plugin_api::{
    NativePlugin, NativePluginApi, NativePluginApiRequest, NativePluginHost, NativePluginStatus,
};
use crate::plugin_registry::NativePluginRegistry;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::project_service::scheduler::PeriodicTask;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub fn native_plugin_statuses_for_context(
    context: &ProjectServiceRequestContext,
) -> Vec<NativePluginStatus> {
    let mut host = ProjectServicePluginHost::new(context);
    NativePluginRegistry::builtins().start(&mut host)
}

pub struct ProjectServicePluginHost<'a> {
    context: &'a ProjectServiceRequestContext,
    store: BTreeMap<String, BTreeMap<String, Value>>,
}

impl<'a> ProjectServicePluginHost<'a> {
    pub fn new(context: &'a ProjectServiceRequestContext) -> Self {
        Self {
            context,
            store: BTreeMap::new(),
        }
    }

    fn project_state_dir(&self) -> PathBuf {
        self.context.project_state_dir()
    }

    fn metadata_value(&self) -> Value {
        serde_json::to_value(crate::daemon_state::load_metadata_state(
            self.project_state_dir(),
        ))
        .unwrap_or_else(|_| json!({ "version": 1, "sessions": {} }))
    }

    fn session_list(&self) -> Vec<Value> {
        let metadata = self.metadata_value();
        let mut seen = BTreeSet::new();
        let mut sessions = Vec::new();
        if let Ok(topology) = crate::runtime_topology::read_runtime_topology(
            crate::runtime_topology::runtime_topology_path(self.project_state_dir()),
        ) {
            for session in crate::runtime_topology::list_topology_session_states(&topology, None) {
                if let Some(id) = session.get("id").and_then(Value::as_str)
                    && seen.insert(id.to_owned())
                {
                    sessions.push(json!({ "id": id }));
                }
            }
        }
        if let Some(map) = metadata.get("sessions").and_then(Value::as_object) {
            for id in map.keys() {
                if seen.insert(id.clone()) {
                    sessions.push(json!({ "id": id }));
                }
            }
        }
        sessions
    }
}

impl NativePluginHost for ProjectServicePluginHost<'_> {
    fn execute(
        &mut self,
        plugin_name: &str,
        request: NativePluginApiRequest,
    ) -> Result<Value, String> {
        match request {
            NativePluginApiRequest::GetIdentity => Ok(json!({
                "projectRoot": self.context.project_root().to_string_lossy(),
                "projectId": crate::paths::compute_project_id(self.context.project_root()),
                "sessions": self.session_list(),
            })),
            NativePluginApiRequest::ListSessions => Ok(Value::Array(self.session_list())),
            NativePluginApiRequest::ReadSessionMetadata { session_id } => {
                Ok(session_value(&self.metadata_value(), &session_id))
            }
            NativePluginApiRequest::ReadSessionContext { session_id } => {
                Ok(session_value(&self.metadata_value(), &session_id)
                    .get("context")
                    .cloned()
                    .unwrap_or_else(|| json!({})))
            }
            NativePluginApiRequest::ReadSessionHistory { session_id, since } => Ok(json!({
                "lines": read_session_history_lines(self.context.project_root(), &session_id, since.as_deref()),
            })),
            NativePluginApiRequest::ReadSessionTranscript { session_id, since } => Ok(json!({
                "bytes": read_transcript_bytes_since_checkpoint(
                    self.context.project_root(),
                    &session_id,
                    since.as_deref(),
                ),
            })),
            NativePluginApiRequest::ReadTranscriptBytesSinceCheckpoint { session_id } => {
                Ok(json!({
                    "bytes": read_transcript_bytes_since_checkpoint(
                        self.context.project_root(),
                        &session_id,
                        None,
                    ),
                }))
            }
            NativePluginApiRequest::ReadAgentOutput {
                session_id,
                start_line,
                mode,
            } => Ok(json!({
                "sessionId": session_id,
                "startLine": start_line.unwrap_or(0),
                "mode": mode.unwrap_or_else(|| "full".to_owned()),
                "available": false,
            })),
            NativePluginApiRequest::ReadActivityAttention { session_id } => {
                let session = session_value(&self.metadata_value(), &session_id);
                Ok(json!({
                    "activity": session.get("derived").and_then(|derived| derived.get("activity")).cloned().unwrap_or(Value::Null),
                    "attention": session.get("derived").and_then(|derived| derived.get("attention")).cloned().unwrap_or(Value::Null),
                }))
            }
            NativePluginApiRequest::ReadConfig { path } => {
                let config = crate::config::load_config_for_project(self.context.project_root());
                Ok(path
                    .as_deref()
                    .and_then(|path| dotted_value(&config, path))
                    .unwrap_or(config))
            }
            NativePluginApiRequest::ReadProjectPaths => Ok(json!({
                "projectRoot": self.context.project_root().to_string_lossy(),
                "projectStateDir": self.project_state_dir().to_string_lossy(),
                "contextDir": self.context.project_root().join(".aimux/context").to_string_lossy(),
                "historyDir": self.context.project_root().join(".aimux/history").to_string_lossy(),
            })),
            NativePluginApiRequest::ReadRuntimeTopology { statuses } => {
                let topology = crate::runtime_topology::read_runtime_topology(
                    crate::runtime_topology::runtime_topology_path(self.project_state_dir()),
                )?;
                if let Some(statuses) = statuses {
                    let refs = statuses.iter().map(String::as_str).collect::<Vec<_>>();
                    return Ok(json!({
                        "sessions": crate::runtime_topology::list_topology_session_states(&topology, Some(&refs)),
                    }));
                }
                Ok(topology)
            }
            NativePluginApiRequest::ReadWorktreeInventory => {
                let topology = crate::runtime_topology::read_runtime_topology(
                    crate::runtime_topology::runtime_topology_path(self.project_state_dir()),
                )?;
                Ok(topology
                    .get("worktrees")
                    .cloned()
                    .unwrap_or_else(|| json!([])))
            }
            NativePluginApiRequest::ReadCoordinationState => Ok(
                crate::project_service::runtime_exchange::read_runtime_exchange(
                    crate::project_service::runtime_exchange::runtime_exchange_path(
                        self.project_state_dir(),
                    ),
                ),
            ),
            NativePluginApiRequest::ReadNotificationFeed => {
                let snapshot = crate::project_service::notifications::list_notification_snapshot(
                    self.project_state_dir(),
                    crate::project_service::notifications::NotificationQuery::default(),
                );
                Ok(json!({
                    "notifications": snapshot.notifications,
                    "total": snapshot.total,
                    "unreadCount": snapshot.unread_count,
                    "limit": snapshot.limit,
                    "truncated": snapshot.truncated,
                }))
            }
            NativePluginApiRequest::ReadStatuslineSnapshot => Ok(read_json_file(
                self.project_state_dir().join("statusline.json"),
            )
            .unwrap_or_else(|| json!({ "sessions": [] }))),
            NativePluginApiRequest::ReadDaemonStateSnapshot => {
                Ok(read_json_file(self.project_state_dir().join("state.json"))
                    .unwrap_or_else(|| json!({ "services": [] })))
            }
            NativePluginApiRequest::ReadMetadataState => Ok(self.metadata_value()),
            NativePluginApiRequest::SetStatuslineSegment {
                session_id,
                line,
                segment,
            } => crate::project_service::metadata::put_statusline_segment(
                self.project_state_dir(),
                &session_id,
                &line,
                segment,
            )
            .map(|_| json!({ "ok": true })),
            NativePluginApiRequest::ClearStatuslineSegment {
                session_id,
                segment_id,
                line,
            } => crate::project_service::metadata::drop_statusline_segment(
                self.project_state_dir(),
                &session_id,
                &segment_id,
                line.as_deref(),
            )
            .map(|_| json!({ "ok": true })),
            NativePluginApiRequest::SetSessionContext {
                session_id,
                context,
            } => crate::project_service::metadata::update_session_metadata(
                self.project_state_dir(),
                &session_id,
                |current| merge_session_context_value(current, context),
            )
            .map(|_| json!({ "ok": true })),
            NativePluginApiRequest::SubscribeEvents { kinds } => {
                Ok(json!({ "ok": true, "subscriptions": kinds }))
            }
            NativePluginApiRequest::PluginStoreGet { key } => Ok(self
                .store
                .get(plugin_name)
                .and_then(|entries| entries.get(&key))
                .cloned()
                .unwrap_or(Value::Null)),
            NativePluginApiRequest::PluginStoreSet { key, value } => {
                self.store
                    .entry(plugin_name.to_owned())
                    .or_default()
                    .insert(key, value);
                Ok(json!({ "ok": true }))
            }
            NativePluginApiRequest::PluginStoreDelete { key } => {
                if let Some(entries) = self.store.get_mut(plugin_name) {
                    entries.remove(&key);
                }
                Ok(json!({ "ok": true }))
            }
            NativePluginApiRequest::PluginStoreList => Ok(Value::Array(
                self.store
                    .get(plugin_name)
                    .map(|entries| entries.keys().cloned().map(Value::String).collect())
                    .unwrap_or_default(),
            )),
            NativePluginApiRequest::ReadDeclaredFileMetadata { capability, path } => {
                declared_file_metadata(plugin_name, &capability, &path)
            }
            NativePluginApiRequest::ReadDeclaredFile { capability, path } => {
                if !plugin_declares_file_read(plugin_name, &capability) {
                    return Err(format!(
                        "{plugin_name} did not declare file-read capability {capability}"
                    ));
                }
                fs::read_to_string(path)
                    .map(|contents| json!({ "ok": true, "contents": contents }))
                    .map_err(|error| error.to_string())
            }
            NativePluginApiRequest::RunDeclaredSubprocess {
                capability,
                command,
                args,
                cwd,
                timeout_ms: _,
            } => run_declared_subprocess(plugin_name, &capability, &command, &args, cwd.as_deref()),
            NativePluginApiRequest::PublishNotification { notification } => Ok(json!({
                "ok": false,
                "error": "native plugin notification writes are not wired yet",
                "notification": notification,
            })),
            NativePluginApiRequest::MutateTaskThread { mutation } => Ok(json!({
                "ok": false,
                "error": "native plugin task/thread mutations are not wired yet",
                "mutation": mutation,
            })),
            NativePluginApiRequest::DeliverAgentInput {
                session_id,
                text,
                options,
            } => Ok(json!({
                "ok": false,
                "error": "native plugin agent input delivery is not wired yet",
                "sessionId": session_id,
                "text": text,
                "options": options,
            })),
            NativePluginApiRequest::HttpRequest {
                capability,
                method,
                url,
                headers,
                body,
            } => Ok(json!({
                "ok": false,
                "error": "native plugin outbound HTTP is not wired yet",
                "capability": capability,
                "method": method,
                "url": url,
                "headers": headers,
                "body": body,
            })),
        }
    }
}

fn run_declared_subprocess(
    plugin_name: &str,
    capability: &str,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<Value, String> {
    if !(plugin_name == "gh-pr-context"
        && ((capability == "git" && command == "git") || (capability == "gh" && command == "gh")))
    {
        return Err(format!(
            "{plugin_name} did not declare subprocess capability {capability}"
        ));
    }
    let mut process = Command::new(command);
    process.args(args);
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    match process.output() {
        Ok(output) => Ok(json!({
            "ok": output.status.success(),
            "exitCode": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
        })),
        Err(error) => Ok(json!({
            "ok": false,
            "error": error.to_string(),
            "stdout": "",
            "stderr": "",
        })),
    }
}

fn declared_file_metadata(
    plugin_name: &str,
    capability: &str,
    path: &str,
) -> Result<Value, String> {
    if !plugin_declares_file_read(plugin_name, capability) {
        return Err(format!(
            "{plugin_name} did not declare file-read capability {capability}"
        ));
    }
    let meta = fs::metadata(path).ok();
    Ok(json!({
        "exists": meta.is_some(),
        "isFile": meta.as_ref().is_some_and(|meta| meta.is_file()),
        "bytes": meta.map(|meta| meta.len()).unwrap_or(0),
    }))
}

fn plugin_declares_file_read(plugin_name: &str, capability: &str) -> bool {
    plugin_name == "transcript-length" && capability == "session-transcript"
}

fn read_transcript_bytes_since_checkpoint(
    project_root: &Path,
    session_id: &str,
    since: Option<&str>,
) -> u64 {
    let checkpoint = since
        .map(str::to_owned)
        .or_else(|| read_last_compaction_turn_ts(project_root, session_id));
    read_session_history_lines(project_root, session_id, checkpoint.as_deref())
        .iter()
        .map(|line| line.len() as u64 + 1)
        .sum()
}

fn read_session_history_lines(
    project_root: &Path,
    session_id: &str,
    since: Option<&str>,
) -> Vec<String> {
    let path = project_root
        .join(".aimux")
        .join("history")
        .join(format!("{session_id}.jsonl"));
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let Some(since) = since else {
                return true;
            };
            read_json_str(line)
                .and_then(|turn| turn.get("ts").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|ts| ts.as_str() > since)
        })
        .map(str::to_owned)
        .collect()
}

fn read_last_compaction_turn_ts(project_root: &Path, session_id: &str) -> Option<String> {
    let path = project_root
        .join(".aimux")
        .join("context")
        .join(session_id)
        .join("summary.checkpoints.jsonl");
    let raw = fs::read_to_string(path).ok()?;
    raw.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .and_then(read_json_str)
        .and_then(|checkpoint| {
            checkpoint
                .get("lastTurnTs")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

fn merge_session_context_value(mut current: Value, input: Value) -> Value {
    let Value::Object(session) = &mut current else {
        return json!({ "context": input });
    };
    let mut context = session
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(input) = input.as_object() {
        for (key, value) in input {
            if key == "pr" {
                context.insert(key.clone(), merge_object_values(context.get("pr"), value));
            } else {
                context.insert(key.clone(), value.clone());
            }
        }
    }
    session.insert("context".to_owned(), Value::Object(context));
    current
}

fn merge_object_values(current: Option<&Value>, next: &Value) -> Value {
    let mut map = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(next) = next.as_object() {
        for (key, value) in next {
            map.insert(key.clone(), value.clone());
        }
    }
    Value::Object(map)
}

fn dotted_value(value: &Value, path: &str) -> Option<Value> {
    let mut current = value;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current.clone())
}

fn read_json_file(path: impl AsRef<Path>) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn read_json_str(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn session_value(metadata: &Value, session_id: &str) -> Value {
    metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))
        .cloned()
        .unwrap_or_else(|| json!({}))
}

/// One scheduled task per plugin.
///
/// The plugin is owned by its task and lives across ticks, because the builtins
/// dedupe against their own last-rendered state — rebuilding the registry each
/// tick would rewrite every session's statusline on every tick forever.
pub struct PluginTickTask {
    name: String,
    interval_ms: i64,
    plugin: Box<dyn NativePlugin + Send>,
}

impl PluginTickTask {
    pub fn new(interval_ms: i64, plugin: Box<dyn NativePlugin + Send>) -> Self {
        Self {
            name: plugin.manifest().name,
            interval_ms,
            plugin,
        }
    }
}

impl PeriodicTask for PluginTickTask {
    fn name(&self) -> &str {
        &self.name
    }

    fn interval_ms(&self) -> i64 {
        self.interval_ms
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(10)
    }

    fn run(&mut self, context: &ProjectServiceRequestContext) {
        let mut host = ProjectServicePluginHost::new(context);
        let plugin_name = self.name.clone();
        let mut api = NativePluginApi::new(&plugin_name, &mut host);
        // The builtins do their refresh in on_event; start() would re-subscribe.
        let _ = self.plugin.on_event(json!({ "type": "tick" }), &mut api);
    }
}

/// Derived from the one builtin list, so a plugin cannot be registered for a
/// startup status and then silently never ticked.
pub fn builtin_plugin_tick_tasks() -> Vec<Box<dyn PeriodicTask>> {
    crate::plugin_registry::builtin_native_plugins()
        .into_iter()
        .map(|(interval_ms, plugin)| {
            Box::new(PluginTickTask::new(interval_ms, plugin)) as Box<dyn PeriodicTask>
        })
        .collect()
}
