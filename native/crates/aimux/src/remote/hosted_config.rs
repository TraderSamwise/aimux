use crate::atomic_write::quarantine_corrupt_file;
use crate::paths::PathResolver;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub const HOSTED_DEFAULT_PORT: u16 = 43_195;
const SECRET_ENV_PREFIX: &str = "AIMUX_";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedRateLimitConfig {
    pub requests_per_minute: i64,
    pub max_concurrent: i64,
    pub bytes_per_minute: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedConfig {
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub rate_limit: HostedRateLimitConfig,
    pub max_prompt_bytes: i64,
    pub max_response_bytes: i64,
    pub max_attachment_bytes: i64,
    pub max_context_bytes: i64,
    pub audit_prompt_bodies: bool,
    pub webhook_url: Option<String>,
    pub webhook_secret_env: String,
    pub trusted_forwarded_header: Option<String>,
    pub retention_days: i64,
}

impl Default for HostedConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_address: "127.0.0.1".to_owned(),
            port: HOSTED_DEFAULT_PORT,
            rate_limit: HostedRateLimitConfig {
                requests_per_minute: 60,
                max_concurrent: 4,
                bytes_per_minute: 48 * 1024 * 1024,
            },
            max_prompt_bytes: 16_384,
            max_response_bytes: 1_048_576,
            max_attachment_bytes: 14 * 1024 * 1024,
            max_context_bytes: 8_192,
            audit_prompt_bodies: true,
            webhook_url: None,
            webhook_secret_env: "AIMUX_HOSTED_WEBHOOK_SECRET".to_owned(),
            trusted_forwarded_header: None,
            retention_days: 30,
        }
    }
}

pub fn normalize_hosted_config(raw: &Value) -> HostedConfig {
    let default = HostedConfig::default();
    let Some(value) = raw.as_object() else {
        return default;
    };
    let rate_limit = value.get("rateLimit").and_then(Value::as_object);
    HostedConfig {
        enabled: bool_or(value.get("enabled"), default.enabled),
        bind_address: non_empty_string(value.get("bindAddress"), &default.bind_address),
        port: bounded_u16(value.get("port"), default.port),
        rate_limit: HostedRateLimitConfig {
            requests_per_minute: bounded_i64(
                rate_limit.and_then(|rate| rate.get("requestsPerMinute")),
                default.rate_limit.requests_per_minute,
                1,
                100_000,
            ),
            max_concurrent: bounded_i64(
                rate_limit.and_then(|rate| rate.get("maxConcurrent")),
                default.rate_limit.max_concurrent,
                1,
                1_000,
            ),
            bytes_per_minute: bounded_i64(
                rate_limit.and_then(|rate| rate.get("bytesPerMinute")),
                default.rate_limit.bytes_per_minute,
                64 * 1024,
                1_073_741_824,
            ),
        },
        max_prompt_bytes: bounded_i64(value.get("maxPromptBytes"), 16_384, 1, 10_485_760),
        max_response_bytes: bounded_i64(
            value.get("maxResponseBytes"),
            1_048_576,
            4_096,
            104_857_600,
        ),
        max_attachment_bytes: bounded_i64(
            value.get("maxAttachmentBytes"),
            14 * 1024 * 1024,
            16_384,
            104_857_600,
        ),
        max_context_bytes: bounded_i64(value.get("maxContextBytes"), 8_192, 8_192, 1_048_576),
        audit_prompt_bodies: bool_or(value.get("auditPromptBodies"), true),
        webhook_url: value
            .get("webhookUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        webhook_secret_env: non_empty_string(
            value.get("webhookSecretEnv"),
            &default.webhook_secret_env,
        ),
        trusted_forwarded_header: normalize_forwarded_header(value.get("trustedForwardedHeader")),
        retention_days: bounded_i64(value.get("retentionDays"), 30, 1, 3_650),
    }
}

pub fn hosted_config_to_value(config: &HostedConfig) -> Value {
    serde_json::to_value(config).unwrap_or_else(|_| json!({}))
}

pub fn normalize_hosted_config_value(raw: &Value) -> Value {
    hosted_config_to_value(&normalize_hosted_config(raw))
}

pub fn load_hosted_config() -> HostedConfig {
    let resolver = PathResolver::from_env();
    load_hosted_config_with_resolver(&resolver)
}

pub fn load_hosted_config_with_resolver(resolver: &PathResolver) -> HostedConfig {
    load_hosted_config_from_global_path(&resolver.global_config_path())
}

pub fn load_hosted_config_from_global_path(path: &Path) -> HostedConfig {
    let Ok(raw) = fs::read_to_string(path) else {
        return HostedConfig::default();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => normalize_hosted_config(value.get("hosted").unwrap_or(&Value::Null)),
        Err(_) => {
            quarantine_corrupt_file(path);
            HostedConfig::default()
        }
    }
}

pub fn validate_hosted_startup(config: &HostedConfig, active_principal_count: usize) -> Value {
    if !config.enabled {
        return json!({ "ok": true });
    }
    if !is_loopback_bind_address(&config.bind_address) && active_principal_count == 0 {
        return json!({
            "ok": false,
            "error": format!(
                "hosted mode refuses to bind {} with no principals \u{2014} run \"aimux hosted token create\" first",
                config.bind_address
            ),
        });
    }
    if !config.webhook_secret_env.starts_with(SECRET_ENV_PREFIX) {
        return json!({
            "ok": false,
            "error": format!(
                "hosted webhookSecretEnv must name an {SECRET_ENV_PREFIX}* variable, not {}",
                config.webhook_secret_env
            ),
        });
    }
    if let Some(url) = &config.webhook_url {
        let Some((protocol, hostname)) = parse_url_protocol_hostname(url) else {
            return json!({ "ok": false, "error": "hosted webhookUrl is not a valid URL" });
        };
        if protocol != "https" && !is_loopback_bind_address(&hostname) {
            return json!({ "ok": false, "error": "hosted webhookUrl must be https unless it targets loopback" });
        }
    }
    json!({ "ok": true })
}

pub fn is_loopback_bind_address(address: &str) -> bool {
    let host = address
        .trim()
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    host == "localhost" || host == "::1" || host == "::ffff:127.0.0.1" || is_127_quad(&host)
}

fn is_127_quad(host: &str) -> bool {
    let parts = host.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts[0] == "127"
        && parts[1..].iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.chars().all(|ch| ch.is_ascii_digit())
        })
}

fn parse_url_protocol_hostname(url: &str) -> Option<(String, String)> {
    let (protocol, rest) = url.split_once("://")?;
    if protocol.is_empty() || rest.is_empty() {
        return None;
    }
    if rest.starts_with('[') {
        let end = rest.find(']')?;
        let hostname = &rest[1..end];
        if hostname.is_empty() {
            return None;
        }
        return Some((protocol.to_lowercase(), hostname.to_lowercase()));
    }
    let hostname = rest.split(['/', ':', '?', '#']).next().unwrap_or_default();
    if hostname.is_empty() || hostname.chars().any(char::is_whitespace) {
        return None;
    }
    Some((protocol.to_lowercase(), hostname.to_lowercase()))
}

fn normalize_forwarded_header(value: Option<&Value>) -> Option<String> {
    let name = value.as_ref()?.as_str()?.trim().to_lowercase();
    match name.as_str() {
        "cf-connecting-ip" | "x-forwarded-for" | "true-client-ip" => Some(name),
        _ => None,
    }
}

fn bool_or(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn non_empty_string(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn bounded_i64(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    let Some(value) = value.and_then(Value::as_f64) else {
        return fallback;
    };
    if !value.is_finite() {
        return fallback;
    }
    let rounded = value.trunc() as i64;
    if rounded < min || rounded > max {
        fallback
    } else {
        rounded
    }
}

fn bounded_u16(value: Option<&Value>, fallback: u16) -> u16 {
    let Some(value) = value.and_then(Value::as_f64) else {
        return fallback;
    };
    if !value.is_finite() {
        return fallback;
    }
    let rounded = value.trunc();
    if !(1.0..=65_535.0).contains(&rounded) {
        fallback
    } else {
        rounded as u16
    }
}
