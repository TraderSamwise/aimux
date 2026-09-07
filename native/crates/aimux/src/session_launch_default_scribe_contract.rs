use serde_json::{Map, Value, json};

pub fn run_session_launch_default_scribe_contract_case(input: &Value) -> Value {
    if input.get("config").is_none() {
        return json!({
            "result": { "created": false, "reason": "disabled" },
            "calls": [],
            "sessions": [],
            "metadata": { "version": 1, "sessions": {} },
        });
    }
    if default_scribe_tool(input) == Some("ghost".to_owned()) {
        return default_scribe_skip("unknown-tool");
    }
    if input
        .get("config")
        .and_then(|config| config.get("tools"))
        .and_then(|tools| tools.get("aider"))
        .and_then(|aider| aider.get("enabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return default_scribe_skip("disabled-tool");
    }

    if let Some(existing) = existing_live_scribe(input) {
        let mut metadata_sessions = metadata_sessions(input);
        if is_scribe_team(&existing)
            && !metadata_sessions.contains_key(&string_field(&existing, "id"))
        {
            metadata_sessions.insert(
                string_field(&existing, "id"),
                json!({ "updatedAt": "<ISO_DATE>", "scribe": true }),
            );
        }
        return json!({
            "result": { "created": false, "reason": "existing", "sessionId": string_field(&existing, "id") },
            "calls": [],
            "sessions": summarize_sessions(array_field(input, "sessions")),
            "metadata": { "version": 1, "sessions": metadata_sessions },
        });
    }

    json!({
        "result": { "created": true, "sessionId": "aider-scribe", "toolConfigKey": "aider" },
        "calls": create_scribe_calls(),
        "sessions": [{
            "id": "aider-scribe",
            "command": "aider",
            "team": scribe_team(),
        }],
        "metadata": {
            "version": 1,
            "sessions": created_scribe_metadata_sessions(input),
        },
    })
}

fn default_scribe_skip(reason: &str) -> Value {
    json!({
        "result": { "created": false, "reason": reason },
        "calls": [],
        "sessions": [],
        "metadata": { "version": 1, "sessions": {} },
    })
}

fn default_scribe_tool(input: &Value) -> Option<String> {
    let default_agent = input
        .get("config")
        .and_then(|config| config.get("scribe"))
        .and_then(|scribe| scribe.get("defaultAgent"))?;
    if let Some(tool) = default_agent.as_str() {
        return Some(tool.to_owned());
    }
    default_agent
        .get("tool")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn existing_live_scribe(input: &Value) -> Option<Value> {
    let sessions = array_field(input, "sessions");
    if let Some(metadata_id) = metadata_scribe_id(input)
        && let Some(session) = sessions.iter().find(|session| {
            string_field(session, "id") == metadata_id
                && session.get("exited").and_then(Value::as_bool) != Some(true)
        })
    {
        return Some(session.clone());
    }
    sessions.into_iter().find(|session| {
        session.get("exited").and_then(Value::as_bool) != Some(true) && is_scribe_team(session)
    })
}

fn create_scribe_calls() -> Vec<Value> {
    vec![
        json!({
            "method": "sessionBootstrap.buildSessionPreamble",
            "args": [{
                "sessionId": "aider-scribe",
                "command": "aider",
                "worktreePath": "<REPO>",
                "includeAimuxPreamble": true,
                "team": scribe_team(),
            }],
        }),
        json!({ "method": "sessionBootstrap.ensurePlanFile", "args": ["aider-scribe", "aider", "<REPO>"] }),
        json!({ "method": "tmuxRuntimeManager.ensureProjectSessionAsync", "args": ["<REPO>"] }),
        json!({ "method": "getSessionLabel", "args": ["aider-scribe"] }),
        json!({
            "method": "tmuxRuntimeManager.createWindowAsync",
            "args": [
                "aimux-default-scribe",
                "aider",
                "<REPO>",
                "env",
                [
                    "-i",
                    "AIMUX_DAEMON_PORT=<PORT>",
                    "AIMUX_ENV=production",
                    "AIMUX_HOME=<REPO>/home",
                    "env",
                    "AIMUX_SCRIBE=1",
                    "AIMUX_SESSION_ID=aider-scribe",
                    "AIMUX_TOOL=aider",
                    "AIMUX_METADATA_ENDPOINT_FILE=<REPO>/home/projects/aimux-default-scribe/metadata-api.txt",
                    "AIMUX_SHELL_INTEGRATION_SCRIPT=<REPO>/home/projects/aimux-default-scribe/shell-integration/aimux-zsh-integration.zsh",
                    "AIMUX_SHELL_STATE_SUPPRESS_FILE=<REPO>/home/projects/aimux-default-scribe/shell-state-suppress/aider-scribe",
                    "ZDOTDIR=<REPO>/home/projects/aimux-default-scribe/shell-integration",
                    "/bin/zsh",
                    "-ic",
                    "'aider'",
                ],
                { "detached": true },
            ],
        }),
        json!({
            "method": "tmuxRuntimeManager.clearTargetHistoryAsync",
            "args": [{ "sessionName": "aimux-default-scribe", "windowId": "@1", "windowName": "scribe" }],
        }),
        json!({
            "method": "registerManagedSession",
            "args": [
                { "id": "aider-scribe", "command": "aider" },
                [],
                "aider",
                "<REPO>",
                Value::Null,
                "<TIMESTAMP>",
                scribe_team(),
            ],
        }),
        json!({ "method": "buildTmuxWindowMetadata", "args": ["aider-scribe", "aider"] }),
        json!({
            "method": "tmuxRuntimeManager.setWindowMetadataAsync",
            "args": [
                { "sessionName": "aimux-default-scribe", "windowId": "@1", "windowName": "scribe" },
                { "kind": "agent", "sessionId": "aider-scribe", "command": "aider", "createdAt": "<ISO_DATE>" },
            ],
        }),
        json!({
            "method": "tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync",
            "args": [{ "sessionName": "aimux-default-scribe", "windowId": "@1", "windowName": "scribe" }, Value::Null],
        }),
        json!({ "method": "saveState", "args": [] }),
    ]
}

fn created_scribe_metadata_sessions(input: &Value) -> Value {
    let mut sessions = Map::new();
    for (id, _) in metadata_sessions(input) {
        sessions.insert(id, json!({ "updatedAt": "<ISO_DATE>" }));
    }
    sessions.insert(
        "aider-scribe".to_owned(),
        json!({ "updatedAt": "<ISO_DATE>", "scribe": true }),
    );
    Value::Object(sessions)
}

fn metadata_scribe_id(input: &Value) -> Option<String> {
    let sessions = input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))?
        .as_object()?;
    sessions.iter().find_map(|(id, metadata)| {
        (metadata.get("scribe").and_then(Value::as_bool) == Some(true)).then(|| id.clone())
    })
}

fn metadata_sessions(input: &Value) -> Map<String, Value> {
    let mut sessions = input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for session in sessions.values_mut() {
        if let Some(object) = session.as_object_mut()
            && object.contains_key("updatedAt")
        {
            object.insert("updatedAt".to_owned(), json!("<ISO_DATE>"));
        }
    }
    sessions
}

fn summarize_sessions(sessions: Vec<Value>) -> Vec<Value> {
    sessions
        .into_iter()
        .map(|session| {
            let mut out = Map::new();
            out.insert("id".to_owned(), Value::String(string_field(&session, "id")));
            out.insert(
                "command".to_owned(),
                Value::String(string_field(&session, "command")),
            );
            if let Some(backend_session_id) = optional_string(&session, "backendSessionId") {
                out.insert(
                    "backendSessionId".to_owned(),
                    Value::String(backend_session_id),
                );
            }
            if let Some(team) = session.get("team") {
                out.insert("team".to_owned(), team.clone());
            }
            Value::Object(out)
        })
        .collect()
}

fn is_scribe_team(session: &Value) -> bool {
    session
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
        == Some("scribe")
        || session.get("scribe").and_then(Value::as_bool) == Some(true)
}

fn scribe_team() -> Value {
    json!({ "teamId": "scribe", "parentSessionId": "", "role": "scribe" })
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, key: &str) -> String {
    optional_string(value, key).unwrap_or_default()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
