use aimux::tmux::{OpenTargetOptions, TmuxRuntimeManager, TmuxTarget};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

const TMUX_RUNTIME_OPEN_TARGET: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/runtime-open-target.json");

#[test]
fn fixture_tmux_runtime_open_target_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_RUNTIME_OPEN_TARGET).expect("valid runtime open target fixture");
    let cases = contract["cases"].as_array().expect("open target cases");
    assert_eq!(cases.len(), 3, "unexpected open target case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-runtime-open-target parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let target = target_from_value(&input["target"]);
    let options = OpenTargetOptions {
        inside_tmux: input["options"]["insideTmux"].as_bool().unwrap_or_default(),
        ..OpenTargetOptions::default()
    };
    let exec_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let interactive_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let linked_sessions = Rc::new(RefCell::new(BTreeSet::<String>::new()));
    let current_client_session = optional_string(input, "currentClientSession");
    let client_tty = optional_string(input, "clientTty");
    let client_pid = optional_string(input, "clientPid");
    let exec_calls_for_exec = exec_calls.clone();
    let linked_sessions_for_exec = linked_sessions.clone();
    let interactive_calls_for_exec = interactive_calls.clone();
    let mut tmux = TmuxRuntimeManager::with_exec_and_interactive(
        move |args, options| {
            exec_calls_for_exec.borrow_mut().push(call_to_value(
                args,
                options.and_then(|options| options.cwd.as_deref()),
            ));
            let joined = args.join(" ");
            if joined == "display-message -p #{client_session}" {
                return Ok(current_client_session.clone().unwrap_or_default());
            }
            if joined == "display-message -p #{client_tty}" {
                return Ok(client_tty.clone().unwrap_or_default());
            }
            if joined == "display-message -p #{client_pid}" {
                return Ok(client_pid.clone().unwrap_or_default());
            }
            if joined == "show-options -v -t aimux-mobile-abc @aimux-project-root" {
                return Ok(String::new());
            }
            if joined.starts_with("list-windows -t aimux-mobile-abc-client-") {
                let session_name = args.get(2).cloned().unwrap_or_default();
                if linked_sessions_for_exec.borrow().contains(&session_name) {
                    return Ok("@3\t3\tcodex\t0\t90\t0".to_owned());
                }
                return Ok(String::new());
            }
            if joined.starts_with("link-window -d -s @3 -t aimux-mobile-abc-client-") {
                if let Some(session_name) = args.get(5) {
                    linked_sessions_for_exec
                        .borrow_mut()
                        .insert(session_name.clone());
                }
                return Ok(String::new());
            }
            Ok(String::new())
        },
        move |args, options| {
            interactive_calls_for_exec.borrow_mut().push(call_to_value(
                args,
                options.and_then(|options| options.cwd.as_deref()),
            ));
            Ok(())
        },
    );
    let previous_client_key = std::env::var("AIMUX_CLIENT_KEY").ok();
    unsafe {
        std::env::remove_var("AIMUX_CLIENT_KEY");
    }
    let output = match tmux.open_target(&target, options) {
        Ok(_target) => json!({
            "thrown": Value::Null,
            "result": Value::Null,
            "execCalls": exec_calls.borrow().clone(),
            "interactiveCalls": interactive_calls.borrow().clone(),
        }),
        Err(error) => json!({
            "thrown": error,
            "result": Value::Null,
            "execCalls": exec_calls.borrow().clone(),
            "interactiveCalls": interactive_calls.borrow().clone(),
        }),
    };
    unsafe {
        if let Some(previous_client_key) = previous_client_key {
            std::env::set_var("AIMUX_CLIENT_KEY", previous_client_key);
        }
    }
    output
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn target_from_value(value: &Value) -> TmuxTarget {
    TmuxTarget {
        session_name: value["sessionName"]
            .as_str()
            .expect("session name")
            .to_owned(),
        window_id: value["windowId"].as_str().expect("window id").to_owned(),
        window_index: value["windowIndex"].as_i64().expect("window index"),
        window_name: value["windowName"]
            .as_str()
            .expect("window name")
            .to_owned(),
        pane_dead: value["paneDead"].as_bool(),
    }
}

fn call_to_value(args: &[String], cwd: Option<&str>) -> Value {
    let mut call = args.iter().cloned().map(Value::String).collect::<Vec<_>>();
    if let Some(cwd) = cwd {
        call.push(json!({ "cwd": cwd }));
    }
    Value::Array(call)
}
