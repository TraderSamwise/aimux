use serde_json::{Value, json};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_persistence_reapply_contract_case(input: &Value) -> Value {
    let mut state = ReapplyState::new(input);
    state.reapply_dashboard_pending_actions();
    state.snapshot()
}

#[derive(Clone)]
struct PendingAction {
    target: String,
    id: String,
    kind: String,
    seed: Option<Value>,
}

struct ReapplyState {
    pending: Vec<PendingAction>,
    dashboard_sessions_cache: Vec<Value>,
    dashboard_teammates_cache: Vec<Value>,
    dashboard_services_cache: Vec<Value>,
    dashboard_worktree_groups_cache: Vec<Value>,
    raw_sessions: Option<Vec<Value>>,
    raw_teammates: Option<Vec<Value>>,
    raw_services: Option<Vec<Value>>,
    raw_worktree_groups: Option<Vec<Value>>,
    calls: Vec<Value>,
}

impl ReapplyState {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        let mut state = Self {
            pending: Vec::new(),
            dashboard_sessions_cache: array_field(host, "dashboardSessionsCache"),
            dashboard_teammates_cache: array_field(host, "dashboardTeammatesCache"),
            dashboard_services_cache: array_field(host, "dashboardServicesCache"),
            dashboard_worktree_groups_cache: array_field(host, "dashboardWorktreeGroupsCache"),
            raw_sessions: optional_array_field(host, "dashboardRawSessionsCache"),
            raw_teammates: optional_array_field(host, "dashboardRawTeammatesCache"),
            raw_services: optional_array_field(host, "dashboardRawServicesCache"),
            raw_worktree_groups: optional_array_field(host, "dashboardRawWorktreeGroupsCache"),
            calls: Vec::new(),
        };
        for action in array_field(host, "beforeActions") {
            state.apply_action(&action);
        }
        for action in array_field(host, "afterHostActions") {
            state.apply_action(&action);
        }
        state
    }

    fn apply_action(&mut self, action: &Value) {
        self.calls.push(call("pendingActions.onChange", vec![]));
        if action
            .get("clear")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let target = string_field(action, "target");
            let id = action_id(action);
            self.pending
                .retain(|entry| !(entry.target == target && entry.id == id));
            return;
        }
        let target = string_field(action, "target");
        let opts = value_field(action, "opts");
        let seed = match target.as_str() {
            "session" => opts.get("sessionSeed").cloned(),
            "service" => opts.get("serviceSeed").cloned(),
            "worktree" => opts.get("worktreeSeed").cloned(),
            _ => None,
        };
        self.pending.push(PendingAction {
            target,
            id: action_id(action),
            kind: string_field(action, "kind"),
            seed,
        });
    }

    fn reapply_dashboard_pending_actions(&mut self) {
        let raw_sessions = self
            .raw_sessions
            .clone()
            .unwrap_or_else(|| strip_pending_fields_from_vec(&self.dashboard_sessions_cache));
        let raw_teammates = self
            .raw_teammates
            .clone()
            .unwrap_or_else(|| strip_pending_fields_from_vec(&self.dashboard_teammates_cache));
        let raw_services = self
            .raw_services
            .clone()
            .unwrap_or_else(|| strip_pending_fields_from_vec(&self.dashboard_services_cache));
        let raw_worktrees = self.raw_worktree_groups.clone().unwrap_or_else(|| {
            strip_pending_fields_from_vec(&self.dashboard_worktree_groups_cache)
        });
        self.dashboard_sessions_cache = self.apply_sessions(raw_sessions, false);
        self.dashboard_teammates_cache = self.apply_sessions(raw_teammates, true);
        self.dashboard_services_cache = self.apply_services(raw_services);
        self.dashboard_worktree_groups_cache = self.apply_worktrees(raw_worktrees);
        self.calls.push(call(
            "dashboardUiStateStore.orderWorktreeGroups",
            vec![Value::Array(self.dashboard_worktree_groups_cache.clone())],
        ));
    }

    fn snapshot(self) -> Value {
        json!({
            "returned": null,
            "dashboardSessionsCache": self.dashboard_sessions_cache,
            "dashboardTeammatesCache": self.dashboard_teammates_cache,
            "dashboardServicesCache": self.dashboard_services_cache,
            "dashboardWorktreeGroupsCache": self.dashboard_worktree_groups_cache,
            "calls": self.calls,
        })
    }

    fn apply_sessions(&self, sessions: Vec<Value>, include_teammates: bool) -> Vec<Value> {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for mut session in sessions {
            let id = string_field(&session, "id");
            seen.push(id.clone());
            if let Some(action) = self.find("session", &id) {
                apply_pending_fields(&mut session, &action.kind);
            }
            if is_teammate(&session) == include_teammates {
                out.push(session);
            }
        }
        for action in &self.pending {
            if action.target != "session" || seen.contains(&action.id) {
                continue;
            }
            let Some(mut seed) = action.seed.clone() else {
                continue;
            };
            if is_teammate(&seed) != include_teammates {
                continue;
            }
            apply_pending_fields(&mut seed, &action.kind);
            out.push(seed);
        }
        out
    }

    fn apply_services(&self, services: Vec<Value>) -> Vec<Value> {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for mut service in services {
            let id = string_field(&service, "id");
            seen.push(id.clone());
            if let Some(action) = self.find("service", &id) {
                apply_pending_fields(&mut service, &action.kind);
            }
            out.push(service);
        }
        for action in &self.pending {
            if action.target != "service" || seen.contains(&action.id) {
                continue;
            }
            if let Some(mut seed) = action.seed.clone() {
                apply_pending_fields(&mut seed, &action.kind);
                out.push(seed);
            }
        }
        out
    }

    fn apply_worktrees(&self, worktrees: Vec<Value>) -> Vec<Value> {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for mut worktree in worktrees {
            let id = worktree_key(worktree.get("path").and_then(Value::as_str));
            seen.push(id.clone());
            if let Some(action) = self.find("worktree", &id) {
                apply_worktree_pending_fields(&mut worktree, &action.kind);
            }
            out.push(worktree);
        }
        for action in &self.pending {
            let id = worktree_key(Some(&action.id));
            if action.target != "worktree" || seen.contains(&id) {
                continue;
            }
            if let Some(mut seed) = action.seed.clone() {
                apply_worktree_pending_fields(&mut seed, &action.kind);
                out.push(seed);
            }
        }
        out
    }

    fn find(&self, target: &str, id: &str) -> Option<&PendingAction> {
        self.pending.iter().find(|entry| {
            entry.target == target
                && if target == "worktree" {
                    worktree_key(Some(&entry.id)) == id
                } else {
                    entry.id == id
                }
        })
    }
}

fn strip_pending_fields_from_vec(items: &[Value]) -> Vec<Value> {
    items.iter().map(strip_pending_fields).collect()
}

fn strip_pending_fields(value: &Value) -> Value {
    let mut value = value.clone();
    if let Value::Object(object) = &mut value {
        for field in ["pending", "pendingAction", "pendingStartedAt", "optimistic"] {
            object.remove(field);
        }
    }
    value
}

fn action_id(action: &Value) -> String {
    if string_field(action, "target") == "worktree" {
        string_field(action, "path")
    } else {
        string_field(action, "id")
    }
}

fn apply_pending_fields(value: &mut Value, kind: &str) {
    set_field(value, "pending", json!(true));
    set_field(value, "pendingAction", json!(kind));
    set_field(value, "pendingStartedAt", json!(NOW));
    set_field(value, "optimistic", json!(true));
}

fn apply_worktree_pending_fields(value: &mut Value, kind: &str) {
    set_field(value, "pending", json!(true));
    set_field(
        value,
        "removing",
        json!(matches!(kind, "removing" | "graveyarding")),
    );
    set_field(value, "pendingAction", json!(kind));
    set_field(value, "pendingStartedAt", json!(NOW));
    set_field(value, "optimistic", json!(true));
}

fn is_teammate(value: &Value) -> bool {
    value.get("team").is_some()
}

fn worktree_key(path: Option<&str>) -> String {
    format!("worktree:{}", path.unwrap_or("__main__"))
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn set_field(value: &mut Value, field: &str, replacement: Value) {
    if let Value::Object(object) = value {
        object.insert(field.to_owned(), replacement);
    }
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn optional_array_field(value: &Value, field: &str) -> Option<Vec<Value>> {
    value.get(field).and_then(Value::as_array).cloned()
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
