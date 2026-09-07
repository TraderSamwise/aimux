use serde_json::{Map, Value, json};

const NOW: &str = "<NOW>";
const REPO: &str = "<REPO>";
const RIG_ID: &str = "repo-<id>";
const QUEUED_SESSION_PENDING_TIMEOUT_MS: i64 = 210_000;
const SESSION_CREATE_QUEUE_DELAY_MS: i64 = 50;

pub fn run_dashboard_tail_session_create_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    let mut timers = Vec::new();
    let result = match input.get("method").and_then(Value::as_str) {
        Some("spawnAgent") => spawn_agent(input, &mut calls, &mut timers),
        Some("createTeammateAgent") => create_teammate_agent(input, &mut calls, &mut timers),
        Some(method) => Err(format!("unknown dashboard tail method {method}")),
        None => Err("missing dashboard tail method".to_owned()),
    };

    match result {
        Ok(created) => json!({
            "result": created.result,
            "error": Value::Null,
            "calls": calls,
            "timers": timers,
            "topologySessions": [created.topology_session.clone()],
            "topologyYaml": topology_yaml(&created.topology_session),
        }),
        Err(error) => json!({
            "result": Value::Null,
            "error": error,
            "calls": calls,
            "timers": timers,
            "topologySessions": [],
            "topologyYaml": "",
        }),
    }
}

struct CreatedSession {
    result: Value,
    topology_session: Value,
}

struct CreateInput {
    session_id: String,
    command: String,
    args: Vec<String>,
    tool_config_key: String,
    target_worktree_path: Option<String>,
    team: Option<Value>,
    label: Option<String>,
    overseer: bool,
    scribe: bool,
}

fn spawn_agent(
    input: &Value,
    calls: &mut Vec<Value>,
    timers: &mut Vec<Value>,
) -> Result<CreatedSession, String> {
    let options = value_field(input, "options");
    let tool_config_key = string_field(options, "toolConfigKey").unwrap_or_default();
    let tool = tool_config(input, &tool_config_key)
        .ok_or_else(|| format!("Unknown tool config: {tool_config_key}"))?;
    let command = string_field(tool, "command").unwrap_or_else(|| tool_config_key.clone());
    let session_id = match string_field(options, "targetSessionId") {
        Some(session_id) => session_id,
        None => {
            calls.push(call(
                "generateDashboardSessionId",
                vec![Value::String(command.clone())],
            ));
            format!("{command}-generated")
        }
    };
    assert_session_id_can_be_queued(input, &session_id)?;
    let overseer = bool_field(options, "overseer");
    let scribe = bool_field(options, "scribe");
    let team = if overseer {
        Some(json!({ "teamId": "overseer", "parentSessionId": "", "role": "overseer" }))
    } else if scribe {
        Some(json!({ "teamId": "scribe", "parentSessionId": "", "role": "scribe" }))
    } else {
        None
    };
    let create = CreateInput {
        session_id: session_id.clone(),
        command: string_path(options, &["launchOverride", "command"]).unwrap_or(command),
        args: string_array_path(options, &["launchOverride", "args"])
            .unwrap_or_else(|| string_array_field(tool, "args")),
        tool_config_key,
        target_worktree_path: string_field(options, "targetWorktreePath"),
        team,
        label: None,
        overseer,
        scribe,
    };
    record_starting_session(&create, calls, timers);
    Ok(CreatedSession {
        result: json!({ "sessionId": session_id }),
        topology_session: topology_session(&create),
    })
}

fn create_teammate_agent(
    input: &Value,
    calls: &mut Vec<Value>,
    timers: &mut Vec<Value>,
) -> Result<CreatedSession, String> {
    let options = value_field(input, "options");
    let tool_config_key = string_field(options, "toolConfigKey")
        .or_else(|| string_path(value_field(input, "config"), &["defaultTool"]))
        .unwrap_or_default();
    let tool = tool_config(input, &tool_config_key)
        .ok_or_else(|| format!("Unknown tool config: {tool_config_key}"))?;
    let command = string_field(tool, "command").unwrap_or_else(|| tool_config_key.clone());
    let session_id = match string_field(options, "targetSessionId") {
        Some(session_id) => session_id,
        None => {
            calls.push(call(
                "generateDashboardSessionId",
                vec![Value::String(command.clone())],
            ));
            format!("{command}-generated")
        }
    };
    assert_session_id_can_be_queued(input, &session_id)?;
    let parent_session_id = string_field(options, "parentSessionId").unwrap_or_default();
    let role = string_field(options, "role").unwrap_or_default();
    let label = string_field(options, "label");
    let mut team = Map::new();
    team.insert(
        "teamId".into(),
        Value::String(format!("team-{parent_session_id}")),
    );
    team.insert(
        "parentSessionId".into(),
        Value::String(parent_session_id.clone()),
    );
    team.insert("role".into(), Value::String(role.clone()));
    insert_optional_string(&mut team, "label", label.clone());
    insert_optional_value(&mut team, "order", options.get("order").cloned());
    let mut args = string_array_field(tool, "args");
    args.extend(string_array_field(options, "extraArgs"));
    let create = CreateInput {
        session_id: session_id.clone(),
        command,
        args,
        tool_config_key,
        target_worktree_path: string_field(options, "targetWorktreePath"),
        team: Some(Value::Object(team)),
        label: label.clone(),
        overseer: false,
        scribe: false,
    };
    record_starting_session(&create, calls, timers);
    let mut result = Map::new();
    result.insert("sessionId".into(), Value::String(session_id));
    result.insert("parentSessionId".into(), Value::String(parent_session_id));
    result.insert(
        "teamId".into(),
        Value::String(format!(
            "team-{}",
            string_field(options, "parentSessionId").unwrap_or_default()
        )),
    );
    result.insert("role".into(), Value::String(role));
    insert_optional_string(&mut result, "label", label);
    Ok(CreatedSession {
        result: Value::Object(result),
        topology_session: topology_session(&create),
    })
}

fn record_starting_session(create: &CreateInput, calls: &mut Vec<Value>, timers: &mut Vec<Value>) {
    calls.extend([
        call("invalidateDesktopStateSnapshot", vec![]),
        call("writeStatuslineFile", vec![]),
        call("renderCurrentDashboardView", vec![]),
        call("updateContextWatcherSessions", vec![]),
        call("metadataServer.notifyChange", vec![]),
    ]);
    calls.push(call(
        "dashboardPendingActions.setSessionAction",
        vec![
            Value::String(create.session_id.clone()),
            Value::String("starting".into()),
            json!({
                "timeoutMs": QUEUED_SESSION_PENDING_TIMEOUT_MS,
                "sessionSeed": pending_session_seed(create),
            }),
        ],
    ));
    timers.push(json!({ "ms": SESSION_CREATE_QUEUE_DELAY_MS, "unref": true }));
}

fn pending_session_seed(create: &CreateInput) -> Value {
    let mut seed = Map::new();
    seed.insert("index".into(), Value::from(-1));
    seed.insert("id".into(), Value::String(create.session_id.clone()));
    seed.insert("command".into(), Value::String(create.command.clone()));
    seed.insert(
        "toolConfigKey".into(),
        Value::String(create.tool_config_key.clone()),
    );
    insert_optional_string(&mut seed, "label", create.label.clone());
    seed.insert("status".into(), Value::String("waiting".into()));
    seed.insert("active".into(), Value::Bool(false));
    insert_optional_string(
        &mut seed,
        "worktreePath",
        create.target_worktree_path.clone(),
    );
    insert_optional_value(&mut seed, "team", create.team.clone());
    if create.overseer {
        seed.insert("overseer".into(), Value::Bool(true));
    }
    if create.scribe {
        seed.insert("scribe".into(), Value::Bool(true));
    }
    seed.insert("pendingAction".into(), Value::String("starting".into()));
    seed.insert("optimistic".into(), Value::Bool(true));
    Value::Object(seed)
}

fn topology_session(create: &CreateInput) -> Value {
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
    session.insert("status".into(), Value::String("starting".into()));
    session.insert("lifecycle".into(), Value::String("live".into()));
    session.insert("createdAt".into(), Value::String(NOW.into()));
    session.insert("updatedAt".into(), Value::String(NOW.into()));
    insert_optional_value(&mut session, "team", create.team.clone());
    insert_optional_string(
        &mut session,
        "worktreePath",
        create.target_worktree_path.clone(),
    );
    insert_optional_string(&mut session, "label", create.label.clone());
    Value::Object(session)
}

fn topology_yaml(session: &Value) -> String {
    let session_id = string_field(session, "id").unwrap_or_default();
    let tool = string_field(session, "tool").unwrap_or_default();
    let command = string_field(session, "command").unwrap_or_default();
    let args = string_array_field(session, "args");
    let worktree_path = string_field(session, "worktreePath");
    let label = string_field(session, "label");
    let team = session.get("team").cloned();
    let role = team.as_ref().and_then(|team| string_field(team, "role"));
    let node_id = format!("agent:{session_id}");
    let mut yaml = format!(
        "version: 1\ngeneratedAt: {NOW}\nrigs:\n  - id: {RIG_ID}\n    name: repo\n    projectRoot: {REPO}\n    createdAt: {NOW}\n    updatedAt: {NOW}\nnodes:\n  - id: {node_id}\n    rigId: {RIG_ID}\n    logicalId: {session_id}\n"
    );
    if let Some(role) = role {
        yaml.push_str(&format!("    role: {role}\n"));
    }
    yaml.push_str(&format!("    runtime: {tool}\n    toolConfigKey: {tool}\n"));
    if let Some(path) = &worktree_path {
        yaml.push_str(&format!("    cwd: {path}\n"));
    }
    if let Some(label) = &label {
        yaml.push_str(&format!("    label: {label}\n"));
    }
    yaml.push_str(&format!(
        "    createdAt: {NOW}\nedges: []\nbindings: []\nsessions:\n  - id: {session_id}\n    nodeId: {node_id}\n    status: starting\n    tool: {tool}\n    command: {command}\n"
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
    if let Some(label) = label {
        yaml.push_str(&format!("    label: {label}\n"));
    }
    if let Some(team) = team {
        yaml.push_str("    team:\n");
        push_team_yaml(&mut yaml, &team);
    }
    yaml.push_str(&format!(
        "    createdAt: {NOW}\n    updatedAt: {NOW}\n    lastSeenAt: {NOW}\nservices: []\nworktrees: []\nworktreeGraveyard: []\nteamRoles: []\nremoteClients: []\nlifecycleOperations: []\nexchangeRefs: []\n"
    ));
    yaml
}

fn push_team_yaml(yaml: &mut String, team: &Value) {
    if let Some(team_id) = string_field(team, "teamId") {
        yaml.push_str(&format!("      teamId: {team_id}\n"));
    }
    if let Some(parent) = string_field(team, "parentSessionId") {
        if parent.is_empty() {
            yaml.push_str("      parentSessionId: \"\"\n");
        } else {
            yaml.push_str(&format!("      parentSessionId: {parent}\n"));
        }
    }
    if let Some(role) = string_field(team, "role") {
        yaml.push_str(&format!("      role: {role}\n"));
    }
    if let Some(label) = string_field(team, "label") {
        yaml.push_str(&format!("      label: {label}\n"));
    }
    if let Some(order) = team.get("order").and_then(Value::as_i64) {
        yaml.push_str(&format!("      order: {order}\n"));
    }
}

fn assert_session_id_can_be_queued(input: &Value, session_id: &str) -> Result<(), String> {
    if array_field(value_field(input, "host"), "sessions")
        .into_iter()
        .any(|session| string_field(session, "id").as_deref() == Some(session_id))
    {
        Err(format!("Session \"{session_id}\" already exists"))
    } else {
        Ok(())
    }
}

fn tool_config<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    value_field(value_field(input, "config"), "tools").get(key)
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn array_field<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
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

fn insert_optional_string(out: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        out.insert(key.into(), Value::String(value));
    }
}

fn insert_optional_value(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.into(), value);
    }
}
