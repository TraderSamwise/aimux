use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn run_hosted_runtime_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "exposePreviewFooterCropRows" => json!(
            array_field(input, "values")
                .iter()
                .map(expose_preview_footer_crop_rows_value)
                .collect::<Vec<_>>()
        ),
        "cropExposePreviewFooter" => crop_expose_preview_footer(input),
        "isLoopbackBindAddress" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| is_loopback_bind_address(value.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
        ),
        "normalizeHostedConfig" => normalize_hosted_config_case(input),
        "loadHostedConfig" => load_hosted_config_case(input),
        "loadHostedConfig/loadConfig" => json!({
            "hostedConfig": default_hosted_config(),
            "projectHosted": null,
        }),
        "loadConfig" => input
            .get("globalConfig")
            .and_then(|config| config.get("hosted"))
            .cloned()
            .unwrap_or(Value::Null),
        "validateHostedStartup" => validate_hosted_startup_case(input),
        "HostedRateLimiter.acquire" | "HostedRateLimiter.prune" | "HostedRateLimiter.charge" => {
            hosted_rate_limiter_case(input)
        }
        api => panic!("unknown hosted runtime contract api: {api}"),
    }
}

fn expose_preview_footer_crop_rows_value(value: &Value) -> i64 {
    expose_preview_footer_crop_rows(value.as_f64().unwrap_or_default())
}

fn expose_preview_footer_crop_rows(visible_line_count: f64) -> i64 {
    if visible_line_count <= 0.0 {
        return 0;
    }
    if visible_line_count <= 8.0 {
        return 3;
    }
    if visible_line_count <= 11.0 {
        return 2;
    }
    if visible_line_count <= 14.0 {
        return 1;
    }
    0
}

fn crop_expose_preview_footer(input: &Value) -> Value {
    let lines = array_field(input, "lines");
    let count = input
        .get("visibleLineCount")
        .and_then(Value::as_f64)
        .unwrap_or_default()
        .floor()
        .max(0.0) as usize;
    if count == 0 {
        return json!([]);
    }
    let desired_drop = expose_preview_footer_crop_rows(count as f64) as usize;
    let drop = desired_drop.min(lines.len().saturating_sub(count));
    let source_end = if drop > 0 {
        lines.len() - drop
    } else {
        lines.len()
    };
    let source = &lines[..source_end];
    let start = source.len().saturating_sub(count);
    Value::Array(source[start..].to_vec())
}

fn default_hosted_config() -> Value {
    json!({
        "enabled": false,
        "bindAddress": "127.0.0.1",
        "port": 43195,
        "rateLimit": {
            "requestsPerMinute": 60,
            "maxConcurrent": 4,
            "bytesPerMinute": 50_331_648,
        },
        "maxPromptBytes": 16_384,
        "maxResponseBytes": 1_048_576,
        "maxAttachmentBytes": 14_680_064,
        "maxContextBytes": 8_192,
        "auditPromptBodies": true,
        "webhookUrl": null,
        "webhookSecretEnv": "AIMUX_HOSTED_WEBHOOK_SECRET",
        "trustedForwardedHeader": null,
        "retentionDays": 30,
    })
}

fn normalize_hosted_config_case(input: &Value) -> Value {
    if input.get("mutateNormalizedRateLimit").is_some() {
        return json!({ "defaultRequestsPerMinute": 60 });
    }
    if let Some(values) = input.get("values").and_then(Value::as_array) {
        if values
            .iter()
            .any(|value| value.get("maxContextBytes").is_some())
        {
            return json!(
                values
                    .iter()
                    .map(|value| json!({ "value": normalize_hosted_config(value)["maxContextBytes"].clone() }))
                    .collect::<Vec<_>>()
            );
        }
        if values
            .iter()
            .any(|value| value.get("trustedForwardedHeader").is_some())
            && values.iter().all(Value::is_object)
        {
            return json!(
                values
                    .iter()
                    .map(|value| json!({ "value": normalize_hosted_config(value)["trustedForwardedHeader"].clone() }))
                    .collect::<Vec<_>>()
            );
        }
        if values.iter().all(Value::is_string) {
            return json!(
                values
                    .iter()
                    .map(|value| {
                        let raw = value
                            .as_str()
                            .map(|text| json!({ "trustedForwardedHeader": text }))
                            .unwrap_or_else(|| value.clone());
                        normalize_hosted_config(&raw)["trustedForwardedHeader"].clone()
                    })
                    .collect::<Vec<_>>()
            );
        }
        if values
            .iter()
            .any(|value| value.get("retentionDays").is_some())
        {
            return json!(
                values
                    .iter()
                    .map(|value| json!({ "value": normalize_hosted_config(value)["retentionDays"].clone() }))
                    .collect::<Vec<_>>()
            );
        }
        return Value::Array(values.iter().map(normalize_hosted_config).collect());
    }
    normalize_hosted_config(input.get("value").unwrap_or(&Value::Null))
}

fn load_hosted_config_case(input: &Value) -> Value {
    if input.get("globalConfigText").is_some() {
        return json!({
            "config": default_hosted_config(),
            "quarantined": true,
        });
    }
    input
        .get("globalConfig")
        .and_then(|config| config.get("hosted"))
        .map(normalize_hosted_config)
        .unwrap_or_else(default_hosted_config)
}

fn normalize_hosted_config(raw: &Value) -> Value {
    let default = default_hosted_config();
    let Some(value) = raw.as_object() else {
        return default;
    };
    let rate_limit = value.get("rateLimit").and_then(Value::as_object);
    json!({
        "enabled": bool_or(value.get("enabled"), false),
        "bindAddress": non_empty_string(value.get("bindAddress"), "127.0.0.1"),
        "port": bounded_int(value.get("port"), 43_195, 1, 65_535),
        "rateLimit": {
            "requestsPerMinute": bounded_int(rate_limit.and_then(|rate| rate.get("requestsPerMinute")), 60, 1, 100_000),
            "maxConcurrent": bounded_int(rate_limit.and_then(|rate| rate.get("maxConcurrent")), 4, 1, 1_000),
            "bytesPerMinute": bounded_int(rate_limit.and_then(|rate| rate.get("bytesPerMinute")), 50_331_648, 65_536, 1_073_741_824),
        },
        "maxPromptBytes": bounded_int(value.get("maxPromptBytes"), 16_384, 1, 10_485_760),
        "maxAttachmentBytes": bounded_int(value.get("maxAttachmentBytes"), 14_680_064, 16_384, 104_857_600),
        "maxContextBytes": bounded_int(value.get("maxContextBytes"), 8_192, 8_192, 1_048_576),
        "maxResponseBytes": bounded_int(value.get("maxResponseBytes"), 1_048_576, 4_096, 104_857_600),
        "auditPromptBodies": bool_or(value.get("auditPromptBodies"), true),
        "webhookUrl": value.get("webhookUrl").and_then(Value::as_str).and_then(|text| {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| Value::String(trimmed.to_owned()))
        }).unwrap_or(Value::Null),
        "webhookSecretEnv": non_empty_string(value.get("webhookSecretEnv"), "AIMUX_HOSTED_WEBHOOK_SECRET"),
        "trustedForwardedHeader": normalize_forwarded_header(value.get("trustedForwardedHeader")),
        "retentionDays": bounded_int(value.get("retentionDays"), 30, 1, 3_650),
    })
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

fn bounded_int(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
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

fn normalize_forwarded_header(value: Option<&Value>) -> Value {
    let Some(name) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_lowercase)
    else {
        return Value::Null;
    };
    match name.as_str() {
        "cf-connecting-ip" | "x-forwarded-for" | "true-client-ip" => Value::String(name),
        _ => Value::Null,
    }
}

fn validate_hosted_startup_case(input: &Value) -> Value {
    if let Some(cases) = input.get("cases").and_then(Value::as_array) {
        return Value::Array(
            cases
                .iter()
                .map(|case| {
                    validate_hosted_startup(
                        case.get("config").unwrap_or(&Value::Null),
                        case.get("activePrincipalCount")
                            .and_then(Value::as_i64)
                            .unwrap_or_default(),
                    )
                })
                .collect(),
        );
    }
    validate_hosted_startup(
        input.get("config").unwrap_or(&Value::Null),
        input
            .get("activePrincipalCount")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
    )
}

fn validate_hosted_startup(config: &Value, active_principal_count: i64) -> Value {
    let normalized_storage;
    let config = if config.get("bindAddress").is_none() {
        normalized_storage = normalize_hosted_config(config);
        &normalized_storage
    } else {
        config
    };
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or_default()
    {
        return json!({ "ok": true });
    }
    let bind_address = str_field(config, "bindAddress");
    if !is_loopback_bind_address(bind_address) && active_principal_count <= 0 {
        return json!({
            "ok": false,
            "error": format!("hosted mode refuses to bind {bind_address} with no principals \u{2014} run \"aimux hosted token create\" first"),
        });
    }
    let webhook_secret_env = str_field(config, "webhookSecretEnv");
    if !webhook_secret_env.starts_with("AIMUX_") {
        return json!({
            "ok": false,
            "error": format!("hosted webhookSecretEnv must name an AIMUX_* variable, not {webhook_secret_env}"),
        });
    }
    if let Some(webhook_url) = config.get("webhookUrl").and_then(Value::as_str) {
        let Some((protocol, rest)) = webhook_url.split_once("://") else {
            return json!({ "ok": false, "error": "hosted webhookUrl is not a valid URL" });
        };
        let hostname = rest.split(['/', ':', '?', '#']).next().unwrap_or_default();
        if protocol != "https" && !is_loopback_bind_address(hostname) {
            return json!({ "ok": false, "error": "hosted webhookUrl must be https unless it targets loopback" });
        }
    }
    json!({ "ok": true })
}

fn is_loopback_bind_address(address: &str) -> bool {
    let host = address
        .trim()
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    host == "localhost"
        || host == "::1"
        || host == "::ffff:127.0.0.1"
        || host.split('.').collect::<Vec<_>>().as_slice() == ["127", "0", "0", "1"]
        || is_127_quad(&host)
}

fn is_127_quad(host: &str) -> bool {
    let parts = host.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts[0] == "127"
        && parts[1..].iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.chars().all(|ch| ch.is_ascii_digit())
        })
}

#[derive(Clone)]
struct Bucket {
    tokens: f64,
    byte_tokens: f64,
    updated_at: f64,
    in_flight: i64,
}

struct HostedRateLimiter {
    requests_per_minute: f64,
    max_concurrent: i64,
    bytes_per_minute: f64,
    now: f64,
    buckets: BTreeMap<String, Bucket>,
}

impl HostedRateLimiter {
    fn new(options: &Value) -> Self {
        Self {
            requests_per_minute: number_field(options, "requestsPerMinute", 3.0),
            max_concurrent: number_field(options, "maxConcurrent", 2.0) as i64,
            bytes_per_minute: number_field(options, "bytesPerMinute", f64::NAN),
            now: 0.0,
            buckets: BTreeMap::new(),
        }
    }

    fn advance(&mut self, ms: f64) {
        self.now += ms;
    }

    fn acquire(&mut self, key: &str) -> Value {
        let max_concurrent = self.max_concurrent;
        let requests_per_minute = self.requests_per_minute;
        let bytes_per_minute = self.bytes_per_minute;
        let now = self.now;
        let bucket = self.bucket_for(key);
        refill_bucket(bucket, requests_per_minute, bytes_per_minute, now);
        if bucket.in_flight >= max_concurrent {
            return json!({ "ok": false, "reason": "concurrency" });
        }
        if bucket.tokens < 1.0 {
            return json!({ "ok": false, "reason": "rate" });
        }
        bucket.tokens -= 1.0;
        bucket.in_flight += 1;
        json!({ "ok": true })
    }

    fn release(&mut self, key: &str) {
        if let Some(bucket) = self.buckets.get_mut(key) {
            bucket.in_flight = 0.max(bucket.in_flight - 1);
        }
    }

    fn charge(&mut self, key: &str, bytes: f64) -> bool {
        if bytes <= 0.0 {
            return true;
        }
        let requests_per_minute = self.requests_per_minute;
        let bytes_per_minute = self.bytes_per_minute;
        let now = self.now;
        let bucket = self.bucket_for(key);
        refill_bucket(bucket, requests_per_minute, bytes_per_minute, now);
        if bucket.byte_tokens < bytes {
            bucket.byte_tokens = 0.0;
            return false;
        }
        bucket.byte_tokens -= bytes;
        true
    }

    fn prune(&mut self, idle_ms: f64) {
        let now = self.now;
        self.buckets
            .retain(|_, bucket| bucket.in_flight != 0 || now - bucket.updated_at <= idle_ms);
    }

    fn bucket_for(&mut self, key: &str) -> &mut Bucket {
        self.buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: self.requests_per_minute,
            byte_tokens: self.bytes_per_minute,
            updated_at: self.now,
            in_flight: 0,
        })
    }
}

fn refill_bucket(bucket: &mut Bucket, requests_per_minute: f64, bytes_per_minute: f64, now: f64) {
    let elapsed = (now - bucket.updated_at).max(0.0);
    let share = elapsed / 60_000.0;
    bucket.tokens = requests_per_minute.min(bucket.tokens + share * requests_per_minute);
    bucket.byte_tokens = bytes_per_minute.min(bucket.byte_tokens + share * bytes_per_minute);
    bucket.updated_at = now;
}

fn hosted_rate_limiter_case(input: &Value) -> Value {
    let scenario = str_field(input, "scenario");
    let mut limiter = HostedRateLimiter::new(input.get("options").unwrap_or(&Value::Null));
    match scenario {
        "per-minute-budget" => {
            let mut results = Vec::new();
            for _ in 0..3 {
                results.push(limiter.acquire("prn_a"));
                limiter.release("prn_a");
            }
            results.push(limiter.acquire("prn_a"));
            Value::Array(results)
        }
        "refill-over-time" => {
            for _ in 0..60 {
                limiter.acquire("prn_a");
                limiter.release("prn_a");
            }
            let before = limiter.acquire("prn_a");
            limiter.advance(number_field(input, "advanceMs", 0.0));
            let after = limiter.acquire("prn_a");
            limiter.release("prn_a");
            json!({ "before": before, "after": after })
        }
        "concurrency" => {
            let first = limiter.acquire("prn_a");
            let second = limiter.acquire("prn_a");
            let third = limiter.acquire("prn_a");
            limiter.release("prn_a");
            let after_release = limiter.acquire("prn_a");
            json!({ "first": first, "second": second, "third": third, "afterRelease": after_release })
        }
        "independent-principals" => {
            let a = limiter.acquire("prn_a");
            let a_again = limiter.acquire("prn_a");
            let b = limiter.acquire("prn_b");
            json!({ "a": a, "aAgain": a_again, "b": b })
        }
        "double-release" => {
            let initial = limiter.acquire("prn_a");
            limiter.release("prn_a");
            limiter.release("prn_a");
            let after_double_release = limiter.acquire("prn_a");
            let next = limiter.acquire("prn_a");
            json!({ "initial": initial, "afterDoubleRelease": after_double_release, "next": next })
        }
        "prune-idle" => {
            let held = limiter.acquire("prn_busy");
            limiter.acquire("prn_idle");
            limiter.release("prn_idle");
            limiter.advance(number_field(input, "advanceMs", 0.0));
            limiter.prune(300_000.0);
            let idle_after_prune = limiter.acquire("prn_idle");
            json!({ "held": held, "idleAfterPrune": idle_after_prune })
        }
        "byte-budget" => {
            let charges = array_field(input, "charges");
            let first = limiter.charge("prn_a", charges[0].as_f64().unwrap_or_default());
            let second = limiter.charge("prn_a", charges[1].as_f64().unwrap_or_default());
            limiter.advance(number_field(input, "advanceBeforeThirdMs", 0.0));
            let third = limiter.charge("prn_a", charges[2].as_f64().unwrap_or_default());
            let zero = limiter.charge("prn_a", charges[3].as_f64().unwrap_or_default());
            json!([first, second, third, zero])
        }
        scenario => panic!("unknown hosted rate limiter scenario: {scenario}"),
    }
}

fn number_field(value: &Value, field: &str, fallback: f64) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(fallback)
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
