use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::core_command_transport::{DaemonHttpMethod, DaemonRequestInit, send_core_command_with};
use serde::Deserialize;
use serde_json::{Value, json};
use std::cell::RefCell;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/transport/core-command.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn core_command_transport_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("core command transport fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_case(input: &Value) -> Value {
    let calls = RefCell::new(Vec::new());
    let command = input["command"].as_str().expect("command");
    let payload = input.get("payload").cloned();
    let timeout_ms = input
        .get("options")
        .and_then(|options| options.get("timeoutMs"))
        .and_then(Value::as_u64);
    let result = send_core_command_with(command, payload, timeout_ms, |path, init| {
        calls.borrow_mut().push(request_call(path, &init));
        Ok(mock_response(input, &init))
    });
    match result {
        Ok(value) => json!({
            "ok": true,
            "value": serde_json::to_value(value).expect("serialize core command response"),
            "calls": calls.into_inner(),
        }),
        Err(error) => json!({
            "ok": false,
            "error": error.to_string(),
            "calls": calls.into_inner(),
        }),
    }
}

fn request_call(path: &str, init: &DaemonRequestInit) -> Value {
    let mut value = json!({
        "path": path,
        "init": {
            "method": match init.method.unwrap_or(DaemonHttpMethod::Get) {
                DaemonHttpMethod::Get => "GET",
                DaemonHttpMethod::Post => "POST",
            },
            "headers": init.headers,
        }
    });
    if let Some(body) = &init.body {
        value["init"]["body"] = json!(body);
    }
    if let Some(timeout_ms) = init.timeout_ms {
        value["init"]["timeoutMs"] = json!(timeout_ms);
    }
    value
}

fn mock_response(input: &Value, init: &DaemonRequestInit) -> Value {
    match input["mockResponse"].as_str().unwrap_or_default() {
        "echo-command-success" => {
            let body: Value =
                serde_json::from_str(init.body.as_deref().unwrap_or("{}")).expect("request body");
            json!({
                "ok": true,
                "id": "test",
                "command": body["command"],
                "issuedAt": "1970-01-01T00:00:00.000Z",
                "result": { "pong": true },
            })
        }
        "daemon-error" => json!({
            "ok": false,
            "error": "bad command",
        }),
        "mismatched-command" => json!({
            "ok": true,
            "id": "test",
            "command": CORE_COMMAND_NAMES.status,
            "issuedAt": "1970-01-01T00:00:00.000Z",
            "result": { "pong": true },
        }),
        other => panic!("unknown mock response: {other}"),
    }
}
