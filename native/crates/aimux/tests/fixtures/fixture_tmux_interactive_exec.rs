use aimux::tmux::TmuxRuntimeManager;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

const TMUX_INTERACTIVE_EXEC: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/interactive-exec.json");

#[test]
fn fixture_tmux_interactive_exec_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_INTERACTIVE_EXEC).expect("valid interactive exec fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("interactive exec cases");
    assert_eq!(cases.len(), 6, "unexpected interactive exec case count");

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
        "{} tmux-interactive-exec parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let exec_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let interactive_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let exec_calls_for_exec = Rc::clone(&exec_calls);
    let interactive_calls_for_exec = Rc::clone(&interactive_calls);
    let current_client_session = input
        .get("currentClientSession")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let return_session = input
        .get("returnSession")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let interactive_error = input
        .get("interactiveError")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut tmux = TmuxRuntimeManager::with_exec_and_interactive(
        move |args, options| {
            exec_calls_for_exec.borrow_mut().push(call_to_value(
                args,
                options.and_then(|options| options.cwd.as_deref()),
            ));
            let joined = args.join(" ");
            if joined == "display-message -p #{client_session}" {
                return Ok(current_client_session.clone());
            }
            if joined.ends_with(" @aimux-return-session") {
                return Ok(return_session.clone());
            }
            Ok(String::new())
        },
        move |args, options| {
            interactive_calls_for_exec.borrow_mut().push(call_to_value(
                args,
                options.and_then(|options| options.cwd.as_deref()),
            ));
            if let Some(error) = interactive_error.as_ref() {
                return Err(error.clone());
            }
            Ok(())
        },
    );

    match run_named_case(case["name"].as_str().expect("case name"), &mut tmux) {
        Ok(()) => json!({
            "thrown": Value::Null,
            "snapshot": {
                "execCalls": exec_calls.borrow().clone(),
                "interactiveCalls": interactive_calls.borrow().clone(),
            }
        }),
        Err(error) => json!({
            "thrown": error,
            "snapshot": {
                "execCalls": exec_calls.borrow().clone(),
                "interactiveCalls": interactive_calls.borrow().clone(),
            }
        }),
    }
}

fn run_named_case(name: &str, tmux: &mut TmuxRuntimeManager) -> Result<(), String> {
    match name {
        "detachClient uses interactive exec" => tmux.detach_client(),
        "switchToLastClientSession uses interactive exec" => tmux.switch_to_last_client_session(),
        "switchClient uses interactive exec with explicit tty" => {
            tmux.switch_client("aimux-repo-client-deadbeef", 3, Some("/dev/ttys001"))
        }
        "leaveManagedSession switches to external return session" => {
            tmux.leave_managed_session(true, Some("aimux-repo-client-deadbeef"))
        }
        "leaveManagedSession detaches without external return session" => {
            tmux.leave_managed_session(true, Some("aimux-repo-client-deadbeef"))
        }
        "attachSession refuses without a terminal" => tmux.attach_session("aimux-repo", Some(2)),
        unexpected => panic!("unexpected case {unexpected}"),
    }
}

fn call_to_value(args: &[String], cwd: Option<&str>) -> Value {
    let mut call = args.iter().cloned().map(Value::String).collect::<Vec<_>>();
    if let Some(cwd) = cwd {
        call.push(json!({ "cwd": cwd }));
    }
    Value::Array(call)
}
