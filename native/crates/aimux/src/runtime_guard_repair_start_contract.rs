use serde_json::{Value, json};

const FIXED_NOW_MS: i64 = 1_700_000_000_000;
const RUNTIME_GUARD_REPAIR_RETRY_MS: i64 = 5_000;

pub fn run_runtime_guard_repair_start_contract_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(run_scenario)
            .collect(),
    )
}

fn run_scenario(scenario: &Value) -> Value {
    let name = scenario.get("name").cloned().unwrap_or(Value::Null);
    let state = value_field(scenario, "state").clone();
    let project_root = string_field(scenario, "projectRoot");
    let restart_kind = scenario
        .get("restartBehavior")
        .and_then(|behavior| behavior.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let repair_key = repair_key(&state);
    let started_notice = repair_notice("started", "Aimux repair started", None);
    let restart_calls = json!([restart_call(&project_root)]);

    match restart_kind {
        "resolve" => json!({
            "name": name,
            "host": {
                "runtimeGuardRepairing": false,
                "runtimeGuardRepairBusy": false,
                "runtimeGuardRepairFailedKey": Value::Null,
                "runtimeGuardRepairRetryAt": Value::Null,
                "runtimeGuardRepairTimedOutPending": false,
                "dashboardBusyState": Value::Null,
                "dashboardErrorState": Value::Null,
                "runtimeGuardState": { "kind": "ok" },
                "footerFlash": Value::Null,
                "footerFlashTicks": Value::Null,
                "dashboardRepairNotices": [
                    started_notice,
                    repair_notice("succeeded", "Aimux repair complete", None),
                ],
                "runtimeGuardRepairAttempts": [FIXED_NOW_MS],
            },
            "calls": [
                { "method": "renderCurrentDashboardView", "args": [] },
                { "method": "reloadDashboardAfterRuntimeGuardRepair", "args": [project_root] },
            ],
            "restartCalls": restart_calls,
            "lockExists": false,
        }),
        "reject" => {
            let message = scenario
                .get("restartBehavior")
                .and_then(|behavior| behavior.get("message"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error = message.to_owned();
            json!({
                "name": name,
                "host": {
                    "runtimeGuardRepairing": false,
                    "runtimeGuardRepairBusy": false,
                    "runtimeGuardRepairFailedKey": repair_key,
                    "runtimeGuardRepairRetryAt": FIXED_NOW_MS + RUNTIME_GUARD_REPAIR_RETRY_MS,
                    "runtimeGuardRepairTimedOutPending": false,
                    "dashboardBusyState": Value::Null,
                    "dashboardErrorState": { "title": "Aimux repair failed", "lines": [error] },
                    "runtimeGuardState": state,
                    "footerFlash": Value::Null,
                    "footerFlashTicks": Value::Null,
                    "dashboardRepairNotices": [
                        started_notice,
                        repair_notice("failed", "Aimux repair failed", Some(&error)),
                    ],
                    "runtimeGuardRepairAttempts": [FIXED_NOW_MS],
                },
                "calls": [
                    { "method": "renderCurrentDashboardView", "args": [] },
                    { "method": "showDashboardError", "args": ["Aimux repair failed", [error]] },
                ],
                "restartCalls": restart_calls,
                "lockExists": false,
            })
        }
        _ => json!({
            "name": name,
            "host": {
                "runtimeGuardRepairing": true,
                "runtimeGuardRepairBusy": true,
                "runtimeGuardRepairFailedKey": Value::Null,
                "runtimeGuardRepairRetryAt": Value::Null,
                "runtimeGuardRepairTimedOutPending": false,
                "dashboardBusyState": {
                    "title": "Repairing Aimux",
                    "lines": ["Aimux is repairing the local control plane."],
                    "spinnerFrame": 0,
                    "startedAt": FIXED_NOW_MS,
                },
                "dashboardErrorState": Value::Null,
                "runtimeGuardState": state,
                "footerFlash": Value::Null,
                "footerFlashTicks": Value::Null,
                "dashboardRepairNotices": [started_notice],
                "runtimeGuardRepairAttempts": [FIXED_NOW_MS],
            },
            "calls": [{ "method": "renderCurrentDashboardView", "args": [] }],
            "restartCalls": restart_calls,
            "lockExists": true,
        }),
    }
}

fn repair_key(state: &Value) -> String {
    let kind = string_field(state, "kind");
    if kind == "stale" {
        format!("stale:{}", string_field(state, "reason"))
    } else {
        kind
    }
}

fn restart_call(project_root: &str) -> Value {
    json!({
        "reason": "dashboard-runtime-guard-repair",
        "projectRoot": project_root,
        "reloadDashboards": false,
        "verifyDashboards": false,
        "abortSignalAborted": false,
    })
}

fn repair_notice(phase: &str, message: &str, error: Option<&str>) -> Value {
    let mut notice = json!({
        "kind": "runtime-guard-repair",
        "phase": phase,
        "message": message,
        "at": FIXED_NOW_MS,
    });
    if let Some(error) = error {
        notice["error"] = json!(error);
    }
    notice
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
