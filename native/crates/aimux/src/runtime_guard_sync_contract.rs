use serde_json::{Map, Value, json};

const RUNTIME_GUARD_ESCALATION_MS: i64 = 60_000;

pub fn run_runtime_guard_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "evaluateRuntimeGuard" => {
            evaluate_runtime_guard(input.get("input").unwrap_or(&Value::Null))
        }
        "runtimeGuardEquals" => json!(
            array_field(input, "pairs")
                .iter()
                .map(|pair| {
                    let Some(pair) = pair.as_array() else {
                        return false;
                    };
                    runtime_guard_equals(&pair[0], &pair[1])
                })
                .collect::<Vec<_>>()
        ),
        "stabilizeRuntimeGuardProbe" => {
            if input.get("cases").is_some() {
                json!(
                    array_field(input, "cases")
                        .iter()
                        .map(stabilize_runtime_guard_probe_case)
                        .collect::<Vec<_>>()
                )
            } else {
                stabilize_runtime_guard_probe_case(input.get("input").unwrap_or(&Value::Null))
            }
        }
        "runtimeGuardKeyDisposition" => {
            let mut output = Map::new();
            for key in array_field(input, "keys").iter().filter_map(Value::as_str) {
                output.insert(
                    key.to_owned(),
                    Value::from(runtime_guard_key_disposition(key)),
                );
            }
            Value::Object(output)
        }
        "runtimeGuardOverlayCopy" => {
            if input.get("states").is_some() {
                json!(
                    array_field(input, "states")
                        .iter()
                        .map(|state| runtime_guard_overlay_copy(
                            state,
                            input.get("options").unwrap_or(&Value::Null)
                        ))
                        .collect::<Vec<_>>()
                )
            } else {
                runtime_guard_overlay_copy(
                    input.get("state").unwrap_or(&Value::Null),
                    input.get("options").unwrap_or(&Value::Null),
                )
            }
        }
        api => panic!("unknown runtime guard contract api: {api}"),
    }
}

pub fn run_runtime_sync_contract_case(input: &Value) -> Value {
    let mut mode = str_field(input, "mode").to_owned();
    let mut interval: Option<Interval> = None;
    let mut calls = Calls::default();
    for action in array_field(input, "actions") {
        match str_field(action, "kind") {
            "startHeartbeat" => {
                if interval.is_none() {
                    interval = Some(Interval {
                        delay_ms: 5_000,
                        cleared: false,
                        unref_called: true,
                    });
                }
            }
            "stopHeartbeat" => {
                if let Some(interval) = interval.as_mut() {
                    interval.cleared = true;
                }
            }
            "startProjectServiceRefresh" | "stopProjectServiceRefresh" => {}
            "setMode" => mode = str_field(action, "mode").to_owned(),
            "tick" => {
                if interval.as_ref().is_some_and(|interval| !interval.cleared) {
                    runtime_sync_tick(&mode, bool_field(input, "offlineChanged"), &mut calls);
                }
            }
            kind => panic!("unknown runtime sync action: {kind}"),
        }
    }
    json!({
        "intervalCount": interval.as_ref().map(|_| 1).unwrap_or(0),
        "intervals": interval
            .into_iter()
            .map(|interval| {
                json!({
                    "delayMs": interval.delay_ms,
                    "cleared": interval.cleared,
                    "unrefCalled": interval.unref_called,
                })
            })
            .collect::<Vec<_>>(),
        "calls": calls.to_value(),
    })
}

fn evaluate_runtime_guard(input: &Value) -> Value {
    if bool_field(input, "selfDrift") {
        return json!({ "kind": "stale", "reason": "self-drift" });
    }
    if bool_field(input, "runtimeRebuildRequired") {
        return json!({ "kind": "runtime-rebuild-required" });
    }
    if !bool_field(input, "endpointPresent")
        || input.get("serviceManifest") == Some(&Value::from("unreachable"))
        || input.get("serviceManifest").is_none_or(Value::is_null)
    {
        return json!({ "kind": "disconnected" });
    }
    if bool_field(input, "serviceIdentityMismatch")
        || !manifest_matches(input.get("serviceManifest").unwrap_or(&Value::Null))
    {
        return json!({ "kind": "stale", "reason": "service-mismatch" });
    }
    json!({ "kind": "ok" })
}

fn manifest_matches(manifest: &Value) -> bool {
    manifest.get("apiVersion").and_then(Value::as_i64) == Some(5)
        && manifest.get("buildStamp").and_then(Value::as_str) == Some("<build-stamp>")
        && manifest.get("capabilities").is_some_and(|capabilities| {
            [
                "parsedAgentOutput",
                "attachmentRead",
                "chatEventStream",
                "agentTranscriptMessages",
                "agentActivityState",
            ]
            .iter()
            .all(|key| capabilities.get(key).and_then(Value::as_bool) == Some(true))
        })
}

fn runtime_guard_equals(left: &Value, right: &Value) -> bool {
    if str_field(left, "kind") != str_field(right, "kind") {
        return false;
    }
    str_field(left, "kind") != "stale" || str_field(left, "reason") == str_field(right, "reason")
}

fn stabilize_runtime_guard_probe_case(input: &Value) -> Value {
    let current = input.get("current").unwrap_or(&Value::Null);
    let next = input.get("next").unwrap_or(&Value::Null);
    let count = input
        .get("disconnectedProbeCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if str_field(next, "kind") != "disconnected" {
        return json!({ "state": next, "disconnectedProbeCount": 0 });
    }
    let next_count = count + 1;
    if str_field(current, "kind") == "disconnected" || next_count >= 2 {
        return json!({ "state": next, "disconnectedProbeCount": next_count });
    }
    json!({ "state": current, "disconnectedProbeCount": next_count })
}

fn runtime_guard_key_disposition(key: &str) -> &'static str {
    let command = if key.chars().count() == 1 {
        key.to_lowercase()
    } else {
        key.to_owned()
    };
    match command.as_str() {
        "up" | "down" | "j" | "k" | "tab" | "?" | "q" => "passthrough",
        _ => "swallow",
    }
}

fn runtime_guard_overlay_copy(state: &Value, options: &Value) -> Value {
    let active_ms = options.get("activeMs").and_then(Value::as_i64).unwrap_or(0);
    let repair_failed = bool_field(options, "repairFailed");
    if str_field(state, "kind") != "ok"
        && (repair_failed || active_ms >= RUNTIME_GUARD_ESCALATION_MS)
    {
        let reason = if str_field(state, "kind") == "disconnected" {
            "The project service did not reconnect."
        } else {
            "Automatic repair did not finish."
        };
        return json!({
            "title": "Aimux needs restart",
            "lines": [
                reason,
                "Run this in any terminal: aimux restart",
                "This preserves agent tmux windows.",
            ],
            "waiting": false,
        });
    }
    match (str_field(state, "kind"), str_field(state, "reason")) {
        ("stale", "self-drift") => json!({
            "title": "Aimux is updating",
            "lines": [
                "Aimux is applying the current build.",
                "Actions resume automatically when repair completes.",
            ],
            "waiting": true,
        }),
        ("stale", _) => json!({
            "title": "Aimux is syncing",
            "lines": [
                "Aimux is syncing the dashboard with the project service.",
                "Actions resume automatically.",
            ],
            "waiting": true,
        }),
        ("disconnected", _) => json!({
            "title": "Aimux is reconnecting",
            "lines": [
                "Aimux is reconnecting the project service.",
                "Actions resume automatically.",
            ],
            "waiting": true,
        }),
        ("runtime-rebuild-required", _) => json!({
            "title": "Aimux is repairing tmux",
            "lines": [
                "Aimux is repairing the managed tmux runtime.",
                "Actions resume automatically.",
            ],
            "waiting": true,
        }),
        _ => json!({ "title": "", "lines": [], "waiting": false }),
    }
}

fn runtime_sync_tick(mode: &str, offline_changed: bool, calls: &mut Calls) {
    if mode == "project-service" {
        return;
    }
    calls.load_offline_topology_sessions += 1;
    if offline_changed && mode == "dashboard" {
        calls.render_current_dashboard_view += 1;
    }
    if mode == "dashboard" {
        calls.refresh_runtime_guard += 1;
    }
}

#[derive(Default)]
struct Calls {
    sync_sessions_from_topology: usize,
    load_offline_topology_sessions: usize,
    render_current_dashboard_view: usize,
    render_dashboard: usize,
    write_statusline_file: usize,
    refresh_runtime_guard: usize,
}

impl Calls {
    fn to_value(&self) -> Value {
        json!({
            "syncSessionsFromTopology": self.sync_sessions_from_topology,
            "loadOfflineTopologySessions": self.load_offline_topology_sessions,
            "renderCurrentDashboardView": self.render_current_dashboard_view,
            "renderDashboard": self.render_dashboard,
            "writeStatuslineFile": self.write_statusline_file,
            "refreshRuntimeGuard": self.refresh_runtime_guard,
        })
    }
}

struct Interval {
    delay_ms: i64,
    cleared: bool,
    unref_called: bool,
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}
