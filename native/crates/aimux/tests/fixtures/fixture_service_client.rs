use aimux::core_cli::{CoreCommandOk, CoreCommandRequestOptions};
use aimux::core_cli_executor::{RestartControlPlaneCliDeps, restart_control_plane_from_cli_with};
use aimux::core_command_transport::{
    DaemonHttpMethod, DaemonJsonRequest, DaemonJsonResponse, DaemonRequestInit,
    request_core_command_with, request_daemon_json_with,
};
use aimux::daemon_state::AimuxDaemonInfo;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/service-client/client.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn service_client_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("service client fixture parses");
    assert_eq!(contract.cases.len(), 10);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_service_client_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn restart_contract_reaches_production_cli_restart_sequence() {
    let calls = RefCell::new(Vec::<&'static str>::new());

    let result = restart_control_plane_from_cli_with(
        Some("/repo"),
        RestartControlPlaneCliDeps {
            should_stop_daemon: true,
            assert_not_stopping_newer_daemon: || {
                calls.borrow_mut().push("assert");
                Ok(())
            },
            stop_daemon_process: || {
                calls.borrow_mut().push("stop");
                Ok(())
            },
            ensure_daemon_running: || {
                calls.borrow_mut().push("ensure");
                Ok(())
            },
            request_core_command:
                |command: &'static str,
                 payload: Option<Value>,
                 options: CoreCommandRequestOptions| {
                    calls.borrow_mut().push("request");
                    assert_eq!(command, "core.restart");
                    assert_eq!(
                        payload,
                        Some(json!({
                            "projectRoot": "/repo",
                            "backendIdCapturePrechecked": true,
                        }))
                    );
                    assert_eq!(
                        options,
                        CoreCommandRequestOptions {
                            ensure_daemon: false,
                            timeout_ms: None,
                        }
                    );
                    Ok(CoreCommandOk {
                        ok: true,
                        id: "test".into(),
                        command: command.into(),
                        issued_at: "1970-01-01T00:00:00.000Z".into(),
                        result: json!({
                            "restart": restart_value(),
                            "text": "restart text",
                        }),
                    })
                },
            verify_restarted_daemon: || {
                calls.borrow_mut().push("verify");
                Ok(())
            },
        },
    )
    .expect("restart through production helper");

    assert_eq!(result.text, "restart text");
    assert_eq!(
        calls.into_inner(),
        vec!["assert", "stop", "ensure", "request", "verify"]
    );
}

fn run_service_client_contract_case(input: &Value) -> Value {
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
    let daemon_info = daemon_info_from_value(state.get("daemonInfo").unwrap_or(&Value::Null));
    let request_result = state
        .get("requestResult")
        .cloned()
        .unwrap_or_else(|| json!({ "status": 200, "json": { "ok": true } }));
    let status = request_result
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or(200) as u16;
    let response_json = request_result
        .get("json")
        .cloned()
        .unwrap_or_else(|| json!({ "ok": true }));
    let path = input.get("path").and_then(Value::as_str).unwrap_or("/");
    let init = daemon_request_init(input.get("init"));
    let captured_calls = RefCell::new(Vec::new());

    let result = request_daemon_json_with(
        path,
        init,
        || daemon_info.clone(),
        |request| {
            assert_request_preserves_node_init(input.get("init"), request);
            captured_calls
                .borrow_mut()
                .push(daemon_request_call(input.get("init"), request));
            Ok(DaemonJsonResponse {
                status,
                json: response_json,
            })
        },
    );

    match result {
        Ok(result) => json!({
            "ok": true,
            "value": {
                "result": result,
                "calls": captured_calls.into_inner(),
            },
        }),
        Err(error) => json!({
            "ok": false,
            "error": error.to_string(),
        }),
    }
}

fn request_core_command(input: &Value) -> Value {
    let command = input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let options = core_command_options(input.get("options"));
    let ensure_calls = Cell::new(0);
    let send_calls = RefCell::new(Vec::new());

    let result = request_core_command_with(
        command,
        input.get("payload").cloned(),
        options,
        || {
            ensure_calls.set(ensure_calls.get() + 1);
            Ok(())
        },
        |command, payload, timeout_ms| {
            let mut options = Map::new();
            if let Some(timeout_ms) = timeout_ms {
                options.insert("timeoutMs".into(), json!(timeout_ms));
            }
            let mut call = Map::new();
            call.insert("command".into(), json!(command));
            if let Some(payload) = payload {
                call.insert("payload".into(), payload);
            }
            call.insert("options".into(), Value::Object(options));
            send_calls.borrow_mut().push(Value::Object(call));
            Ok(command_ok(command))
        },
    );

    match result {
        Ok(result) => json!({
            "ok": true,
            "value": {
                "result": serde_json::to_value(result).expect("serialize core command result"),
                "calls": {
                    "ensureCalls": ensure_calls.get(),
                    "sendCalls": send_calls.into_inner(),
                },
            },
        }),
        Err(error) => json!({
            "ok": false,
            "error": error.to_string(),
        }),
    }
}

fn restart_control_plane_from_cli(input: &Value) -> Value {
    let state = input.get("state").unwrap_or(&Value::Null);
    let daemon_info_value = state.get("daemonInfo").unwrap_or(&Value::Null);
    let daemon_state = state.get("daemonState").cloned().unwrap_or_else(
        || json!({ "version": 1, "updatedAt": "1970-01-01T00:00:00.000Z", "projects": {} }),
    );
    let project_root = input.get("projectRoot").and_then(Value::as_str);
    let should_stop_daemon = !daemon_info_value.is_null();
    let restart = restart_value();
    let calls = RefCell::new(vec![
        json!({ "fn": "loadDaemonInfo" }),
        json!({ "fn": "loadDaemonState" }),
    ]);
    calls.borrow_mut().push(json!({
        "fn": "restartAimuxControlPlane",
        "options": restart_options(project_root, should_stop_daemon),
    }));
    calls.borrow_mut().push(json!({
        "fn": "ensureDaemonRunning",
        "options": { "adoptExisting": false },
    }));

    let result = restart_control_plane_from_cli_with(
        project_root,
        RestartControlPlaneCliDeps {
            should_stop_daemon,
            assert_not_stopping_newer_daemon: || {
                calls
                    .borrow_mut()
                    .push(json!({ "fn": "assertNotStoppingNewerDaemon" }));
                Ok(())
            },
            stop_daemon_process: || {
                calls.borrow_mut().push(json!({
                    "fn": "stopDaemonInfo",
                    "daemon": daemon_info_value,
                    "state": daemon_state,
                }));
                Ok(())
            },
            ensure_daemon_running: || Ok(()),
            request_core_command:
                |command: &'static str,
                 payload: Option<Value>,
                 options: CoreCommandRequestOptions| {
                    assert_eq!(command, "core.restart");
                    assert_eq!(payload, Some(restart_payload(project_root)));
                    assert_eq!(
                        options,
                        CoreCommandRequestOptions {
                            ensure_daemon: false,
                            timeout_ms: None,
                        }
                    );
                    Ok(CoreCommandOk {
                        ok: true,
                        id: "test".into(),
                        command: command.into(),
                        issued_at: "1970-01-01T00:00:00.000Z".into(),
                        result: json!({
                            "restart": restart,
                            "text": "restart text",
                        }),
                    })
                },
            verify_restarted_daemon: || {
                calls
                    .borrow_mut()
                    .push(json!({ "fn": "verifyRestartedDaemon" }));
                Ok(())
            },
        },
    );

    calls.borrow_mut().push(json!({
        "fn": "renderRuntimeRestartResult",
        "restart": restart_value(),
    }));

    let result = result.expect("restart control plane fixture succeeds");
    json!({
        "ok": true,
        "value": {
            "result": {
                "restart": result.restart,
                "text": result.text,
                "source": "local-bootstrap",
            },
            "calls": calls.into_inner(),
        },
    })
}

fn restart_payload(project_root: Option<&str>) -> Value {
    let mut payload = Map::new();
    if let Some(project_root) = project_root {
        payload.insert("projectRoot".into(), json!(project_root));
    }
    payload.insert("backendIdCapturePrechecked".into(), json!(true));
    Value::Object(payload)
}

fn daemon_request_init(init: Option<&Value>) -> DaemonRequestInit {
    let mut request = DaemonRequestInit::default();
    let Some(init) = init else {
        return request;
    };
    request.method = init
        .get("method")
        .and_then(Value::as_str)
        .map(|method| match method {
            "POST" => DaemonHttpMethod::Post,
            "GET" => DaemonHttpMethod::Get,
            other => panic!("unsupported daemon fixture method: {other}"),
        });
    request.headers = init
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|value| (name.clone(), value.into()))
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    request.body = init.get("body").and_then(Value::as_str).map(str::to_owned);
    request.timeout_ms = init.get("timeoutMs").and_then(Value::as_u64);
    request
}

fn core_command_options(options: Option<&Value>) -> CoreCommandRequestOptions {
    CoreCommandRequestOptions {
        ensure_daemon: options
            .and_then(|options| options.get("ensureDaemon"))
            .and_then(Value::as_bool)
            != Some(false),
        timeout_ms: options
            .and_then(|options| options.get("timeoutMs"))
            .and_then(Value::as_u64),
    }
}

fn assert_request_preserves_node_init(init: Option<&Value>, request: &DaemonJsonRequest) {
    let Some(init) = init else {
        return;
    };
    if let Some(method) = init.get("method").and_then(Value::as_str) {
        assert_eq!(request.method.as_str(), method);
    }
    if let Some(body) = init.get("body").and_then(Value::as_str) {
        assert_eq!(request.body.as_deref(), Some(body));
    }
    if let Some(timeout_ms) = init.get("timeoutMs").and_then(Value::as_u64) {
        assert_eq!(request.timeout_ms, Some(timeout_ms));
    }
    for (name, value) in init
        .get("headers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let expected = value.as_str().expect("header fixture value is a string");
        assert_eq!(
            request.headers.get(name).map(String::as_str),
            Some(expected)
        );
    }
}

fn daemon_request_call(init: Option<&Value>, request: &DaemonJsonRequest) -> Value {
    let mut traced_init = Map::new();
    if let Some(method) = init
        .and_then(|init| init.get("method"))
        .and_then(Value::as_str)
    {
        traced_init.insert("method".into(), json!(method));
    }
    if let Some(headers) = init.and_then(|init| init.get("headers")) {
        traced_init.insert("headers".into(), headers.clone());
    }
    if let Some(body) = request.body.as_ref() {
        traced_init.insert("body".into(), json!(body));
    }
    if let Some(timeout_ms) = request.timeout_ms {
        traced_init.insert("timeoutMs".into(), json!(timeout_ms));
    }
    json!({
        "url": request.url,
        "init": traced_init,
    })
}

fn daemon_info_from_value(value: &Value) -> Option<AimuxDaemonInfo> {
    if value.is_null() {
        return None;
    }
    Some(serde_json::from_value(value.clone()).expect("daemon info fixture parses"))
}

fn command_ok(command: &str) -> CoreCommandOk {
    CoreCommandOk {
        ok: true,
        id: "test".into(),
        command: command.into(),
        issued_at: "1970-01-01T00:00:00.000Z".into(),
        result: json!({ "pong": true }),
    }
}

fn restart_options(project_root: Option<&str>, should_stop_daemon: bool) -> Value {
    let mut options = Map::new();
    options.insert("reason".into(), json!("cli"));
    if let Some(project_root) = project_root {
        options.insert("projectRoot".into(), json!(project_root));
    }
    options.insert("hasStopDaemon".into(), json!(should_stop_daemon));
    options.insert("hasEnsureDaemonRunning".into(), json!(true));
    Value::Object(options)
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
