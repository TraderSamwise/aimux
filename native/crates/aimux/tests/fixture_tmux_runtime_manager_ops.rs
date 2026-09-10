use aimux::tmux::{
    CapturePaneOptions, PanePipeFileOptions, PanePipeFileOwnership, TmuxManagedWindow,
    TmuxRuntimeManager, TmuxTarget,
};
use aimux::tmux_query_memo::reset_tmux_query_memo;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

const TMUX_RUNTIME_MANAGER_OPS: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/runtime-manager-ops.json");

#[test]
fn fixture_tmux_runtime_manager_ops_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_RUNTIME_MANAGER_OPS).expect("valid runtime manager ops fixture");
    let cases = contract["cases"].as_array().expect("runtime manager cases");
    assert_eq!(cases.len(), 10, "unexpected runtime manager case count");

    let mut failures = Vec::new();
    for case in cases {
        reset_tmux_query_memo();
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    reset_tmux_query_memo();

    assert!(
        failures.is_empty(),
        "{} tmux-runtime-manager-ops parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let exec_calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let created_dashboard = Rc::new(RefCell::new(false));
    let responses = input.get("responses").cloned().unwrap_or(Value::Null);
    let errors = input
        .get("errors")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let error_message = input
        .get("errorMessage")
        .and_then(Value::as_str)
        .unwrap_or("tmux unavailable")
        .to_owned();
    let list_windows_raw = input
        .get("listWindowsRaw")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let list_windows_after_create = input
        .get("listWindowsAfterCreate")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let list_managed_windows_raw = input
        .get("listManagedWindowsRaw")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let exec_calls_for_exec = Rc::clone(&exec_calls);
    let created_dashboard_for_exec = Rc::clone(&created_dashboard);
    let mut tmux = TmuxRuntimeManager::with_exec(move |args, options| {
        exec_calls_for_exec.borrow_mut().push(call_to_value(
            args,
            options.and_then(|options| options.cwd.as_deref()),
        ));
        let joined = args.join(" ");
        if errors.contains(&joined) {
            return Err(error_message.clone());
        }
        if joined
            == "list-windows -t aimux-mobile-abc -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}"
        {
            if *created_dashboard_for_exec.borrow()
                && let Some(after_create) = &list_windows_after_create
            {
                return Ok(after_create.clone());
            }
            return Ok(list_windows_raw.clone());
        }
        if joined
            == "list-windows -t aimux-mobile-abc -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}"
        {
            return Ok(list_managed_windows_raw.clone());
        }
        if joined
            == "new-window -d -t aimux-mobile-abc -c /repo/mobile -n dashboard sh -lc tail -f /dev/null"
        {
            *created_dashboard_for_exec.borrow_mut() = true;
            return Ok(String::new());
        }
        if joined == "capture-pane -p -J -t @3 -S -" {
            return Ok("default capture".to_owned());
        }
        if joined == "capture-pane -p -J -e -t @3 -S 0 -E 1999" {
            return Ok("bounded capture".to_owned());
        }
        if let Some(response) = responses.get(&joined).and_then(Value::as_str) {
            return Ok(response.to_owned());
        }
        Ok(String::new())
    });

    match run_named_case(case["name"].as_str().expect("case name"), &mut tmux) {
        Ok(result) => json!({
            "thrown": Value::Null,
            "result": result,
            "snapshot": { "execCalls": exec_calls.borrow().clone() }
        }),
        Err(error) => json!({
            "thrown": error,
            "result": Value::Null,
            "snapshot": { "execCalls": exec_calls.borrow().clone() }
        }),
    }
}

fn run_named_case(name: &str, tmux: &mut TmuxRuntimeManager) -> Result<Value, String> {
    match name {
        "captures default pane tail" => tmux
            .capture_target(&target(), CapturePaneOptions::default())
            .map(Value::String),
        "captures bounded pane output with escapes" => tmux
            .capture_target(
                &target(),
                CapturePaneOptions {
                    start_line: Some(0),
                    end_line: Some(1999),
                    include_escapes: true,
                },
            )
            .map(Value::String),
        "starts file pane pipes with quoted sinks and ownership" => {
            tmux.start_pane_pipe(&target(), "cat >> /tmp/plain.log", false)?;
            tmux.pipe_target_to_file(
                &target(),
                "/tmp/aimux tap/it's.log",
                PanePipeFileOptions {
                    only_if_not_piped: true,
                    ownership: None,
                },
            )?;
            tmux.pipe_target_to_file(
                &target(),
                "/tmp/aimux tap/output.log",
                PanePipeFileOptions {
                    only_if_not_piped: true,
                    ownership: Some(PanePipeFileOwnership {
                        token: "tap-token".to_owned(),
                        token_file_path: "/tmp/aimux tap/token.txt".to_owned(),
                    }),
                },
            )?;
            tmux.stop_pane_pipe(&target())?;
            Ok(Value::Null)
        }
        "collects persisted command text from global and per-session tmux stores"
        | "marks persisted command text incomplete while keeping successful reads" => {
            let result = tmux.list_persisted_command_text();
            Ok(json!({
                "text": result.text,
                "complete": result.complete,
            }))
        }
        "renames an existing dashboard window" | "creates a dashboard window when absent" => tmux
            .ensure_dashboard_window("aimux-mobile-abc", "/repo/mobile", None)
            .map(|target| target_to_value(&target)),
        "lists managed windows and skips invalid metadata" => Ok(managed_to_value(
            tmux.list_managed_windows("aimux-mobile-abc")?,
        )),
        "finds managed windows by session or backend id" => Ok(json!({
            "bySession": tmux.find_managed_window("aimux-mobile-abc", Some("codex-1"), None)
                .map(|entry| entry.map(|entry| target_to_value(&entry.target)))?,
            "byBackend": tmux.find_managed_window("aimux-mobile-abc", None, Some("backend-existing"))
                .map(|entry| entry.map(|entry| target_to_value(&entry.target)))?,
            "missing": tmux.find_managed_window("aimux-mobile-abc", None, None)
                .map(|entry| entry.map(|entry| managed_entry_to_value(&entry)))?,
        })),
        "cancels copy mode only when pane is in mode" => {
            tmux.cancel_copy_mode(dashboard_target().window_id)?;
            tmux.cancel_copy_mode(target().window_id)?;
            Ok(Value::Null)
        }
        unexpected => panic!("unexpected case {unexpected}"),
    }
}

fn target() -> TmuxTarget {
    TmuxTarget {
        session_name: "aimux-mobile-abc".to_owned(),
        window_id: "@3".to_owned(),
        window_index: 3,
        window_name: "codex".to_owned(),
        pane_dead: None,
    }
}

fn dashboard_target() -> TmuxTarget {
    TmuxTarget {
        session_name: "aimux-mobile-abc".to_owned(),
        window_id: "@0".to_owned(),
        window_index: 0,
        window_name: "dashboard".to_owned(),
        pane_dead: None,
    }
}

fn managed_to_value(entries: Vec<TmuxManagedWindow>) -> Value {
    Value::Array(
        entries
            .into_iter()
            .map(|entry| managed_entry_to_value(&entry))
            .collect(),
    )
}

fn managed_entry_to_value(entry: &TmuxManagedWindow) -> Value {
    json!({
        "target": target_to_value(&entry.target),
        "metadata": entry.metadata,
    })
}

fn target_to_value(target: &TmuxTarget) -> Value {
    let mut value = Map::from_iter([
        (
            "sessionName".to_owned(),
            Value::String(target.session_name.clone()),
        ),
        (
            "windowId".to_owned(),
            Value::String(target.window_id.clone()),
        ),
        ("windowIndex".to_owned(), Value::from(target.window_index)),
        (
            "windowName".to_owned(),
            Value::String(target.window_name.clone()),
        ),
    ]);
    if let Some(pane_dead) = target.pane_dead {
        value.insert("paneDead".to_owned(), Value::Bool(pane_dead));
    }
    Value::Object(value)
}

fn call_to_value(args: &[String], cwd: Option<&str>) -> Value {
    let mut call = args.iter().cloned().map(Value::String).collect::<Vec<_>>();
    if let Some(cwd) = cwd {
        call.push(json!({ "cwd": cwd }));
    }
    Value::Array(call)
}
