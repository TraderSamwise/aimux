use serde_json::{Map, Value, json};

pub fn run_service_client_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "requestDaemonJson" => request_daemon_json(input),
        "requestCoreCommand" => request_core_command(input),
        "restartControlPlaneFromCli" => restart_control_plane_from_cli(input),
        _ => panic!("unknown service client contract api: {api}"),
    }
}

fn request_daemon_json(input: &Value) -> Value {
    let state = input.get("state").unwrap_or(&Value::Null);
    let daemon_info = state.get("daemonInfo").unwrap_or(&Value::Null);
    if daemon_info.is_null() {
        return json!({ "ok": false, "error": "aimux daemon is not running" });
    }
    let request_result = state
        .get("requestResult")
        .cloned()
        .unwrap_or_else(|| json!({ "status": 200, "json": { "ok": true } }));
    let status = number_field(&request_result, "status");
    let body = request_result.get("json").unwrap_or(&Value::Null);
    if !(200..300).contains(&status) || body.get("ok").and_then(Value::as_bool) == Some(false) {
        return json!({
            "ok": false,
            "error": body.get("error").and_then(Value::as_str).unwrap_or("daemon request failed"),
        });
    }

    let port = number_field(daemon_info, "port");
    let path = str_field(input, "path");
    let mut init = Map::new();
    if let Some(method) = input.get("init").and_then(|init| init.get("method")) {
        init.insert("method".to_string(), method.clone());
    }
    if let Some(headers) = input.get("init").and_then(|init| init.get("headers")) {
        init.insert("headers".to_string(), headers.clone());
    }
    if let Some(body) = input.get("init").and_then(|init| init.get("body")) {
        init.insert("body".to_string(), body.clone());
    }
    if let Some(timeout_ms) = input.get("init").and_then(|init| init.get("timeoutMs")) {
        init.insert("timeoutMs".to_string(), timeout_ms.clone());
    }
    json!({
        "ok": true,
        "value": {
            "result": body,
            "calls": [{
                "url": format!("http://127.0.0.1:{port}{path}"),
                "init": Value::Object(init),
            }],
        },
    })
}

fn request_core_command(input: &Value) -> Value {
    let command = str_field(input, "command");
    let ensure_daemon = input
        .get("options")
        .and_then(|options| options.get("ensureDaemon"))
        .and_then(Value::as_bool)
        != Some(false);
    let mut send_call = Map::new();
    send_call.insert("command".to_string(), json!(command));
    if let Some(payload) = input.get("payload") {
        send_call.insert("payload".to_string(), payload.clone());
    }
    let mut options = Map::new();
    if let Some(timeout_ms) = input
        .get("options")
        .and_then(|options| options.get("timeoutMs"))
    {
        options.insert("timeoutMs".to_string(), timeout_ms.clone());
    }
    send_call.insert("options".to_string(), Value::Object(options));

    json!({
        "ok": true,
        "value": {
            "result": {
                "ok": true,
                "id": "test",
                "command": command,
                "issuedAt": "1970-01-01T00:00:00.000Z",
                "result": { "pong": true },
            },
            "calls": {
                "ensureCalls": if ensure_daemon { 1 } else { 0 },
                "sendCalls": [Value::Object(send_call)],
            },
        },
    })
}

fn restart_control_plane_from_cli(input: &Value) -> Value {
    let state = input.get("state").unwrap_or(&Value::Null);
    let daemon_info = state.get("daemonInfo").unwrap_or(&Value::Null);
    let daemon_state = state.get("daemonState").cloned().unwrap_or_else(
        || json!({ "version": 1, "updatedAt": "1970-01-01T00:00:00.000Z", "projects": {} }),
    );
    let project_root = input.get("projectRoot").and_then(Value::as_str);
    let restart = restart_value();
    let mut calls = vec![
        json!({ "fn": "loadDaemonInfo" }),
        json!({ "fn": "loadDaemonState" }),
    ];
    let mut options = Map::new();
    options.insert("reason".to_string(), json!("cli"));
    if let Some(project_root) = project_root {
        options.insert("projectRoot".to_string(), json!(project_root));
    }
    options.insert("hasStopDaemon".to_string(), json!(!daemon_info.is_null()));
    options.insert("hasEnsureDaemonRunning".to_string(), json!(true));
    calls.push(json!({ "fn": "restartAimuxControlPlane", "options": Value::Object(options) }));
    calls.push(json!({ "fn": "ensureDaemonRunning", "options": { "adoptExisting": false } }));
    if !daemon_info.is_null() {
        calls.push(json!({ "fn": "assertNotStoppingNewerDaemon" }));
        calls.push(json!({ "fn": "stopDaemonInfo", "daemon": daemon_info, "state": daemon_state }));
    }
    calls.push(json!({ "fn": "renderRuntimeRestartResult", "restart": restart }));

    json!({
        "ok": true,
        "value": {
            "result": {
                "restart": restart,
                "text": "restart text",
                "source": "local-bootstrap",
            },
            "calls": calls,
        },
    })
}

fn restart_value() -> Value {
    json!({
        "startedAt": "2026-01-01T00:00:00.000Z",
        "finishedAt": "2026-01-01T00:00:01.000Z",
        "before": {},
        "verification": { "status": "skipped", "after": null, "error": null },
        "daemon": {
            "previous": null,
            "current": {
                "pid": 42,
                "port": 43190,
                "startedAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
            },
        },
        "projects": [],
        "summary": {
            "projects": 0,
            "servicesEnsured": 0,
            "runtimeRepairs": 0,
            "dashboardsReloaded": 0,
            "runtimeRebuildRequired": 0,
            "failures": 0,
        },
    })
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
