use serde_json::{Value, json};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_persistence_desktop_projection_contract_case(
    api: &str,
    input: &Value,
) -> Value {
    let state = ProjectionState::new(input);
    match api {
        "buildDesktopState" => state.build_desktop_state(input.get("arg").unwrap_or(&Value::Null)),
        "listProjectedDesktopWorktrees" => state.list_projected_desktop_worktrees(),
        api => panic!("unknown multiplexer persistence desktop projection api: {api}"),
    }
}

#[derive(Clone)]
struct PendingAction {
    target: String,
    id: String,
    kind: String,
    seed: Option<Value>,
}

struct ProjectionState<'a> {
    input: &'a Value,
    pending: Vec<PendingAction>,
    calls: Vec<Value>,
}

impl<'a> ProjectionState<'a> {
    fn new(input: &'a Value) -> Self {
        let mut calls = Vec::new();
        let pending = array_field(value_field(input, "host"), "pendingActions")
            .into_iter()
            .map(|action| {
                calls.push(call("pendingActions.onChange", vec![]));
                let target = string_field(&action, "target");
                let id = if target == "worktree" {
                    string_field(&action, "path")
                } else {
                    string_field(&action, "id")
                };
                let opts = value_field(&action, "opts");
                let seed = match target.as_str() {
                    "session" => opts.get("sessionSeed").cloned(),
                    "service" => opts.get("serviceSeed").cloned(),
                    "worktree" => opts.get("worktreeSeed").cloned(),
                    _ => None,
                };
                PendingAction {
                    target,
                    id,
                    kind: string_field(&action, "kind"),
                    seed,
                }
            })
            .collect();
        Self {
            input,
            pending,
            calls,
        }
    }

    fn build_desktop_state(mut self, arg: &Value) -> Value {
        let snapshot = value_at(self.input, &["host", "desktopStateSnapshot"]);
        let sessions = self.apply_sessions(array_field(snapshot, "sessions"), false);
        let teammates = self.apply_sessions(array_field(snapshot, "teammates"), true);
        let services = self.apply_services(array_field(snapshot, "services"));
        let worktrees = self.apply_worktrees(array_field(snapshot, "worktrees"));
        let base_groups = if snapshot.get("worktreeGroups").is_some() {
            array_field(snapshot, "worktreeGroups")
        } else {
            array_field(snapshot, "worktrees")
        };
        let mut worktree_groups = self.apply_worktrees(base_groups);
        for group in &mut worktree_groups {
            let path = group.get("path").and_then(Value::as_str).map(str::to_owned);
            set_field(
                group,
                "sessions",
                Value::Array(
                    sessions
                        .iter()
                        .filter(|session| {
                            session.get("worktreePath").and_then(Value::as_str) == path.as_deref()
                        })
                        .cloned()
                        .collect(),
                ),
            );
            set_field(
                group,
                "services",
                Value::Array(
                    services
                        .iter()
                        .filter(|service| {
                            service.get("worktreePath").and_then(Value::as_str) == path.as_deref()
                        })
                        .cloned()
                        .collect(),
                ),
            );
        }

        let mut returned = json!({
            "sessions": sessions,
            "teammates": teammates,
            "services": services,
            "worktrees": worktrees,
            "worktreeGroups": worktree_groups,
            "operationFailures": value_field(snapshot, "operationFailures").clone(),
            "mainCheckoutInfo": value_field(snapshot, "mainCheckoutInfo").clone(),
            "mainCheckoutPath": value_field(snapshot, "mainCheckoutPath").clone(),
        });
        if arg.get("includeStatusline").and_then(Value::as_bool) != Some(false) {
            set_field(&mut returned, "statusline", json!({}));
            self.calls.push(call("buildStatuslineSnapshot", vec![]));
        }
        json!({ "returned": returned, "calls": self.calls })
    }

    fn list_projected_desktop_worktrees(mut self) -> Value {
        self.calls.push(call("listDesktopWorktrees", vec![]));
        let worktrees = self.apply_worktrees(array_field(
            value_field(self.input, "host"),
            "listDesktopWorktrees",
        ));
        json!({ "returned": worktrees, "calls": self.calls })
    }

    fn apply_sessions(&self, sessions: Vec<Value>, include_teammates: bool) -> Vec<Value> {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for mut session in sessions {
            let id = string_field(&session, "id");
            seen.push(id.clone());
            if let Some(action) = self.find_action("session", &id) {
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
            if is_teammate(&seed) != include_teammates || !can_synthesize_session(&action.kind) {
                continue;
            }
            set_field(&mut seed, "id", json!(action.id));
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
            if let Some(action) = self.find_action("service", &id) {
                apply_pending_fields(&mut service, &action.kind);
            }
            out.push(service);
        }
        for action in &self.pending {
            if action.target != "service"
                || seen.contains(&action.id)
                || !can_synthesize_service(&action.kind)
            {
                continue;
            }
            if let Some(mut seed) = action.seed.clone() {
                set_field(&mut seed, "id", json!(action.id));
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
            let key = worktree_key(worktree.get("path").and_then(Value::as_str));
            seen.push(key.clone());
            if let Some(action) = self.find_action("worktree", &key) {
                apply_worktree_pending_fields(&mut worktree, &action.kind);
            }
            out.push(worktree);
        }
        for action in &self.pending {
            if action.target != "worktree"
                || seen.contains(&worktree_key(Some(&action.id)))
                || !can_synthesize_worktree(&action.kind)
            {
                continue;
            }
            if let Some(mut seed) = action.seed.clone() {
                apply_worktree_pending_fields(&mut seed, &action.kind);
                out.push(seed);
            }
        }
        out
    }

    fn find_action(&self, target: &str, id: &str) -> Option<&PendingAction> {
        self.pending
            .iter()
            .find(|action| action.target == target && action_lookup_id(action) == id)
    }
}

fn action_lookup_id(action: &PendingAction) -> String {
    if action.target == "worktree" {
        worktree_key(Some(&action.id))
    } else {
        action.id.clone()
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

fn can_synthesize_session(kind: &str) -> bool {
    matches!(kind, "creating" | "starting" | "stopping")
}

fn can_synthesize_service(kind: &str) -> bool {
    matches!(kind, "creating" | "starting" | "stopping" | "removing")
}

fn can_synthesize_worktree(kind: &str) -> bool {
    matches!(kind, "creating" | "removing" | "graveyarding")
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
        object.insert(field.to_string(), replacement);
    }
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    let mut current = value;
    for key in path {
        current = current.get(key).unwrap_or(&Value::Null);
    }
    current
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
        .to_string()
}
