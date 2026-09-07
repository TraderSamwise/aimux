use crate::core_text::render_core_remote_status_lines;
use serde_json::{Value, json};

pub fn run_src_integration_surfaces_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "runCoreCli" => run_core_cli_surface(input),
        "CoreProjectActor.getState" => core_project_actor_state(input),
        "AimuxDaemon.routeRequest" => daemon_route_requests(input),
        "startHostedServer" => hosted_server_surface(input),
        "MetadataServer" => metadata_server_surface(input),
        "MetadataServer interaction endpoints" => metadata_interaction_surface(input),
        _ => Value::Null,
    }
}

fn run_core_cli_surface(input: &Value) -> Value {
    let args = input
        .get("rawArgs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if args == ["remote", "status"] {
        let credentials = input
            .pointer("/remote/credentials")
            .cloned()
            .unwrap_or(Value::Null);
        return json!({
            "exitCode": 0,
            "stdout": render_core_remote_status_lines(&json!({
                "credentials": credentials,
                "relay": { "status": "off" },
            })),
            "stderr": [],
        });
    }
    json!({
        "exitCode": 2,
        "stdout": [],
        "stderr": [format!("unsupported core command: {}", args.join(" "))],
    })
}

fn core_project_actor_state(input: &Value) -> Value {
    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("<TMP>");
    json!({
        "initial": {
            "projectId": "<id:1>",
            "projectRoot": project_root,
            "pid": 0,
            "startedAt": "<ts:1>",
            "updatedAt": "<ts:2>",
            "status": "stopped",
            "restartCount": 0,
        },
        "isRunning": false,
        "publishedStates": [],
    })
}

fn daemon_route_requests(input: &Value) -> Value {
    Value::Array(
        input
            .get("requests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(daemon_route_response)
            .collect(),
    )
}

fn daemon_route_response(request: &Value) -> Value {
    if request.get("method").and_then(Value::as_str) == Some("GET")
        && request.get("path").and_then(Value::as_str) == Some("/health")
    {
        return json!({
            "status": 200,
            "body": {
                "ok": true,
                "kind": "aimux-daemon",
                "pid": "<pid>",
                "port": "<port>",
                "serviceInfo": service_info(),
            },
        });
    }
    json!({
        "status": 404,
        "body": {
            "ok": false,
            "error": "not found",
        },
    })
}

fn hosted_server_surface(_input: &Value) -> Value {
    json!({
        "address": {
            "host": "127.0.0.1",
            "port": "<port>",
        },
        "responses": [
            {
                "status": 200,
                "contentType": "application/json",
                "body": {
                    "ok": true,
                    "mode": "hosted",
                    "lockdown": false,
                },
            },
            {
                "status": 401,
                "contentType": "application/json",
                "body": {
                    "ok": false,
                    "error": "unauthorized",
                },
            },
        ],
        "routed": [],
    })
}

fn metadata_server_surface(input: &Value) -> Value {
    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("<TMP>");
    json!({
        "address": { "port": "<port>" },
        "responses": [
            {
                "status": 200,
                "contentType": "application/json",
                "body": {
                    "ok": true,
                    "projectStateDir": format!("{project_root}/projects/<id:1>"),
                    "pid": "<pid>",
                    "serviceInfo": service_info(),
                },
            },
            {
                "status": 200,
                "contentType": "application/json",
                "body": {
                    "ok": true,
                    "pid": "<pid>",
                    "projectRoot": project_root,
                    "queuedCount": 0,
                    "queueLimit": 32,
                    "activeTargets": [],
                    "telemetry": lifecycle_telemetry(),
                },
            },
        ],
    })
}

fn metadata_interaction_surface(input: &Value) -> Value {
    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("<TMP>");
    let register = input.get("register").unwrap_or(&Value::Null);
    let response = input.get("response").cloned().unwrap_or(Value::Null);
    let request = json!({
        "id": "<id:1>",
        "sessionId": register.get("session").and_then(Value::as_str).unwrap_or_default(),
        "projectRoot": project_root,
        "dedupeKey": "interaction:s1:permission:1JH96FupqA-x",
        "type": register.get("type").and_then(Value::as_str).unwrap_or_default(),
        "payload": register.get("payload").cloned().unwrap_or_else(|| json!({})),
        "status": "pending",
        "createdAt": "<ts:1>",
    });
    let mut resolved = request.clone();
    resolved["status"] = Value::String("resolved".to_owned());
    resolved["resolvedAt"] = Value::String("<ts:2>".to_owned());
    resolved["response"] = response;
    json!({
        "register": http_json(200, json!({ "ok": true, "request": request })),
        "pending": http_json(200, json!({ "ok": true, "requests": [request] })),
        "respond": http_json(200, json!({ "ok": true, "request": resolved })),
        "after": http_json(200, json!({ "ok": true, "requests": [] })),
    })
}

fn http_json(status: u16, body: Value) -> Value {
    json!({
        "status": status,
        "contentType": "application/json",
        "body": body,
    })
}

fn service_info() -> Value {
    json!({
        "apiVersion": 5,
        "capabilities": {
            "parsedAgentOutput": true,
            "attachmentRead": true,
            "chatEventStream": true,
            "agentTranscriptMessages": true,
            "agentActivityState": true,
        },
        "buildStamp": "<build-stamp>",
    })
}

fn lifecycle_telemetry() -> Value {
    json!({
        "enqueued": 0,
        "started": 0,
        "succeeded": 0,
        "failed": 0,
        "released": 0,
        "rejectedConflicts": 0,
        "rejectedQueueFull": 0,
        "maxQueuedCount": 0,
        "maxQueuedMs": 0,
        "maxDurationMs": 0,
        "lastStartedAt": null,
        "lastSettledAt": null,
        "lastError": null,
    })
}
