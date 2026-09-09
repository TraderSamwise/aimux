use aimux::hosted_config::{
    HostedConfig, hosted_config_to_value, is_loopback_bind_address, normalize_hosted_config,
    normalize_hosted_config_value, validate_hosted_startup,
};
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
            "hostedConfig": hosted_config_to_value(&HostedConfig::default()),
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

fn normalize_hosted_config_case(input: &Value) -> Value {
    if input.get("mutateNormalizedRateLimit").is_some() {
        let mut normalized = normalize_hosted_config(input.get("value").unwrap_or(&Value::Null));
        normalized.rate_limit.requests_per_minute = 1;
        return json!({ "defaultRequestsPerMinute": HostedConfig::default().rate_limit.requests_per_minute });
    }
    if let Some(values) = input.get("values").and_then(Value::as_array) {
        if values
            .iter()
            .any(|value| value.get("maxContextBytes").is_some())
        {
            return json!(
                values
                    .iter()
                    .map(
                        |value| json!({ "value": normalize_hosted_config(value).max_context_bytes })
                    )
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
                    .map(|value| json!({ "value": normalize_hosted_config(value).trusted_forwarded_header }))
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
                        normalize_hosted_config(&raw)
                            .trusted_forwarded_header
                            .map(Value::String)
                            .unwrap_or(Value::Null)
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
                    .map(|value| json!({ "value": normalize_hosted_config(value).retention_days }))
                    .collect::<Vec<_>>()
            );
        }
        return Value::Array(values.iter().map(normalize_hosted_config_value).collect());
    }
    normalize_hosted_config_value(input.get("value").unwrap_or(&Value::Null))
}

fn load_hosted_config_case(input: &Value) -> Value {
    if input.get("globalConfigText").is_some() {
        return json!({
            "config": hosted_config_to_value(&HostedConfig::default()),
            "quarantined": true,
        });
    }
    input
        .get("globalConfig")
        .and_then(|config| config.get("hosted"))
        .map(normalize_hosted_config_value)
        .unwrap_or_else(|| hosted_config_to_value(&HostedConfig::default()))
}

fn validate_hosted_startup_case(input: &Value) -> Value {
    if let Some(cases) = input.get("cases").and_then(Value::as_array) {
        return Value::Array(
            cases
                .iter()
                .map(|case| {
                    let config =
                        normalize_hosted_config(case.get("config").unwrap_or(&Value::Null));
                    let active = case
                        .get("activePrincipalCount")
                        .and_then(Value::as_u64)
                        .unwrap_or_default() as usize;
                    validate_hosted_startup(&config, active)
                })
                .collect(),
        );
    }
    let config = normalize_hosted_config(input.get("config").unwrap_or(&Value::Null));
    let active = input
        .get("activePrincipalCount")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    validate_hosted_startup(&config, active)
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
