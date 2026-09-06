use serde_json::{Map, Value};

pub fn run_multiplexer_services_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "getServiceLaunchCommandLine" => {
            Value::String(service_launch_command_line(value_field(input, "metadata")))
        }
        "serviceLabelForCommand" => {
            Value::String(service_label_for_command(str_field(input, "commandLine")))
        }
        "buildServiceStateFromMetadata" => build_service_state_from_metadata(input),
        api => panic!("unknown multiplexer services api: {api}"),
    }
}

fn build_service_state_from_metadata(input: &Value) -> Value {
    let metadata = value_field(input, "metadata");
    let options = value_field(input, "options");
    let mut object = Map::new();
    object.insert(
        "id".to_owned(),
        Value::String(str_field(input, "serviceId").to_owned()),
    );
    copy_if_present(&mut object, metadata, "createdAt");
    copy_if_present(&mut object, metadata, "worktreePath");
    copy_if_present(&mut object, options, "cwd");
    copy_if_present(&mut object, metadata, "label");
    object.insert(
        "launchCommandLine".to_owned(),
        Value::String(launch_command_line_from_metadata(metadata)),
    );
    copy_if_present(&mut object, options, "tmuxTarget");
    copy_if_present(&mut object, options, "retained");
    Value::Object(object)
}

fn launch_command_line_from_metadata(metadata: &Value) -> String {
    let explicit = str_field(metadata, "launchCommandLine").trim().to_owned();
    if explicit.is_empty() {
        service_launch_command_line(metadata)
    } else {
        explicit
    }
}

fn service_launch_command_line(metadata: &Value) -> String {
    let args = metadata
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.first().and_then(Value::as_str) == Some("-lc") {
        args.get(1)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        String::new()
    }
}

fn service_label_for_command(command_line: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return "shell".to_owned();
    }
    let first = trimmed.split_whitespace().next().unwrap_or("service");
    first.rsplit('/').next().unwrap_or(first).to_owned()
}

fn copy_if_present(output: &mut Map<String, Value>, source: &Value, field: &str) {
    if let Some(value) = source.get(field) {
        output.insert(field.to_owned(), value.clone());
    }
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
