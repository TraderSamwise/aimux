use aimux::project_service_manifest::ProjectServiceManifest;
use aimux::runtime_guard::{
    RuntimeGuardInput, RuntimeGuardKeyDisposition, RuntimeGuardOverlayCopy,
    RuntimeGuardServiceManifest, RuntimeGuardStaleReason, RuntimeGuardState,
    evaluate_runtime_guard_against, runtime_guard_key_disposition, runtime_guard_overlay_copy,
    stabilize_runtime_guard_probe,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub fn run_runtime_guard_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "evaluateRuntimeGuard" => {
            let guard_input = runtime_guard_input(input.get("input").unwrap_or(&Value::Null));
            runtime_guard_state_value(&evaluate_runtime_guard_against(
                &guard_input,
                Some(&expected_manifest()),
            ))
        }
        "runtimeGuardEquals" => json!(
            array_field(input, "pairs")
                .iter()
                .map(|pair| {
                    let Some(pair) = pair.as_array() else {
                        return false;
                    };
                    runtime_guard_state(&pair[0]) == runtime_guard_state(&pair[1])
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
                    Value::from(match runtime_guard_key_disposition(key) {
                        RuntimeGuardKeyDisposition::Passthrough => "passthrough",
                        RuntimeGuardKeyDisposition::Swallow => "swallow",
                    }),
                );
            }
            Value::Object(output)
        }
        "runtimeGuardOverlayCopy" => {
            let options = input.get("options").unwrap_or(&Value::Null);
            if input.get("states").is_some() {
                json!(
                    array_field(input, "states")
                        .iter()
                        .map(
                            |state| runtime_guard_overlay_copy_value(&runtime_guard_overlay_copy(
                                &runtime_guard_state(state),
                                int_field(options, "activeMs"),
                                bool_field(options, "repairFailed")
                            ))
                        )
                        .collect::<Vec<_>>()
                )
            } else {
                runtime_guard_overlay_copy_value(&runtime_guard_overlay_copy(
                    &runtime_guard_state(input.get("state").unwrap_or(&Value::Null)),
                    int_field(options, "activeMs"),
                    bool_field(options, "repairFailed"),
                ))
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

fn runtime_guard_input(input: &Value) -> RuntimeGuardInput {
    RuntimeGuardInput {
        self_drift: bool_field(input, "selfDrift"),
        runtime_rebuild_required: bool_field(input, "runtimeRebuildRequired"),
        endpoint_present: bool_field(input, "endpointPresent"),
        service_manifest: match input.get("serviceManifest") {
            Some(Value::String(value)) if value == "unreachable" => {
                RuntimeGuardServiceManifest::Unreachable
            }
            Some(Value::Null) | None => RuntimeGuardServiceManifest::Missing,
            Some(value) => RuntimeGuardServiceManifest::Value(value.clone()),
        },
        service_identity_mismatch: bool_field(input, "serviceIdentityMismatch"),
    }
}

fn expected_manifest() -> ProjectServiceManifest {
    ProjectServiceManifest {
        api_version: 5,
        build_stamp: "<build-stamp>".to_owned(),
        capabilities: [
            "parsedAgentOutput",
            "attachmentRead",
            "chatEventStream",
            "agentTranscriptMessages",
            "agentActivityState",
        ]
        .into_iter()
        .map(|capability| (capability.to_owned(), true))
        .collect::<BTreeMap<_, _>>(),
    }
}

fn stabilize_runtime_guard_probe_case(input: &Value) -> Value {
    let (state, disconnected_probe_count) = stabilize_runtime_guard_probe(
        &runtime_guard_state(input.get("current").unwrap_or(&Value::Null)),
        runtime_guard_state(input.get("next").unwrap_or(&Value::Null)),
        input
            .get("disconnectedProbeCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        2,
    );
    json!({
        "state": runtime_guard_state_value(&state),
        "disconnectedProbeCount": disconnected_probe_count,
    })
}

fn runtime_guard_state(value: &Value) -> RuntimeGuardState {
    match str_field(value, "kind") {
        "stale" => RuntimeGuardState::Stale {
            reason: match str_field(value, "reason") {
                "self-drift" => RuntimeGuardStaleReason::SelfDrift,
                _ => RuntimeGuardStaleReason::ServiceMismatch,
            },
        },
        "runtime-rebuild-required" => RuntimeGuardState::RuntimeRebuildRequired,
        "disconnected" => RuntimeGuardState::Disconnected,
        _ => RuntimeGuardState::Ok,
    }
}

fn runtime_guard_state_value(state: &RuntimeGuardState) -> Value {
    match state {
        RuntimeGuardState::Ok => json!({ "kind": "ok" }),
        RuntimeGuardState::Stale { reason } => json!({
            "kind": "stale",
            "reason": reason.as_str(),
        }),
        RuntimeGuardState::RuntimeRebuildRequired => json!({ "kind": "runtime-rebuild-required" }),
        RuntimeGuardState::Disconnected => json!({ "kind": "disconnected" }),
    }
}

fn runtime_guard_overlay_copy_value(copy: &RuntimeGuardOverlayCopy) -> Value {
    json!({
        "title": copy.title,
        "lines": copy.lines,
        "waiting": copy.waiting,
    })
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

fn int_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
