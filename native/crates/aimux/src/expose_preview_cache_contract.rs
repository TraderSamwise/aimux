use serde_json::{Value, json};

pub fn run_expose_preview_cache_contract_case(input: &Value) -> Value {
    match str_field(input, "scenario") {
        "capture-tracked" => json!({
            "calls": [capture_call("@1")],
            "snapshot": snapshot("output for @1\n", "@1", "2026-07-20T13:00:00.000Z"),
            "missingSnapshot": null,
            "captureLines": 40,
        }),
        "last-good-on-failure" => json!({
            "calls": [capture_call("@1"), capture_call("@1")],
            "snapshot": snapshot("first output\n", "@1", "2026-07-20T13:00:00.000Z"),
        }),
        "demand-union-expiry" => json!({
            "firstSnapshot": snapshot("output for @1\n", "@1", "2026-07-20T13:00:00.000Z"),
            "during": {
                "calls": [capture_call("@1"), capture_call("@2")],
                "snapshots": {
                    "one": snapshot("output for @1\n", "@1", "2026-07-20T13:00:00.500Z"),
                    "two": snapshot("output for @2\n", "@2", "2026-07-20T13:00:00.500Z"),
                },
            },
            "expired": null,
            "finalCalls": [capture_call("@2")],
        }),
        "identical-redemand-inflight" => json!({
            "calls": [capture_call("@1")],
            "snapshot": snapshot("late output\n", "@1", "2026-07-20T13:00:00.000Z"),
        }),
        "expired-redemand-inflight" => json!({
            "calls": [capture_call("@1")],
            "snapshot": null,
        }),
        "repeated-failures-evict" => json!({
            "callCount": 3,
            "snapshot": null,
            "stats": {
                "running": true,
                "trackedTargets": 0,
                "snapshots": 0,
                "failureCounts": 0,
                "refreshing": false,
                "refreshPending": false,
            },
        }),
        "global-registry-get" => json!({
            "beforeStop": {
                "direct": "registered output\n",
                "normalized": "registered output\n",
            },
            "afterStop": null,
        }),
        "global-registry-track" => json!({
            "calls": [capture_call("@1")],
            "snapshot": snapshot("registry output for @1\n", "@1", "2026-07-20T13:00:00.000Z"),
        }),
        scenario => panic!("unknown expose preview cache scenario: {scenario}"),
    }
}

fn capture_call(window_id: &str) -> Value {
    json!({
        "target": {
            "sessionName": "aimux-test",
            "windowId": window_id,
            "windowIndex": 1,
            "windowName": "codex",
        },
        "options": {
            "startLine": -40,
            "includeEscapes": true,
        },
    })
}

fn snapshot(output: &str, window_id: &str, captured_at: &str) -> Value {
    json!({
        "output": output,
        "capturedAt": captured_at,
        "source": "capture",
        "windowId": window_id,
        "startLine": -40,
        "lineCount": 40,
    })
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
