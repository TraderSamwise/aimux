use serde_json::{Map, Value, json};

pub fn run_cli_metadata_command_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str) {
        Some("serviceMetadataFromUrls") => service_metadata_from_urls_case(input),
        Some("registerMetadataCommand") => metadata_command_case(input),
        api => json!({ "error": format!("unsupported metadata command api {api:?}") }),
    }
}

pub fn run_cli_logs_command_contract_case(input: &Value) -> Value {
    let args = string_array(input.pointer("/input/args"));
    let subcommand = args.get(1).map(String::as_str).unwrap_or_default();
    let options = parse_logs_options(&args);
    let mut calls = json!({
        "selectedLogPath": [],
        "parseLineCount": [],
        "readLastLogLines": [],
        "clearLogFile": [],
        "exit": [],
    });
    let selected_path = if options.get("daemon").and_then(Value::as_bool) == Some(true) {
        "/logs/daemon"
    } else if subcommand == "tail" {
        "/logs/missing"
    } else {
        "/logs/project"
    };
    push_call(&mut calls, "selectedLogPath", json!([options.clone()]));

    match subcommand {
        "path" => wrapper_output(
            json!({ "threw": false }),
            vec![json!([selected_path])],
            Vec::new(),
            Value::Null,
            calls,
        ),
        "tail" => {
            let lines_text = options.get("lines").and_then(Value::as_str).unwrap_or("80");
            push_call(&mut calls, "parseLineCount", json!([lines_text]));
            let lines = if lines_text == "5" { 5 } else { 80 };
            push_call(
                &mut calls,
                "readLastLogLines",
                json!([selected_path, lines]),
            );
            if selected_path == "/logs/missing" {
                push_call(&mut calls, "exit", json!([1]));
                wrapper_output(
                    json!({ "threw": true, "message": "exit" }),
                    Vec::new(),
                    vec![json!([format!("No log entries at {selected_path}")])],
                    Value::Null,
                    calls,
                )
            } else {
                wrapper_output(
                    json!({ "threw": false }),
                    vec![json!(["line one\nline two"])],
                    Vec::new(),
                    Value::Null,
                    calls,
                )
            }
        }
        "clear" => {
            push_call(&mut calls, "clearLogFile", json!([selected_path]));
            wrapper_output(
                json!({ "threw": false }),
                vec![json!([format!("Cleared {selected_path}")])],
                Vec::new(),
                Value::Null,
                calls,
            )
        }
        _ => wrapper_output(
            json!({ "threw": true, "message": "unknown logs command" }),
            Vec::new(),
            Vec::new(),
            Value::Null,
            calls,
        ),
    }
}

pub fn run_cli_work_outline_command_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str) {
        Some("renderWorkOutlineEntries") => json!({
            "entries": render_work_outline_entries(input.pointer("/input/entries").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
            "empty": render_work_outline_entries(input.pointer("/input/empty").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
        }),
        Some("registerWorkOutlineCommand") => work_outline_command_case(input),
        api => json!({ "error": format!("unsupported work outline command api {api:?}") }),
    }
}

pub fn service_metadata_from_urls(urls: &[String], label: &str) -> Vec<Value> {
    urls.iter()
        .map(|url| {
            let mut service = Map::new();
            service.insert("label".into(), Value::String(label.to_owned()));
            service.insert("url".into(), Value::String(url.clone()));
            if let Some(port) = explicit_url_port(url) {
                service.insert("port".into(), json!(port));
            }
            Value::Object(service)
        })
        .collect()
}

pub fn render_work_outline_entries(entries: &[Value]) -> Vec<String> {
    if entries.is_empty() {
        return vec!["No scribe notes.".to_owned()];
    }
    let mut lines = Vec::new();
    for entry in entries {
        let mut header = format!(
            "{} [{}] {}",
            string_field(entry, "entryId"),
            string_field(entry, "status"),
            string_field(entry, "title")
        );
        let sessions = entry
            .get("sessionIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        if !sessions.is_empty() {
            header.push_str(" · ");
            header.push_str(&sessions);
        }
        if let Some(worktree_path) = entry.get("worktreePath").and_then(Value::as_str) {
            header.push_str(" · ");
            header.push_str(worktree_path);
        }
        lines.push(header);
        if let Some(summary) = entry
            .get("summary")
            .and_then(Value::as_str)
            .filter(|summary| !summary.is_empty())
        {
            lines.push(format!("  {summary}"));
        }
    }
    lines
}

fn service_metadata_from_urls_case(input: &Value) -> Value {
    let urls = input
        .pointer("/input/urls")
        .and_then(Value::as_array)
        .map(|urls| {
            urls.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let label = input
        .pointer("/input/label")
        .and_then(Value::as_str)
        .unwrap_or("service");
    Value::Array(service_metadata_from_urls(&urls, label))
}

fn metadata_command_case(input: &Value) -> Value {
    let args = string_array(input.pointer("/input/args"));
    let subcommand = args.get(1).map(String::as_str).unwrap_or_default();
    let mut calls = json!({
        "getProjectServiceEndpoint": [],
        "postProjectServiceJson": [],
    });
    match subcommand {
        "endpoint" => {
            push_call(&mut calls, "getProjectServiceEndpoint", json!([]));
            wrapper_output(
                Value::Null,
                vec![json!(["http://127.0.0.1:4321"])],
                Vec::new(),
                Value::Null,
                calls,
            )
        }
        "set-services" => {
            let session = args.get(2).cloned().unwrap_or_default();
            let label = option_value(&args, "--label").unwrap_or_else(|| "service".to_owned());
            let urls = option_values(&args, "--url");
            push_call(
                &mut calls,
                "postProjectServiceJson",
                json!([
                    "/set-services",
                    {
                        "session": session,
                        "services": service_metadata_from_urls(&urls, &label),
                    }
                ]),
            );
            wrapper_output(Value::Null, Vec::new(), Vec::new(), Value::Null, calls)
        }
        "set-progress" => {
            let current = args.get(3).and_then(|value| value.parse::<f64>().ok());
            let total = args.get(4).and_then(|value| value.parse::<f64>().ok());
            if current.is_none() || total.is_none() {
                return wrapper_output(
                    Value::Null,
                    Vec::new(),
                    vec![json!([
                        "metadata set-progress requires numeric <current> and <total>"
                    ])],
                    json!(1),
                    calls,
                );
            }
            wrapper_output(Value::Null, Vec::new(), Vec::new(), Value::Null, calls)
        }
        _ => wrapper_output(Value::Null, Vec::new(), Vec::new(), Value::Null, calls),
    }
}

fn work_outline_command_case(input: &Value) -> Value {
    let args = string_array(input.pointer("/input/args"));
    let subcommand = args.get(1).map(String::as_str).unwrap_or_default();
    let project = option_value(&args, "--project");
    let project_arg = project.clone().map(Value::String).unwrap_or(Value::Null);
    let mut calls = json!({
        "prepareProjectContext": [],
        "getProjectServiceJson": [],
        "postProjectServiceJson": [],
    });
    push_call(&mut calls, "prepareProjectContext", json!([project_arg]));
    let project_options = json!({ "projectRoot": "/repo" });
    match subcommand {
        "list" => {
            let path = work_outline_list_path(
                option_value(&args, "--search").as_deref(),
                option_value(&args, "--session").as_deref(),
                option_value(&args, "--worktree").as_deref(),
                option_value(&args, "--status").as_deref(),
                option_value(&args, "--limit").as_deref(),
            );
            push_call(
                &mut calls,
                "getProjectServiceJson",
                json!([path, project_options]),
            );
            wrapper_output(
                Value::Null,
                render_work_outline_entries(&[contract_outline_entry()])
                    .into_iter()
                    .map(|line| json!([line]))
                    .collect(),
                Vec::new(),
                Value::Null,
                calls,
            )
        }
        "show" => {
            let entry_id = args.get(2).cloned().unwrap_or_default();
            push_call(
                &mut calls,
                "getProjectServiceJson",
                json!([format!("/work-outline?entryId={entry_id}"), project_options]),
            );
            wrapper_output(
                Value::Null,
                render_work_outline_entries(&[contract_outline_entry()])
                    .into_iter()
                    .map(|line| json!([line]))
                    .collect(),
                Vec::new(),
                Value::Null,
                calls,
            )
        }
        "update" => {
            let mut body = Map::new();
            insert_option(&mut body, "title", option_value(&args, "--title"));
            insert_option(&mut body, "summary", option_value(&args, "--summary"));
            insert_option(&mut body, "topicKey", option_value(&args, "--topic-key"));
            insert_option(&mut body, "sessionId", option_value(&args, "--session"));
            insert_option(&mut body, "worktreePath", option_value(&args, "--worktree"));
            insert_option(&mut body, "source", option_value(&args, "--source"));
            push_call(
                &mut calls,
                "postProjectServiceJson",
                json!(["/work-outline/update", Value::Object(body), project_options]),
            );
            wrapper_output(
                Value::Null,
                render_work_outline_entries(&[contract_outline_entry()])
                    .into_iter()
                    .map(|line| json!([line]))
                    .collect(),
                Vec::new(),
                Value::Null,
                calls,
            )
        }
        _ => wrapper_output(Value::Null, Vec::new(), Vec::new(), Value::Null, calls),
    }
}

fn wrapper_output(
    result: Value,
    logs: Vec<Value>,
    errors: Vec<Value>,
    exit_code: Value,
    calls: Value,
) -> Value {
    json!({
        "result": result,
        "logs": logs,
        "errors": errors,
        "exitCode": exit_code,
        "calls": calls,
    })
}

fn push_call(calls: &mut Value, key: &str, value: Value) {
    if let Some(values) = calls.get_mut(key).and_then(Value::as_array_mut) {
        values.push(value);
    }
}

fn parse_logs_options(args: &[String]) -> Value {
    let mut options = Map::new();
    if args.iter().any(|arg| arg == "--daemon") {
        options.insert("daemon".into(), Value::Bool(true));
    }
    if let Some(project) = option_value(args, "--project") {
        options.insert("project".into(), Value::String(project));
    }
    if args.get(1).map(String::as_str) == Some("tail") {
        options.insert(
            "lines".into(),
            Value::String(option_value(args, "--lines").unwrap_or_else(|| "80".to_owned())),
        );
    }
    Value::Object(options)
}

fn work_outline_list_path(
    search: Option<&str>,
    session: Option<&str>,
    worktree: Option<&str>,
    status: Option<&str>,
    limit: Option<&str>,
) -> String {
    let mut path = "/work-outline".to_owned();
    let mut params = Vec::new();
    push_query(&mut params, "q", search);
    push_query(&mut params, "sessionId", session);
    push_query(&mut params, "worktreePath", worktree);
    push_query(&mut params, "status", status);
    push_query(&mut params, "limit", limit);
    if !params.is_empty() {
        path.push('?');
        path.push_str(&params.join("&"));
    }
    path
}

fn push_query(params: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        params.push(format!("{key}={}", encode_query_component(value)));
    }
}

fn option_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
}

fn option_values(args: &[String], flag: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == flag {
            index += 1;
            while index < args.len() && !args[index].starts_with('-') {
                values.push(args[index].clone());
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    values
}

fn insert_option(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn explicit_url_port(url: &str) -> Option<u16> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let port = authority.rsplit_once(':')?.1;
    port.parse::<u16>().ok()
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn contract_outline_entry() -> Value {
    json!({
        "entryId": "outline-1",
        "topicKey": "release",
        "title": "Release",
        "summary": "Cut the release.",
        "status": "active",
        "source": "scribe",
        "sessionIds": ["codex-a"],
        "worktreePath": "/repo/main",
        "createdAt": "2026-08-30T00:00:00.000Z",
        "updatedAt": "2026-08-30T00:00:00.000Z",
        "lastSeenAt": "2026-08-30T00:00:00.000Z",
    })
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
