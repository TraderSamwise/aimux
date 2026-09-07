use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn run_dashboard_ops_mutations_contract_case(api: &str, input: &Value) -> Value {
    let mut state = OpsState::new(input);
    let result = match api {
        "createDashboardServiceWithFeedback" => {
            create_dashboard_service_with_feedback(&mut state, string_field(input, "commandLine"));
            Value::Null
        }
        "resumeOfflineServiceWithFeedback" => {
            resume_offline_service_with_feedback(&mut state, value_field(input, "service"))
        }
        "stopDashboardServiceWithFeedback" => {
            stop_dashboard_service_with_feedback(&mut state, value_field(input, "service"));
            Value::Null
        }
        "removeDashboardServiceWithFeedback" => {
            remove_dashboard_service_with_feedback(&mut state, value_field(input, "service"));
            Value::Null
        }
        "stopSessionToOfflineWithFeedback" => {
            stop_session_to_offline_with_feedback(&mut state, value_field(input, "session"));
            Value::Null
        }
        "graveyardSessionWithFeedback" => {
            graveyard_session_with_feedback(&mut state, string_field(input, "sessionId"));
            Value::Null
        }
        api => panic!("unknown dashboard ops mutation api: {api}"),
    };
    state.summary(result)
}

fn create_dashboard_service_with_feedback(state: &mut OpsState, command_line: String) {
    let service_id = "<SERVICE_ID>".to_owned();
    let label = service_label_for_command(&command_line);
    let worktree_path = optional_string(state.input, "worktreePath");
    state.get_dashboard_services();
    if state.in_flight_count() >= 4 {
        state.flash_mutation_pressure();
        return;
    }
    state.call(
        "preferDashboardEntrySelection",
        vec![
            json!("service"),
            json!(service_id.clone()),
            worktree_path.clone().map_or(Value::Null, Value::String),
        ],
    );
    state.set_service_action(
        &service_id,
        Some("creating"),
        Some(json!({
            "serviceSeed": {
                "id": service_id,
                "command": if command_line.trim().is_empty() { "shell" } else { "/bin/zsh" },
                "args": if command_line.trim().is_empty() { json!(["-l"]) } else { json!(["-lc", command_line]) },
                "createdAt": "<ISO_DATE>",
                "worktreePath": worktree_path,
                "status": "running",
                "active": false,
                "label": label,
                "optimistic": true,
            }
        })),
    );
    state.render_mutation_frame();
    state.call(
        "postToProjectService",
        vec![
            json!("/services/create"),
            json!({ "serviceId": "<SERVICE_ID>", "command": command_line, "worktreePath": worktree_path }),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    state.refresh_model();
    state.get_dashboard_services();
    state.set_service_action("<SERVICE_ID>", None, None);
    state.footer_flash = format!("◆ Created service {label}");
    state.footer_flash_ticks = 3;
    state.render_mutation_frame();
}

fn resume_offline_service_with_feedback(state: &mut OpsState, service: &Value) -> Value {
    let service_id = string_field(service, "id");
    let label = display_label(service);
    if state.get_service_action(&service_id).as_deref() == Some("starting") {
        return json!("pending");
    }
    if state.mode == "dashboard" {
        let service_seed = state
            .get_dashboard_services()
            .into_iter()
            .find(|entry| string_field(entry, "id") == service_id)
            .unwrap_or_else(|| {
                json!({
                    "id": service_id,
                    "command": label,
                    "args": [],
                    "status": "offline",
                    "active": false,
                    "label": label,
                })
            });
        if state.existing_service_action(&service_id).is_some() {
            return json!("pending");
        }
        state.set_service_action(
            &service_id,
            Some("starting"),
            Some(json!({ "serviceSeed": service_seed })),
        );
        state.render_mutation_frame();
        state.call(
            "postToProjectService",
            vec![
                json!("/services/resume"),
                json!({ "serviceId": service_id }),
                json!({ "timeoutMs": 10000 }),
            ],
        );
        state.refresh_model();
        state.get_dashboard_services();
        state.set_service_action(&service_id, None, None);
        state.footer_flash = format!("◆ Started service {label}");
        state.footer_flash_ticks = 3;
        state.render_mutation_frame();
        return json!("settled");
    }

    state.set_service_action(&service_id, Some("starting"), None);
    state.footer_flash = format!("Restoring {label}");
    state.footer_flash_ticks = 3;
    state.call("renderDashboard", vec![]);
    state.call("resumeOfflineServiceById", vec![json!(service_id)]);
    state.set_service_action(&service_id, None, None);
    state.call("refreshLocalDashboardModel", vec![]);
    state.call(
        "showDashboardError",
        vec![json!("Failed to start service"), json!(["boom"])],
    );
    json!("failed")
}

fn stop_dashboard_service_with_feedback(state: &mut OpsState, service: &Value) {
    let service_id = string_field(service, "id");
    let label = display_label(service);
    let canceling_startup = state.service_start_pending_kind(&service_id).is_some();
    let service_seed = state
        .get_dashboard_services()
        .into_iter()
        .find(|entry| string_field(entry, "id") == service_id)
        .unwrap_or_else(|| {
            json!({
                "id": service_id,
                "command": label,
                "args": [],
                "status": "running",
                "active": false,
                "label": label,
            })
        });
    if let Some(existing) = state.existing_service_action(&service_id) {
        state.footer_flash = format!("{existing} is already settling");
        state.footer_flash_ticks = 2;
        state.render_mutation_frame();
        return;
    }
    state.set_service_action(
        &service_id,
        Some("stopping"),
        Some(json!({ "serviceSeed": service_seed })),
    );
    state.render_mutation_frame();
    state.call(
        "postToProjectService",
        vec![
            json!("/services/stop"),
            json!({ "serviceId": service_id }),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    state.refresh_model();
    state.get_dashboard_services();
    state.set_service_action(&service_id, None, None);
    state.footer_flash = format!("◆ Stopped service {label}");
    state.footer_flash_ticks = 3;
    let _ = canceling_startup;
    state.render_mutation_frame();
}

fn remove_dashboard_service_with_feedback(state: &mut OpsState, service: &Value) {
    let service_id = string_field(service, "id");
    let label = display_label(service);
    if let Some(existing) = state.existing_service_action(&service_id) {
        state.footer_flash = format!("{existing} is already settling");
        state.footer_flash_ticks = 2;
        state.render_mutation_frame();
        return;
    }
    state.set_service_action(&service_id, Some("removing"), Some(json!({})));
    state.render_mutation_frame();
    state.call(
        "postToProjectService",
        vec![
            json!("/services/remove"),
            json!({ "serviceId": service_id }),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    for _ in 0..4 {
        state.refresh_model();
    }
    state.set_service_action(&service_id, None, None);
    state.footer_flash = format!("◆ Deleted service {label}");
    state.footer_flash_ticks = 3;
    state.render_mutation_frame();
}

fn stop_session_to_offline_with_feedback(state: &mut OpsState, session: &Value) {
    let session_id = string_field(session, "id");
    let label = state
        .session_label(&session_id)
        .unwrap_or_else(|| display_label(session));
    let session_seed = state
        .get_dashboard_sessions()
        .into_iter()
        .find(|entry| string_field(entry, "id") == session_id)
        .unwrap_or_else(|| session.clone());
    if let Some(existing) = state.existing_session_action(&session_id) {
        state.footer_flash = format!("{existing} is already settling");
        state.footer_flash_ticks = 2;
        state.render_mutation_frame();
        return;
    }
    state.set_session_action(
        &session_id,
        Some("stopping"),
        Some(json!({ "sessionSeed": session_seed })),
    );
    state.render_mutation_frame();
    state.call(
        "postToProjectService",
        vec![
            json!("/agents/stop"),
            json!({ "sessionId": session_id }),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    state.refresh_model();
    state.get_dashboard_sessions();
    state.set_session_action(&session_id, None, None);
    state.footer_flash = format!("Stopped {label}");
    state.footer_flash_ticks = 3;
    state.render_mutation_frame();
}

fn graveyard_session_with_feedback(state: &mut OpsState, session_id: String) {
    let dashboard_entry = state
        .get_dashboard_sessions()
        .into_iter()
        .find(|entry| string_field(entry, "id") == session_id);
    let session = state
        .array("offlineSessions")
        .into_iter()
        .chain(state.array("sessions"))
        .chain(dashboard_entry)
        .find(|entry| string_field(entry, "id") == session_id);
    if session.is_none() {
        return;
    }
    let label = state
        .session_label(&session_id)
        .unwrap_or_else(|| display_label(session.as_ref().expect("session exists")));
    if let Some(existing) = state.existing_session_action(&session_id) {
        state.footer_flash = format!("{existing} is already settling");
        state.footer_flash_ticks = 2;
        state.render_mutation_frame();
        return;
    }
    state.call(
        "postToProjectService",
        vec![
            json!("/agents/kill"),
            json!({ "sessionId": session_id }),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    state.footer_flash = format!("Sent {label} to graveyard");
}

#[derive(Clone)]
struct Sequence {
    values: Vec<Value>,
    index: usize,
}

impl Sequence {
    fn from_input(input: &Value, key: &str) -> Self {
        Self {
            values: array_field(input, key),
            index: 0,
        }
    }

    fn current(&self) -> Vec<Value> {
        if self.values.is_empty() {
            return Vec::new();
        }
        self.values[self.index.min(self.values.len() - 1)]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn advance(&mut self) -> Vec<Value> {
        if !self.values.is_empty() {
            self.index = (self.index + 1).min(self.values.len() - 1);
        }
        self.current()
    }
}

#[derive(Default)]
struct PendingActions {
    sessions: BTreeMap<String, PendingAction>,
    services: BTreeMap<String, PendingAction>,
    next_token: u64,
}

#[derive(Clone)]
struct PendingAction {
    kind: String,
    token: u64,
}

impl PendingActions {
    fn new(input: &Value) -> Self {
        let mut pending = Self::default();
        for action in array_field(input, "pendingActions") {
            let target_kind = string_field(&action, "targetKind");
            let id = string_field(&action, "id");
            let kind = string_field(&action, "kind");
            let token = action
                .get("token")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| pending.next_token + 1);
            pending.next_token = pending.next_token.max(token);
            let entry = PendingAction { kind, token };
            if target_kind == "session" {
                pending.sessions.insert(id, entry);
            } else if target_kind == "service" {
                pending.services.insert(id, entry);
            }
        }
        pending
    }

    fn set_session(&mut self, id: &str, kind: &str) {
        self.next_token += 1;
        self.sessions.insert(
            id.to_owned(),
            PendingAction {
                kind: kind.to_owned(),
                token: self.next_token,
            },
        );
    }

    fn set_service(&mut self, id: &str, kind: &str) {
        self.next_token += 1;
        self.services.insert(
            id.to_owned(),
            PendingAction {
                kind: kind.to_owned(),
                token: self.next_token,
            },
        );
    }

    fn list_sessions(&self) -> Vec<Value> {
        self.sessions
            .iter()
            .map(|(id, action)| json!({ "id": id, "kind": action.kind, "token": action.token }))
            .collect()
    }

    fn list_services(&self) -> Vec<Value> {
        self.services
            .iter()
            .map(|(id, action)| json!({ "id": id, "kind": action.kind, "token": action.token }))
            .collect()
    }
}

struct OpsState<'a> {
    input: &'a Value,
    mode: String,
    pending: PendingActions,
    service_snapshots: Sequence,
    session_snapshots: Sequence,
    raw_services: Vec<Value>,
    raw_sessions: Vec<Value>,
    footer_flash: String,
    footer_flash_ticks: u64,
    service_seed: Value,
    session_seed: Value,
    calls: Vec<Value>,
}

impl<'a> OpsState<'a> {
    fn new(input: &'a Value) -> Self {
        let service_snapshots = Sequence::from_input(input, "serviceSnapshots");
        let session_snapshots = Sequence::from_input(input, "sessionSnapshots");
        Self {
            input,
            mode: string_or(input, "mode", "dashboard"),
            pending: PendingActions::new(input),
            raw_services: if input.get("rawServices").is_some() {
                array_field(input, "rawServices")
            } else {
                service_snapshots.current()
            },
            raw_sessions: if input.get("rawSessions").is_some() {
                array_field(input, "rawSessions")
            } else {
                session_snapshots.current()
            },
            service_snapshots,
            session_snapshots,
            footer_flash: String::new(),
            footer_flash_ticks: 0,
            service_seed: Value::Null,
            session_seed: Value::Null,
            calls: Vec::new(),
        }
    }

    fn summary(self, result: Value) -> Value {
        json!({
            "result": result,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "pendingSessions": self.pending.list_sessions(),
            "pendingServices": self.pending.list_services(),
            "serviceSeed": self.service_seed,
            "sessionSeed": self.session_seed,
            "rawServices": self.raw_services,
            "rawSessions": self.raw_sessions,
            "calls": self.calls,
        })
    }

    fn array(&self, key: &str) -> Vec<Value> {
        array_field(self.input, key)
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn render_mutation_frame(&mut self) {
        self.call("reapplyDashboardPendingActions", vec![]);
        self.call("reconcileDashboardRenderState", vec![]);
        self.call("renderDashboard", vec![]);
    }

    fn flash_mutation_pressure(&mut self) {
        self.footer_flash = "Lifecycle queue is settling".into();
        self.footer_flash_ticks = 2;
        self.render_mutation_frame();
    }

    fn in_flight_count(&self) -> usize {
        self.pending.sessions.len() + self.pending.services.len()
    }

    fn refresh_model(&mut self) {
        self.call(
            "refreshDashboardModelFromService",
            vec![json!(true), json!({ "lifecycle": { "mode": "dashboard" } })],
        );
        self.raw_services = self.service_snapshots.advance();
        self.raw_sessions = self.session_snapshots.advance();
    }

    fn get_dashboard_services(&mut self) -> Vec<Value> {
        self.call("getDashboardServices", vec![]);
        self.service_snapshots.current()
    }

    fn get_dashboard_sessions(&mut self) -> Vec<Value> {
        self.call("getDashboardSessions", vec![]);
        self.session_snapshots.current()
    }

    fn set_service_action(&mut self, id: &str, kind: Option<&str>, opts: Option<Value>) {
        let mut args = vec![
            json!(id),
            kind.map_or(Value::Null, |value| Value::String(value.to_owned())),
        ];
        if let Some(opts) = opts {
            args.push(opts.clone());
            self.service_seed = opts.get("serviceSeed").cloned().unwrap_or(Value::Null);
        }
        self.call("setPendingDashboardServiceAction", args);
        if let Some(kind) = kind {
            self.pending.set_service(id, kind);
        } else {
            self.pending.services.remove(id);
            self.service_seed = Value::Null;
        }
    }

    fn set_session_action(&mut self, id: &str, kind: Option<&str>, opts: Option<Value>) {
        let mut args = vec![
            json!(id),
            kind.map_or(Value::Null, |value| Value::String(value.to_owned())),
        ];
        if let Some(opts) = opts {
            args.push(opts.clone());
            self.session_seed = opts.get("sessionSeed").cloned().unwrap_or(Value::Null);
        }
        self.call("setPendingDashboardSessionAction", args);
        if let Some(kind) = kind {
            self.pending.set_session(id, kind);
        } else {
            self.pending.sessions.remove(id);
            self.session_seed = Value::Null;
        }
    }

    fn get_service_action(&self, id: &str) -> Option<String> {
        self.pending
            .services
            .get(id)
            .map(|action| action.kind.clone())
    }

    fn existing_service_action(&mut self, id: &str) -> Option<String> {
        if let Some(action) = self.pending.services.get(id) {
            return Some(action.kind.clone());
        }
        self.get_dashboard_services()
            .into_iter()
            .find(|entry| string_field(entry, "id") == id)
            .and_then(|entry| external_pending_action(&entry))
    }

    fn existing_session_action(&mut self, id: &str) -> Option<String> {
        if let Some(action) = self.pending.sessions.get(id) {
            return Some(action.kind.clone());
        }
        self.get_dashboard_sessions()
            .into_iter()
            .find(|entry| string_field(entry, "id") == id)
            .and_then(|entry| external_pending_action(&entry))
    }

    fn service_start_pending_kind(&mut self, id: &str) -> Option<String> {
        if let Some(action) = self.pending.services.get(id) {
            return match action.kind.as_str() {
                "creating" | "starting" => Some(action.kind.clone()),
                _ => None,
            };
        }
        self.get_dashboard_services()
            .into_iter()
            .find(|entry| string_field(entry, "id") == id)
            .and_then(
                |entry| match string_field(&entry, "pendingAction").as_str() {
                    "creating" | "starting" => Some(string_field(&entry, "pendingAction")),
                    _ => None,
                },
            )
    }

    fn session_label(&mut self, id: &str) -> Option<String> {
        self.call("getSessionLabel", vec![json!(id)]);
        self.input
            .get("sessionLabels")
            .and_then(|labels| labels.get(id))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

fn external_pending_action(entry: &Value) -> Option<String> {
    if entry.get("optimistic").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let action = string_field(entry, "pendingAction");
    if is_blocking_pending_action(&action) {
        Some(action)
    } else {
        None
    }
}

fn is_blocking_pending_action(action: &str) -> bool {
    matches!(
        action,
        "creating"
            | "forking"
            | "migrating"
            | "switching"
            | "starting"
            | "stopping"
            | "graveyarding"
            | "renaming"
            | "removing"
    )
}

fn service_label_for_command(command_line: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return "shell".into();
    }
    trimmed
        .split_whitespace()
        .next()
        .and_then(|part| part.rsplit('/').next())
        .unwrap_or("service")
        .to_owned()
}

fn display_label(value: &Value) -> String {
    for key in ["label", "command", "id"] {
        let field = string_field(value, key);
        if !field.is_empty() {
            return field;
        }
    }
    String::new()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_or(value: &Value, key: &str, default: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
