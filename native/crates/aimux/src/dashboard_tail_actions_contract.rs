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
