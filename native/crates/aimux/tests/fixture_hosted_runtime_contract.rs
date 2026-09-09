use aimux::config::merge_config_layers;
use aimux::hosted_config::{
    HostedConfig, hosted_config_to_value, is_loopback_bind_address,
    load_hosted_config_from_global_path, normalize_hosted_config, normalize_hosted_config_value,
    validate_hosted_startup,
};
use aimux::hosted_rate_limit::{HostedLimitOutcome, HostedRateLimitOptions, HostedRateLimiter};
use aimux::tmux_expose::{
    crop_expose_preview_footer as production_crop_expose_preview_footer,
    expose_preview_footer_crop_rows as production_expose_preview_footer_crop_rows,
};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
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
        "loadHostedConfig/loadConfig" => load_hosted_config_load_config_case(input),
        "loadConfig" => load_config_case(input),
        "validateHostedStartup" => validate_hosted_startup_case(input),
        "HostedRateLimiter.acquire" | "HostedRateLimiter.prune" | "HostedRateLimiter.charge" => {
            hosted_rate_limiter_case(input)
        }
        api => panic!("unknown hosted runtime contract api: {api}"),
    }
}

fn expose_preview_footer_crop_rows_value(value: &Value) -> i64 {
    production_expose_preview_footer_crop_rows(value.as_f64().unwrap_or_default() as i64)
}

fn crop_expose_preview_footer(input: &Value) -> Value {
    let lines = array_field(input, "lines");
    let count = input
        .get("visibleLineCount")
        .and_then(Value::as_f64)
        .unwrap_or_default()
        .floor()
        .max(0.0) as i64;
    Value::Array(production_crop_expose_preview_footer(lines, count))
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
    let fixture = ConfigFixture::new();
    if let Some(text) = input.get("globalConfigText").and_then(Value::as_str) {
        fixture.write_global_text(text);
        let config = load_hosted_config_from_global_path(&fixture.global_config_path);
        return json!({
            "config": hosted_config_to_value(&config),
            "quarantined": fixture.has_quarantined_global_config(),
        });
    }
    if let Some(global_config) = input.get("globalConfig") {
        fixture.write_global_value(global_config);
    }
    hosted_config_to_value(&load_hosted_config_from_global_path(
        &fixture.global_config_path,
    ))
}

fn load_hosted_config_load_config_case(input: &Value) -> Value {
    let merged = merge_config_layers(None, input.get("projectConfig"));
    json!({
        "hostedConfig": hosted_config_to_value(&HostedConfig::default()),
        "projectHosted": merged.get("hosted").cloned().unwrap_or(Value::Null),
    })
}

fn load_config_case(input: &Value) -> Value {
    merge_config_layers(input.get("globalConfig"), None)
        .get("hosted")
        .cloned()
        .unwrap_or(Value::Null)
}

struct ConfigFixture {
    global_config_path: PathBuf,
}

impl ConfigFixture {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-runtime-contract-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).expect("hosted runtime temp dir created");
        Self {
            global_config_path: root.join("config.json"),
        }
    }

    fn write_global_text(&self, text: &str) {
        fs::write(&self.global_config_path, text).expect("hosted runtime global config written");
    }

    fn write_global_value(&self, value: &Value) {
        self.write_global_text(&serde_json::to_string(value).expect("global config serializes"));
    }

    fn has_quarantined_global_config(&self) -> bool {
        let Some(parent) = self.global_config_path.parent() else {
            return false;
        };
        let Some(file_name) = self
            .global_config_path
            .file_name()
            .and_then(|name| name.to_str())
        else {
            return false;
        };
        let prefix = format!("{file_name}.corrupt-");
        fs::read_dir(parent)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&prefix))
            })
    }
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
