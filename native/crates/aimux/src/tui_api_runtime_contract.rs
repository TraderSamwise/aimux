use serde_json::{Value, json};

const NOW: i64 = 1_700_000_000_000;
const RECOVERY_DEBOUNCE_MS: i64 = 250;
const RECOVERY_COOLDOWN_MS: i64 = 1_000;
const RECOVERY_BACKOFF_MAX_MS: i64 = 30_000;

pub fn run_tui_api_runtime_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "isTuiApiConnectionMutationBlocked" => {
            if let Some(snapshots) = input.get("snapshots").and_then(Value::as_array) {
                Value::Array(
                    snapshots
                        .iter()
                        .map(|snapshot| {
                            json!({
                                "snapshot": snapshot,
                                "blocked": is_mutation_blocked(snapshot, value_field(input, "options")),
                            })
                        })
                        .collect(),
                )
            } else {
                Value::Bool(is_mutation_blocked(
                    value_field(input, "snapshot"),
                    value_field(input, "options"),
                ))
            }
        }
        "isRecoverableTuiApiError" => {
            if let Some(errors) = input.get("errors").and_then(Value::as_array) {
                Value::Array(
                    errors
                        .iter()
                        .map(|error| {
                            json!({
                                "error": error,
                                "recoverable": is_recoverable_tui_api_error(error),
                            })
                        })
                        .collect(),
                )
            } else {
                Value::Bool(is_recoverable_tui_api_error(value_field(input, "error")))
            }
        }
        "hasTuiApiRuntimeReadTransport" => Value::Array(
            input
                .get("hosts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|host| {
                    let host = host.as_str().unwrap_or_default();
                    json!({
                        "host": host,
                        "hasReadTransport": host == "with-read-transport",
                    })
                })
                .collect(),
        ),
        "scheduleTuiApiRecovery" => schedule_tui_api_recovery(input),
        api => panic!("unknown tui api runtime api: {api}"),
    }
}

fn is_mutation_blocked(snapshot: &Value, options: &Value) -> bool {
    if options.get("allowDuringReconnect").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if !snapshot
        .get("failedCriticalResources")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true)
    {
        return true;
    }
    matches!(
        str_field(snapshot, "state"),
        "failed" | "reconnecting" | "stale" | "repairing"
    )
}

fn is_recoverable_tui_api_error(error: &Value) -> bool {
    match error.get("tuiApiRecoverable").and_then(Value::as_bool) {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    if let Some(status) = error.get("status").and_then(Value::as_i64) {
        if matches!(status, 408 | 409 | 425 | 429) || status >= 500 {
            return true;
        }
        if (400..500).contains(&status) {
            return false;
        }
    }
    if matches!(
        str_field(error, "code"),
        "ETIMEDOUT" | "ECONNREFUSED" | "ECONNRESET" | "EPIPE"
    ) {
        return true;
    }
    true
}

fn schedule_tui_api_recovery(input: &Value) -> Value {
    if !matches!(str_field(input, "mode"), "" | "dashboard") {
        return json!({
            "host": {
                "tuiApiRecoveryPending": false,
                "tuiApiRecoveryInFlight": false,
                "tuiApiRecoveryTimer": Value::Null,
                "dashboardRepairNotices": [],
            },
            "timers": [],
            "cleared": [],
            "unref": [],
            "calls": [],
        });
    }

    if input.get("inFlight").and_then(Value::as_bool) == Some(true) {
        return json!({
            "host": {
                "tuiApiRecoveryPending": true,
                "tuiApiRecoveryInFlight": true,
                "tuiApiRecoveryTimer": Value::Null,
                "dashboardRepairNotices": [],
            },
            "timers": [],
            "cleared": [],
            "unref": [],
            "calls": [],
        });
    }

    let initial_delay = recovery_delay(input, option_bool(input, "immediate"));
    let mut timers = vec![json!({ "id": 1, "delay": initial_delay })];
    let mut cleared = Vec::new();
    if input.get("existingTimerDelay").is_some()
        && input
            .get("existingDueAt")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
            > NOW + initial_delay
    {
        cleared.push(json!(0));
    }
    let mut unref = vec![json!(1)];
    if !input
        .get("fireScheduled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "host": scheduled_host(input, NOW + initial_delay, initial_delay),
            "timers": timers,
            "cleared": cleared,
            "unref": unref,
            "calls": [],
        });
    }

    let mut calls = vec![
        call("tuiApiRuntime.beginRecovery"),
        call("renderCurrentDashboardView"),
        call("refreshRuntimeGuard"),
        call("tuiApiRuntime.refreshCriticalResources"),
    ];
    let started_notice = repair_notice("started", "Aimux API recovery started", None);

    if let Some(message) = input.get("refreshCriticalThrows").and_then(Value::as_str) {
        calls.push(json!({
            "method": "tuiApiRuntime.markRecoveryFailed",
            "args": [{ "name": "Error", "message": message }],
        }));
        calls.push(call("renderCurrentDashboardView"));
        timers.push(json!({ "id": 2, "delay": 1000 }));
        unref.push(json!(2));
        return json!({
            "host": recovery_finished_host(
                true,
                1,
                Some(error_json(message)),
                vec![
                    started_notice,
                    repair_notice("failed", "Aimux API recovery failed", Some(message)),
                ],
                Some("Aimux API recovery failed"),
                Some(NOW + 1000),
                Some(1000),
            ),
            "timers": timers,
            "cleared": cleared,
            "unref": unref,
            "calls": calls,
        });
    }

    calls.push(call("tuiApiRuntime.finishRecovery"));
    let refresh = input
        .get("refreshCriticalResources")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "attemptedResources": ["desktop-state"],
                "missingResources": [],
                "failedResources": [],
            })
        });
    let snapshot = input
        .get("connectionSnapshot")
        .cloned()
        .unwrap_or_else(|| json!({ "state": "ready", "failedCriticalResources": [] }));
    let runtime_guard_ok = input
        .get("runtimeGuardState")
        .and_then(|state| state.get("kind"))
        .and_then(Value::as_str)
        .map(|kind| kind == "ok")
        .unwrap_or(true);
    let critical_verified = !array_field(&refresh, "attemptedResources").is_empty()
        && array_field(&refresh, "missingResources").is_empty()
        && array_field(&refresh, "failedResources").is_empty();
    let snapshot_ready = str_field(&snapshot, "state") == "ready"
        && array_field(&snapshot, "failedCriticalResources").is_empty();

    if runtime_guard_ok && critical_verified && snapshot_ready {
        calls.push(call("renderCurrentDashboardView"));
        return json!({
            "host": recovery_finished_host(
                false,
                0,
                None,
                vec![
                    started_notice,
                    repair_notice("succeeded", "Aimux API recovery complete", None),
                ],
                Some("Aimux API recovery complete"),
                None,
                None,
            ),
            "timers": timers,
            "cleared": cleared,
            "unref": unref,
            "calls": calls,
        });
    }

    calls.push(call("renderCurrentDashboardView"));
    timers.push(json!({ "id": 2, "delay": 1000 }));
    unref.push(json!(2));
    let error = snapshot
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or(if runtime_guard_ok {
            "critical resources not verified"
        } else {
            "runtime guard is not healthy"
        });
    json!({
        "host": recovery_finished_host(
            true,
            1,
            None,
            vec![
                started_notice,
                repair_notice(
                    "waiting",
                    "Aimux API recovery still reconnecting",
                    Some(error),
                ),
            ],
            Some("Aimux API recovery still reconnecting"),
            Some(NOW + 1000),
            Some(1000),
        ),
        "timers": timers,
        "cleared": cleared,
        "unref": unref,
        "calls": calls,
    })
}

fn scheduled_host(input: &Value, due_at: i64, delay: i64) -> Value {
    let mut host = serde_json::Map::new();
    host.insert("tuiApiRecoveryPending".to_owned(), json!(true));
    host.insert("tuiApiRecoveryInFlight".to_owned(), json!(false));
    host.insert("tuiApiRecoveryDueAt".to_owned(), json!(due_at));
    host.insert(
        "tuiApiRecoveryTimer".to_owned(),
        json!({ "id": 1, "delay": delay }),
    );
    if let Some(streak) = input.get("failureStreak").and_then(Value::as_i64) {
        host.insert("tuiApiRecoveryFailureStreak".to_owned(), json!(streak));
    }
    if let Some(last) = input.get("lastRecoveryAt").and_then(Value::as_i64) {
        host.insert("tuiApiLastRecoveryAt".to_owned(), json!(last));
    }
    host.insert("dashboardRepairNotices".to_owned(), json!([]));
    Value::Object(host)
}

fn recovery_finished_host(
    pending: bool,
    failure_streak: i64,
    last_error: Option<Value>,
    notices: Vec<Value>,
    flash: Option<&str>,
    due_at: Option<i64>,
    retry_delay: Option<i64>,
) -> Value {
    let mut host = serde_json::Map::new();
    host.insert("tuiApiRecoveryPending".to_owned(), json!(pending));
    host.insert("tuiApiRecoveryInFlight".to_owned(), json!(false));
    if let (Some(due_at), Some(delay)) = (due_at, retry_delay) {
        host.insert("tuiApiRecoveryDueAt".to_owned(), json!(due_at));
        host.insert(
            "tuiApiRecoveryTimer".to_owned(),
            json!({ "id": 2, "delay": delay }),
        );
    } else {
        host.insert("tuiApiRecoveryTimer".to_owned(), Value::Null);
    }
    host.insert(
        "tuiApiRecoveryFailureStreak".to_owned(),
        json!(failure_streak),
    );
    host.insert("tuiApiLastRecoveryAt".to_owned(), json!(NOW));
    if let Some(error) = last_error {
        host.insert("tuiApiRecoveryLastError".to_owned(), error);
    }
    host.insert("dashboardRepairNotices".to_owned(), Value::Array(notices));
    if let Some(flash) = flash {
        host.insert("footerFlash".to_owned(), json!(flash));
        host.insert("footerFlashTicks".to_owned(), json!(4));
    }
    Value::Object(host)
}

fn recovery_delay(input: &Value, immediate: bool) -> i64 {
    if let Some(last) = input.get("lastRecoveryAt").and_then(Value::as_i64) {
        let cooldown = RECOVERY_COOLDOWN_MS
            .saturating_mul(2_i64.saturating_pow(recovery_streak(input) as u32))
            .min(RECOVERY_BACKOFF_MAX_MS);
        let cooldown_delay = (cooldown - (NOW - last)).max(0);
        return cooldown_delay.max(if immediate { 0 } else { RECOVERY_DEBOUNCE_MS });
    }
    if immediate { 0 } else { RECOVERY_DEBOUNCE_MS }
}

fn recovery_streak(input: &Value) -> i64 {
    input
        .get("failureStreak")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 5)
}

fn option_bool(input: &Value, field: &str) -> bool {
    input
        .get("options")
        .and_then(|options| options.get(field))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn call(method: &str) -> Value {
    json!({ "method": method, "args": [] })
}

fn repair_notice(phase: &str, message: &str, error: Option<&str>) -> Value {
    let mut notice = serde_json::Map::new();
    notice.insert("kind".to_owned(), json!("tui-api-recovery"));
    notice.insert("phase".to_owned(), json!(phase));
    notice.insert("message".to_owned(), json!(message));
    notice.insert("at".to_owned(), json!(NOW));
    if let Some(error) = error {
        notice.insert("error".to_owned(), json!(error));
    }
    Value::Object(notice)
}

fn error_json(message: &str) -> Value {
    json!({ "name": "Error", "message": message })
}

fn array_field<'a>(value: &'a Value, field: &str) -> Vec<&'a Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
