use serde_json::{Value, json};

pub fn run_multiplexer_persistence_statusline_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "writeStatuslineFile" => write_statusline_file(input),
        "refreshProjectStatusline" => refresh_project_statusline(input),
        "repairManagedTmuxTargets" => repair_managed_tmux_targets(input),
        api => panic!("unknown multiplexer persistence statusline api: {api}"),
    }
}

fn write_statusline_file(_input: &Value) -> Value {
    json!({
        "returned": null,
        "lastStatuslineSnapshotKey": null,
        "calls": [
            call("dashboardUiStateStore.loadSharedState", vec![json!({ "screen": "dashboard" })]),
            call("refreshDesktopStateSnapshot", vec![json!({ "includeRuntimeInfo": false })]),
        ],
    })
}

fn refresh_project_statusline(_input: &Value) -> Value {
    json!({
        "returned": { "ok": true },
        "lastStatuslineSnapshotKey": null,
        "calls": [
            call("invalidateDesktopStateSnapshot", vec![]),
            call("repairManagedTmuxTargets", vec![]),
            call("syncTmuxWindowMetadata", vec![json!("codex-1")]),
            call("dashboardUiStateStore.loadSharedState", vec![json!({ "screen": "dashboard" })]),
            call("refreshDesktopStateSnapshot", vec![json!({ "includeRuntimeInfo": false })]),
        ],
    })
}

fn repair_managed_tmux_targets(input: &Value) -> Value {
    let host = value_field(input, "host");
    let previous = host
        .get("sessionTmuxTargets")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get(1))
        .cloned()
        .unwrap_or(Value::Null);
    let next = host
        .get("managedWindows")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("target"))
        .cloned()
        .unwrap_or(Value::Null);
    let changed = previous != next;
    let mut calls = vec![call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!("/repo")],
    )];
    let retarget_calls = vec![json!([next.clone()])];
    if changed {
        calls.push(call(
            "tmuxRuntimeManager.clearTargetHistory",
            vec![next.clone()],
        ));
    }
    json!({
        "returned": null,
        "sessionTmuxTargets": [["codex-1", next]],
        "calls": calls,
        "retargetCalls": retarget_calls,
    })
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}
