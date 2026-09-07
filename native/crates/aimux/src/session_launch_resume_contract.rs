use serde_json::{Value, json};

pub fn run_session_launch_resume_contract_case(api: &str, input: &Value) -> Value {
    let mut state = ResumeState {
        sessions: topology_after_reconcile(input),
        calls: Vec::new(),
        stderr: Vec::new(),
    };
    let result = match api {
        "resumeSessions" => resume_sessions(&mut state, input),
        "restoreSessions" => restore_sessions(&mut state, input),
        api => panic!("unknown session launch resume api: {api}"),
    };
    json!({
        "result": result,
        "calls": state.calls,
        "stderr": state.stderr,
    })
}

fn resume_sessions(state: &mut ResumeState, input: &Value) -> i32 {
    state.call("startHeartbeat", vec![]);
    reconcile_launchable_topology(state);
    let sessions_to_resume = list_launchable_topology_sessions(&state.sessions, input);
    if sessions_to_resume.is_empty() {
        state.stderr.push(vec![
            "No saved session state found (or state is stale). Starting fresh.".to_owned(),
        ]);
        state.call("runDashboard", vec![]);
        return 0;
    }

    for saved in sessions_to_resume {
        let tool_config_key = string_field(&saved, "toolConfigKey");
        let backend_session_id = optional_string(&saved, "backendSessionId");
        let Some(tool_cfg) = tool_config(&tool_config_key) else {
            continue;
        };
        if backend_session_id.as_deref().unwrap_or_default().is_empty() {
            state.stderr.push(vec![format!(
                "Skipping saved session \"{}\" because \"{}\" has no exact resumable backend session id.",
                string_field(&saved, "id"),
                tool_config_key
            )]);
            continue;
        }
        let backend_session_id = backend_session_id.unwrap_or_default();
        state.call(
            "sessionBootstrap.canResumeWithBackendSessionId",
            vec![tool_cfg.clone(), Value::String(backend_session_id.clone())],
        );
        if !can_resume_with_backend_session_id(&tool_cfg, &backend_session_id) {
            state.stderr.push(vec![format!(
                "Skipping saved session \"{}\" because \"{}\" has no exact resumable backend session id.",
                string_field(&saved, "id"),
                tool_config_key
            )]);
            continue;
        }
        let resume_args =
            replace_session_id(array_field(&tool_cfg, "resumeArgs"), &backend_session_id);
        let original_args = array_field(&saved, "args");
        state.call(
            "sessionBootstrap.composeToolLaunch",
            vec![
                tool_cfg.clone(),
                Value::Array(resume_args.clone()),
                Value::Array(original_args.clone()),
            ],
        );
        let launch_args = compose_tool_launch_args(&tool_cfg, &resume_args, &original_args);
        let persist_args = compose_tool_persist_args(&tool_cfg, &original_args);
        state.call(
            "createSession",
            vec![
                string_value(&saved, "command"),
                Value::Array(launch_args),
                null_if_missing(&tool_cfg, "preambleFlag"),
                Value::String(tool_config_key),
                Value::Null,
                Value::Null,
                null_if_missing(&saved, "worktreePath"),
                Value::String(backend_session_id),
                string_value(&saved, "id"),
                Value::Bool(false),
                Value::Bool(true),
                null_if_missing(&saved, "team"),
                Value::Null,
                Value::Array(persist_args),
            ],
        );
    }

    state.call("openTmuxDashboardTarget", vec![]);
    0
}

fn restore_sessions(state: &mut ResumeState, input: &Value) -> i32 {
    reconcile_launchable_topology(state);
    let sessions_to_restore = list_launchable_topology_sessions(&state.sessions, input);
    if sessions_to_restore.is_empty() {
        state.stderr.push(vec![
            "No saved session state found (or state is stale). Starting fresh.".to_owned(),
        ]);
        state.call("runDashboard", vec![]);
        return 0;
    }

    for saved in sessions_to_restore {
        let tool_config_key = string_field(&saved, "toolConfigKey");
        let Some(tool_cfg) = tool_config(&tool_config_key) else {
            continue;
        };
        let configured_args = strip_tool_action_args(&tool_cfg, array_field(&saved, "args"));
        state.call(
            "sessionBootstrap.stripToolActionArgs",
            vec![tool_cfg.clone(), Value::Array(array_field(&saved, "args"))],
        );
        state.call(
            "createSession",
            vec![
                string_value(&saved, "command"),
                Value::Array(configured_args),
                null_if_missing(&tool_cfg, "preambleFlag"),
                Value::String(tool_config_key),
                Value::Null,
                Value::Null,
                null_if_missing(&saved, "worktreePath"),
                Value::Null,
                string_value(&saved, "id"),
                Value::Bool(false),
                Value::Bool(false),
                null_if_missing(&saved, "team"),
            ],
        );
    }

    state.call("openTmuxDashboardTarget", vec![]);
    0
}

fn topology_after_reconcile(input: &Value) -> Vec<Value> {
    value_field(value_field(input, "hostOptions"), "reconcileSessions")
        .as_array()
        .cloned()
        .unwrap_or_else(|| array_field(input, "topologySessions"))
}

fn reconcile_launchable_topology(state: &mut ResumeState) {
    state.call("syncSessionsFromTopology", vec![]);
    state.call("saveState", vec![]);
}

fn list_launchable_topology_sessions(sessions: &[Value], input: &Value) -> Vec<Value> {
    let tool_filter = optional_string(input, "toolFilter");
    sessions
        .iter()
        .filter(|session| string_field(session, "lifecycle") == "offline")
        .filter(|session| {
            tool_filter.as_ref().is_none_or(|filter| {
                string_field(session, "tool") == *filter
                    || string_field(session, "toolConfigKey") == *filter
            })
        })
        .cloned()
        .collect()
}

fn can_resume_with_backend_session_id(tool_cfg: &Value, backend_session_id: &str) -> bool {
    tool_cfg
        .get("resumeByBackendSessionId")
        .and_then(Value::as_bool)
        == Some(true)
        && !backend_session_id.trim().is_empty()
        && !array_field(tool_cfg, "resumeArgs").is_empty()
}

fn compose_tool_launch_args(
    tool_cfg: &Value,
    resume_args: &[Value],
    original_args: &[Value],
) -> Vec<Value> {
    let mut args = array_field(tool_cfg, "args");
    args.extend(strip_tool_action_args(tool_cfg, original_args.to_vec()));
    args.extend(resume_args.iter().cloned());
    args
}

fn compose_tool_persist_args(tool_cfg: &Value, original_args: &[Value]) -> Vec<Value> {
    let mut args = array_field(tool_cfg, "args");
    args.extend(strip_tool_action_args(tool_cfg, original_args.to_vec()));
    args
}

fn strip_tool_action_args(tool_cfg: &Value, args: Vec<Value>) -> Vec<Value> {
    let mut stripped = Vec::new();
    let resume_args = string_array(tool_cfg, "resumeArgs");
    let resume_fallback = string_array(tool_cfg, "resumeFallback");
    let fork_args = string_array(tool_cfg, "forkArgs");
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str().unwrap_or_default();
        if sequence_starts_with(&args, index, &resume_args)
            || sequence_starts_with(&args, index, &resume_fallback)
            || sequence_starts_with(&args, index, &fork_args)
        {
            let skip =
                matching_action_len(&args, index, [&resume_args, &resume_fallback, &fork_args]);
            index += skip.max(1);
            continue;
        }
        if arg == "resume" && index + 1 < args.len() {
            index += 2;
            continue;
        }
        stripped.push(args[index].clone());
        index += 1;
    }
    stripped
}

fn sequence_starts_with(args: &[Value], index: usize, pattern: &[String]) -> bool {
    if pattern.is_empty() || index + pattern.len() > args.len() {
        return false;
    }
    pattern.iter().enumerate().all(|(offset, expected)| {
        expected == "{sessionId}" || args[index + offset].as_str().unwrap_or_default() == expected
    })
}

fn matching_action_len(args: &[Value], index: usize, patterns: [&[String]; 3]) -> usize {
    patterns
        .into_iter()
        .filter(|pattern| sequence_starts_with(args, index, pattern))
        .map(<[String]>::len)
        .max()
        .unwrap_or_default()
}

fn replace_session_id(args: Vec<Value>, backend_session_id: &str) -> Vec<Value> {
    args.into_iter()
        .map(|arg| {
            let value = arg.as_str().unwrap_or_default();
            Value::String(value.replace("{sessionId}", backend_session_id))
        })
        .collect()
}

fn tool_config(tool_config_key: &str) -> Option<Value> {
    match tool_config_key {
        "codex" => Some(json!({
            "command": "codex",
            "args": ["--dangerously-bypass-approvals-and-sandbox"],
            "enabled": true,
            "resumeArgs": ["resume", "{sessionId}"],
            "forkArgs": ["fork", "{sessionId}"],
            "resumeByBackendSessionId": true,
            "resumeFallback": ["resume", "--last"],
            "developerInstructionsConfigKey": "developer_instructions",
            "promptPatterns": ["^> $"],
            "turnPatterns": ["^[>❯]\\s*(.+)"],
            "startupInterstitials": [
                {
                    "id": "codex-update-available",
                    "when": ["Update available!", "Press enter to continue"],
                    "choose": "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$"
                }
            ]
        })),
        "claude" => Some(json!({
            "command": "claude",
            "args": ["--dangerously-skip-permissions"],
            "enabled": true,
            "wrapperEnabled": true,
            "preambleFlag": ["--append-system-prompt"],
            "sessionIdFlag": ["--session-id", "{sessionId}"],
            "resumeArgs": ["--resume", "{sessionId}"],
            "forkArgs": ["--resume", "{sessionId}", "--fork-session"],
            "resumeByBackendSessionId": true,
            "resumeFallback": ["--continue"],
            "promptPatterns": ["^> $", "\\$ $"],
            "turnPatterns": ["^[❯>]\\s*(.+)", "^❯\\s+(.+)", "^>\\s+(.+)"],
            "compactCommand": "claude --print --output-format text"
        })),
        _ => None,
    }
}

struct ResumeState {
    sessions: Vec<Value>,
    calls: Vec<Value>,
    stderr: Vec<Vec<String>>,
}

impl ResumeState {
    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    array_field(value, key)
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_value(value: &Value, key: &str) -> Value {
    optional_string(value, key).map_or(Value::Null, Value::String)
}

fn null_if_missing(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
