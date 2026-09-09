use crate::config;
use crate::paths::PathResolver;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const DEFAULT_MAX_BYTES: u64 = 10_000_000;
const DEFAULT_MAX_FILES: u64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    fn priority(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Warn => 1,
            Self::Info => 2,
            Self::Debug => 3,
            Self::Trace => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoggingRuntimeConfig {
    pub enabled: bool,
    pub level: LogLevel,
    pub categories: Vec<String>,
    pub max_bytes: u64,
    pub max_files: u64,
    pub path: PathBuf,
    pub process_kind: String,
    pub project_id: Option<String>,
    pub project_root: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoggingCliOptions {
    pub debug: bool,
    pub trace: bool,
    pub log_level: Option<String>,
    pub log_category: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ResolveLoggingOptions<'a> {
    pub config: &'a Value,
    pub env: &'a Map<String, Value>,
    pub cli: LoggingCliOptions,
    pub path: PathBuf,
    pub process_kind: String,
    pub project_id: Option<String>,
    pub project_root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogRecord<'a> {
    ts: String,
    level: &'static str,
    category: &'a str,
    message: String,
    pid: u32,
    process_kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_root: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<Value>,
}

impl Default for LoggingRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            level: LogLevel::Info,
            categories: vec!["*".to_owned()],
            max_bytes: DEFAULT_MAX_BYTES,
            max_files: DEFAULT_MAX_FILES,
            path: PathBuf::new(),
            process_kind: "cli".to_owned(),
            project_id: None,
            project_root: None,
        }
    }
}

static RUNTIME_CONFIG: OnceLock<Mutex<LoggingRuntimeConfig>> = OnceLock::new();

pub fn configure_logging(config: LoggingRuntimeConfig) {
    let lock = RUNTIME_CONFIG.get_or_init(|| Mutex::new(LoggingRuntimeConfig::default()));
    if let Ok(mut runtime) = lock.lock() {
        *runtime = config;
    }
}

pub fn get_logging_config() -> LoggingRuntimeConfig {
    let lock = RUNTIME_CONFIG.get_or_init(|| Mutex::new(LoggingRuntimeConfig::default()));
    lock.lock()
        .map(|runtime| runtime.clone())
        .unwrap_or_else(|_| LoggingRuntimeConfig::default())
}

pub fn reset_logging_for_tests() {
    configure_logging(LoggingRuntimeConfig::default());
}

pub fn resolve_logging_runtime_config(options: ResolveLoggingOptions<'_>) -> LoggingRuntimeConfig {
    let logging = options.config.get("logging").unwrap_or(options.config);
    let mut enabled = logging
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut level = normalize_level(value_string(logging, "level").as_deref(), LogLevel::Info);
    let mut categories = normalize_categories(logging.get("categories"));

    if let Some(env_log) = env_string(options.env, "AIMUX_LOG") {
        if is_explicit_false(&env_log) {
            enabled = false;
        } else {
            enabled = true;
            level = normalize_level(Some(&env_log), level);
        }
    }
    if let Some(env_level) = env_string(options.env, "AIMUX_LOG_LEVEL") {
        enabled = true;
        level = normalize_level(Some(&env_level), level);
    }
    if let Some(env_categories) =
        parse_log_categories(env_string(options.env, "AIMUX_LOG_CATEGORIES").as_deref())
    {
        enabled = true;
        categories = env_categories;
    }

    if options.cli.debug {
        enabled = true;
        level = LogLevel::Debug;
    }
    if options.cli.trace {
        enabled = true;
        level = LogLevel::Trace;
    }
    if let Some(cli_level) = options.cli.log_level.as_deref() {
        enabled = true;
        level = normalize_level(Some(cli_level), level);
    }
    if let Some(cli_categories) = parse_log_categories(options.cli.log_category.as_deref()) {
        enabled = true;
        categories = cli_categories;
    }

    LoggingRuntimeConfig {
        enabled,
        level,
        categories,
        max_bytes: logging
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_BYTES),
        max_files: logging
            .get("maxFiles")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_FILES),
        path: options.path,
        process_kind: options.process_kind,
        project_id: options.project_id,
        project_root: options.project_root,
    }
}

pub fn configure_process_logging(
    project_root: impl AsRef<Path>,
    process_kind: impl Into<String>,
    cli: LoggingCliOptions,
) {
    let project_root = project_root.as_ref();
    let config = config::load_config_for_project(project_root);
    let env = std::env::vars()
        .map(|(key, value)| (key, Value::String(value)))
        .collect::<Map<_, _>>();
    let mut resolver = PathResolver::from_env();
    let project_id = Some(resolver.project_id_for(project_root));
    let path = resolver.project_log_path_for(project_root);
    configure_logging(resolve_logging_runtime_config(ResolveLoggingOptions {
        config: &config["logging"],
        env: &env,
        cli,
        path,
        process_kind: process_kind.into(),
        project_id,
        project_root: Some(project_root.to_string_lossy().into_owned()),
    }));
}

pub fn configure_daemon_logging(cli: LoggingCliOptions) {
    let config = config::load_global_config();
    let env = std::env::vars()
        .map(|(key, value)| (key, Value::String(value)))
        .collect::<Map<_, _>>();
    let resolver = PathResolver::from_env();
    configure_logging(resolve_logging_runtime_config(ResolveLoggingOptions {
        config: &config["logging"],
        env: &env,
        cli,
        path: resolver.daemon_log_path(),
        process_kind: "daemon".to_owned(),
        project_id: None,
        project_root: None,
    }));
}

pub fn log_at(level: LogLevel, message: &str, category: &str, fields: Option<Value>) {
    let config = get_logging_config();
    if !should_log(&config, level, category) {
        return;
    }
    write_record(&config, level, message, category, fields);
}

pub fn log_always_at(level: LogLevel, message: &str, category: &str, fields: Option<Value>) {
    let config = get_logging_config();
    if config.path.as_os_str().is_empty() {
        return;
    }
    write_record(&config, level, message, category, fields);
}

pub fn log_lifecycle_always(message: &str, category: &str, fields: Option<Value>) {
    let mut config = get_logging_config();
    let resolver = PathResolver::from_env();
    config.path = resolver.daemon_log_path();
    config.process_kind = if config.process_kind.is_empty() {
        "cli".to_owned()
    } else {
        config.process_kind
    };
    write_record(&config, LogLevel::Warn, message, category, fields);
}

pub fn sanitize_log_string(value: &str) -> String {
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

pub fn sanitize_log_value(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(sanitize_log_string(value)),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_log_value).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    if is_sensitive_log_name(key) {
                        (key.clone(), Value::String("<redacted>".to_owned()))
                    } else {
                        (key.clone(), sanitize_log_value(value))
                    }
                })
                .collect(),
        ),
        value => value.clone(),
    }
}

pub fn should_log(config: &LoggingRuntimeConfig, level: LogLevel, category: &str) -> bool {
    config.enabled
        && !config.path.as_os_str().is_empty()
        && level.priority() <= config.level.priority()
        && (config.categories.iter().any(|entry| entry == "*")
            || config.categories.iter().any(|entry| entry == category))
}

pub fn parse_logging_cli_options<S: AsRef<str>>(args: &[S]) -> LoggingCliOptions {
    let mut options = LoggingCliOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--debug" {
            options.debug = true;
            index += 1;
            continue;
        }
        if arg == "--trace" {
            options.trace = true;
            index += 1;
            continue;
        }
        if arg == "--log-level" {
            if let Some(value) = args.get(index + 1).map(AsRef::as_ref) {
                if !value.is_empty() && !value.starts_with('-') {
                    options.log_level = Some(value.to_owned());
                    index += 2;
                    continue;
                }
            }
        }
        if let Some(value) = arg.strip_prefix("--log-level=") {
            if !value.is_empty() {
                options.log_level = Some(value.to_owned());
            }
            index += 1;
            continue;
        }
        if arg == "--log-category" {
            if let Some(value) = args.get(index + 1).map(AsRef::as_ref) {
                if !value.is_empty() && !value.starts_with('-') {
                    options.log_category = Some(value.to_owned());
                    index += 2;
                    continue;
                }
            }
        }
        if let Some(value) = arg.strip_prefix("--log-category=") {
            if !value.is_empty() {
                options.log_category = Some(value.to_owned());
            }
            index += 1;
            continue;
        }
        index += 1;
    }
    options
}

pub fn parse_log_categories(value: Option<&str>) -> Option<Vec<String>> {
    value.map(|value| {
        let categories = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if categories.is_empty() {
            vec!["*".to_owned()]
        } else {
            categories
        }
    })
}

fn write_record(
    config: &LoggingRuntimeConfig,
    level: LogLevel,
    message: &str,
    category: &str,
    fields: Option<Value>,
) {
    let record = LogRecord {
        ts: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned()),
        level: level.as_str(),
        category,
        message: sanitize_log_string(message),
        pid: std::process::id(),
        process_kind: &config.process_kind,
        project_id: config.project_id.as_deref(),
        project_root: config.project_root.as_deref(),
        fields: fields.as_ref().map(sanitize_log_value),
    };
    let Ok(line) = serde_json::to_string(&record).map(|line| format!("{line}\n")) else {
        return;
    };
    if let Some(parent) = config.path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    rotate_if_needed(&config.path, line.len() as u64, config.max_bytes, config.max_files);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

fn rotate_if_needed(path: &Path, incoming_bytes: u64, max_bytes: u64, max_files: u64) {
    if max_bytes == 0 || max_files == 0 || !path.exists() {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len().saturating_add(incoming_bytes) <= max_bytes {
        return;
    }
    let _ = fs::remove_file(rotated_path(path, max_files));
    for index in (1..max_files).rev() {
        let source = rotated_path(path, index);
        if source.exists() {
            let _ = fs::rename(source, rotated_path(path, index + 1));
        }
    }
    let _ = fs::rename(path, rotated_path(path, 1));
}

fn rotated_path(path: &Path, index: u64) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

fn normalize_level(value: Option<&str>, fallback: LogLevel) -> LogLevel {
    match value {
        Some("error") => LogLevel::Error,
        Some("warn") => LogLevel::Warn,
        Some("info") => LogLevel::Info,
        Some("debug") => LogLevel::Debug,
        Some("trace") => LogLevel::Trace,
        _ => fallback,
    }
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
        .unwrap_or_else(|| vec!["*".to_owned()]);
    if categories.is_empty() {
        vec!["*".to_owned()]
    } else {
        categories
    }
}

fn is_explicit_false(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn env_string(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_assignments_and_nested_fields() {
        let message = "spawn AWS_SECRET_ACCESS_KEY=real PATH=/bin OPENAI_API_KEY=\"quoted\"";
        assert_eq!(
            sanitize_log_string(message),
            "spawn AWS_SECRET_ACCESS_KEY=<redacted> PATH=/bin OPENAI_API_KEY=<redacted>"
        );
        assert_eq!(
            sanitize_log_value(&json!({
                "token": "real",
                "nested": {
                    "password": "real-password",
                    "command": "SENTRY_AUTH_TOKEN=real-auth"
                },
                "visible": ["AUTH_KEY=hidden", "PATH=/bin"]
            })),
            json!({
                "token": "<redacted>",
                "nested": {
                    "password": "<redacted>",
                    "command": "SENTRY_AUTH_TOKEN=<redacted>"
                },
                "visible": ["AUTH_KEY=<redacted>", "PATH=/bin"]
            })
        );
    }

    #[test]
    fn filters_by_level_and_category() {
        let mut config = LoggingRuntimeConfig {
            enabled: true,
            level: LogLevel::Info,
            categories: vec!["daemon".to_owned()],
            path: PathBuf::from("/tmp/aimux.jsonl"),
            ..LoggingRuntimeConfig::default()
        };
        assert!(should_log(&config, LogLevel::Warn, "daemon"));
        assert!(!should_log(&config, LogLevel::Debug, "daemon"));
        assert!(!should_log(&config, LogLevel::Warn, "session"));
        config.categories = vec!["*".to_owned()];
        assert!(should_log(&config, LogLevel::Info, "daemon"));
    }

    #[test]
    fn resolves_env_and_cli_precedence() {
        let config = json!({
            "enabled": false,
            "level": "info",
            "categories": ["session"],
            "maxBytes": 123,
            "maxFiles": 2
        });
        let env = Map::from_iter([
            ("AIMUX_LOG".to_owned(), json!("1")),
            ("AIMUX_LOG_LEVEL".to_owned(), json!("debug")),
            ("AIMUX_LOG_CATEGORIES".to_owned(), json!("daemon,tmux")),
        ]);
        let resolved = resolve_logging_runtime_config(ResolveLoggingOptions {
            config: &config,
            env: &env,
            cli: LoggingCliOptions {
                trace: true,
                log_category: Some("http".to_owned()),
                ..LoggingCliOptions::default()
            },
            path: PathBuf::from("/logs/aimux.jsonl"),
            process_kind: "test".to_owned(),
            project_id: Some("project-1".to_owned()),
            project_root: Some("/repo".to_owned()),
        });
        assert!(resolved.enabled);
        assert_eq!(resolved.level, LogLevel::Trace);
        assert_eq!(resolved.categories, ["http"]);
        assert_eq!(resolved.max_bytes, 123);
        assert_eq!(resolved.max_files, 2);
    }

    #[test]
    fn parses_global_logging_cli_options() {
        assert_eq!(
            parse_logging_cli_options(&[
                "remote",
                "--debug",
                "--log-level",
                "warn",
                "--log-category=daemon,tmux",
                "--trace",
            ]),
            LoggingCliOptions {
                debug: true,
                trace: true,
                log_level: Some("warn".to_owned()),
                log_category: Some("daemon,tmux".to_owned()),
            }
        );
        assert_eq!(
            parse_logging_cli_options(&["logs", "--log-level", "--daemon", "--log-category="]),
            LoggingCliOptions::default()
        );
    }
}
