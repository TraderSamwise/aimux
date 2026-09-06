use serde_json::{Map, Value, json};

pub fn run_app_lifecycle_transitions_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "localAndFail" => {
            let local =
                local_project_lifecycle_transition(input.get("value").unwrap_or(&Value::Null));
            let mut failed = local.as_object().cloned().unwrap_or_default();
            failed.insert("phase".to_string(), json!("failed"));
            failed.insert("updatedAt".to_string(), json!("<ts:1>"));
            json!({ "local": local, "failed": Value::Object(failed) })
        }
        "applyProjectLifecycleTransitionsToDesktopState" => {
            apply_project_lifecycle_transitions_to_desktop_state(
                input.get("state").unwrap_or(&Value::Null),
                array_field(input, "records"),
            )
        }
        api => panic!("unknown app lifecycle transitions contract api: {api}"),
    }
}

fn local_project_lifecycle_transition(input: &Value) -> Value {
    let operation = str_field(input, "operation");
    let target_kind = str_field(input, "targetKind");
    let target = optional_str(input, "targetId")
        .or_else(|| optional_str(input, "targetPath"))
        .unwrap_or("unknown");
    let mut output = Map::new();
    output.insert(
        "operationId".to_string(),
        json!(format!("client:{operation}:{target}:<id:1>")),
    );
    output.insert("operation".to_string(), json!(operation));
    output.insert("targetKind".to_string(), json!(target_kind));
    insert_value(&mut output, "targetId", input.get("targetId"));
    insert_value(&mut output, "targetPath", input.get("targetPath"));
    output.insert("phase".to_string(), json!("started"));
    output.insert("startedAt".to_string(), json!("<ts:1>"));
    output.insert("updatedAt".to_string(), json!("<ts:1>"));
    Value::Object(output)
}

fn apply_project_lifecycle_transitions_to_desktop_state(state: &Value, records: &[Value]) -> Value {
    if state.is_null() || records.is_empty() {
        return state.clone();
    }
    let mut sessions = array_field(state, "sessions").to_vec();
    let mut services = array_field(state, "services").to_vec();
    let mut worktrees = array_field(state, "worktrees").to_vec();

    for record in records {
        let transition = record.get("transition").unwrap_or(&Value::Null);
        if !matches!(
            str_field(transition, "phase"),
            "queued" | "started" | "settling" | "succeeded"
        ) {
            continue;
        }
        match str_field(transition, "targetKind") {
            "agent" => overlay_agent_transition(&mut sessions, record),
            "service" => overlay_service_transition(&mut services, record),
            "worktree" => overlay_worktree_transition(&mut worktrees, record),
            _ => {}
        }
    }

    let mut output = state.as_object().cloned().unwrap_or_default();
    output.insert("sessions".to_string(), json!(sessions));
    output.insert("services".to_string(), json!(services));
    output.insert("worktrees".to_string(), json!(worktrees));
    Value::Object(output)
}

fn overlay_agent_transition(sessions: &mut Vec<Value>, record: &Value) {
    let transition = record.get("transition").unwrap_or(&Value::Null);
    let session_id = str_field(transition, "targetId");
    if session_id.is_empty() {
        return;
    }
    let Some(pending_action) = agent_pending_action(str_field(transition, "operation")) else {
        return;
    };
    let status = "waiting";
    if let Some(index) = sessions
        .iter()
        .position(|session| str_field(session, "id") == session_id)
    {
        let mut session = sessions[index].as_object().cloned().unwrap_or_default();
        if str_field(transition, "operation") == "agent.rename"
            && let Some(label) = record.get("label")
        {
            session.insert("label".to_string(), label.clone());
        }
        session.insert("status".to_string(), json!(status));
        session.insert("pendingAction".to_string(), json!(pending_action));
        session.insert("optimistic".to_string(), json!(true));
        sessions[index] = Value::Object(session);
        return;
    }
    if !matches!(
        str_field(transition, "operation"),
        "agent.spawn" | "agent.fork" | "agent.resume" | "graveyard.agent.resurrect"
    ) {
        return;
    }
    let mut session = Map::new();
    session.insert("id".to_string(), json!(session_id));
    session.insert(
        "label".to_string(),
        record
            .get("label")
            .cloned()
            .unwrap_or_else(|| json!(session_id)),
    );
    insert_value(&mut session, "command", record.get("tool"));
    insert_value(&mut session, "toolConfigKey", record.get("tool"));
    insert_value(&mut session, "worktreePath", record.get("worktreePath"));
    session.insert("status".to_string(), json!(status));
    session.insert("pendingAction".to_string(), json!(pending_action));
    session.insert("optimistic".to_string(), json!(true));
    sessions.push(Value::Object(session));
}

fn overlay_service_transition(services: &mut Vec<Value>, record: &Value) {
    let transition = record.get("transition").unwrap_or(&Value::Null);
    let service_id = str_field(transition, "targetId");
    if service_id.is_empty() {
        return;
    }
    let Some(pending_action) = service_pending_action(str_field(transition, "operation")) else {
        return;
    };
    let status = if str_field(transition, "operation") == "service.remove" {
        "offline"
    } else {
        "running"
    };
    if let Some(index) = services
        .iter()
        .position(|service| str_field(service, "id") == service_id)
    {
        let mut service = services[index].as_object().cloned().unwrap_or_default();
        service.insert("status".to_string(), json!(status));
        service.insert("pendingAction".to_string(), json!(pending_action));
        service.insert("optimistic".to_string(), json!(true));
        services[index] = Value::Object(service);
        return;
    }
    if str_field(transition, "operation") != "service.create" {
        return;
    }
    let mut service = Map::new();
    service.insert("id".to_string(), json!(service_id));
    service.insert(
        "label".to_string(),
        record
            .get("label")
            .cloned()
            .unwrap_or_else(|| json!(service_id)),
    );
    insert_value(&mut service, "worktreePath", record.get("worktreePath"));
    service.insert("status".to_string(), json!(status));
    service.insert("pendingAction".to_string(), json!(pending_action));
    service.insert("optimistic".to_string(), json!(true));
    services.push(Value::Object(service));
}

fn overlay_worktree_transition(worktrees: &mut Vec<Value>, record: &Value) {
    let transition = record.get("transition").unwrap_or(&Value::Null);
    let path = optional_str(record, "worktreePath")
        .or_else(|| optional_str(transition, "targetPath"))
        .unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let operation = str_field(transition, "operation");
    let index = worktrees
        .iter()
        .position(|worktree| str_field(worktree, "path") == path);
    if matches!(
        operation,
        "worktree.create" | "graveyard.worktree.resurrect"
    ) {
        if let Some(index) = index {
            let mut worktree = worktrees[index].as_object().cloned().unwrap_or_default();
            worktree.insert("pending".to_string(), json!(true));
            worktrees[index] = Value::Object(worktree);
            return;
        }
        worktrees.push(new_worktree(record, transition, path, "pending"));
        return;
    }
    if matches!(
        operation,
        "worktree.remove" | "worktree.graveyard" | "graveyard.worktree.delete"
    ) && index.is_none()
    {
        worktrees.push(new_worktree(record, transition, path, "removing"));
        return;
    }
    if let Some(index) = index {
        let mut worktree = worktrees[index].as_object().cloned().unwrap_or_default();
        worktree.insert("removing".to_string(), json!(true));
        worktrees[index] = Value::Object(worktree);
    }
}

fn new_worktree(record: &Value, transition: &Value, path: &str, flag: &str) -> Value {
    let name = optional_str(record, "worktreeName")
        .or_else(|| optional_str(transition, "targetId"))
        .or_else(|| path.rsplit(['/', '\\']).next())
        .unwrap_or(path);
    let mut worktree = Map::new();
    worktree.insert("name".to_string(), json!(name));
    worktree.insert("path".to_string(), json!(path));
    worktree.insert("branch".to_string(), json!(name));
    worktree.insert(flag.to_string(), json!(true));
    Value::Object(worktree)
}

fn agent_pending_action(operation: &str) -> Option<&'static str> {
    match operation {
        "agent.spawn" | "agent.resume" | "graveyard.agent.resurrect" => Some("starting"),
        "agent.fork" => Some("forking"),
        "agent.switchTool" => Some("switching"),
        "agent.stop" => Some("stopping"),
        "agent.kill" => Some("graveyarding"),
        "agent.rename" => Some("renaming"),
        "agent.migrate" => Some("migrating"),
        "agent.interrupt" => Some("interrupting"),
        _ => None,
    }
}

fn service_pending_action(operation: &str) -> Option<&'static str> {
    match operation {
        "service.create" | "service.resume" => Some("starting"),
        "service.stop" => Some("stopping"),
        "service.remove" => Some("removing"),
        _ => None,
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        map.insert(key.to_string(), value.clone());
    }
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

fn optional_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}
