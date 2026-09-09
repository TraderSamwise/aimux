use serde_json::{Value, json};

pub fn run_session_launch_startup_contract_case(api: &str, input: &Value) -> Value {
    let mut state = StartupState::new(input);
    let result = match api {
        "run" => state.run(input),
        "startProjectServiceHost" => state.start_project_service_host(input, false),
        "runProjectService" => state.run_project_service(input),
        api => panic!("unknown session launch startup api: {api}"),
    };
    json!({
        "result": result,
        "host": {
            "mode": state.mode,
            "startedInDashboard": state.started_in_dashboard,
            "defaultCommand": state.default_command.unwrap_or(Value::Null),
            "defaultArgs": state.default_args.unwrap_or(Value::Null),
            "sessionCount": state.session_count,
            "graveyardCleanupRunning": state.graveyard_cleanup_running,
            "inboxCleanupRunning": state.inbox_cleanup_running,
        },
        "calls": state.calls,
    })
}

struct StartupState {
    mode: String,
    started_in_dashboard: bool,
    default_command: Option<Value>,
    default_args: Option<Value>,
    session_count: usize,
    graveyard_cleanup_running: bool,
    inbox_cleanup_running: bool,
    calls: Vec<Value>,
}

impl StartupState {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        Self {
            mode: string_field(host, "mode").unwrap_or_else(|| "session".into()),
            started_in_dashboard: bool_field(host, "startedInDashboard"),
            default_command: host.get("defaultCommand").cloned(),
            default_args: host.get("defaultArgs").cloned(),
            session_count: array_field(host, "sessions").len(),
            graveyard_cleanup_running: bool_field(host, "graveyardCleanupRunning"),
            inbox_cleanup_running: bool_field(host, "inboxCleanupRunning"),
            calls: Vec::new(),
        }
    }

    fn run(&mut self, input: &Value) -> Value {
        self.call("startHeartbeat", vec![]);
        self.call("syncSessionsFromTopology", vec![]);
        let options = value_field(input, "options");
        let command = string_field(options, "command").unwrap_or_default();
        let args = array_field(options, "args");
        self.default_command = Some(Value::String(command.clone()));
        self.default_args = Some(Value::Array(args.clone()));
        let tool_entry = find_tool_by_command(input, &command);
        self.call("writeInstructionFiles", vec![]);
        let preamble_flag = tool_entry
            .as_ref()
            .and_then(|(_, tool)| tool.get("preambleFlag").cloned())
            .unwrap_or(Value::Null);
        let tool_key = tool_entry
            .as_ref()
            .map(|(key, _)| Value::String(key.clone()))
            .unwrap_or(Value::Null);
        let session_id_flag = tool_entry
            .as_ref()
            .and_then(|(_, tool)| tool.get("sessionIdFlag").cloned())
            .unwrap_or(Value::Null);
        self.call(
            "createSession",
            vec![
                Value::String(command),
                Value::Array(args),
                preamble_flag,
                tool_key,
                Value::Null,
                session_id_flag,
            ],
        );
        self.session_count += 1;
        self.call(
            "focusSession",
            vec![Value::from(self.session_count.saturating_sub(1))],
        );
        Value::from(0)
    }

    fn start_project_service_host(&mut self, _input: &Value, include_teardown: bool) -> Value {
        self.mode = "project-service".into();
        self.call(
            "tmuxRuntimeManager.repairLegacyProjectSessionNames",
            vec![Value::String("<REPO>".into())],
        );
        self.call("syncSessionsFromTopology", vec![]);
        self.call("writeInstructionFiles", vec![]);
        self.call("refreshDesktopStateSnapshot", vec![]);
        self.call("startProjectServices", vec![]);
        self.call("startStatusRefresh", vec![]);
        self.call("startGraveyardCleanup", vec![]);
        if !self.graveyard_cleanup_running {
            self.graveyard_cleanup_running = true;
            self.call("cleanupGraveyard", vec![]);
            self.graveyard_cleanup_running = false;
        }
        self.call("startInboxCleanup", vec![]);
        if !self.inbox_cleanup_running {
            self.inbox_cleanup_running = true;
            self.call("cleanupInbox", vec![]);
            self.inbox_cleanup_running = false;
        }
        self.call("writeStatuslineFile", vec![]);
        if include_teardown {
            self.call("teardown", vec![]);
        }
        Value::Null
    }

    fn run_project_service(&mut self, input: &Value) -> Value {
        self.start_project_service_host(input, true);
        input
            .get("exitCode")
            .cloned()
            .unwrap_or_else(|| Value::from(0))
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn find_tool_by_command(input: &Value, command: &str) -> Option<(String, Value)> {
    value_field(value_field(input, "config"), "tools")
        .as_object()?
        .iter()
        .find(|(_, tool)| string_field(tool, "command").as_deref() == Some(command))
        .map(|(key, tool)| (key.clone(), tool.clone()))
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

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}
