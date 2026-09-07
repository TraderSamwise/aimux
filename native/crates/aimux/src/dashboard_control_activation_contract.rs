use serde_json::{Map, Value, json};

const NOW: &str = "<NOW>";
const REPO: &str = "<REPO>";

pub fn run_dashboard_control_activation_contract_case(input: &Value) -> Value {
    let mut state = ActivationState {
        input,
        calls: Vec::new(),
        timers: Vec::new(),
        now: 1_000,
        dashboard_input_epoch: int_field(input, "dashboardInputEpoch").unwrap_or_default(),
    };
    let result = match string_field(input, "api").as_deref() {
        Some("entry") => state.wait_and_open_entry(),
        Some("service") => state.wait_and_open_service(),
        _ => "missing".to_owned(),
    };
    json!({
        "result": result,
        "calls": state.calls,
        "timers": state.timers,
        "dashboardInputEpoch": state.dashboard_input_epoch,
    })
}

struct ActivationState<'a> {
    input: &'a Value,
    calls: Vec<Value>,
    timers: Vec<Value>,
    now: i64,
    dashboard_input_epoch: i64,
}

#[derive(Clone, Default)]
struct DashboardClientContext {
    current_client_session: Option<String>,
    client_tty: Option<String>,
    current_window_id: Option<String>,
}

impl ActivationState<'_> {
    fn wait_and_open_entry(&mut self) -> String {
        let entry = value_field(self.input, "entry");
        let timeout_ms = wait_timeout_ms(self.input, entry);
        let deadline = self.now + timeout_ms;

        if self.can_focus_local_dashboard(entry) {
            let context = self.dashboard_control_client_context();
            if self.open_live_tmux_window_for_entry(entry, context) == "opened" {
                return "opened".to_owned();
            }
        }

        while self.now < deadline {
            if self.activation_stale("session", id_for(entry)) {
                return "missing".to_owned();
            }
            let remaining_ms = (deadline - self.now).max(100);
            let result = self.open_project_service_notification_target(
                "session",
                id_for(entry),
                remaining_ms,
            );
            if result != "missing" {
                return result;
            }
            self.sleep(100);
        }
        "missing".to_owned()
    }

    fn wait_and_open_service(&mut self) -> String {
        let service = value_field(self.input, "service");
        let timeout_ms = int_field(self.input, "timeoutMs").unwrap_or(3_000);
        let deadline = self.now + timeout_ms;

        if self.can_focus_local_dashboard(service) {
            let context = self.dashboard_control_client_context();
            if self.open_live_tmux_window_for_service(service, context) == "opened" {
                return "opened".to_owned();
            }
        }

        while self.now < deadline {
            if self.activation_stale("service", id_for(service)) {
                return "missing".to_owned();
            }
            let remaining_ms = (deadline - self.now).max(100);
            let result = self.open_project_service_notification_target(
                "service",
                id_for(service),
                remaining_ms,
            );
            if result != "missing" {
                return result;
            }
            self.sleep(100);
        }
        "missing".to_owned()
    }

    fn can_focus_local_dashboard(&self, value: &Value) -> bool {
        string_field(self.input, "mode").unwrap_or_else(|| "dashboard".to_owned()) == "dashboard"
            && !matches!(
                string_field(value, "status").as_deref(),
                Some("offline" | "exited")
            )
    }

    fn dashboard_control_client_context(&mut self) -> DashboardClientContext {
        let tmux_pane = match self.input.get("tmuxPane") {
            Some(Value::String(value)) => Some(value.clone()),
            _ => None,
        };
        let dashboard_window_id = self.display_message("#{window_id}", tmux_pane.as_deref());
        let ambient_client_tty = self.display_message("#{client_tty}", None);
        let ambient_session_name = self.current_client_session();
        let clients = self.list_clients();

        let dashboard_clients: Vec<Value> = clients
            .iter()
            .filter(|client| {
                dashboard_window_id.as_deref().is_some_and(|window_id| {
                    string_field(client, "windowId").as_deref() == Some(window_id)
                })
            })
            .cloned()
            .collect();
        let ambient_client = ambient_client_tty.as_deref().and_then(|tty| {
            clients
                .iter()
                .find(|client| string_field(client, "tty").as_deref() == Some(tty))
                .cloned()
        });
        let visible_client = ambient_client
            .as_ref()
            .filter(|client| {
                dashboard_clients.iter().any(|dashboard_client| {
                    string_field(dashboard_client, "tty") == string_field(client, "tty")
                })
            })
            .cloned()
            .or_else(|| dashboard_clients.first().cloned())
            .or(ambient_client);

        DashboardClientContext {
            current_client_session: visible_client
                .as_ref()
                .and_then(|client| string_field(client, "sessionName"))
                .or(ambient_session_name),
            client_tty: visible_client
                .as_ref()
                .and_then(|client| string_field(client, "tty"))
                .or(ambient_client_tty),
            current_window_id: dashboard_window_id.or_else(|| {
                visible_client
                    .as_ref()
                    .and_then(|client| string_field(client, "windowId"))
            }),
        }
    }

    fn open_live_tmux_window_for_entry(
        &mut self,
        entry: &Value,
        context: DashboardClientContext,
    ) -> &'static str {
        let target = match self.find_managed_window("agent", entry) {
            Some(target) => target,
            None => return "missing",
        };
        if !self.open_target_for_client(&context, &target) {
            return "missing";
        }
        let session_id = id_for(entry);
        self.post_to_project_service(
            "/statusline/refresh",
            json!({ "sessionId": session_id }),
            None,
        );
        self.timers.push(json!({ "ms": 0 }));
        self.note_last_used_item(&session_id, context.current_client_session.as_deref());
        self.post_to_project_service(
            "/notification-context",
            json!({
                "source": "tui",
                "focused": true,
                "screen": "agent",
                "sessionId": session_id,
                "panelOpen": false,
            }),
            Some(json!({ "timeoutMs": 3000 })),
        );
        self.post_to_project_service("/mark-seen", json!({ "session": session_id }), None);
        "opened"
    }

    fn open_live_tmux_window_for_service(
        &mut self,
        service: &Value,
        context: DashboardClientContext,
    ) -> &'static str {
        let target = match self.find_managed_window("service", service) {
            Some(target) => target,
            None => return "missing",
        };
        if !self.open_target_for_client(&context, &target) {
            return "missing";
        }
        let service_id = id_for(service);
        self.post_to_project_service(
            "/statusline/refresh",
            json!({ "sessionId": service_id }),
            None,
        );
        self.note_last_used_item(&service_id, context.current_client_session.as_deref());
        "opened"
    }

    fn find_managed_window(&mut self, kind: &str, item: &Value) -> Option<Value> {
        let windows = self.list_project_managed_windows(REPO);
        let tmux_window_id = string_field(item, "tmuxWindowId");
        let item_id = id_for(item);
        for window in windows {
            let metadata = value_field(&window, "metadata");
            if string_field(metadata, "kind").as_deref() != Some(kind) {
                continue;
            }
            let target = value_field(&window, "target").clone();
            let target_window_id = string_field(&target, "windowId");
            let metadata_session_id = string_field(metadata, "sessionId");
            let metadata_backend_id = string_field(metadata, "backendSessionId");
            let matches_tmux_window = tmux_window_id
                .as_deref()
                .is_some_and(|window_id| target_window_id.as_deref() == Some(window_id));
            let matches_session = metadata_session_id.as_deref() == Some(item_id.as_str())
                || metadata_backend_id.as_deref() == Some(item_id.as_str());
            if (matches_tmux_window || matches_session) && self.is_window_alive(&target) {
                return Some(target);
            }
        }
        None
    }

    fn open_target_for_client(&mut self, context: &DashboardClientContext, target: &Value) -> bool {
        let Some(client_tty) = context.client_tty.as_deref() else {
            return false;
        };
        if self.find_client_by_tty(client_tty).is_none() {
            return false;
        }
        self.calls.push(call(
            "tmuxRuntimeManager.switchClientToTarget",
            vec![Value::String(client_tty.to_owned()), target.clone()],
        ));
        self.calls
            .push(call("tmuxRuntimeManager.refreshStatus", vec![]));
        if string_field(target, "windowName").is_some_and(|name| name.starts_with("dashboard")) {
            self.calls
                .push(call("tmuxRuntimeManager.sendFocusIn", vec![target.clone()]));
        }
        true
    }

    fn open_project_service_notification_target(
        &mut self,
        kind: &str,
        id: String,
        remaining_ms: i64,
    ) -> String {
        let context = self.dashboard_control_client_context();
        let Some(client_tty) = context.client_tty else {
            return "missing".to_owned();
        };
        let mut body = Map::new();
        let id_key = if kind == "service" {
            "serviceId"
        } else {
            "sessionId"
        };
        body.insert(id_key.to_owned(), Value::String(id.clone()));
        body.insert("focus".to_owned(), Value::Bool(false));
        self.post_to_project_service(
            "/control/open-notification-target",
            Value::Object(body),
            Some(json!({ "timeoutMs": remaining_ms })),
        );
        if self.activation_stale(kind, id.clone()) {
            return "missing".to_owned();
        }

        let mut focus_body = Map::new();
        focus_body.insert(id_key.to_owned(), Value::String(id));
        focus_body.insert("focus".to_owned(), Value::Bool(true));
        if let Some(current_client_session) = context.current_client_session {
            focus_body.insert(
                "currentClientSession".to_owned(),
                Value::String(current_client_session),
            );
        }
        focus_body.insert("clientTty".to_owned(), Value::String(client_tty));
        if let Some(current_window_id) = context.current_window_id {
            focus_body.insert(
                "currentWindowId".to_owned(),
                Value::String(current_window_id),
            );
        }
        self.post_to_project_service(
            "/control/open-notification-target",
            Value::Object(focus_body),
            Some(json!({ "timeoutMs": remaining_ms })),
        );
        "opened".to_owned()
    }

    fn activation_stale(&self, kind: &str, id: String) -> bool {
        let token = value_field(self.input, "dashboardActivationToken");
        if token.is_null() {
            return false;
        }
        let token_kind = string_field(token, "targetKind");
        let token_id = string_field(token, "targetId");
        if token_kind.as_deref() != Some(kind) || token_id.as_deref() != Some(id.as_str()) {
            return false;
        }
        int_field(token, "inputEpoch").unwrap_or_default() != self.dashboard_input_epoch
    }

    fn note_last_used_item(&mut self, item_id: &str, client_session: Option<&str>) {
        let mut body = Map::new();
        body.insert("itemId".to_owned(), Value::String(item_id.to_owned()));
        if let Some(client_session) = client_session {
            body.insert(
                "clientSession".to_owned(),
                Value::String(client_session.to_owned()),
            );
        }
        body.insert("usedAt".to_owned(), Value::String(NOW.to_owned()));
        self.post_to_project_service("/usage/mark", Value::Object(body), None);
        self.calls
            .push(call("invalidateDesktopStateSnapshot", vec![]));
    }

    fn post_to_project_service(&mut self, path: &str, body: Value, options: Option<Value>) {
        let mut args = vec![Value::String(path.to_owned()), body.clone()];
        if let Some(options) = options {
            args.push(options);
        }
        self.calls.push(call("postToProjectService", args));
        if self
            .input
            .get("invalidateAfterResolve")
            .and_then(Value::as_bool)
            == Some(true)
            && body.get("focus").and_then(Value::as_bool) == Some(false)
        {
            self.dashboard_input_epoch += 1;
        }
    }

    fn display_message(&mut self, format: &str, target: Option<&str>) -> Option<String> {
        let mut args = vec![Value::String(format.to_owned())];
        if let Some(target) = target {
            args.push(Value::String(target.to_owned()));
        }
        self.calls
            .push(call("tmuxRuntimeManager.displayMessage", args));
        let key = target
            .map(|target| format!("{format}|{target}"))
            .unwrap_or_else(|| format.to_owned());
        string_path(value_field(self.input, "tmux"), &["display", &key])
    }

    fn current_client_session(&mut self) -> Option<String> {
        self.calls
            .push(call("tmuxRuntimeManager.currentClientSession", vec![]));
        string_path(value_field(self.input, "tmux"), &["currentClientSession"])
    }

    fn list_clients(&mut self) -> Vec<Value> {
        self.calls
            .push(call("tmuxRuntimeManager.listClients", vec![]));
        array_path(value_field(self.input, "tmux"), &["clients"])
    }

    fn list_project_managed_windows(&mut self, project_root: &str) -> Vec<Value> {
        self.calls.push(call(
            "tmuxRuntimeManager.listProjectManagedWindows",
            vec![Value::String(project_root.to_owned())],
        ));
        array_path(value_field(self.input, "tmux"), &["windows"])
    }

    fn is_window_alive(&mut self, target: &Value) -> bool {
        self.calls.push(call(
            "tmuxRuntimeManager.isWindowAlive",
            vec![target.clone()],
        ));
        target.get("alive").and_then(Value::as_bool) != Some(false)
    }

    fn find_client_by_tty(&mut self, tty: &str) -> Option<Value> {
        self.calls.push(call(
            "tmuxRuntimeManager.findClientByTty",
            vec![Value::String(tty.to_owned())],
        ));
        array_path(value_field(self.input, "tmux"), &["clients"])
            .into_iter()
            .find(|client| string_field(client, "tty").as_deref() == Some(tty))
    }

    fn sleep(&mut self, ms: i64) {
        self.timers.push(json!({ "ms": ms }));
        self.now += ms;
    }
}

fn wait_timeout_ms(input: &Value, entry: &Value) -> i64 {
    if let Some(timeout_ms) = int_field(input, "timeoutMs") {
        return timeout_ms;
    }
    match string_field(entry, "status").as_deref() {
        Some("offline" | "exited") => 60_000,
        _ => 3_000,
    }
}

fn id_for(value: &Value) -> String {
    string_field(value, "id")
        .or_else(|| string_field(value, "sessionId"))
        .unwrap_or_default()
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |value, key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn int_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn array_path(value: &Value, path: &[&str]) -> Vec<Value> {
    path.iter()
        .try_fold(value, |value, key| value.get(*key))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
