use aimux::tmux::{CapturePaneOptions, TmuxRuntimeManager};
use aimux::tmux_query_memo::{
    is_in_tmux_query_memo_scope, memoized_tmux_query, reset_tmux_query_memo, tmux_query_key,
    with_tmux_query_memo,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;

const TMUX_QUERY_MEMO: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/query-memo.json");

#[test]
fn fixture_tmux_query_memo_matches_typescript_contract() {
    let contract: Value = serde_json::from_str(TMUX_QUERY_MEMO).expect("valid query memo fixture");
    let cases = contract["cases"].as_array().expect("query memo cases");
    assert_eq!(cases.len(), 13, "unexpected query memo case count");

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
        "{} tmux-query-memo parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    reset_tmux_query_memo();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let snapshot = match case["name"].as_str().expect("case name") {
            "is inert outside a scope" => inert_outside_scope(),
            "answers a repeated question once inside one scope" => repeated_question_once(),
            "keys separately and includes cwd" => keys_include_cwd(),
            "clears even when the scope throws" => clears_on_panic(),
            "inherits an outer scope rather than nesting a fresh one" => inherits_outer_scope(),
            "memoizes a failure" => memoizes_failure(),
            "re-asks after a reset" => reasks_after_reset(),
            "asks tmux once for a repeated read inside a scope" => repeated_read_exec_boundary(),
            "re-reads after a mutation" => rereads_after_mutation(),
            "never memoizes pane contents" => never_memoizes_pane_contents(),
            "keeps the memo across a pane capture" => keeps_memo_across_capture(),
            "re-reads on every poll after reset" => rereads_after_poll_reset(),
            "is inert with no scope open" => inert_no_scope_exec_boundary(),
            unexpected => panic!("unexpected case {unexpected}"),
        };
        json!({ "thrown": Value::Null, "snapshot": snapshot })
    }));
    reset_tmux_query_memo();
    match result {
        Ok(output) => output,
        Err(payload) => json!({
            "thrown": panic_message(payload),
            "snapshot": Value::Null,
        }),
    }
}

fn inert_outside_scope() -> Value {
    let mut calls = 0;
    let _ = memoized_tmux_query("k", || {
        calls += 1;
        Ok("x".to_owned())
    });
    let _ = memoized_tmux_query("k", || {
        calls += 1;
        Ok("x".to_owned())
    });
    json!({ "calls": calls, "inScope": is_in_tmux_query_memo_scope() })
}

fn repeated_question_once() -> Value {
    let calls = Rc::new(RefCell::new(0));
    let result = with_tmux_query_memo(|| {
        vec![
            compute_counted(&calls, "list-windows"),
            compute_counted(&calls, "list-windows"),
            compute_counted(&calls, "list-windows"),
        ]
    });
    json!({ "result": result, "calls": *calls.borrow(), "inScope": is_in_tmux_query_memo_scope() })
}

fn keys_include_cwd() -> Value {
    let args = vec!["list-windows".to_owned(), "-t".to_owned(), "s".to_owned()];
    json!({
        "keys": [
            tmux_query_key(&args, None),
            tmux_query_key(&args, Some("/repo/a")),
            tmux_query_key(&args, Some("/repo/b")),
        ]
    })
}

fn clears_on_panic() -> Value {
    let result = catch_unwind(AssertUnwindSafe(|| {
        with_tmux_query_memo(|| {
            panic!("snapshot failed");
        });
    }));
    json!({
        "thrown": result.err().map(panic_message).unwrap_or_else(|| Value::Null),
        "inScope": is_in_tmux_query_memo_scope(),
    })
}

fn inherits_outer_scope() -> Value {
    let calls = Rc::new(RefCell::new(0));
    let inner_scope = with_tmux_query_memo(|| {
        let _ = compute_counted(&calls, "k");
        with_tmux_query_memo(|| {
            json!({
                "value": compute_counted(&calls, "k"),
                "inScope": is_in_tmux_query_memo_scope(),
            })
        })
    });
    json!({ "innerScope": inner_scope, "calls": *calls.borrow(), "inScope": is_in_tmux_query_memo_scope() })
}

fn memoizes_failure() -> Value {
    let mut calls = 0;
    let mut thrown = Vec::new();
    with_tmux_query_memo(|| {
        for _ in 0..2 {
            let result = memoized_tmux_query("k", || {
                calls += 1;
                Err("no server".to_owned())
            });
            if let Err(error) = result {
                thrown.push(Value::String(error));
            }
        }
    });
    json!({ "calls": calls, "thrown": thrown })
}

fn reasks_after_reset() -> Value {
    let mut calls = 0;
    with_tmux_query_memo(|| {
        let _ = memoized_tmux_query("k", || {
            calls += 1;
            Ok("x".to_owned())
        });
        reset_tmux_query_memo();
        let _ = memoized_tmux_query("k", || {
            calls += 1;
            Ok("x".to_owned())
        });
    });
    json!({ "calls": calls })
}

fn repeated_read_exec_boundary() -> Value {
    let (mut tmux, log) = manager_with();
    with_tmux_query_memo(|| {
        tmux.has_session("s");
        tmux.has_session("s");
        tmux.has_session("s");
    });
    json!({ "log": *log.borrow() })
}

fn rereads_after_mutation() -> Value {
    let (mut tmux, log) = manager_with();
    with_tmux_query_memo(|| {
        tmux.has_session("s");
        let _ = tmux.rename_window("@1", "renamed");
        tmux.has_session("s");
    });
    json!({ "log": *log.borrow() })
}

fn never_memoizes_pane_contents() -> Value {
    let (mut tmux, log) = manager_with();
    let target = target();
    let captures = with_tmux_query_memo(|| {
        vec![
            tmux.capture_target(&target, CapturePaneOptions::default())
                .unwrap(),
            tmux.capture_target(&target, CapturePaneOptions::default())
                .unwrap(),
        ]
    });
    json!({ "captures": captures, "log": *log.borrow() })
}

fn keeps_memo_across_capture() -> Value {
    let (mut tmux, log) = manager_with();
    let target = target();
    with_tmux_query_memo(|| {
        tmux.has_session("s");
        let _ = tmux.capture_target(&target, CapturePaneOptions::default());
        tmux.has_session("s");
    });
    json!({ "log": *log.borrow() })
}

fn rereads_after_poll_reset() -> Value {
    let (mut tmux, log) = manager_with();
    with_tmux_query_memo(|| {
        for _ in 0..3 {
            reset_tmux_query_memo();
            tmux.has_session("s");
        }
    });
    json!({ "log": *log.borrow() })
}

fn inert_no_scope_exec_boundary() -> Value {
    let (mut tmux, log) = manager_with();
    tmux.has_session("s");
    tmux.has_session("s");
    json!({ "log": *log.borrow() })
}

fn compute_counted(calls: &Rc<RefCell<i64>>, key: &str) -> String {
    memoized_tmux_query(key, || {
        *calls.borrow_mut() += 1;
        Ok(if key == "list-windows" {
            "windows"
        } else {
            "x"
        }
        .to_owned())
    })
    .unwrap()
}

fn manager_with() -> (TmuxRuntimeManager, Rc<RefCell<Vec<Value>>>) {
    let log = Rc::new(RefCell::new(Vec::new()));
    let log_for_exec = Rc::clone(&log);
    let manager = TmuxRuntimeManager::with_exec(move |args, options| {
        let mut entry: Vec<Value> = args.iter().cloned().map(Value::String).collect();
        if let Some(cwd) = options.and_then(|options| options.cwd.as_ref()) {
            entry.push(json!({ "cwd": cwd }));
        }
        log_for_exec.borrow_mut().push(Value::Array(entry));
        Ok(if args.first().is_some_and(|arg| arg == "capture-pane") {
            format!("capture-{}", log_for_exec.borrow().len())
        } else {
            "ok".to_owned()
        })
    });
    (manager, log)
}

fn target() -> aimux::tmux::TmuxTarget {
    aimux::tmux::TmuxTarget {
        session_name: "s".into(),
        window_id: "@1".into(),
        window_index: 0,
        window_name: String::new(),
        pane_dead: None,
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> Value {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return Value::String((*message).to_owned());
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return Value::String(message.clone());
    }
    Value::String("panic".to_owned())
}
