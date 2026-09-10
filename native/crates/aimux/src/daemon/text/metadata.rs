use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl, text_error};
use crate::daemon::text::params::ProjectServiceJsonResult;
use crate::daemon_state::MetadataApiEndpoint;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Number, Value, json};

pub trait DaemonMetadataTextRuntime {
    fn resolve_project_root(&self, value: &str) -> String;
    fn ensure_project(&mut self, project_root: &str) -> Result<(), String>;
    fn metadata_endpoint(&self, project_root: &str) -> Option<MetadataApiEndpoint>;
    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult;
}

#[derive(Debug, Clone, PartialEq)]
pub enum MetadataCliResult {
    Endpoint,
    Post { route_path: String, body: Value },
    Error(String),
}

pub fn route_metadata_text_request(
    runtime: &mut impl DaemonMetadataTextRuntime,
    method: &str,
    path: &str,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    if method != "POST" || route_url.pathname() != CORE_API_ROUTES.metadata_text {
        return None;
    }
    Some(metadata_text_route(runtime, &route_url))
}

pub fn metadata_text_route(
    runtime: &mut impl DaemonMetadataTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let Some(project) = route_url.search_param("project") else {
        return text_error(400, "project query is required");
    };
    let raw_args = route_url.search_params("arg");
    let args_text = route_url.search_param("args");
    let args: Vec<String> = if raw_args.is_empty() {
        args_text
            .map(|value| {
                value
                    .split('\n')
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        raw_args.into_iter().map(str::to_owned).collect()
    };

    let parsed = parse_runtime_metadata_cli_args(&args);
    let project_root = runtime.resolve_project_root(project);
    match parsed {
        MetadataCliResult::Endpoint => {
            if let Err(error) = runtime.ensure_project(&project_root) {
                return text_error(502, format!("Error: {error}"));
            }
            match runtime.metadata_endpoint(&project_root) {
                Some(endpoint) => DaemonRouteResponse::text(
                    200,
                    format!("http://{}:{}\n", endpoint.host, endpoint.port),
                ),
                None => text_error(
                    503,
                    format!("Error: project service unavailable for {project_root}"),
                ),
            }
        }
        MetadataCliResult::Post { route_path, body } => {
            match runtime.post_project_service_json(&project_root, &route_path, body) {
                ProjectServiceJsonResult::Ok { .. } => DaemonRouteResponse::text(200, ""),
                ProjectServiceJsonResult::Err { response } => response,
            }
        }
        MetadataCliResult::Error(error) => text_error(400, error),
    }
}

pub fn parse_runtime_metadata_cli_args(raw_args: &[String]) -> MetadataCliResult {
    let args = strip_option_terminator(strip_command(raw_args));
    let subcommand = args.first().map(String::as_str).unwrap_or("");
    if subcommand == "endpoint" && args.len() == 1 {
        return MetadataCliResult::Endpoint;
    }

    if subcommand == "event" {
        let session = args.get(1).map(String::as_str);
        let kind = args.get(2).map(String::as_str);
        if !valid_required(session) || !valid_required(kind) {
            return MetadataCliResult::Error("metadata event requires <session> and <kind>".into());
        }
        let mut event = Map::new();
        event.insert("kind".into(), Value::String(kind.unwrap().into()));
        for_each_option(&args, 3, &[
            ("--message", "message"),
            ("--source", "source"),
            ("--tone", "tone"),
            ("--thread-id", "threadId"),
            ("--thread-name", "threadName"),
        ], |field, value| {
            event.insert(field.into(), Value::String(value.into()));
            Ok(())
        })
        .map_or_else(
            MetadataCliResult::Error,
            |_| MetadataCliResult::Post {
                route_path: project_routes::runtime::EVENT.into(),
                body: json!({ "session": session.unwrap(), "event": Value::Object(compact_record(event)) }),
            },
        )
    } else if subcommand == "mark-seen" || subcommand == "clear-log" {
        let session = args.get(1).map(String::as_str);
        if !valid_required(session) || args.len() != 2 {
            return MetadataCliResult::Error(format!("metadata {subcommand} requires <session>"));
        }
        let route_path = if subcommand == "mark-seen" {
            project_routes::runtime::MARK_SEEN
        } else {
            project_routes::runtime::CLEAR_LOG
        };
        MetadataCliResult::Post {
            route_path: route_path.into(),
            body: json!({ "session": session.unwrap() }),
        }
    } else if subcommand == "set-activity" || subcommand == "set-attention" {
        let session = args.get(1).map(String::as_str);
        let value = args.get(2).map(String::as_str);
        if !valid_required(session) || !valid_required(value) || args.len() != 3 {
            return MetadataCliResult::Error(format!(
                "metadata {subcommand} requires <session> and <value>"
            ));
        }
        let (route_path, key) = if subcommand == "set-activity" {
            (project_routes::runtime::SET_ACTIVITY, "activity")
        } else {
            (project_routes::runtime::SET_ATTENTION, "attention")
        };
        MetadataCliResult::Post {
            route_path: route_path.into(),
            body: json!({ "session": session.unwrap(), key: value.unwrap() }),
        }
    } else if subcommand == "set-status" {
        parse_set_status(&args)
    } else if subcommand == "set-progress" {
        parse_set_progress(&args)
    } else if subcommand == "set-context" {
        parse_set_context(&args)
    } else if subcommand == "set-services" {
        parse_set_services(&args)
    } else if subcommand == "log" {
        parse_log(&args)
    } else {
        MetadataCliResult::Error("unsupported metadata command".into())
    }
}

fn parse_set_status(args: &[String]) -> MetadataCliResult {
    let session = args.get(1).map(String::as_str);
    let text = args.get(2).map(String::as_str);
    if !valid_required(session) || text.is_none_or(str::is_empty) {
        return MetadataCliResult::Error(
            "metadata set-status requires <session> and <text>".into(),
        );
    }
    let mut tone = "info".to_owned();
    let mut index = 3;
    while index < args.len() {
        let Some(consumed) = option_value(args, index, "--tone") else {
            return MetadataCliResult::Error(format!(
                "unsupported metadata set-status argument: {}",
                args[index]
            ));
        };
        tone = consumed.value;
        index = consumed.next_index + 1;
    }
    MetadataCliResult::Post {
        route_path: project_routes::runtime::SET_STATUS.into(),
        body: json!({ "session": session.unwrap(), "text": text.unwrap(), "tone": tone }),
    }
}

fn parse_set_progress(args: &[String]) -> MetadataCliResult {
    let session = args.get(1).map(String::as_str);
    let current = args.get(2).and_then(|value| parse_js_finite_number(value));
    let total = args.get(3).and_then(|value| parse_js_finite_number(value));
    if !valid_required(session) || current.is_none() || total.is_none() {
        return MetadataCliResult::Error(
            "metadata set-progress requires numeric <current> and <total>".into(),
        );
    }
    let mut label: Option<String> = None;
    let mut index = 4;
    while index < args.len() {
        let Some(consumed) = option_value(args, index, "--label") else {
            return MetadataCliResult::Error(format!(
                "unsupported metadata set-progress argument: {}",
                args[index]
            ));
        };
        label = Some(consumed.value);
        index = consumed.next_index + 1;
    }
    let mut body = Map::new();
    body.insert("session".into(), Value::String(session.unwrap().into()));
    body.insert("current".into(), current.unwrap());
    body.insert("total".into(), total.unwrap());
    if let Some(label) = label {
        body.insert("label".into(), Value::String(label));
    }
    MetadataCliResult::Post {
        route_path: project_routes::runtime::SET_PROGRESS.into(),
        body: Value::Object(body),
    }
}

fn parse_set_context(args: &[String]) -> MetadataCliResult {
    let session = args.get(1).map(String::as_str);
    if !valid_required(session) {
        return MetadataCliResult::Error("metadata set-context requires <session>".into());
    }
    let mut values = Map::new();
    let result = for_each_option(
        args,
        2,
        &[
            ("--cwd", "cwd"),
            ("--worktree-path", "worktreePath"),
            ("--worktree-name", "worktreeName"),
            ("--branch", "branch"),
            ("--pr-number", "prNumber"),
            ("--pr-title", "prTitle"),
            ("--pr-url", "prUrl"),
        ],
        |field, value| {
            values.insert(field.into(), Value::String(value.into()));
            Ok(())
        },
    );
    if let Err(error) = result {
        return MetadataCliResult::Error(error);
    }
    let mut context = Map::new();
    copy_string(&values, &mut context, "cwd");
    copy_string(&values, &mut context, "worktreePath");
    copy_string(&values, &mut context, "worktreeName");
    copy_string(&values, &mut context, "branch");
    if values.contains_key("prNumber")
        || values.contains_key("prTitle")
        || values.contains_key("prUrl")
    {
        let mut pr = Map::new();
        if let Some(value) = values.get("prNumber").and_then(Value::as_str) {
            pr.insert("number".into(), parse_js_number(value));
        }
        copy_string_as(&values, &mut pr, "prTitle", "title");
        copy_string_as(&values, &mut pr, "prUrl", "url");
        context.insert("pr".into(), Value::Object(compact_record(pr)));
    }
    MetadataCliResult::Post {
        route_path: project_routes::runtime::SET_CONTEXT.into(),
        body: json!({ "session": session.unwrap(), "context": Value::Object(compact_record(context)) }),
    }
}

fn parse_set_services(args: &[String]) -> MetadataCliResult {
    let session = args.get(1).map(String::as_str);
    if !valid_required(session) {
        return MetadataCliResult::Error("metadata set-services requires <session>".into());
    }
    let mut urls: Vec<String> = Vec::new();
    let mut label: Option<String> = None;
    let mut index = 2;
    while index < args.len() {
        let arg = &args[index];
        if let Some(consumed) = option_value(args, index, "--label") {
            label = Some(consumed.value);
            index = consumed.next_index + 1;
            continue;
        }
        if let Some(inline_url) = arg.strip_prefix("--url=")
            && !inline_url.is_empty()
        {
            urls.push(inline_url.into());
            index += 1;
            continue;
        }
        if arg != "--url" {
            return MetadataCliResult::Error(format!(
                "unsupported metadata set-services argument: {arg}"
            ));
        }
        let mut consumed = false;
        while args
            .get(index + 1)
            .is_some_and(|value| !value.starts_with("--"))
        {
            urls.push(args[index + 1].clone());
            index += 1;
            consumed = true;
        }
        if !consumed {
            return MetadataCliResult::Error("--url requires a value".into());
        }
        index += 1;
    }
    if urls.is_empty() {
        return MetadataCliResult::Error("metadata set-services requires --url".into());
    }
    let services = urls
        .into_iter()
        .map(|url| {
            let mut service = Map::new();
            if let Some(label) = label.clone() {
                service.insert("label".into(), Value::String(label));
            }
            if let Some(port) = port_from_url_text(&url) {
                service.insert("port".into(), Value::Number(Number::from(port)));
            }
            service.insert("url".into(), Value::String(url));
            Value::Object(compact_record(service))
        })
        .collect::<Vec<_>>();
    MetadataCliResult::Post {
        route_path: project_routes::runtime::SET_SERVICES.into(),
        body: json!({ "session": session.unwrap(), "services": services }),
    }
}

fn parse_log(args: &[String]) -> MetadataCliResult {
    let session = args.get(1).map(String::as_str);
    let message = args.get(2).map(String::as_str);
    if !valid_required(session) || message.is_none_or(str::is_empty) {
        return MetadataCliResult::Error("metadata log requires <session> <message>".into());
    }
    let mut body = Map::new();
    body.insert("session".into(), Value::String(session.unwrap().into()));
    body.insert("message".into(), Value::String(message.unwrap().into()));
    let mut index = 3;
    while index < args.len() {
        if let Some(consumed) = option_value(args, index, "--source") {
            body.insert("source".into(), Value::String(consumed.value));
            index = consumed.next_index + 1;
            continue;
        }
        if let Some(consumed) = option_value(args, index, "--tone") {
            body.insert("tone".into(), Value::String(consumed.value));
            index = consumed.next_index + 1;
            continue;
        }
        return MetadataCliResult::Error(format!(
            "unsupported metadata log argument: {}",
            args[index]
        ));
    }
    MetadataCliResult::Post {
        route_path: project_routes::runtime::LOG.into(),
        body: Value::Object(compact_record(body)),
    }
}

fn strip_command(args: &[String]) -> Vec<String> {
    if args.first().map(String::as_str) == Some("metadata") {
        args[1..].to_vec()
    } else {
        args.to_vec()
    }
}

fn strip_option_terminator(args: Vec<String>) -> Vec<String> {
    let Some(index) = args.iter().position(|arg| arg == "--") else {
        return args;
    };
    args[..index]
        .iter()
        .chain(args[index + 1..].iter())
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConsumedOption {
    value: String,
    next_index: usize,
}

fn option_value(args: &[String], index: usize, name: &str) -> Option<ConsumedOption> {
    let arg = args.get(index)?;
    if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
        return (!value.is_empty()).then(|| ConsumedOption {
            value: value.into(),
            next_index: index,
        });
    }
    if arg != name {
        return None;
    }
    let value = args.get(index + 1)?;
    (!value.is_empty()).then(|| ConsumedOption {
        value: value.clone(),
        next_index: index + 1,
    })
}

fn for_each_option(
    args: &[String],
    start: usize,
    options: &[(&str, &str)],
    mut apply: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let mut index = start;
    while index < args.len() {
        let Some((option, field)) = options.iter().find(|(name, _)| {
            args[index].as_str() == *name || args[index].starts_with(&format!("{name}="))
        }) else {
            return Err(format!(
                "unsupported metadata {} argument: {}",
                args[0], args[index]
            ));
        };
        let consumed = option_value(args, index, option)
            .ok_or_else(|| format!("{option} requires a value"))?;
        apply(field, &consumed.value)?;
        index = consumed.next_index + 1;
    }
    Ok(())
}

fn valid_required(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty() && !value.starts_with('-'))
}

fn compact_record(record: Map<String, Value>) -> Map<String, Value> {
    record
}

fn copy_string(from: &Map<String, Value>, to: &mut Map<String, Value>, key: &str) {
    copy_string_as(from, to, key, key);
}

fn copy_string_as(
    from: &Map<String, Value>,
    to: &mut Map<String, Value>,
    source: &str,
    target: &str,
) {
    if let Some(value) = from.get(source).and_then(Value::as_str) {
        to.insert(target.into(), Value::String(value.into()));
    }
}

fn parse_js_finite_number(value: &str) -> Option<Value> {
    let parsed = parse_js_number(value);
    match parsed {
        Value::Number(_) => Some(parsed),
        _ => None,
    }
}

fn parse_js_number(value: &str) -> Value {
    let trimmed = value.trim();
    if let Some(number) = parse_js_prefixed_integer(trimmed) {
        return Value::Number(Number::from(number));
    }
    if matches!(trimmed, "Infinity" | "+Infinity" | "-Infinity" | "NaN") {
        return Value::Null;
    }
    let parsed = if trimmed.is_empty() {
        0.0
    } else {
        match trimmed.parse::<f64>() {
            Ok(value) => value,
            Err(_) => return Value::Null,
        }
    };
    if !parsed.is_finite() {
        return Value::Null;
    }
    if parsed.fract() == 0.0 && parsed >= i64::MIN as f64 && parsed <= i64::MAX as f64 {
        return Value::Number(Number::from(parsed as i64));
    }
    Number::from_f64(parsed)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn parse_js_prefixed_integer(value: &str) -> Option<u64> {
    let (radix, digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .map(|digits| (16, digits))
        .or_else(|| value.strip_prefix("0b").map(|digits| (2, digits)))
        .or_else(|| value.strip_prefix("0B").map(|digits| (2, digits)))
        .or_else(|| value.strip_prefix("0o").map(|digits| (8, digits)))
        .or_else(|| value.strip_prefix("0O").map(|digits| (8, digits)))?;
    (!digits.is_empty())
        .then(|| u64::from_str_radix(digits, radix).ok())
        .flatten()
}

fn port_from_url_text(url: &str) -> Option<u64> {
    let bytes = url.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b':' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start && (end == bytes.len() || bytes[end] == b'/') {
            return url[start..end].parse().ok();
        }
        index += 1;
    }
    None
}
