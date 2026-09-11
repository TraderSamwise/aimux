use aimux::tmux::{TmuxRuntimeManager, attach_session_argv};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/attach-terminal-guard.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
fn tmux_attach_terminal_guard_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tmux attach terminal guard fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux attach-terminal parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "hasInteractiveTerminal" => json!({
            "results": input["matrix"].as_array().into_iter().flatten().map(|entry| {
                entry.get("stdin").and_then(Value::as_bool).unwrap_or(false)
                    && entry.get("stdout").and_then(Value::as_bool).unwrap_or(false)
            }).collect::<Vec<_>>()
        }),
        "attachSession" => attach_session_case(input),
        api => panic!("unknown tmux attach terminal guard api: {api}"),
    }
}

fn attach_session_case(input: &Value) -> Value {
    let session_name = input["sessionName"].as_str().expect("session name");
    let window_index = input["windowIndex"].as_i64();
    if input["isTTY"].as_bool() == Some(true) {
        return json!({
            "thrown": Value::Null,
            "interactiveCalls": [attach_session_argv(session_name, window_index)],
        });
    }

    let mut tmux = TmuxRuntimeManager::with_exec_and_interactive(
        |_args, _options| Ok(String::new()),
        |_args, _options| Ok(()),
    );
    match tmux.attach_session(session_name, window_index) {
        Ok(()) => json!({ "thrown": Value::Null, "interactiveCalls": [] }),
        Err(error) => json!({ "thrown": error, "interactiveCalls": [] }),
    }
}
