use serde_json::{Number, Value, json};

pub const MAX_SYNC_SHARE_PCT: f64 = 2.0;
pub const MAX_LOOP_DELAY_P99_MS: f64 = 250.0;
pub const MIN_WINDOW_MS: f64 = 10_000.0;
pub const MIN_SYNC_CALLS: u64 = 20;

pub fn assess_loop_budget(input: &Value) -> Value {
    let window_ms = input["windowMs"].as_f64().unwrap_or(0.0);
    let event_loop = &input["eventLoop"];
    let tmux_exec = &input["tmuxExec"];
    let sync = &tmux_exec["sync"];
    let sync_count = sync["count"].as_u64().unwrap_or(0);
    let sync_total_ms = sync["totalMs"].as_f64().unwrap_or(0.0);
    let raw_sync_share_pct = if window_ms > 0.0 {
        (sync_total_ms / window_ms) * 100.0
    } else {
        0.0
    };
    let loop_delay_p99_ms = event_loop["p99"].as_f64().unwrap_or(0.0);
    let mut reasons = Vec::new();
    if window_ms < MIN_WINDOW_MS || sync_count < MIN_SYNC_CALLS {
        reasons.push(Value::String("insufficient-sample".into()));
    }
    if event_loop["monitoring"].as_bool() != Some(true) {
        reasons.push(Value::String("not-monitoring".into()));
    }
    if raw_sync_share_pct > MAX_SYNC_SHARE_PCT {
        reasons.push(Value::String("sync-share-over-budget".into()));
    }
    if loop_delay_p99_ms > MAX_LOOP_DELAY_P99_MS {
        reasons.push(Value::String("loop-delay-over-budget".into()));
    }
    json!({
        "withinBudget": reasons.is_empty(),
        "syncSharePct": js_number(round2(raw_sync_share_pct)),
        "loopDelayP99Ms": js_number(loop_delay_p99_ms),
        "reasons": reasons,
    })
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}
