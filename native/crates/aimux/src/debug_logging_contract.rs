use serde_json::{Map, Value, json};

pub fn run_debug_logging_contract_case(input: &Value) -> Value {
    match string_field(input, "api").as_deref() {
        Some("sanitizeLogString") => json!(sanitize_log_string(
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
        "message": sanitize_log_string(string_field(input, "message").unwrap_or_default().as_str()),
        "pid": "<pid>",
        "processKind": "cli",
        "fields": input.get("fields").map(sanitize_log_value).unwrap_or_else(|| json!({})),
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
    config.path = "/logs/aimux.jsonl".to_owned();
    let mut records = Vec::new();
    for op in input["operations"].as_array().into_iter().flatten() {
        let level = match string_field(op, "kind").as_deref() {
            Some("debug" | "log.debug") => "debug",
            Some("log.info" | "logAlways.info") => "info",
            Some("log.warn") => "warn",
            Some(kind) => panic!("unknown debug log op: {kind}"),
            None => panic!("missing debug log op"),
        };
        let always = string_field(op, "kind").as_deref() == Some("logAlways.info");
        let category = string_field(op, "category").unwrap_or_else(|| "general".into());
        if !always && !should_log(&config, level, &category) {
            continue;
        }
        if always && config.path.is_empty() {
            continue;
        }
        let mut record = Map::new();
        record.insert("ts".into(), Value::String("<ts>".into()));
        record.insert("level".into(), Value::String(level.into()));
        record.insert("category".into(), Value::String(category));
        record.insert(
            "message".into(),
            Value::String(sanitize_log_string(
                string_field(op, "message").unwrap_or_default().as_str(),
            )),
        );
        record.insert("pid".into(), Value::String("<pid>".into()));
        record.insert(
            "processKind".into(),
            Value::String(config.process_kind.clone()),
        );
        insert_optional_string(&mut record, "projectId", config.project_id.as_deref());
        insert_optional_string(&mut record, "projectRoot", config.project_root.as_deref());
        if let Some(fields) = op.get("fields") {
            record.insert("fields".into(), sanitize_log_value(fields));
        }
        records.push(Value::Object(record));
    }
    json!({
        "exists": !records.is_empty(),
        "records": records,
    })
}

#[derive(Clone, Debug)]
struct RuntimeConfig {
    enabled: bool,
    level: String,
    categories: Vec<String>,
    path: String,
    process_kind: String,
    project_id: Option<String>,
    project_root: Option<String>,
}

fn runtime_config_from_partial(value: &Value) -> RuntimeConfig {
    RuntimeConfig {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        level: normalize_level(string_field(value, "level").as_deref(), "info"),
        categories: normalize_categories(value.get("categories")),
        path: string_field(value, "path").unwrap_or_default(),
        process_kind: string_field(value, "processKind").unwrap_or_else(|| "cli".into()),
        project_id: string_field(value, "projectId"),
        project_root: string_field(value, "projectRoot"),
    }
}

fn resolve_logging_runtime_config(input: &Value) -> Value {
    let config = &input["config"];
    let env = &input["env"];
    let cli = &input["cli"];
    let mut enabled = config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut level = normalize_level(string_field(config, "level").as_deref(), "info");
    let mut categories = normalize_categories(config.get("categories"));

    if let Some(env_log) = string_field(env, "AIMUX_LOG") {
        if is_explicit_false(&env_log) {
            enabled = false;
        } else {
            enabled = true;
            level = normalize_level(Some(&env_log), &level);
        }
    }
    if let Some(env_level) = string_field(env, "AIMUX_LOG_LEVEL") {
        enabled = true;
        level = normalize_level(Some(&env_level), &level);
    }
    if let Some(env_categories) =
        parse_log_categories(string_field(env, "AIMUX_LOG_CATEGORIES").as_deref())
    {
        enabled = true;
        categories = env_categories;
    }
    if cli.get("debug").and_then(Value::as_bool) == Some(true) {
        enabled = true;
        level = "debug".into();
    }
    if cli.get("trace").and_then(Value::as_bool) == Some(true) {
        enabled = true;
        level = "trace".into();
    }
    if let Some(cli_level) = string_field(cli, "logLevel") {
        enabled = true;
        level = normalize_level(Some(&cli_level), &level);
    }
    if let Some(cli_categories) = parse_log_categories(string_field(cli, "logCategory").as_deref())
    {
        enabled = true;
        categories = cli_categories;
    }

    let mut output = Map::new();
    output.insert("enabled".into(), Value::Bool(enabled));
    output.insert("level".into(), Value::String(level));
    output.insert(
        "categories".into(),
        Value::Array(categories.into_iter().map(Value::String).collect()),
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
        Value::String(string_field(input, "path").unwrap_or_default()),
    );
    output.insert(
        "processKind".into(),
        Value::String(string_field(input, "processKind").unwrap_or_default()),
    );
    insert_optional_string(
        &mut output,
        "projectId",
        string_field(input, "projectId").as_deref(),
    );
    insert_optional_string(
        &mut output,
        "projectRoot",
        string_field(input, "projectRoot").as_deref(),
    );
    Value::Object(output)
}

fn should_log(config: &RuntimeConfig, level: &str, category: &str) -> bool {
    config.enabled
        && !config.path.is_empty()
        && level_priority(level) <= level_priority(&config.level)
        && (config.categories.iter().any(|entry| entry == "*")
            || config.categories.iter().any(|entry| entry == category))
}

fn level_priority(level: &str) -> u8 {
    match level {
        "error" => 0,
        "warn" => 1,
        "info" => 2,
        "debug" => 3,
        "trace" => 4,
        _ => 2,
    }
}

fn normalize_level(value: Option<&str>, fallback: &str) -> String {
    match value {
        Some(level @ ("error" | "warn" | "info" | "debug" | "trace")) => level.to_owned(),
        _ => fallback.to_owned(),
    }
}

fn is_explicit_false(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn parse_log_categories(value: Option<&str>) -> Option<Vec<String>> {
    value.map(|value| {
        let categories = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if categories.is_empty() {
            vec!["*".into()]
        } else {
            categories
        }
    })
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

fn sanitize_log_value(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(sanitize_log_string(value)),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_log_value).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    if is_sensitive_log_name(key) {
                        (key.clone(), Value::String("<redacted>".into()))
                    } else {
                        (key.clone(), sanitize_log_value(value))
                    }
                })
                .collect(),
        ),
        value => value.clone(),
    }
}

fn sanitize_log_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while let Some(relative) = value[index..].find('=') {
        let equals = index + relative;
        let name_start = value[..equals]
            .char_indices()
            .rev()
            .find_map(|(candidate, ch)| {
                (!is_env_name_char(ch)).then_some(candidate + ch.len_utf8())
            })
            .unwrap_or(0);
        let name = &value[name_start..equals];
        if !is_valid_env_name(name) || !is_sensitive_log_name(name) {
            output.push_str(&value[index..=equals]);
            index = equals + 1;
            continue;
        }
        output.push_str(&value[index..equals + 1]);
        output.push_str("<redacted>");
        index = assignment_value_end(value, equals + 1);
    }
    output.push_str(&value[index..]);
    output
}

fn assignment_value_end(value: &str, start: usize) -> usize {
    let bytes = value.as_bytes();
    if bytes.get(start) == Some(&b'\\') && matches!(bytes.get(start + 1), Some(b'"' | b'\'')) {
        let quote = bytes[start + 1];
        let mut index = start + 2;
        while index + 1 < bytes.len() {
            if bytes[index] == b'\\' && bytes[index + 1] == quote {
                return index + 2;
            }
            index += 1;
        }
        return bytes.len();
    }
    if matches!(bytes.get(start), Some(b'"' | b'\'')) {
        let quote = bytes[start];
        let mut index = start + 1;
        while index < bytes.len() {
            if bytes[index] == quote {
                return index + 1;
            }
            index += 1;
        }
        return bytes.len();
    }
    let mut index = start;
    while index < bytes.len()
        && !matches!(
            bytes[index],
            b'"' | b'\'' | b',' | b']' | b' ' | b'\n' | b'\t'
        )
    {
        index += 1;
    }
    index
}

fn is_sensitive_log_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("authorization")
        || normalized.contains("auth")
        || normalized == "key"
        || normalized.ends_with("key")
        || normalized.contains("_key")
}

fn is_valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn is_env_name_char(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphanumeric()
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
