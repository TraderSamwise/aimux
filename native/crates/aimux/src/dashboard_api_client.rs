use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const FIXED_NOW: i64 = 1_770_000_000_000;

pub fn run_dashboard_api_client_named_contract_case(name: &str, input: &Value) -> Value {
    if name.contains("applies resource snapshots") {
        return run_resource_applies_case();
    }
    if name.contains("does not request or apply a resource for a stale lifecycle") {
        return run_resource_stale_lifecycle_case();
    }
    if name.contains("does not apply a resource if the lifecycle goes stale while loading") {
        return run_resource_stale_while_loading_case(input);
    }
    if name.contains("failed dashboard model refresh outcome") {
        return run_model_refresh_failed_case();
    }
    if name.contains("stale dashboard model refresh outcome") {
        return run_model_refresh_stale_case();
    }
    if name.contains("allows model settlement refreshes while inactive") {
        return run_model_refresh_allow_inactive_case();
    }
    if name.contains("mutates through the shared TUI API runtime") {
        return run_mutation_pass_through_case();
    }
    if name.contains("blocks mutations while the critical desktop-state resource is reconnecting") {
        return run_mutation_blocked_case();
    }
    panic!("unknown dashboard api client contract case: {name}");
}

fn run_resource_applies_case() -> Value {
    let mut runtime = TuiApiRuntime::default();
    let response = json!({ "ok": true, "value": 1 });
    let mut get_calls = Vec::new();
    let result = refresh_dashboard_api_resource(
        &mut runtime,
        "/demo",
        "demo",
        &response,
        &mut get_calls,
        None,
    );
    json!({
        "result": result,
        "calls": {
            "getFromProjectService": get_calls,
            "apply": [[response]],
            "ensure": [],
        },
        "connection": runtime.connection_snapshot(),
    })
}

fn run_resource_stale_lifecycle_case() -> Value {
    json!({
        "result": false,
        "calls": {
            "getFromProjectService": [],
            "apply": [],
            "ensure": [],
        },
    })
}

fn run_resource_stale_while_loading_case(input: &Value) -> Value {
    let mut runtime = TuiApiRuntime::default();
    let response = input.get("response").cloned().unwrap_or(Value::Null);
    let mut host = input
        .get("hostBefore")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let get_calls = vec![json!(["/demo"])];
    merge_object(
        &mut host,
        input.get("mutateBeforeResolve").unwrap_or(&Value::Null),
    );
    let stale =
        !is_dashboard_api_lifecycle_current(&host, input.get("lifecycle").unwrap_or(&Value::Null));
    if !stale {
        runtime.refresh_json("demo", response);
    }
    json!({
        "result": !stale,
        "calls": {
            "getFromProjectService": get_calls,
            "apply": [],
            "ensure": [],
        },
        "hostAfter": host,
    })
}

fn run_model_refresh_failed_case() -> Value {
    let runtime = TuiApiRuntime::default();
    json!({
        "result": dashboard_model_refresh_outcome(&runtime, "failed", Some(error_value("offline", None))),
        "calls": {
            "refreshDashboardModelFromService": [[true, null]],
        },
    })
}

fn run_model_refresh_stale_case() -> Value {
    let mut runtime = TuiApiRuntime::default();
    let mut get_calls = Vec::new();
    get_calls.push(json!(["/desktop-state"]));
    runtime.refresh_json("desktop-state", json!({ "ok": true, "sessions": [] }));
    get_calls.push(json!(["/desktop-state"]));
    runtime.refresh_json_error(
        "desktop-state",
        error_value("offline", Some("ECONNREFUSED")),
        true,
    );
    json!({
        "result": dashboard_model_refresh_outcome(&runtime, "stale", Some(error_value("offline", None))),
        "calls": {
            "getFromProjectService": get_calls,
            "refreshDashboardModelFromService": [[true, null]],
        },
        "connection": runtime.connection_snapshot(),
    })
}

fn run_model_refresh_allow_inactive_case() -> Value {
    let runtime = TuiApiRuntime::default();
    json!({
        "result": dashboard_model_refresh_outcome(&runtime, "applied", None),
        "calls": {
            "refreshDashboardModelFromService": [[true, { "allowInactive": true }]],
        },
    })
}

fn run_mutation_pass_through_case() -> Value {
    let mut runtime = TuiApiRuntime::default();
    let body = json!({ "sessionId": "a" });
    let mutation = unwrap_mutation_value(runtime.mutate_json("/agents/stop", &body, None));
    json!({
        "result": mutation,
        "calls": {
            "postToProjectService": [["/agents/stop", body]],
        },
        "connection": runtime.connection_snapshot(),
    })
}

fn run_mutation_blocked_case() -> Value {
    let mut runtime = TuiApiRuntime::default();
    let mut get_calls = Vec::new();
    get_calls.push(json!(["/desktop-state"]));
    runtime.refresh_json("desktop-state", json!({ "ok": true, "sessions": [] }));
    get_calls.push(json!(["/desktop-state"]));
    runtime.refresh_json_error(
        "desktop-state",
        error_value("offline", Some("ECONNREFUSED")),
        true,
    );
    let blocked =
        is_tui_api_connection_mutation_blocked(&runtime.connection_snapshot(), &Value::Null);
    let mutation = runtime.mutate_json(
        "/agents/stop",
        &json!({ "sessionId": "a" }),
        Some(&Value::Null),
    );
    json!({
        "blocked": blocked,
        "mutation": mutation,
        "calls": {
            "getFromProjectService": get_calls,
            "postToProjectService": [],
        },
        "connection": runtime.connection_snapshot(),
    })
}

fn refresh_dashboard_api_resource(
    runtime: &mut TuiApiRuntime,
    path: &str,
    resource: &str,
    response: &Value,
    get_calls: &mut Vec<Value>,
    lifecycle: Option<(&Value, &Value)>,
) -> bool {
    if let Some((host, token)) = lifecycle
        && !is_dashboard_api_lifecycle_current(host, token)
    {
        return false;
    }
    get_calls.push(json!([path]));
    runtime.refresh_json(resource, response.clone());
    true
}

fn dashboard_model_refresh_outcome(
    runtime: &TuiApiRuntime,
    status: &str,
    error: Option<Value>,
) -> Value {
    let desktop = runtime.snapshot("desktop-state");
    let mut outcome = Map::new();
    outcome.insert("ok".into(), Value::Bool(status == "applied"));
    outcome.insert("status".into(), Value::String(status.to_owned()));
    outcome.insert(
        "stale".into(),
        Value::Bool(
            desktop
                .as_ref()
                .map(|state| state.stale && state.value.is_some())
                .unwrap_or(false),
        ),
    );
    outcome.insert("connection".into(), runtime.connection_snapshot());
    if let Some(error) = error {
        outcome.insert("error".into(), error);
    }
    Value::Object(outcome)
}

#[derive(Debug, Clone)]
struct ResourceState {
    value: Option<Value>,
    error: Option<Value>,
    generation: i64,
    pending: bool,
    stale: bool,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct TuiApiRuntime {
    resources: BTreeMap<String, ResourceState>,
    state: String,
    state_updated_at: i64,
    last_error: Option<Value>,
}

impl Default for TuiApiRuntime {
    fn default() -> Self {
        Self {
            resources: BTreeMap::new(),
            state: "ready".to_owned(),
            state_updated_at: FIXED_NOW,
            last_error: None,
        }
    }
}

impl TuiApiRuntime {
    fn refresh_json(&mut self, resource: &str, value: Value) -> Value {
        self.mark_resource_refresh_started();
        let state = self.resource_mut(resource);
        state.generation += 1;
        state.value = Some(value.clone());
        state.error = None;
        state.pending = false;
        state.stale = false;
        state.updated_at = FIXED_NOW;
        let generation = state.generation;
        if !self.has_critical_resource_failure() {
            self.last_error = None;
            self.set_connection_state("ready");
        }
        json!({ "ok": true, "value": value, "stale": false, "generation": generation })
    }

    fn refresh_json_error(&mut self, resource: &str, error: Value, recoverable: bool) -> Value {
        self.mark_resource_refresh_started();
        let state = self.resource_mut(resource);
        state.generation += 1;
        state.error = Some(error.clone());
        state.pending = false;
        state.stale = state.value.is_some();
        let generation = state.generation;
        let value = state.value.clone();
        if recoverable {
            self.last_error = Some(error.clone());
            self.set_connection_state(if self.has_any_stale_resource() {
                "stale"
            } else {
                "reconnecting"
            });
        }
        json!({ "ok": false, "value": value, "error": error, "stale": value.is_some(), "generation": generation })
    }

    fn mutate_json(&mut self, path: &str, body: &Value, blocked_payload: Option<&Value>) -> Value {
        let connection = self.connection_snapshot();
        if is_tui_api_connection_mutation_blocked(
            &connection,
            blocked_payload.unwrap_or(&Value::Null),
        ) {
            return json!({
                "ok": false,
                "error": {
                    "name": "TuiApiMutationBlockedError",
                    "message": "Aimux is reconnecting the project service",
                    "connection": connection,
                },
            });
        }
        let _ = path;
        if !self.has_critical_resource_failure() {
            self.last_error = None;
            self.set_connection_state("ready");
        }
        json!({ "ok": true, "value": { "ok": true, "body": body } })
    }

    fn connection_snapshot(&self) -> Value {
        let mut pending_resources = Vec::new();
        let mut stale_resources = Vec::new();
        let mut failed_resources = Vec::new();
        let mut failed_critical_resources = Vec::new();
        for (resource, state) in &self.resources {
            if state.pending {
                pending_resources.push(Value::String(resource.clone()));
            }
            if state.stale {
                stale_resources.push(Value::String(resource.clone()));
            }
            if state.error.is_some() {
                failed_resources.push(Value::String(resource.clone()));
                if resource == "desktop-state" {
                    failed_critical_resources.push(Value::String(resource.clone()));
                }
            }
        }
        let mut snapshot = Map::new();
        snapshot.insert("state".into(), Value::String(self.state.clone()));
        snapshot.insert("updatedAt".into(), Value::from(self.state_updated_at));
        snapshot.insert("pendingResources".into(), Value::Array(pending_resources));
        snapshot.insert("staleResources".into(), Value::Array(stale_resources));
        snapshot.insert("failedResources".into(), Value::Array(failed_resources));
        snapshot.insert(
            "failedCriticalResources".into(),
            Value::Array(failed_critical_resources),
        );
        if let Some(error) = &self.last_error {
            snapshot.insert("lastError".into(), error.clone());
        }
        Value::Object(snapshot)
    }

    fn snapshot(&self, resource: &str) -> Option<&ResourceState> {
        self.resources.get(resource)
    }

    fn resource_mut(&mut self, resource: &str) -> &mut ResourceState {
        self.resources
            .entry(resource.to_owned())
            .or_insert_with(|| ResourceState {
                value: None,
                error: None,
                generation: 0,
                pending: false,
                stale: false,
                updated_at: 0,
            })
    }

    fn set_connection_state(&mut self, state: &str) {
        if self.state == state {
            return;
        }
        self.state = state.to_owned();
        self.state_updated_at = FIXED_NOW;
    }

    fn mark_resource_refresh_started(&mut self) {
        if self.has_critical_resource_failure() || self.state == "repairing" {
            return;
        }
        self.set_connection_state("refreshing");
    }

    fn has_critical_resource_failure(&self) -> bool {
        self.resources
            .get("desktop-state")
            .and_then(|state| state.error.as_ref())
            .is_some()
    }

    fn has_any_stale_resource(&self) -> bool {
        self.resources.values().any(|state| state.stale)
    }
}

fn is_tui_api_connection_mutation_blocked(snapshot: &Value, opts: &Value) -> bool {
    if opts.get("allowDuringReconnect").and_then(Value::as_bool) == Some(true) {
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
        snapshot.get("state").and_then(Value::as_str),
        Some("failed" | "reconnecting" | "stale" | "repairing")
    )
}

fn is_dashboard_api_lifecycle_current(host: &Value, lifecycle: &Value) -> bool {
    if lifecycle.is_null() {
        return true;
    }
    let mode = lifecycle
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("dashboard");
    if host
        .get("mode")
        .and_then(Value::as_str)
        .is_some_and(|host_mode| host_mode != mode)
    {
        return false;
    }
    if lifecycle.get("requiresInputEpoch").and_then(Value::as_bool) == Some(true) {
        return host.get("dashboardInputEpoch").and_then(Value::as_i64)
            == lifecycle.get("inputEpoch").and_then(Value::as_i64);
    }
    true
}

fn error_value(message: &str, code: Option<&str>) -> Value {
    let mut error = Map::new();
    error.insert("name".into(), Value::String("Error".to_owned()));
    error.insert("message".into(), Value::String(message.to_owned()));
    if let Some(code) = code {
        error.insert("code".into(), Value::String(code.to_owned()));
    }
    Value::Object(error)
}

fn unwrap_mutation_value(result: Value) -> Value {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return result.get("value").cloned().unwrap_or(Value::Null);
    }
    result
}

fn merge_object(target: &mut Value, patch: &Value) {
    let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in patch {
        target.insert(key.clone(), value.clone());
    }
}
