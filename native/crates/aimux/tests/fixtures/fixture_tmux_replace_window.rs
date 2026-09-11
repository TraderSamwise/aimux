use aimux::tmux::{TmuxCommandSpec, TmuxRuntimeManager, TmuxTarget};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

const TMUX_REPLACE_WINDOW: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/replace-window.json");

#[test]
fn fixture_tmux_replace_window_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_REPLACE_WINDOW).expect("valid replace window fixture");
    let cases = contract["cases"].as_array().expect("replace window cases");
    assert_eq!(cases.len(), 3, "unexpected replace window case count");

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
        "{} tmux-replace-window parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn replacement_failure_reports_child_output_before_timeout() {
    let calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push(call_to_value(
            args,
            options.and_then(|options| options.cwd.as_deref()),
        ));
        let joined = args.join(" ");
        if joined == "display-message -p -t @1 #{window_active}" {
            return Ok("1".to_owned());
        }
        if joined.starts_with("new-window -d -P -t aimux-mobile-abc ") {
            return Ok("@2\t2\taimux-reload-1-rust".to_owned());
        }
        if joined == "show-window-options -v -t @2 @ready" {
            return Ok(String::new());
        }
        if joined == "display-message -p -t @2 #{pane_dead}" {
            return Ok("1".to_owned());
        }
        if joined == "capture-pane -p -J -t @2 -S -80" {
            return Ok("dashboard crashed while parsing /desktop-state".to_owned());
        }
        Ok(String::new())
    });

    let result = manager.replace_window_when_ready(
        &target_from_value(&json!({
            "sessionName": "aimux-mobile-abc",
            "windowId": "@1",
            "windowIndex": 0,
            "windowName": "dashboard"
        })),
        &command_spec_from_value(&json!({
            "cwd": "/repo/mobile",
            "command": "/usr/local/bin/node",
            "args": ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"]
        })),
        "@ready",
        "stamp",
        10_000,
    );

    let error = result.expect_err("dead replacement should fail immediately");
    assert!(
        error.contains("Replacement tmux window @2 exited before dashboard readiness"),
        "{error}"
    );
    assert!(
        error.contains("dashboard crashed while parsing /desktop-state"),
        "{error}"
    );
    assert_eq!(
        calls.borrow().last(),
        Some(&json!(["kill-window", "-t", "@2"]))
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let calls_for_exec = calls.clone();
    let was_active = input["wasActive"].as_bool().unwrap_or_default();
    let swap_error = input
        .get("swapError")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push(call_to_value(
            args,
            options.and_then(|options| options.cwd.as_deref()),
        ));
        let joined = args.join(" ");
        if joined == "display-message -p -t @1 #{window_active}" {
            return Ok(if was_active { "1" } else { "0" }.to_owned());
        }
        if joined.starts_with("new-window -d -P -t aimux-mobile-abc ") {
            return Ok("@2\t2\taimux-reload-1-rust".to_owned());
        }
        if joined == "show-window-options -v -t @2 @ready" {
            return Ok("stamp".to_owned());
        }
        if swap_error.is_some() && joined == "swap-window -d -s @2 -t @1" {
            return Err(swap_error.clone().unwrap_or_default());
        }
        if joined.starts_with("list-windows -t aimux-mobile-abc -F ") {
            return Ok([
                "@2\t0\tdashboard\t1\t100\t0",
                "@1\t2\tdashboard-old\t0\t90\t0",
            ]
            .join("\n"));
        }
        Ok(String::new())
    });
    let result = manager.replace_window_when_ready(
        &target_from_value(&input["target"]),
        &command_spec_from_value(&input["spec"]),
        input["readiness"]["option"]
            .as_str()
            .expect("readiness option"),
        input["readiness"]["value"]
            .as_str()
            .expect("readiness value"),
        input["readiness"]["timeoutMs"]
            .as_u64()
            .expect("readiness timeout"),
    );
    let output = match result {
        Ok(target) => json!({
            "thrown": Value::Null,
            "result": target_to_value(&target),
            "calls": calls.borrow().clone(),
        }),
        Err(error) => json!({
            "thrown": error,
            "result": Value::Null,
            "calls": calls.borrow().clone(),
        }),
    };
    normalize_value(output)
}

fn command_spec_from_value(value: &Value) -> TmuxCommandSpec {
    TmuxCommandSpec {
        cwd: value["cwd"].as_str().expect("cwd").to_owned(),
        command: value["command"].as_str().expect("command").to_owned(),
        args: value["args"]
            .as_array()
            .expect("args")
            .iter()
            .map(|value| value.as_str().expect("arg").to_owned())
            .collect(),
    }
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

fn target_to_value(target: &TmuxTarget) -> Value {
    let mut value = json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    });
    if let Some(pane_dead) = target.pane_dead {
        value["paneDead"] = json!(pane_dead);
    }
    value
}

fn call_to_value(args: &[String], cwd: Option<&str>) -> Value {
    let mut call = args.iter().cloned().map(Value::String).collect::<Vec<_>>();
    if let Some(cwd) = cwd {
        call.push(json!({ "cwd": cwd }));
    }
    Value::Array(call)
}

fn normalize_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(normalize_reload_name(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(normalize_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, normalize_value(value)))
                .collect(),
        ),
        value => value,
    }
}

fn normalize_reload_name(value: &str) -> String {
    let Some(start) = value.find("aimux-reload-") else {
        return value.to_owned();
    };
    let end = value[start..]
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')))
        .map(|offset| start + offset)
        .unwrap_or(value.len());
    let mut normalized = String::with_capacity(value.len());
    normalized.push_str(&value[..start]);
    normalized.push_str("<RELOAD_WINDOW>");
    normalized.push_str(&value[end..]);
    normalized
}
