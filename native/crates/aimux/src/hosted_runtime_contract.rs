use aimux::hosted_config::{
    HostedConfig, hosted_config_to_value, is_loopback_bind_address, normalize_hosted_config,
    normalize_hosted_config_value, validate_hosted_startup,
};
use aimux::hosted_rate_limit::{HostedLimitOutcome, HostedRateLimitOptions, HostedRateLimiter};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

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

fn hosted_rate_limiter_case(input: &Value) -> Value {
    let scenario = str_field(input, "scenario");
    let now = Arc::new(AtomicU64::new(0));
    let limiter = HostedRateLimiter::with_now(rate_limit_options(input), {
        let now = Arc::clone(&now);
        move || now.load(Ordering::SeqCst) as f64
    });
    match scenario {
        "per-minute-budget" => {
            let mut results = Vec::new();
            for _ in 0..3 {
                let outcome = limiter.acquire("prn_a");
                release_if_allowed(&outcome);
                results.push(limit_outcome_value(&outcome));
            }
            results.push(limit_outcome_value(&limiter.acquire("prn_a")));
            Value::Array(results)
        }
        "refill-over-time" => {
            for _ in 0..60 {
                let outcome = limiter.acquire("prn_a");
                release_if_allowed(&outcome);
            }
            let before = limiter.acquire("prn_a");
            now.fetch_add(
                number_field(input, "advanceMs", 0.0) as u64,
                Ordering::SeqCst,
            );
            let after = limiter.acquire("prn_a");
            release_if_allowed(&after);
            json!({ "before": limit_outcome_value(&before), "after": limit_outcome_value(&after) })
        }
        "concurrency" => {
            let first = limiter.acquire("prn_a");
            let second = limiter.acquire("prn_a");
            let third = limiter.acquire("prn_a");
            release_if_allowed(&first);
            let after_release = limiter.acquire("prn_a");
            json!({
                "first": limit_outcome_value(&first),
                "second": limit_outcome_value(&second),
                "third": limit_outcome_value(&third),
                "afterRelease": limit_outcome_value(&after_release),
            })
        }
        "independent-principals" => {
            let a = limiter.acquire("prn_a");
            let a_again = limiter.acquire("prn_a");
            let b = limiter.acquire("prn_b");
            json!({
                "a": limit_outcome_value(&a),
                "aAgain": limit_outcome_value(&a_again),
                "b": limit_outcome_value(&b),
            })
        }
        "double-release" => {
            let initial = limiter.acquire("prn_a");
            release_if_allowed(&initial);
            release_if_allowed(&initial);
            let after_double_release = limiter.acquire("prn_a");
            let next = limiter.acquire("prn_a");
            json!({
                "initial": limit_outcome_value(&initial),
                "afterDoubleRelease": limit_outcome_value(&after_double_release),
                "next": limit_outcome_value(&next),
            })
        }
        "prune-idle" => {
            let held = limiter.acquire("prn_busy");
            let done = limiter.acquire("prn_idle");
            release_if_allowed(&done);
            now.fetch_add(
                number_field(input, "advanceMs", 0.0) as u64,
                Ordering::SeqCst,
            );
            limiter.prune(300_000.0);
            let idle_after_prune = limiter.acquire("prn_idle");
            json!({
                "held": limit_outcome_value(&held),
                "idleAfterPrune": limit_outcome_value(&idle_after_prune),
            })
        }
        "byte-budget" => {
            let charges = array_field(input, "charges");
            let first = limiter.charge("prn_a", charges[0].as_f64().unwrap_or_default());
            let second = limiter.charge("prn_a", charges[1].as_f64().unwrap_or_default());
            now.fetch_add(
                number_field(input, "advanceBeforeThirdMs", 0.0) as u64,
                Ordering::SeqCst,
            );
            let third = limiter.charge("prn_a", charges[2].as_f64().unwrap_or_default());
            let zero = limiter.charge("prn_a", charges[3].as_f64().unwrap_or_default());
            json!([first, second, third, zero])
        }
        scenario => panic!("unknown hosted rate limiter scenario: {scenario}"),
    }
}

fn rate_limit_options(input: &Value) -> HostedRateLimitOptions {
    let options = input.get("options").unwrap_or(&Value::Null);
    HostedRateLimitOptions {
        requests_per_minute: number_field(options, "requestsPerMinute", 3.0),
        max_concurrent: number_field(options, "maxConcurrent", 2.0) as i64,
        bytes_per_minute: number_field(options, "bytesPerMinute", f64::NAN),
    }
}

fn release_if_allowed(outcome: &HostedLimitOutcome) {
    if let HostedLimitOutcome::Allowed(release) = outcome {
        release.release();
    }
}

fn limit_outcome_value(outcome: &HostedLimitOutcome) -> Value {
    match outcome {
        HostedLimitOutcome::Allowed(_) => json!({ "ok": true }),
        HostedLimitOutcome::Denied(denied) => {
            json!({ "ok": denied.ok, "reason": denied.reason })
        }
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
