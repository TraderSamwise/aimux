use serde_json::{Value, json};

pub fn run_dashboard_model_metadata_pending_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    let mut pending = input
        .get("initialPendingKind")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut timers = Vec::new();

    let Some(session_id) = input.get("sessionId").and_then(Value::as_str) else {
        calls.push(call("work", vec![]));
        return json!({
            "result": { "ok": true, "value": work_result(input) },
            "pending": Value::Null,
            "timers": timers,
            "calls": calls,
        });
    };

    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("creating");
    set_pending(input, &mut calls, &mut pending, session_id, kind);
    calls.push(call("work", vec![]));

    if let Some(message) = input.get("workThrows").and_then(Value::as_str) {
        clear_after_failure(input, &mut calls, &mut pending, session_id, kind);
        return json!({
            "result": { "ok": false, "error": error_json(message) },
            "pending": pending_value(pending),
            "timers": timers,
            "calls": calls,
        });
    }

    let result_value = work_result(input);
    let await_settle = input
        .get("options")
        .and_then(|options| options.get("awaitSettle"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if await_settle {
        if input.get("settle").is_some() {
            settle(input, &mut calls, session_id, kind, &result_value);
        }
        if let Some(message) = input.get("settleThrows").and_then(Value::as_str) {
            clear_after_failure(input, &mut calls, &mut pending, session_id, kind);
            return json!({
                "result": { "ok": false, "error": error_json(message) },
                "pending": pending_value(pending),
                "timers": timers,
                "calls": calls,
            });
        }
        cleanup_pending(input, &mut calls, &mut pending, session_id, kind);
    } else {
        timers.push(json!({ "delay": 0 }));
        if input.get("fireTimers").and_then(Value::as_bool) == Some(true) {
            if input.get("settle").is_some() {
                settle(input, &mut calls, session_id, kind, &result_value);
            }
            cleanup_pending(input, &mut calls, &mut pending, session_id, kind);
        }
    }

    json!({
        "result": { "ok": true, "value": result_value },
        "pending": pending_value(pending),
        "timers": timers,
        "calls": calls,
    })
}

fn set_pending(
    input: &Value,
    calls: &mut Vec<Value>,
    pending: &mut Option<String>,
    session_id: &str,
    kind: &str,
) {
    calls.push(call(
        "dashboardPendingActions.setSessionAction",
        vec![
            json!(session_id),
            json!(kind),
            json!({ "sessionSeed": input.get("sessionSeed").cloned().unwrap_or(Value::Null) }),
        ],
    ));
    *pending = Some(kind.to_owned());
    calls.push(call("reapplyDashboardPendingActions", vec![]));
}

fn settle(input: &Value, calls: &mut Vec<Value>, session_id: &str, kind: &str, result: &Value) {
    calls.push(call("settle", vec![result.clone()]));
    if let Some(message) = input.get("settleThrows").and_then(Value::as_str) {
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "metadata pending action settle failed: session {kind} {session_id}: {message}"
                )),
                json!("dashboard"),
            ],
        ));
    } else if input.get("settle").and_then(Value::as_bool) == Some(false) {
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "metadata pending action did not settle: session {kind} {session_id}"
                )),
                json!("dashboard"),
            ],
        ));
    }
}

fn cleanup_pending(
    input: &Value,
    calls: &mut Vec<Value>,
    pending: &mut Option<String>,
    session_id: &str,
    kind: &str,
) {
    if let Some(token) = input.get("pendingToken").and_then(Value::as_i64) {
        calls.push(call(
            "dashboardPendingActions.clearSessionActionIfToken",
            vec![json!(session_id), json!(token)],
        ));
        if input
            .get("clearTokenResult")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            *pending = None;
            calls.push(call("reapplyDashboardPendingActions", vec![]));
            schedule_reconcile(calls);
        }
    } else {
        calls.push(call(
            "dashboardPendingActions.getSessionAction",
            vec![json!(session_id)],
        ));
        if pending.as_deref() == Some(kind) {
            calls.push(call(
                "dashboardPendingActions.clearSessionAction",
                vec![json!(session_id)],
            ));
            *pending = None;
            calls.push(call("reapplyDashboardPendingActions", vec![]));
            schedule_reconcile(calls);
        }
    }
}

fn clear_after_failure(
    input: &Value,
    calls: &mut Vec<Value>,
    pending: &mut Option<String>,
    session_id: &str,
    kind: &str,
) {
    cleanup_pending(input, calls, pending, session_id, kind);
}

fn schedule_reconcile(calls: &mut Vec<Value>) {
    calls.push(call(
        "refreshDashboardModelFromService",
        vec![json!(true), json!({ "lifecycle": { "mode": "dashboard" } })],
    ));
    calls.push(call("isDashboardScreen", vec![json!("dashboard")]));
    calls.push(call("renderDashboard", vec![]));
}

fn work_result(input: &Value) -> Value {
    input
        .get("workResult")
        .cloned()
        .unwrap_or_else(|| json!({ "ok": true }))
}

fn pending_value(pending: Option<String>) -> Value {
    pending.map(Value::String).unwrap_or(Value::Null)
}

fn error_json(message: &str) -> Value {
    json!({ "name": "Error", "message": message })
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}
