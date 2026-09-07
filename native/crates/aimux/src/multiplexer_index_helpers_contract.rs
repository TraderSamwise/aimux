use serde_json::{Map, Value, json};

pub fn run_multiplexer_index_helpers_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "resolveNativeForkLaunch" => resolve_native_fork_launch(input),
        "resolveSessionAlertDisplayContext" => resolve_session_alert_display_context(input),
        "publishAlert" => publish_alert(input),
        "forkSessionFromSource" => fork_session_from_source(input),
        api => panic!("unknown multiplexer index helper api: {api}"),
    }
}

fn resolve_native_fork_launch(input: &Value) -> Value {
    let source_session_id = string_field(input, "sourceSessionId");
    let target_tool_config_key = string_field(input, "targetToolConfigKey");
    let tool_cfg = value_field(input, "toolCfg");
    let fork_args = string_array(tool_cfg.get("forkArgs").unwrap_or(&Value::Null));
    if fork_args.is_empty() {
        return json!({ "result": Value::Null, "calls": [] });
    }
    if map_pair(input, "sessionToolKeys", &source_session_id).as_deref()
        != Some(&target_tool_config_key)
    {
        return json!({ "result": Value::Null, "calls": [] });
    }
    let launch_override = input.get("launchOverride").unwrap_or(&Value::Null);
    let override_command = string_field(launch_override, "command");
    if !override_command.is_empty() && override_command != string_field(tool_cfg, "command") {
        return json!({ "result": Value::Null, "calls": [] });
    }
    let Some(backend_session_id) = topology_backend_session_id(input, &source_session_id) else {
        return json!({ "result": Value::Null, "calls": [] });
    };
    let resolved_fork_args = fork_args
        .iter()
        .map(|arg| Value::String(arg.replace("{sessionId}", &backend_session_id)))
        .collect::<Vec<_>>();
    let override_args = string_array(launch_override.get("args").unwrap_or(&Value::Null))
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();
    let mut result = override_args.clone();
    result.extend(resolved_fork_args.clone());
    json!({
        "result": result,
        "calls": [{
            "method": "sessionBootstrap.composeToolArgs",
            "args": [tool_cfg.clone(), resolved_fork_args, override_args],
        }],
    })
}

fn resolve_session_alert_display_context(input: &Value) -> Value {
    let session_id = optional_string(input, "sessionId");
    let (context, calls) = session_alert_context(input, session_id.as_deref());
    json!({ "result": context, "calls": calls })
}

fn publish_alert(input: &Value) -> Value {
    let alert = value_field(input, "alert");
    let session_id = optional_string(alert, "sessionId");
    let (context, mut calls) = session_alert_context(input, session_id.as_deref());
    let published = contextualize_alert(alert, &context);
    calls.push(json!({ "method": "eventBus.publishAlert", "args": [published] }));
    json!({ "result": Value::Null, "calls": calls })
}

fn fork_session_from_source(input: &Value) -> Value {
    let source_session_id = string_field(input, "sourceSessionId");
    let target_tool_config_key = string_field(input, "targetToolConfigKey");
    let requested_target_session_id = string_field(input, "requestedTargetSessionId");
    let instruction = optional_string(input, "instruction");
    let target_worktree_path = optional_string(input, "targetWorktreePath");
    let source_session = array_field(input, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id") == source_session_id);
    let Some(source_session) = source_session else {
        return json!({
            "calls": [{
                "method": "showDashboardError",
                "args": ["Cannot fork missing session", [format!("Source session {source_session_id} not found.")]],
            }],
            "exchange": { "threads": [], "messages": [] },
        });
    };

    let mut calls = Vec::new();
    let source_label = session_label(input, &source_session_id)
        .unwrap_or_else(|| string_field(&source_session, "command"));
    calls.push(json!({ "method": "getSessionLabel", "args": [source_session_id] }));
    let target_session_id = if requested_target_session_id.is_empty() {
        "codex-child".to_owned()
    } else {
        requested_target_session_id
    };
    let title = format!("Handoff: {source_label} → {target_tool_config_key}");
    calls.push(json!({ "method": "contextWatcher.syncNow", "args": [source_session_id] }));

    let default_tool_cfg = default_tool_config(&target_tool_config_key);
    let native_fork = resolve_native_fork_args(
        input,
        &source_session_id,
        &target_tool_config_key,
        &default_tool_cfg,
    );
    let (args, extra_preamble, launch_env, persist_args) = if let Some(fork_args) = native_fork {
        let override_args = string_array(
            input
                .get("launchOverride")
                .and_then(|value| value.get("args"))
                .unwrap_or(&Value::Null),
        )
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();
        calls.push(json!({
            "method": "sessionBootstrap.composeToolArgs",
            "args": [default_tool_cfg.clone(), fork_args, override_args],
        }));
        let mut composed = override_args.clone();
        composed.extend(
            fork_args
                .iter()
                .filter_map(Value::as_str)
                .map(|value| Value::String(value.to_owned())),
        );
        (
            Value::Array(composed),
            Value::String(instruction.clone().unwrap_or_default()),
            input
                .get("launchOverride")
                .and_then(|value| value.get("env"))
                .cloned()
                .unwrap_or(Value::Null),
            Value::Array(override_args),
        )
    } else {
        calls.push(json!({ "method": "sessionBootstrap.readForkSourceSnapshot", "args": [source_session_id] }));
        calls.push(json!({
            "method": "sessionBootstrap.seedForkArtifacts",
            "args": [source_session_id, target_session_id, target_tool_config_key],
        }));
        calls.push(json!({
            "method": "sessionBootstrap.buildForkPreamble",
            "args": [source_session_id, target_session_id, { "historyText": "history", "liveText": "live" }],
        }));
        let mut preamble = "fork preamble".to_owned();
        if let Some(instruction) = instruction
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            preamble.push_str("\n\n");
            preamble.push_str(instruction);
        }
        (
            json!(["--dangerously-bypass-approvals-and-sandbox"]),
            Value::String(preamble),
            Value::Null,
            Value::Null,
        )
    };

    let worktree_path = target_worktree_path.map_or(Value::Null, Value::String);
    calls.push(json!({
        "method": "createSession",
        "args": [
            "codex",
            args,
            Value::Null,
            target_tool_config_key,
            extra_preamble,
            Value::Null,
            worktree_path,
            Value::Null,
            target_session_id,
            true,
            false,
            Value::Null,
            launch_env,
            persist_args,
        ],
    }));
    calls.push(json!({
        "method": "agentTracker.emit",
        "args": [source_session_id, {
            "kind": "status",
            "message": format!("Forked {target_session_id} from this session"),
            "threadId": "<THREAD_ID>",
            "threadName": title,
            "source": "fork",
            "tone": "info",
        }],
    }));
    calls.push(json!({
        "method": "agentTracker.emit",
        "args": [target_session_id, {
            "kind": "task_assigned",
            "message": format!("Forked from {source_session_id}"),
            "threadId": "<THREAD_ID>",
            "threadName": title,
            "source": "fork",
            "tone": "info",
        }],
    }));

    let body = instruction
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Continue this work with the same context and take over as needed.");
    json!({
        "result": {
            "sessionId": target_session_id,
            "threadId": "<THREAD_ID>",
            "target": { "sessionName": "aimux-test", "windowId": "@1", "windowName": "agent" },
        },
        "calls": calls,
        "exchange": {
            "threads": [{
                "id": "<THREAD_ID>",
                "title": title,
                "kind": "handoff",
                "status": "waiting",
                "createdAt": "<ISO_DATE>",
                "updatedAt": "<ISO_DATE>",
                "createdBy": source_session_id,
                "participants": [source_session_id, target_session_id],
                "owner": target_session_id,
                "waitingOn": [target_session_id],
                "worktreePath": value_field(input, "targetWorktreePath").clone(),
                "lastMessageId": "<MESSAGE_ID>",
                "unreadBy": [target_session_id],
            }],
            "messages": [{
                "id": "<MESSAGE_ID>",
                "threadId": "<THREAD_ID>",
                "ts": "<ISO_DATE>",
                "from": source_session_id,
                "to": [target_session_id],
                "kind": "handoff",
                "body": body,
                "metadata": { "sourceSessionId": source_session_id },
            }],
        },
    })
}

fn session_alert_context(input: &Value, session_id: Option<&str>) -> (Value, Vec<Value>) {
    let Some(session_id) = session_id else {
        return (Value::Null, Vec::new());
    };
    let metadata_context = input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("context"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let session = find_by_id(input, "dashboardSessionsCache", session_id)
        .or_else(|| find_by_id(input, "sessions", session_id))
        .or_else(|| find_by_id(input, "offlineSessions", session_id));
    let service = find_by_id(input, "dashboardServicesCache", session_id)
        .or_else(|| find_by_id(input, "offlineServices", session_id));
    let worktree_path = optional_string(input, "worktreePath")
        .or_else(|| map_pair(input, "sessionWorktreePaths", session_id))
        .or_else(|| {
            session
                .as_ref()
                .and_then(|value| optional_string(value, "worktreePath"))
        })
        .or_else(|| {
            service
                .as_ref()
                .and_then(|value| optional_string(value, "worktreePath"))
        })
        .or_else(|| optional_string(&metadata_context, "worktreePath"));
    let group = worktree_path
        .as_deref()
        .and_then(|path| {
            array_field(input, "dashboardWorktreeGroupsCache")
                .into_iter()
                .find(|entry| string_field(entry, "path") == path)
        })
        .or_else(|| {
            array_field(input, "dashboardWorktreeGroupsCache")
                .into_iter()
                .find(|entry| optional_string(entry, "path").is_none())
        });
    let mut calls = Vec::new();
    calls.push(json!({ "method": "getSessionLabel", "args": [session_id] }));
    let service_command = service
        .as_ref()
        .and_then(|value| optional_string(value, "launchCommandLine"))
        .or_else(|| {
            service
                .as_ref()
                .and_then(|value| optional_string(value, "command"))
        });
    let context = json!({
        "label": session_label(input, session_id)
            .or_else(|| session.as_ref().and_then(|value| optional_string(value, "label")))
            .or_else(|| service.as_ref().and_then(|value| optional_string(value, "label")))
            .or_else(|| service_command.as_deref().map(service_label_for_command))
            .or_else(|| session.as_ref().and_then(|value| optional_string(value, "command"))),
        "command": session.as_ref().and_then(|value| optional_string(value, "command")).or(service_command),
        "worktreePath": worktree_path,
        "worktreeName": session.as_ref().and_then(|value| optional_string(value, "worktreeName"))
            .or_else(|| service.as_ref().and_then(|value| optional_string(value, "worktreeName")))
            .or_else(|| group.as_ref().and_then(|value| optional_string(value, "name")))
            .or_else(|| optional_string(&metadata_context, "worktreeName")),
        "branch": session.as_ref().and_then(|value| optional_string(value, "worktreeBranch"))
            .or_else(|| service.as_ref().and_then(|value| optional_string(value, "worktreeBranch")))
            .or_else(|| group.as_ref().and_then(|value| optional_string(value, "branch")))
            .or_else(|| optional_string(&metadata_context, "branch")),
    });
    (drop_null_fields(context), calls)
}

fn contextualize_alert(alert: &Value, context: &Value) -> Value {
    let kind = string_field(alert, "kind");
    let category = if kind == "task_failed" {
        "Error"
    } else {
        "Activity"
    };
    let reason = if kind == "task_failed" {
        "Agent or service errored"
    } else {
        "Notification"
    };
    let location = match (
        optional_string(context, "worktreeName"),
        optional_string(context, "branch"),
    ) {
        (Some(worktree), Some(branch)) if branch != worktree => {
            format!("<REPO_NAME> / {worktree} ({branch})")
        }
        (Some(worktree), _) => format!("<REPO_NAME> / {worktree}"),
        _ => "<REPO_NAME>".to_owned(),
    };
    let title = format!("[{category}] {location}");
    let subject = string_field(alert, "title");
    let message = string_field(alert, "message");
    let body = format!("{reason}: {subject} - {message}");
    let mut output = alert.as_object().cloned().unwrap_or_default();
    output.insert("title".to_owned(), Value::String(title));
    output.insert("message".to_owned(), Value::String(body));
    output.insert("projectName".to_owned(), json!("<REPO_NAME>"));
    output.insert("projectRoot".to_owned(), json!("<REPO>"));
    for key in ["worktreePath", "worktreeName", "branch"] {
        if let Some(value) = context.get(key) {
            output.insert(key.to_owned(), value.clone());
        }
    }
    output.insert("categoryLabel".to_owned(), json!(category));
    output.insert("reasonLabel".to_owned(), json!(reason));
    Value::Object(output)
}

fn resolve_native_fork_args(
    input: &Value,
    source_session_id: &str,
    target_tool_config_key: &str,
    tool_cfg: &Value,
) -> Option<Vec<Value>> {
    let fork_args = string_array(tool_cfg.get("forkArgs").unwrap_or(&Value::Null));
    if fork_args.is_empty() {
        return None;
    }
    if map_pair(input, "sessionToolKeys", source_session_id).as_deref()
        != Some(target_tool_config_key)
    {
        return None;
    }
    let backend_session_id = topology_backend_session_id(input, source_session_id)?;
    Some(
        fork_args
            .into_iter()
            .map(|arg| Value::String(arg.replace("{sessionId}", &backend_session_id)))
            .collect(),
    )
}

fn default_tool_config(tool: &str) -> Value {
    if tool == "codex" {
        json!({
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
            "startupInterstitials": [{
                "id": "codex-update-available",
                "when": ["Update available!", "Press enter to continue"],
                "choose": "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$",
            }],
        })
    } else {
        Value::Null
    }
}

fn topology_backend_session_id(input: &Value, session_id: &str) -> Option<String> {
    array_field(input, "topologySessions")
        .into_iter()
        .find(|session| string_field(session, "id") == session_id)
        .and_then(|session| optional_string(&session, "backendSessionId"))
}

fn find_by_id(input: &Value, key: &str, id: &str) -> Option<Value> {
    array_field(input, key)
        .into_iter()
        .find(|entry| string_field(entry, "id") == id)
}

fn map_pair(input: &Value, key: &str, wanted: &str) -> Option<String> {
    input.get(key)?.as_array()?.iter().find_map(|entry| {
        let pair = entry.as_array()?;
        (pair.first()?.as_str()? == wanted).then(|| pair.get(1)?.as_str().map(str::to_owned))?
    })
}

fn session_label(input: &Value, id: &str) -> Option<String> {
    input
        .get("sessionLabels")
        .and_then(|labels| labels.get(id))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn service_label_for_command(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .and_then(|part| part.rsplit('/').next())
        .unwrap_or("service")
        .to_owned()
}

fn drop_null_fields(value: Value) -> Value {
    let mut output = Map::new();
    if let Some(object) = value.as_object() {
        for (key, value) in object {
            if !value.is_null() {
                output.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(output)
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, key: &str) -> String {
    optional_string(value, key).unwrap_or_default()
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
