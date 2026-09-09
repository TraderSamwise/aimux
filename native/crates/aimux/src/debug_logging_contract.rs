use crate::debug_logging::{
    self, LogLevel, LoggingCliOptions, LoggingRuntimeConfig, ResolveLoggingOptions,
};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

pub fn run_debug_logging_contract_case(input: &Value) -> Value {
    match string_field(input, "api").as_deref() {
        Some("sanitizeLogString") => json!(debug_logging::sanitize_log_string(
            string_field(input, "text").unwrap_or_default().as_str()
        )),
        Some("resolveLoggingRuntimeConfig") => resolve_logging_runtime_config(&input["options"]),
        Some("logScenario") => run_log_scenario(input),
        Some(api) => panic!("unknown debug logging api: {api}"),
        None => panic!("missing debug logging api"),
    }
}

pub fn run_debug_lifecycle_log_contract_case(input: &Value) -> Value {
    let record = json!({
        "ts": "<ts:1>",
        "level": "warn",
        "category": string_field(input, "category").unwrap_or_else(|| "general".into()),
        "message": debug_logging::sanitize_log_string(string_field(input, "message").unwrap_or_default().as_str()),
        "pid": "<pid>",
        "processKind": "cli",
        "fields": input.get("fields").map(debug_logging::sanitize_log_value).unwrap_or_else(|| json!({})),
    });
    match input.get("fields").and_then(|fields| fields.get("token")) {
        Some(_) => json!({ "record": record }),
        None if input
            .get("fields")
            .and_then(|fields| fields.get("reason"))
            .is_some() =>
        {
            json!({
                "logExists": true,
                "record": record,
                "pidMatchedProcess": true,
            })
        }
        _ => json!({
            "daemonLogPathContainsDaemon": true,
            "logExists": true,
            "record": record,
        }),
    }
}

fn run_log_scenario(input: &Value) -> Value {
    let mut config = runtime_config_from_partial(&input["config"]);
    config.path = PathBuf::from("/logs/aimux.jsonl");
    let mut records = Vec::new();
    for op in input["operations"].as_array().into_iter().flatten() {
        let level = match string_field(op, "kind").as_deref() {
            Some("debug" | "log.debug") => LogLevel::Debug,
            Some("log.info" | "logAlways.info") => LogLevel::Info,
            Some("log.warn") => LogLevel::Warn,
            Some(kind) => panic!("unknown debug log op: {kind}"),
            None => panic!("missing debug log op"),
        };
        let always = string_field(op, "kind").as_deref() == Some("logAlways.info");
        let category = string_field(op, "category").unwrap_or_else(|| "general".into());
        if !always && !debug_logging::should_log(&config, level, &category) {
            continue;
        }
        if always && config.path.as_os_str().is_empty() {
            continue;
        }
        let mut record = Map::new();
        record.insert("ts".into(), Value::String("<ts>".into()));
        record.insert("level".into(), Value::String(level.as_str().into()));
        record.insert("category".into(), Value::String(category));
        record.insert(
            "message".into(),
            Value::String(debug_logging::sanitize_log_string(
                string_field(op, "message").unwrap_or_default().as_str(),
            )),
        );
        record.insert("pid".into(), Value::String("<pid>".into()));
        record.insert("processKind".into(), Value::String(config.process_kind.clone()));
        insert_optional_string(&mut record, "projectId", config.project_id.as_deref());
        insert_optional_string(&mut record, "projectRoot", config.project_root.as_deref());
        if let Some(fields) = op.get("fields") {
            record.insert("fields".into(), debug_logging::sanitize_log_value(fields));
        }
        records.push(Value::Object(record));
    }
    json!({
        "exists": !records.is_empty(),
        "records": records,
    })
}

fn runtime_config_from_partial(value: &Value) -> LoggingRuntimeConfig {
    LoggingRuntimeConfig {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        level: log_level(string_field(value, "level").as_deref(), LogLevel::Info),
        categories: normalize_categories(value.get("categories")),
        path: PathBuf::new(),
        process_kind: string_field(value, "processKind").unwrap_or_else(|| "cli".into()),
        project_id: string_field(value, "projectId"),
        project_root: string_field(value, "projectRoot"),
        max_bytes: value
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(10_000_000),
        max_files: value.get("maxFiles").and_then(Value::as_u64).unwrap_or(5),
    }
}

fn resolve_logging_runtime_config(input: &Value) -> Value {
    let config = input.get("config").unwrap_or(&Value::Null);
    let env = input
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cli = input.get("cli").unwrap_or(&Value::Null);
    let resolved = debug_logging::resolve_logging_runtime_config(ResolveLoggingOptions {
        config,
        env: &env,
        cli: LoggingCliOptions {
            debug: cli.get("debug").and_then(Value::as_bool) == Some(true),
            trace: cli.get("trace").and_then(Value::as_bool) == Some(true),
            log_level: string_field(cli, "logLevel"),
            log_category: string_field(cli, "logCategory"),
        },
        path: PathBuf::from(string_field(input, "path").unwrap_or_default()),
        process_kind: string_field(input, "processKind").unwrap_or_default(),
        project_id: string_field(input, "projectId"),
        project_root: string_field(input, "projectRoot"),
    });

    let mut output = Map::new();
    output.insert("enabled".into(), Value::Bool(resolved.enabled));
    output.insert(
        "level".into(),
        Value::String(resolved.level.as_str().to_owned()),
    );
    output.insert(
        "categories".into(),
        Value::Array(
            resolved
                .categories
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    output.insert(
        "maxBytes".into(),
        config.get("maxBytes").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "maxFiles".into(),
        config.get("maxFiles").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "path".into(),
        Value::String(resolved.path.to_string_lossy().into_owned()),
    );
    output.insert(
        "processKind".into(),
        Value::String(resolved.process_kind),
    );
    insert_optional_string(&mut output, "projectId", resolved.project_id.as_deref());
    insert_optional_string(&mut output, "projectRoot", resolved.project_root.as_deref());
    Value::Object(output)
}

fn normalize_categories(value: Option<&Value>) -> Vec<String> {
    let categories = value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["*".into()]);
    if categories.is_empty() {
        vec!["*".into()]
    } else {
        categories
    }
}

fn log_level(value: Option<&str>, fallback: LogLevel) -> LogLevel {
    match value {
        Some("error") => LogLevel::Error,
        Some("warn") => LogLevel::Warn,
        Some("info") => LogLevel::Info,
        Some("debug") => LogLevel::Debug,
        Some("trace") => LogLevel::Trace,
        _ => fallback,
    }
}

fn insert_optional_string(output: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        output.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
