use serde_json::{Map, Value, json};

const NOW: &str = "<ts>";
const REPO: &str = "<repo>";
const PROJECT_STATE: &str = "<project-state>";
const SESSION_NAME: &str = "aimux-repo";
const DEFAULT_SHELL: &str = "zsh";

const CALL_NAMES: &[&str] = &[
    "tmuxRuntimeManager.getProjectSession",
    "tmuxRuntimeManager.ensureProjectSession",
    "tmuxRuntimeManager.findManagedWindow",
    "tmuxRuntimeManager.createWindow",
    "tmuxRuntimeManager.setWindowMetadata",
    "tmuxRuntimeManager.applyManagedAgentWindowPolicy",
    "tmuxRuntimeManager.killWindow",
    "tmuxRuntimeManager.sendKey",
    "tmuxRuntimeManager.sendText",
    "tmuxRuntimeManager.sendEnter",
    "tmuxRuntimeManager.hasWindow",
    "tmuxRuntimeManager.isWindowAlive",
    "tmuxRuntimeManager.displayMessage",
    "saveState",
    "invalidateDesktopStateSnapshot",
    "refreshLocalDashboardModel",
    "updateWorktreeSessions",
    "adjustAfterRemove",
    "noteLastUsedItem",
    "preferDashboardEntrySelection",
    "settleDashboardCreatePending",
    "setPendingDashboardServiceAction",
];

#[derive(Debug)]
struct HostState {
    offline_services: Vec<Value>,
    removed_service_ids: Vec<Value>,
    calls: Map<String, Value>,
    saved_state: Value,
    topology_services: Vec<Value>,
}

impl HostState {
    fn new(input: &Value) -> Self {
        Self {
            offline_services: array_field(input, "offlineServices"),
            removed_service_ids: Vec::new(),
            calls: empty_calls(),
            saved_state: input.get("initialState").cloned().unwrap_or(Value::Null),
            topology_services: Vec::new(),
        }
    }

    fn call(&mut self, name: &str, args: Value) {
        self.calls
            .get_mut(name)
            .and_then(Value::as_array_mut)
            .expect("known call name")
            .push(args);
    }

    fn commit_service_state(&mut self, upsert: Vec<Value>, remove_ids: &[String]) {
        let mut state = self
            .saved_state
            .as_object()
            .cloned()
            .unwrap_or_else(Map::new);
        let mut services = self.offline_services.clone();
        for service in upsert {
            let id = string_field(&service, "id");
            services.retain(|entry| string_field(entry, "id") != id);
            services.push(service);
        }
        for remove_id in remove_ids {
            services.retain(|entry| string_field(entry, "id") != remove_id.as_str());
        }
        state.insert("savedAt".into(), Value::String(NOW.into()));
        state.insert("cwd".into(), Value::String(REPO.into()));
        state.insert("services".into(), Value::Array(services));
        self.saved_state = Value::Object(state);
        self.call("invalidateDesktopStateSnapshot", json!([]));
    }

    fn output(self, result: Value, thrown: Value) -> Value {
        let running = self
            .topology_services
            .iter()
            .filter(|service| string_field(service, "status") == "running")
            .cloned()
            .collect::<Vec<_>>();
        let stopped = self
            .topology_services
            .iter()
            .filter(|service| string_field(service, "status") == "stopped")
            .cloned()
            .collect::<Vec<_>>();
        let saved_services = self
            .saved_state
            .get("services")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        json!({
            "result": result,
            "thrown": thrown,
            "host": {
                "offlineServices": self.offline_services,
                "removedServiceIds": self.removed_service_ids,
            },
            "calls": Value::Object(self.calls),
            "savedState": self.saved_state,
            "savedServices": saved_services,
            "topologyServicesAll": self.topology_services,
            "topologyServicesRunning": running,
            "topologyServicesStopped": stopped,
        })
    }
}

pub fn run_multiplexer_services_runtime_contract_case(input: &Value) -> Value {
    let mut host = HostState::new(input);
    let api = string_field(input, "api");
    let result = match api.as_str() {
        "createService" => create_service(&mut host, input),
        "stopService" => stop_service(&mut host, input),
        "removeOfflineService" => remove_offline_service(&mut host, input),
        "resumeOfflineService" => resume_offline_service(&mut host, input),
        "resumeOfflineServiceByState" => resume_offline_service_by_state(&mut host, input),
        "resumeOfflineServiceById" => resume_offline_service_by_id(&mut host, input),
        other => Err(format!("unknown api {other}")),
    };

    match result {
        Ok(result) => host.output(result, Value::Null),
        Err(error) => host.output(Value::Null, Value::String(error)),
    }
}

fn create_service(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let service_id = input
        .pointer("/options/serviceId")
        .and_then(Value::as_str)
        .unwrap_or("<service-id>");
    let command_line = string_field(input, "commandLine");
    let trimmed = command_line.trim();
    let worktree_path = input.get("worktreePath").cloned();
    let cwd = worktree_path
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or(REPO)
        .to_owned();
    let shell = string_field(input, "shell");
    let shell = if shell.is_empty() {
        DEFAULT_SHELL
    } else {
        shell.as_str()
    };
    let label = service_label_for_command(trimmed);
    let target = created_target(input);
    let should_render_pending =
        bool_field(input, "startedInDashboard") && string_field(input, "mode") == "dashboard";

    if should_render_pending {
        host.call(
            "setPendingDashboardServiceAction",
            json!([
                service_id,
                "creating",
                {
                    "serviceSeed": {
                        "id": service_id,
                        "command": if trimmed.is_empty() { "shell" } else { shell },
                        "args": if trimmed.is_empty() { json!(["-l"]) } else { json!(["-lc", trimmed]) },
                        "createdAt": NOW,
                        "worktreePath": worktree_path.clone().unwrap_or(Value::Null),
                        "status": "running",
                        "active": false,
                        "label": label,
                        "optimistic": true,
                    },
                },
            ]),
        );
    }

    host.call("tmuxRuntimeManager.ensureProjectSession", json!([REPO]));
    let (command, args) = service_wrapped_command(service_id, trimmed, shell);
    host.call(
        "tmuxRuntimeManager.createWindow",
        json!([SESSION_NAME, label, cwd, command, args, { "detached": true }]),
    );

    let metadata = service_metadata(
        service_id,
        shell,
        trimmed,
        worktree_path.clone(),
        &label,
        NOW,
    );
    host.call(
        "tmuxRuntimeManager.setWindowMetadata",
        json!([target, metadata]),
    );

    host.topology_services.push(topology_service_from_launch(
        input, service_id, shell, trimmed, &cwd, &label, &target,
    ));
    host.call(
        "tmuxRuntimeManager.applyManagedAgentWindowPolicy",
        json!([target, "service"]),
    );
    host.commit_service_state(
        vec![saved_service_from_launch(
            input, service_id, trimmed, &cwd, &label, &target,
        )],
        &[],
    );
    host.call(
        "preferDashboardEntrySelection",
        json!(["service", service_id, worktree_path.unwrap_or(Value::Null)]),
    );
    host.call(
        "settleDashboardCreatePending",
        json!([service_id, "service"]),
    );
    Ok(json!({ "serviceId": service_id }))
}

fn stop_service(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let service_id = string_field(input, "serviceId");
    host.call("tmuxRuntimeManager.getProjectSession", json!([REPO]));
    let Some(existing) = input.get("existingWindow").filter(|value| !value.is_null()) else {
        return Err(format!("Service \"{service_id}\" not found"));
    };
    host.call(
        "tmuxRuntimeManager.findManagedWindow",
        json!([SESSION_NAME, { "sessionId": service_id }]),
    );
    let metadata = existing.get("metadata").unwrap_or(&Value::Null);
    if string_field(metadata, "kind") != "service" {
        return Err(format!("Service \"{service_id}\" not found"));
    }
    let target = existing.get("target").cloned().unwrap_or(Value::Null);
    host.call("noteLastUsedItem", json!([service_id]));
    host.call(
        "tmuxRuntimeManager.displayMessage",
        json!(["#{pane_current_path}", string_field(&target, "windowId")]),
    );
    let cwd = input
        .get("displayPath")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            string_field(metadata, "worktreePath")
                .is_empty()
                .not()
                .then(|| string_field(metadata, "worktreePath"))
        })
        .unwrap_or_default();
    let offline =
        service_state_from_metadata(service_id.as_str(), metadata, cwd.as_str(), None, None);
    host.offline_services
        .retain(|service| string_field(service, "id") != service_id);
    host.offline_services.push(offline.clone());
    host.topology_services.push(topology_service_from_metadata(
        service_id.as_str(),
        metadata,
        cwd.as_str(),
        "stopped",
        None,
    ));
    host.call("tmuxRuntimeManager.killWindow", json!([target]));
    if bool_field(input, "killWindowThrows") {
        host.call("tmuxRuntimeManager.sendKey", json!([target, "C-c"]));
    }
    host.commit_service_state(Vec::new(), &[]);
    Ok(json!({ "serviceId": service_id, "status": "stopped" }))
}

fn remove_offline_service(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let service_id = string_field(input, "serviceId");
    host.removed_service_ids
        .push(Value::String(service_id.clone()));
    let offline_service = host
        .offline_services
        .iter()
        .find(|service| string_field(service, "id") == service_id)
        .cloned();
    host.call("tmuxRuntimeManager.getProjectSession", json!([REPO]));
    host.call(
        "tmuxRuntimeManager.findManagedWindow",
        json!([SESSION_NAME, { "sessionId": service_id }]),
    );
    if let Some(existing) = input.get("existingWindow").filter(|value| !value.is_null()) {
        let metadata = existing.get("metadata").unwrap_or(&Value::Null);
        if string_field(metadata, "kind") == "service" {
            let target = existing.get("target").cloned().unwrap_or(Value::Null);
            host.call("tmuxRuntimeManager.killWindow", json!([target]));
        }
    } else if let Some(target) = offline_service
        .as_ref()
        .and_then(|service| service.get("tmuxTarget"))
        .cloned()
    {
        host.call("tmuxRuntimeManager.hasWindow", json!([target]));
        if bool_field(input, "hasWindow") {
            host.call("tmuxRuntimeManager.killWindow", json!([target]));
        }
    }
    host.offline_services
        .retain(|service| string_field(service, "id") != service_id);
    host.topology_services
        .retain(|service| string_field(service, "id") != service_id);
    host.commit_service_state(Vec::new(), &[service_id]);
    Ok(json!({ "serviceId": string_field(input, "serviceId"), "status": "removed" }))
}

fn resume_offline_service(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let index = input
        .get("serviceIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let service = host
        .offline_services
        .get(index)
        .cloned()
        .ok_or_else(|| "service is required".to_owned())?;
    resume_service(host, input, &service)
}

fn resume_offline_service_by_state(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let service = input.get("service").cloned().unwrap_or(Value::Null);
    resume_service(host, input, &service)
}

fn resume_offline_service_by_id(host: &mut HostState, input: &Value) -> Result<Value, String> {
    let service_id = string_field(input, "serviceId");
    if let Some(service) = host
        .offline_services
        .iter()
        .find(|entry| string_field(entry, "id") == service_id)
        .cloned()
    {
        return resume_service(host, input, &service);
    }

    host.call("tmuxRuntimeManager.getProjectSession", json!([REPO]));
    host.call(
        "tmuxRuntimeManager.findManagedWindow",
        json!([SESSION_NAME, { "sessionId": service_id }]),
    );
    let Some(existing) = input.get("existingWindow").filter(|value| !value.is_null()) else {
        return Err(format!("Service \"{service_id}\" not found"));
    };
    let metadata = existing.get("metadata").unwrap_or(&Value::Null);
    if string_field(metadata, "kind") != "service" {
        return Err(format!("Service \"{service_id}\" not found"));
    }
    let target = existing.get("target").cloned().unwrap_or(Value::Null);
    host.call("tmuxRuntimeManager.isWindowAlive", json!([target]));
    if bool_field(input, "isWindowAlive") {
        return Ok(json!({ "serviceId": service_id, "status": "running" }));
    }
    let restored = service_state_from_metadata(&service_id, metadata, "", None, None);
    resume_service(host, input, &restored)
}

fn resume_service(host: &mut HostState, input: &Value, service: &Value) -> Result<Value, String> {
    let service_id = string_field(service, "id");
    host.call("tmuxRuntimeManager.getProjectSession", json!([REPO]));
    host.call(
        "tmuxRuntimeManager.findManagedWindow",
        json!([SESSION_NAME, { "sessionId": service_id }]),
    );
    if let Some(existing) = input.get("existingWindow").filter(|value| !value.is_null()) {
        let metadata = existing.get("metadata").unwrap_or(&Value::Null);
        if string_field(metadata, "kind") == "service" {
            host.call(
                "tmuxRuntimeManager.killWindow",
                json!([existing.get("target").cloned().unwrap_or(Value::Null)]),
            );
        }
    }

    let cwd = optional_string(service, "worktreePath").unwrap_or_else(|| REPO.into());
    let resume_cwd = optional_string(service, "cwd").unwrap_or_else(|| cwd.clone());
    let shell = optional_string(input, "shell").unwrap_or_else(|| DEFAULT_SHELL.into());
    let launch_command_line = optional_string(service, "launchCommandLine")
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    let label = optional_string(service, "label")
        .unwrap_or_else(|| service_label_for_command(&launch_command_line));
    let target = created_target(input);
    let (command, args) = service_wrapped_command(&service_id, &launch_command_line, &shell);

    host.call("tmuxRuntimeManager.ensureProjectSession", json!([REPO]));
    host.call(
        "tmuxRuntimeManager.createWindow",
        json!([SESSION_NAME, label, resume_cwd, command, args, { "detached": true }]),
    );

    let created_at = service
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(NOW)
        .to_owned();
    let metadata = service_metadata(
        &service_id,
        &shell,
        &launch_command_line,
        service.get("worktreePath").cloned(),
        &label,
        &created_at,
    );
    host.call(
        "tmuxRuntimeManager.setWindowMetadata",
        json!([target, metadata]),
    );
    host.topology_services.push(topology_service_from_resume(
        service,
        &shell,
        &launch_command_line,
        &resume_cwd,
        &label,
        &target,
    ));
    host.call(
        "tmuxRuntimeManager.applyManagedAgentWindowPolicy",
        json!([target, "service"]),
    );
    host.offline_services
        .retain(|entry| string_field(entry, "id") != service_id);
    host.call("noteLastUsedItem", json!([service_id]));
    host.commit_service_state(
        vec![saved_service_from_resume(
            service,
            &launch_command_line,
            &resume_cwd,
            &label,
            &target,
        )],
        &[],
    );
    host.call(
        "preferDashboardEntrySelection",
        json!([
            "service",
            service_id,
            service.get("worktreePath").cloned().unwrap_or(Value::Null)
        ]),
    );
    Ok(json!({ "serviceId": service_id, "status": "running" }))
}

fn service_metadata(
    service_id: &str,
    shell: &str,
    command_line: &str,
    worktree_path: Option<Value>,
    label: &str,
    created_at: &str,
) -> Value {
    let command = if command_line.is_empty() {
        "shell"
    } else {
        shell
    };
    let args = if command_line.is_empty() {
        json!(["-l"])
    } else {
        json!(["-lc", command_line])
    };
    let mut metadata = Map::new();
    metadata.insert("kind".into(), Value::String("service".into()));
    metadata.insert("sessionId".into(), Value::String(service_id.into()));
    metadata.insert("command".into(), Value::String(command.into()));
    metadata.insert("args".into(), args);
    metadata.insert("toolConfigKey".into(), Value::String("service".into()));
    metadata.insert("createdAt".into(), Value::String(created_at.into()));
    if let Some(worktree_path) = worktree_path.filter(|value| !value.is_null()) {
        metadata.insert("worktreePath".into(), worktree_path);
    }
    metadata.insert("label".into(), Value::String(label.into()));
    metadata.insert(
        "launchCommandLine".into(),
        Value::String(command_line.into()),
    );
    Value::Object(metadata)
}

fn saved_service_from_launch(
    input: &Value,
    service_id: &str,
    command_line: &str,
    cwd: &str,
    label: &str,
    target: &Value,
) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), Value::String(service_id.into()));
    service.insert("createdAt".into(), Value::String(NOW.into()));
    copy_if_present(&mut service, input, "worktreePath");
    service.insert("cwd".into(), Value::String(cwd.into()));
    service.insert("label".into(), Value::String(label.into()));
    service.insert(
        "launchCommandLine".into(),
        Value::String(command_line.into()),
    );
    service.insert("tmuxTarget".into(), target.clone());
    Value::Object(service)
}

fn saved_service_from_resume(
    service: &Value,
    command_line: &str,
    cwd: &str,
    label: &str,
    target: &Value,
) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), Value::String(string_field(service, "id")));
    copy_if_present(&mut row, service, "createdAt");
    copy_if_present(&mut row, service, "worktreePath");
    row.insert("cwd".into(), Value::String(cwd.into()));
    row.insert("label".into(), Value::String(label.into()));
    row.insert(
        "launchCommandLine".into(),
        Value::String(command_line.into()),
    );
    row.insert("tmuxTarget".into(), target.clone());
    Value::Object(row)
}

fn service_state_from_metadata(
    service_id: &str,
    metadata: &Value,
    cwd: &str,
    tmux_target: Option<&Value>,
    retained: Option<bool>,
) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), Value::String(service_id.into()));
    copy_if_present(&mut service, metadata, "createdAt");
    copy_if_present(&mut service, metadata, "worktreePath");
    if !cwd.is_empty() {
        service.insert("cwd".into(), Value::String(cwd.into()));
    }
    copy_if_present(&mut service, metadata, "label");
    service.insert(
        "launchCommandLine".into(),
        Value::String(service_launch_command_line(metadata)),
    );
    if let Some(tmux_target) = tmux_target {
        service.insert("tmuxTarget".into(), tmux_target.clone());
    }
    if let Some(retained) = retained {
        service.insert("retained".into(), Value::Bool(retained));
    }
    Value::Object(service)
}

fn topology_service_from_launch(
    input: &Value,
    service_id: &str,
    shell: &str,
    command_line: &str,
    cwd: &str,
    label: &str,
    target: &Value,
) -> Value {
    let mut service = base_topology_service(service_id, "running");
    service.insert(
        "command".into(),
        Value::String(
            if command_line.is_empty() {
                "shell"
            } else {
                shell
            }
            .into(),
        ),
    );
    service.insert(
        "args".into(),
        if command_line.is_empty() {
            json!(["-l"])
        } else {
            json!(["-lc", command_line])
        },
    );
    if !command_line.is_empty() {
        service.insert(
            "launchCommandLine".into(),
            Value::String(command_line.into()),
        );
    }
    copy_if_present(&mut service, input, "worktreePath");
    service.insert("cwd".into(), Value::String(cwd.into()));
    service.insert("label".into(), Value::String(label.into()));
    service.insert("createdAt".into(), Value::String(NOW.into()));
    service.insert("lastSeenAt".into(), Value::String(NOW.into()));
    service.insert("tmuxTarget".into(), target.clone());
    Value::Object(service)
}

fn topology_service_from_metadata(
    service_id: &str,
    metadata: &Value,
    cwd: &str,
    status: &str,
    target: Option<&Value>,
) -> Value {
    let mut service = base_topology_service(service_id, status);
    copy_if_present(&mut service, metadata, "command");
    service.insert(
        "args".into(),
        metadata
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    let launch_command_line = service_launch_command_line(metadata);
    if !launch_command_line.is_empty() {
        service.insert(
            "launchCommandLine".into(),
            Value::String(launch_command_line),
        );
    }
    copy_if_present(&mut service, metadata, "worktreePath");
    if !cwd.is_empty() {
        service.insert("cwd".into(), Value::String(cwd.into()));
    }
    copy_if_present(&mut service, metadata, "label");
    let created_at = optional_trimmed_string(metadata, "createdAt").unwrap_or_else(|| NOW.into());
    service.insert("createdAt".into(), Value::String(created_at));
    if status == "running" {
        service.insert("lastSeenAt".into(), Value::String(NOW.into()));
    }
    if let Some(target) = target {
        service.insert("tmuxTarget".into(), target.clone());
    }
    Value::Object(service)
}

fn topology_service_from_resume(
    service: &Value,
    shell: &str,
    command_line: &str,
    cwd: &str,
    label: &str,
    target: &Value,
) -> Value {
    let service_id = string_field(service, "id");
    let mut row = base_topology_service(&service_id, "running");
    row.insert(
        "command".into(),
        Value::String(
            if command_line.is_empty() {
                "shell"
            } else {
                shell
            }
            .into(),
        ),
    );
    row.insert(
        "args".into(),
        if command_line.is_empty() {
            json!(["-l"])
        } else {
            json!(["-lc", command_line])
        },
    );
    if !command_line.is_empty() {
        row.insert(
            "launchCommandLine".into(),
            Value::String(command_line.into()),
        );
    }
    copy_if_present(&mut row, service, "worktreePath");
    row.insert("cwd".into(), Value::String(cwd.into()));
    row.insert("label".into(), Value::String(label.into()));
    row.insert(
        "createdAt".into(),
        Value::String(optional_trimmed_string(service, "createdAt").unwrap_or_else(|| NOW.into())),
    );
    row.insert("lastSeenAt".into(), Value::String(NOW.into()));
    row.insert("tmuxTarget".into(), target.clone());
    Value::Object(row)
}

fn base_topology_service(service_id: &str, status: &str) -> Map<String, Value> {
    let mut service = Map::new();
    service.insert("id".into(), Value::String(service_id.into()));
    service.insert("status".into(), Value::String(status.into()));
    service
}

fn service_wrapped_command(
    service_id: &str,
    command_line: &str,
    shell: &str,
) -> (String, Vec<Value>) {
    if command_line.trim().is_empty() {
        return (
            "env".into(),
            managed_env_args(
                service_id,
                [
                    format!("AIMUX_SESSION_ID={service_id}"),
                    "AIMUX_TOOL=service".into(),
                    format!("AIMUX_METADATA_ENDPOINT_FILE={PROJECT_STATE}/metadata-api.txt"),
                    format!(
                        "AIMUX_SHELL_INTEGRATION_SCRIPT={PROJECT_STATE}/shell-integration/aimux-zsh-integration.zsh"
                    ),
                    format!(
                        "AIMUX_SHELL_STATE_SUPPRESS_FILE={PROJECT_STATE}/shell-state-suppress/{service_id}"
                    ),
                    format!("ZDOTDIR={PROJECT_STATE}/shell-integration"),
                    shell.into(),
                    "-i".into(),
                ],
            ),
        );
    }
    let launch_script = build_service_launch_script(command_line, shell);
    let command_string = [shell, "-lc", launch_script.as_str()]
        .into_iter()
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    (
        "env".into(),
        managed_env_args(
            service_id,
            [
                format!("AIMUX_SESSION_ID={service_id}"),
                "AIMUX_TOOL=service".into(),
                format!("AIMUX_METADATA_ENDPOINT_FILE={PROJECT_STATE}/metadata-api.txt"),
                format!(
                    "AIMUX_SHELL_INTEGRATION_SCRIPT={PROJECT_STATE}/shell-integration/aimux-zsh-integration.zsh"
                ),
                format!(
                    "AIMUX_SHELL_STATE_SUPPRESS_FILE={PROJECT_STATE}/shell-state-suppress/{service_id}"
                ),
                format!("ZDOTDIR={PROJECT_STATE}/shell-integration"),
                shell.into(),
                "-ic".into(),
                command_string,
            ],
        ),
    )
}

fn managed_env_args(_service_id: &str, shell_args: impl IntoIterator<Item = String>) -> Vec<Value> {
    [
        "-i".to_owned(),
        "AIMUX_DAEMON_PORT=43190".to_owned(),
        "AIMUX_ENV=production".to_owned(),
        "AIMUX_HOME=<repo>/home".to_owned(),
        "CLICOLOR=1".to_owned(),
        "COLORTERM=truecolor".to_owned(),
        "HOME=<repo>/user-home".to_owned(),
        "LANG=C.UTF-8".to_owned(),
        "PATH=/usr/bin:/bin".to_owned(),
        "SHELL=zsh".to_owned(),
        "TERM=xterm-256color".to_owned(),
        "USER=sam".to_owned(),
        "env".to_owned(),
    ]
    .into_iter()
    .chain(shell_args)
    .map(Value::String)
    .collect()
}

fn build_service_launch_script(command_line: &str, shell_path: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    format!(
        "{trimmed}; _aimux_service_status=$?; if [ \"$_aimux_service_status\" -ne 0 ]; then;   printf \"\\n[aimux] Service command exited with status %s. Dropping into an interactive shell for debugging.\\n\" \"$_aimux_service_status\";   exec {} -i; fi; exit \"$_aimux_service_status\"",
        shell_quote(shell_path)
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn service_launch_command_line(metadata: &Value) -> String {
    optional_trimmed_string(metadata, "launchCommandLine").unwrap_or_else(|| {
        metadata
            .get("args")
            .and_then(Value::as_array)
            .filter(|args| args.first().and_then(Value::as_str) == Some("-lc"))
            .and_then(|args| args.get(1).and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned()
    })
}

fn service_label_for_command(command_line: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return "shell".into();
    }
    trimmed
        .split_whitespace()
        .next()
        .and_then(|first| first.rsplit('/').next())
        .unwrap_or("service")
        .to_owned()
}

fn created_target(input: &Value) -> Value {
    input
        .pointer("/targets/created")
        .cloned()
        .unwrap_or_else(|| json!({ "sessionName": SESSION_NAME, "windowId": "@9", "windowIndex": 9, "windowName": "dev" }))
}

fn empty_calls() -> Map<String, Value> {
    CALL_NAMES
        .iter()
        .map(|name| ((*name).to_owned(), Value::Array(Vec::new())))
        .collect()
}

fn copy_if_present(output: &mut Map<String, Value>, source: &Value, field: &str) {
    if let Some(value) = source.get(field).filter(|value| !value.is_null()) {
        output.insert(field.to_owned(), value.clone());
    }
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn optional_trimmed_string(value: &Value, field: &str) -> Option<String> {
    optional_string(value, field)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

trait BoolNot {
    fn not(self) -> bool;
}

impl BoolNot for bool {
    fn not(self) -> bool {
        !self
    }
}
