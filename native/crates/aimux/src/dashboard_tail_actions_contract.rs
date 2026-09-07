use serde_json::{Map, Value, json};

pub fn run_dashboard_tail_actions_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    let result = match input.get("method").and_then(Value::as_str) {
        Some("forkAgent") => fork_agent(input, &mut calls),
        Some("renameAgent") => rename_agent(input, &mut calls),
        Some("migrateAgentSession") => migrate_agent_session(input, &mut calls),
        Some(method) => Err(format!("unknown method {method}")),
        None => Err("unknown method undefined".to_owned()),
    };
    match result {
        Ok(result) => json!({ "result": result, "error": Value::Null, "calls": calls }),
        Err(error) => json!({ "result": Value::Null, "error": error, "calls": calls }),
    }
}

pub fn run_dashboard_tail_lifecycle_contract_case(input: &Value) -> Value {
    let mut state = DashboardTailLifecycleState::from_input(input);
    let mut steps = Vec::new();
    for step in array_field(input, "steps") {
        let method = string_field(&step, "method").unwrap_or_default();
        let result = match method.as_str() {
            "spawnAgent" => state.spawn_agent(value_field(&step, "options")),
            "stopAgent" => state.stop_agent(&string_field(&step, "sessionId").unwrap_or_default()),
            "sendAgentToGraveyard" => {
                state.send_agent_to_graveyard(&string_field(&step, "sessionId").unwrap_or_default())
            }
            other => Err(format!("unknown lifecycle step {other}")),
        };
        match result {
            Ok(value) => {
                steps.push(json!({ "method": method, "result": value, "error": Value::Null }))
            }
            Err(error) => {
                steps.push(json!({ "method": method, "result": Value::Null, "error": error }))
            }
        }
    }
    json!({
        "steps": steps,
        "calls": state.calls,
        "timers": state.timers,
        "topologySessions": state.topology_sessions,
        "offlineSessions": state.offline_sessions,
        "stoppingSessionIds": string_set_json(&state.stopping_session_ids),
        "graveyardAfterStopSessionIds": string_set_json(&state.graveyard_after_stop_session_ids),
        "topologyYaml": state.topology_yaml(),
    })
}

struct DashboardTailLifecycleState {
    input: Value,
    calls: Vec<Value>,
    timers: Vec<Value>,
    topology_sessions: Vec<Value>,
    offline_sessions: Vec<Value>,
    stopping_session_ids: Vec<String>,
    graveyard_after_stop_session_ids: Vec<String>,
    queued_create: Option<DashboardTailLifecycleCreate>,
    queued_pending_token: Option<i64>,
    include_last_seen_in_graveyard_yaml: bool,
}

#[derive(Clone)]
struct DashboardTailLifecycleCreate {
    session_id: String,
    command: String,
    args: Vec<String>,
    tool_config_key: String,
    target_worktree_path: Option<String>,
    team: Option<Value>,
    label: Option<String>,
}

impl DashboardTailLifecycleState {
    fn from_input(input: &Value) -> Self {
        let topology_sessions = array_field(input, "setupTopologySessions")
            .into_iter()
            .map(|session| normalize_setup_topology_session(&session))
            .collect();
        Self {
            input: input.clone(),
            calls: Vec::new(),
            timers: Vec::new(),
            topology_sessions,
            offline_sessions: array_field(value_field(input, "host"), "offlineSessions"),
            stopping_session_ids: string_array_field(
                value_field(input, "host"),
                "stoppingSessionIds",
            ),
            graveyard_after_stop_session_ids: string_array_field(
                value_field(input, "host"),
                "graveyardAfterStopSessionIds",
            ),
            queued_create: None,
            queued_pending_token: None,
            include_last_seen_in_graveyard_yaml: false,
        }
    }

    fn spawn_agent(&mut self, options: &Value) -> Result<Value, String> {
        let tool_config_key = string_field(options, "toolConfigKey").unwrap_or_default();
        let tool = tool_config(&self.input, &tool_config_key)
            .ok_or_else(|| format!("Unknown tool config: {tool_config_key}"))?;
        let command = string_field(tool, "command").unwrap_or_else(|| tool_config_key.clone());
        let session_id = string_field(options, "targetSessionId").unwrap_or_else(|| {
            self.calls.push(call(
                "generateDashboardSessionId",
                vec![Value::String(command.clone())],
            ));
            format!("{command}-generated")
        });
        if self
            .topology_sessions
            .iter()
            .any(|session| string_field(session, "id").as_deref() == Some(session_id.as_str()))
        {
            return Err(format!("Session \"{session_id}\" already exists"));
        }
        let create = DashboardTailLifecycleCreate {
            session_id: session_id.clone(),
            command: string_path(options, &["launchOverride", "command"]).unwrap_or(command),
            args: string_array_path(options, &["launchOverride", "args"])
                .unwrap_or_else(|| string_array_field(tool, "args")),
            tool_config_key,
            target_worktree_path: string_field(options, "targetWorktreePath"),
            team: None,
            label: None,
        };
        self.record_starting_session(&create);
        self.queued_create = Some(create);
        self.queued_pending_token = Some(101);
        Ok(json!({ "sessionId": session_id }))
    }

    fn stop_agent(&mut self, session_id: &str) -> Result<Value, String> {
        self.calls
            .push(call("restoreTmuxSessionsFromTopology", vec![]));
        self.calls.push(call("syncSessionsFromTopology", vec![]));
        if let Some(create) = self.cancel_queued_create(session_id) {
            let offline_entry = self.create_topology_session(&create, "offline", false);
            self.upsert_topology_session(offline_entry.clone());
            self.cache_offline_session(minimal_lifecycle_session(&offline_entry, "offline", true));
            self.notify_lifecycle_change();
            return Ok(json!({ "sessionId": session_id, "status": "offline" }));
        }
        if let Some(existing) = self.find_topology_session(session_id).cloned() {
            match existing.get("status").and_then(Value::as_str) {
                Some("offline") => {
                    self.cache_offline_session(existing);
                    return Ok(json!({ "sessionId": session_id, "status": "offline" }));
                }
                Some("graveyard") => {
                    return Err(format!("Session \"{session_id}\" is already in graveyard"));
                }
                _ => {}
            }
        }
        Err(format!("Unknown session \"{session_id}\""))
    }

    fn send_agent_to_graveyard(&mut self, session_id: &str) -> Result<Value, String> {
        self.calls
            .push(call("restoreTmuxSessionsFromTopology", vec![]));
        self.calls.push(call("syncSessionsFromTopology", vec![]));
        let existing_status = self
            .find_topology_session(session_id)
            .and_then(|session| session.get("status").and_then(Value::as_str))
            .map(str::to_owned);
        let previous_status = if self
            .queued_create
            .as_ref()
            .is_some_and(|create| create.session_id == session_id)
            || is_live_topology_status(existing_status.as_deref())
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
        if let Some(create) = self.cancel_queued_create(session_id) {
            let graveyard_entry = self.create_topology_session(&create, "graveyard", true);
            self.upsert_topology_session(graveyard_entry);
            self.remove_offline_session_cache(session_id);
            self.include_last_seen_in_graveyard_yaml = true;
            self.notify_lifecycle_change();
            return Ok(
                json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
            );
        }
        let Some(existing) = self.find_topology_session(session_id).cloned() else {
            return Err(format!("Unknown session \"{session_id}\""));
        };
        if existing_status.as_deref() == Some("offline") {
            let mut moved = existing;
            set_object_field(&mut moved, "status", Value::String("graveyard".into()));
            remove_object_field(&mut moved, "lifecycle");
            set_object_field(&mut moved, "graveyardedAt", Value::String("<NOW>".into()));
            self.upsert_topology_session(moved);
            self.remove_offline_session_cache(session_id);
            self.notify_lifecycle_change();
            self.calls.push(call(
                "debug",
                vec![
                    Value::String(format!("graveyarded session {session_id}")),
                    Value::String("session".into()),
                ],
            ));
            return Ok(
                json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
            );
        }
        Err(format!("Unable to graveyard session \"{session_id}\""))
    }

    fn record_starting_session(&mut self, create: &DashboardTailLifecycleCreate) {
        self.notify_lifecycle_change();
        self.calls.push(call(
            "dashboardPendingActions.setSessionAction",
            vec![
                Value::String(create.session_id.clone()),
                Value::String("starting".into()),
                json!({
                    "timeoutMs": 210000,
                    "sessionSeed": pending_session_seed_lifecycle(create),
                }),
            ],
        ));
        self.timers.push(json!({ "ms": 50, "unref": true }));
        self.upsert_topology_session(self.create_topology_session(create, "starting", false));
    }

    fn cancel_queued_create(&mut self, session_id: &str) -> Option<DashboardTailLifecycleCreate> {
        let create = self.queued_create.take()?;
        if create.session_id != session_id {
            self.queued_create = Some(create);
            return None;
        }
        if let Some(token) = self.queued_pending_token.take() {
            self.calls.push(call(
                "dashboardPendingActions.clearSessionActionIfToken",
                vec![Value::String(session_id.to_owned()), Value::from(token)],
            ));
        }
        Some(create)
    }

    fn notify_lifecycle_change(&mut self) {
        self.calls.extend([
            call("invalidateDesktopStateSnapshot", vec![]),
            call("writeStatuslineFile", vec![]),
            call("renderCurrentDashboardView", vec![]),
            call("updateContextWatcherSessions", vec![]),
            call("metadataServer.notifyChange", vec![]),
        ]);
    }

    fn create_topology_session(
        &self,
        create: &DashboardTailLifecycleCreate,
        status: &str,
        graveyarded: bool,
    ) -> Value {
        let mut session = Map::new();
        session.insert("id".into(), Value::String(create.session_id.clone()));
        session.insert("tool".into(), Value::String(create.tool_config_key.clone()));
        session.insert(
            "toolConfigKey".into(),
            Value::String(create.tool_config_key.clone()),
        );
        session.insert("command".into(), Value::String(create.command.clone()));
        session.insert(
            "args".into(),
            Value::Array(create.args.iter().cloned().map(Value::String).collect()),
        );
        session.insert("status".into(), Value::String(status.into()));
        if status == "offline" {
            session.insert("lifecycle".into(), Value::String("offline".into()));
        }
        if status == "starting" {
            session.insert("lifecycle".into(), Value::String("live".into()));
        }
        session.insert("createdAt".into(), Value::String("<NOW>".into()));
        session.insert("updatedAt".into(), Value::String("<NOW>".into()));
        if graveyarded {
            session.insert("graveyardedAt".into(), Value::String("<NOW>".into()));
        }
        if let Some(team) = &create.team {
            session.insert("team".into(), team.clone());
        }
        if let Some(path) = &create.target_worktree_path {
            session.insert("worktreePath".into(), Value::String(path.clone()));
        }
        if let Some(label) = &create.label {
            session.insert("label".into(), Value::String(label.clone()));
        }
        Value::Object(session)
    }

    fn find_topology_session(&self, session_id: &str) -> Option<&Value> {
        self.topology_sessions
            .iter()
            .find(|session| string_field(session, "id").as_deref() == Some(session_id))
    }

    fn upsert_topology_session(&mut self, session: Value) {
        let session_id = string_field(&session, "id").unwrap_or_default();
        if let Some(existing) = self
            .topology_sessions
            .iter_mut()
            .find(|entry| string_field(entry, "id").as_deref() == Some(session_id.as_str()))
        {
            *existing = session;
        } else {
            self.topology_sessions.push(session);
        }
    }

    fn cache_offline_session(&mut self, session: Value) {
        let session_id = string_field(&session, "id").unwrap_or_default();
        if let Some(existing) = self
            .offline_sessions
            .iter_mut()
            .find(|entry| string_field(entry, "id").as_deref() == Some(session_id.as_str()))
        {
            *existing = session;
        } else {
            self.offline_sessions.push(session);
        }
    }

    fn remove_offline_session_cache(&mut self, session_id: &str) {
        self.offline_sessions
            .retain(|session| string_field(session, "id").as_deref() != Some(session_id));
    }

    fn topology_yaml(&self) -> String {
        let Some(session) = self.topology_sessions.first() else {
            return String::new();
        };
        lifecycle_topology_yaml(session, self.include_last_seen_in_graveyard_yaml)
    }
}

fn fork_agent(input: &Value, calls: &mut Vec<Value>) -> Result<Value, String> {
    let options = value_field(input, "options");
    let args = vec![
        value_or_null(options, "sourceSessionId"),
        value_or_null(options, "targetToolConfigKey"),
        value_or_null(options, "targetSessionId"),
        value_or_null(options, "instruction"),
        value_or_null(options, "targetWorktreePath"),
        value_or_null(options, "launchOverride"),
    ];
    calls.push(call("forkSessionFromSource", args));
    let fork_result = input.get("forkResult").unwrap_or(&Value::Null);
    if fork_result.is_null() || fork_result.as_bool() == Some(false) {
        return Err(format!(
            "Unable to fork agent \"{}\"",
            string_field(options, "sourceSessionId").unwrap_or_default()
        ));
    }
    if options.get("open").and_then(Value::as_bool) == Some(true) {
        calls.push(call(
            "openLiveTmuxWindowForEntry",
            vec![json!({ "id": value_or_null(fork_result, "sessionId") })],
        ));
    }
    Ok(json!({
        "sessionId": value_or_null(fork_result, "sessionId"),
        "threadId": value_or_null(fork_result, "threadId"),
    }))
}

fn rename_agent(input: &Value, calls: &mut Vec<Value>) -> Result<Value, String> {
    let session_id = string_field(input, "sessionId").unwrap_or_default();
    let label = input.get("label").cloned().unwrap_or(Value::Null);
    calls.push(call(
        "updateSessionLabel",
        vec![Value::String(session_id.clone()), label.clone()],
    ));
    let mut result = Map::new();
    result.insert("sessionId".into(), Value::String(session_id));
    if let Some(label) = label
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        result.insert("label".into(), Value::String(label.to_owned()));
    }
    Ok(Value::Object(result))
}

fn migrate_agent_session(input: &Value, calls: &mut Vec<Value>) -> Result<Value, String> {
    let session_id = string_field(input, "sessionId").unwrap_or_default();
    let target_worktree_path = string_field(input, "targetWorktreePath").unwrap_or_default();
    calls.push(call(
        "migrateAgent",
        vec![
            Value::String(session_id.clone()),
            Value::String(target_worktree_path.clone()),
        ],
    ));
    Ok(json!({ "sessionId": session_id, "worktreePath": target_worktree_path }))
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn value_or_null(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn string_array_path(value: &Value, path: &[&str]) -> Option<Vec<String>> {
    let target = path
        .iter()
        .try_fold(value, |current, key| current.get(*key))?;
    Some(
        target
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn tool_config<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    value_field(value_field(input, "config"), "tools").get(key)
}

fn pending_session_seed_lifecycle(create: &DashboardTailLifecycleCreate) -> Value {
    let mut seed = Map::new();
    seed.insert("index".into(), Value::from(-1));
    seed.insert("id".into(), Value::String(create.session_id.clone()));
    seed.insert("command".into(), Value::String(create.command.clone()));
    seed.insert(
        "toolConfigKey".into(),
        Value::String(create.tool_config_key.clone()),
    );
    seed.insert("status".into(), Value::String("waiting".into()));
    seed.insert("active".into(), Value::Bool(false));
    seed.insert("pendingAction".into(), Value::String("starting".into()));
    seed.insert("optimistic".into(), Value::Bool(true));
    if let Some(path) = &create.target_worktree_path {
        seed.insert("worktreePath".into(), Value::String(path.clone()));
    }
    if let Some(team) = &create.team {
        seed.insert("team".into(), team.clone());
    }
    if let Some(label) = &create.label {
        seed.insert("label".into(), Value::String(label.clone()));
    }
    Value::Object(seed)
}

fn normalize_setup_topology_session(session: &Value) -> Value {
    let mut normalized = session.as_object().cloned().unwrap_or_default();
    if normalized.get("status").and_then(Value::as_str) == Some("graveyard") {
        normalized.remove("lifecycle");
    }
    normalized
        .entry("createdAt")
        .or_insert_with(|| Value::String("<NOW>".into()));
    normalized
        .entry("updatedAt")
        .or_insert_with(|| Value::String("<NOW>".into()));
    Value::Object(normalized)
}

fn minimal_lifecycle_session(session: &Value, lifecycle: &str, keep_lifecycle: bool) -> Value {
    let mut out = session.as_object().cloned().unwrap_or_default();
    if !keep_lifecycle {
        out.remove("lifecycle");
    } else {
        out.insert("lifecycle".into(), Value::String(lifecycle.into()));
    }
    out.remove("createdAt");
    out.remove("updatedAt");
    out.remove("graveyardedAt");
    Value::Object(out)
}

fn set_object_field(value: &mut Value, key: &str, replacement: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.into(), replacement);
    }
}

fn remove_object_field(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}

fn is_live_topology_status(status: Option<&str>) -> bool {
    matches!(status, Some("running" | "idle" | "starting" | "planned"))
}

fn string_set_json(values: &[String]) -> Value {
    let mut values = values.to_vec();
    values.sort();
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn lifecycle_topology_yaml(session: &Value, include_last_seen_in_graveyard: bool) -> String {
    let session_id = string_field(session, "id").unwrap_or_default();
    let tool = string_field(session, "tool").unwrap_or_default();
    let command = string_field(session, "command").unwrap_or_default();
    let args = string_array_field(session, "args");
    let worktree_path = string_field(session, "worktreePath");
    let status = string_field(session, "status").unwrap_or_default();
    let node_id = format!("agent:{session_id}");
    let mut yaml = format!(
        "version: 1\ngeneratedAt: <NOW>\nrigs:\n  - id: repo-<id>\n    name: repo\n    projectRoot: <REPO>\n    createdAt: <NOW>\n    updatedAt: <NOW>\nnodes:\n  - id: {node_id}\n    rigId: repo-<id>\n    logicalId: {session_id}\n    runtime: {tool}\n    toolConfigKey: {tool}\n"
    );
    if let Some(path) = &worktree_path {
        yaml.push_str(&format!("    cwd: {path}\n"));
    }
    yaml.push_str(&format!(
        "    createdAt: <NOW>\nedges: []\nbindings: []\nsessions:\n  - id: {session_id}\n    nodeId: {node_id}\n    status: {status}\n    tool: {tool}\n    command: {command}\n"
    ));
    if args.is_empty() {
        yaml.push_str("    args: []\n");
    } else {
        yaml.push_str("    args:\n");
        for arg in args {
            yaml.push_str(&format!("      - {arg}\n"));
        }
    }
    if let Some(path) = worktree_path {
        yaml.push_str(&format!("    worktreePath: {path}\n"));
    }
    yaml.push_str("    createdAt: <NOW>\n    updatedAt: <NOW>\n");
    if include_last_seen_in_graveyard {
        yaml.push_str("    lastSeenAt: <NOW>\n");
    }
    if session.get("graveyardedAt").is_some() {
        yaml.push_str("    graveyardedAt: <NOW>\n");
    }
    yaml.push_str("services: []\nworktrees: []\nworktreeGraveyard: []\nteamRoles: []\nremoteClients: []\nlifecycleOperations: []\nexchangeRefs: []\n");
    yaml
}
