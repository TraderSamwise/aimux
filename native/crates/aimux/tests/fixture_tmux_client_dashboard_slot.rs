use aimux::tmux::{OpenTargetOptions, TmuxExecOptions, TmuxRuntimeManager, TmuxTarget};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

const CONTRACT: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/client-dashboard-slot.json");
const HOST: &str = "aimux-mobile-abc";
const CLIENT: &str = "aimux-mobile-abc-client-268eff9c";

#[test]
fn fixture_tmux_client_dashboard_slot_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid tmux client dashboard slot contract");
    let cases = contract["cases"]
        .as_array()
        .expect("client dashboard cases");
    assert_eq!(cases.len(), 10, "unexpected client dashboard case count");

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
        "{} tmux-client-dashboard-slot parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"]["input"];
    let calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let interactive_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let client_session_missing = input["clientSessionMissing"].as_bool().unwrap_or(false);
    let window_id = input["windowId"].as_str().unwrap_or("@10").to_owned();
    let current_host_session = input["currentHostSession"]
        .as_str()
        .unwrap_or(HOST)
        .to_owned();
    let current_project_root = input["currentProjectRoot"]
        .as_str()
        .unwrap_or("/repo/mobile")
        .to_owned();
    let current_runtime_build = input["currentRuntimeBuild"]
        .as_str()
        .unwrap_or("<stale-build>")
        .to_owned();
    let renumber_windows = input["renumberWindows"].as_str().unwrap_or("on").to_owned();
    let current_client_session = input["currentClientSession"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let target_pane_in_mode = input["targetPaneInMode"].as_str().unwrap_or("0").to_owned();
    let link_error = input["linkError"].as_str().map(str::to_owned);
    let move_error = input["moveError"].as_str().map(str::to_owned);
    let unlink_placeholder_error = input["unlinkPlaceholderError"].as_str().map(str::to_owned);
    let host_windows = input["hostWindows"].as_str().unwrap_or_default().to_owned();
    let client_windows = input["clientWindows"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let client_windows_after_link = input["clientWindowsAfterLink"].as_str().map(str::to_owned);
    let client_windows_after_swap = input["clientWindowsAfterSwap"].as_str().map(str::to_owned);
    let client_windows_after_move = input["clientWindowsAfterMove"].as_str().map(str::to_owned);

    let calls_for_exec = Rc::clone(&calls);
    let calls_for_state = Rc::clone(&calls);
    let mut tmux = TmuxRuntimeManager::with_exec_and_interactive(
        move |args, options| {
            calls_for_exec
                .borrow_mut()
                .push(call_to_value(args, options));
            let joined = args.join(" ");
            let linked = calls_for_state.borrow().iter().any(|call| {
                call["args"]
                    .as_array()
                    .map(|args| {
                        args_to_joined(args) == format!("link-window -d -s {window_id} -t {CLIENT}")
                    })
                    .unwrap_or(false)
            });
            let swapped = calls_for_state.borrow().iter().any(|call| {
                call["args"]
                    .as_array()
                    .map(|args| {
                        args_to_joined(args)
                            == format!("swap-window -s {CLIENT}:{window_id} -t {CLIENT}:0")
                    })
                    .unwrap_or(false)
            });
            let moved = calls_for_state.borrow().iter().any(|call| {
                call["args"]
                    .as_array()
                    .map(|args| {
                        args_to_joined(args)
                            == format!("move-window -s {CLIENT}:{window_id} -t {CLIENT}:0")
                    })
                    .unwrap_or(false)
            });
            if joined == "-V" {
                return Ok("tmux 3.5a".to_owned());
            }
            if joined == format!("has-session -t {CLIENT}") {
                if client_session_missing {
                    return Err("missing".to_owned());
                }
                return Ok(String::new());
            }
            if joined == format!("show-options -v -t {HOST} @aimux-project-root") {
                return Ok("/repo/mobile".to_owned());
            }
            if joined == format!("show-options -v -t {CLIENT} @aimux-host-session") {
                return Ok(current_host_session.clone());
            }
            if joined == format!("show-options -v -t {CLIENT} @aimux-project-root") {
                return Ok(current_project_root.clone());
            }
            if joined == format!("show-options -v -t {CLIENT} @aimux-runtime-build") {
                return Ok(current_runtime_build.clone());
            }
            if joined == format!("show-options -v -t {CLIENT} renumber-windows") {
                return Ok(renumber_windows.clone());
            }
            if joined.starts_with(&format!("show-options -v -t {CLIENT} terminal-features")) {
                return Ok(String::new());
            }
            if joined == "display-message -p #{client_session}" {
                return Ok(current_client_session.clone());
            }
            if joined == format!("display-message -p -t {window_id} #{{pane_in_mode}}") {
                return Ok(target_pane_in_mode.clone());
            }
            if joined == format!("link-window -d -s {window_id} -t {CLIENT}")
                && let Some(error) = &link_error
            {
                return Err(error.clone());
            }
            if joined == format!("move-window -s {CLIENT}:{window_id} -t {CLIENT}:0")
                && let Some(error) = &move_error
            {
                return Err(error.clone());
            }
            if joined == format!("unlink-window -t {CLIENT}:@placeholder")
                && let Some(error) = &unlink_placeholder_error
            {
                return Err(error.clone());
            }
            if joined.starts_with(&format!("list-windows -t {HOST} -F ")) {
                return Ok(host_windows.clone());
            }
            if joined.starts_with(&format!("list-windows -t {CLIENT} -F ")) {
                if swapped && let Some(value) = &client_windows_after_swap {
                    return Ok(value.clone());
                }
                if moved && let Some(value) = &client_windows_after_move {
                    return Ok(value.clone());
                }
                if linked && let Some(value) = &client_windows_after_link {
                    return Ok(value.clone());
                }
                return Ok(client_windows.clone());
            }
            Ok(String::new())
        },
        {
            let interactive_calls = Rc::clone(&interactive_calls);
            move |args, options| {
                interactive_calls
                    .borrow_mut()
                    .push(call_to_value(args, options));
                Ok(())
            }
        },
    );

    let target = target_from_value(&case["input"]["target"]);
    let options = open_options_from_value(&case["input"]["options"]);
    let result = tmux.open_target(&target, options);
    json!({
        "thrown": result.as_ref().err().map_or(Value::Null, |error| json!(error)),
        "result": Value::Null,
        "calls": calls.borrow().iter().filter(|call| interesting_call(call)).map(normalize_call).collect::<Vec<_>>(),
        "interactiveCalls": interactive_calls.borrow().clone(),
    })
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

fn open_options_from_value(value: &Value) -> OpenTargetOptions {
    OpenTargetOptions {
        inside_tmux: value["insideTmux"].as_bool().unwrap_or(false),
        already_resolved: value["alreadyResolved"].as_bool().unwrap_or(false),
        client_suffix: value["clientSuffix"].as_str().map(str::to_owned),
        client_tty: value["clientTty"].as_str().map(str::to_owned),
        return_session_name: value["returnSessionName"].as_str().map(str::to_owned),
    }
}

fn interesting_call(call: &Value) -> bool {
    let args = call["args"].as_array().expect("call args");
    let verb = args.first().and_then(Value::as_str).unwrap_or_default();
    if [
        "new-session",
        "new-window",
        "link-window",
        "move-window",
        "swap-window",
        "unlink-window",
        "kill-window",
    ]
    .contains(&verb)
    {
        return true;
    }
    verb == "set-option"
        && args.get(3).and_then(Value::as_str).is_some_and(|key| {
            [
                "renumber-windows",
                "@aimux-return-session",
                "@aimux-host-session",
                "@aimux-runtime-build",
            ]
            .contains(&key)
        })
}

fn normalize_call(call: &Value) -> Value {
    let mut call = call.clone();
    if call["args"][0] == "set-option" && call["args"][3] == "@aimux-runtime-build" {
        call["args"][4] = Value::String("<runtime-build>".to_owned());
    }
    call
}

fn call_to_value(args: &[String], options: Option<&TmuxExecOptions>) -> Value {
    let mut call = serde_json::Map::new();
    call.insert(
        "args".to_owned(),
        Value::Array(args.iter().cloned().map(Value::String).collect()),
    );
    if let Some(cwd) = options.and_then(|options| options.cwd.as_deref()) {
        call.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    Value::Object(call)
}

fn args_to_joined(args: &[Value]) -> String {
    args.iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
}
