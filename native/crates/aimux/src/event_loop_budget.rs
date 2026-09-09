use serde_json::{Number, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_SYNC_SHARE_PCT: f64 = 2.0;
pub const MAX_LOOP_DELAY_P99_MS: f64 = 250.0;
pub const MIN_WINDOW_MS: f64 = 10_000.0;
pub const MIN_SYNC_CALLS: u64 = 20;
const EVENT_LOOP_SAMPLE_MS: u64 = 10;
const MAX_EVENT_LOOP_SAMPLES: usize = 10_000;

static DAEMON_EVENT_LOOP_MONITOR: OnceLock<Arc<SharedEventLoopMonitor>> = OnceLock::new();

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

pub fn run_event_loop_metrics_contract_case(input: &Value) -> Value {
    let mut monitor = EventLoopMonitor::default();
    match input["action"].as_str().unwrap_or_default() {
        "getEventLoopDelayBeforeStart" => monitor.get_event_loop_delay(),
        "startEventLoopMonitorTwice" => {
            monitor.start_event_loop_monitor();
            monitor.start_event_loop_monitor();
            let values = monitor.get_event_loop_delay();
            json!({
                "monitoring": true,
                "p50LeP99": values["p50"].as_f64().unwrap_or(0.0) <= values["p99"].as_f64().unwrap_or(0.0),
                "p99LeMax": values["p99"].as_f64().unwrap_or(0.0) <= values["max"].as_f64().unwrap_or(0.0),
                "maxPlausibleMilliseconds": values["max"].as_f64().unwrap_or(0.0) >= 0.0
                    && values["max"].as_f64().unwrap_or(0.0) < 60_000.0,
                "values": values,
            })
        }
        "stopEventLoopMonitor" => {
            monitor.start_event_loop_monitor();
            monitor.stop_event_loop_monitor();
            monitor.get_event_loop_delay()
        }
        action => panic!("unknown event-loop metrics contract action: {action}"),
    }
}

pub fn start_event_loop_monitor() {
    let monitor = DAEMON_EVENT_LOOP_MONITOR
        .get_or_init(|| Arc::new(SharedEventLoopMonitor::default()))
        .clone();
    if monitor.started.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let sample_interval = Duration::from_millis(EVENT_LOOP_SAMPLE_MS);
        let mut expected = Instant::now() + sample_interval;
        loop {
            thread::sleep(sample_interval);
            let now = Instant::now();
            let delay_ms = now
                .checked_duration_since(expected)
                .map(|delay| delay.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            monitor.record(delay_ms);
            expected = now + sample_interval;
        }
    });
}

pub fn get_event_loop_delay() -> Value {
    let Some(monitor) = DAEMON_EVENT_LOOP_MONITOR.get() else {
        return event_loop_delay_json(&[], false);
    };
    monitor.snapshot()
}

#[derive(Debug, Default)]
struct SharedEventLoopMonitor {
    started: AtomicBool,
    samples: Mutex<Vec<f64>>,
}

impl SharedEventLoopMonitor {
    fn record(&self, delay_ms: f64) {
        let mut samples = self
            .samples
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        samples.push(delay_ms.max(0.0));
        if samples.len() > MAX_EVENT_LOOP_SAMPLES {
            let overflow = samples.len() - MAX_EVENT_LOOP_SAMPLES;
            samples.drain(0..overflow);
        }
    }

    fn snapshot(&self) -> Value {
        let samples = self
            .samples
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        event_loop_delay_json(&samples, self.started.load(Ordering::SeqCst))
    }
}

#[derive(Debug, Default)]
pub struct EventLoopDelayRecorder {
    samples: Vec<f64>,
    monitoring: bool,
}

impl EventLoopDelayRecorder {
    pub fn start(&mut self) {
        self.monitoring = true;
    }

    pub fn stop(&mut self) {
        self.monitoring = false;
    }

    pub fn record_delay_ms(&mut self, delay_ms: f64) {
        self.samples.push(delay_ms.max(0.0));
    }

    pub fn snapshot(&self) -> Value {
        event_loop_delay_json(&self.samples, self.monitoring)
    }
}

#[derive(Debug, Default)]
struct EventLoopMonitor {
    recorder: EventLoopDelayRecorder,
}

impl EventLoopMonitor {
    fn start_event_loop_monitor(&mut self) {
        self.recorder.start();
    }

    fn stop_event_loop_monitor(&mut self) {
        self.recorder.stop();
    }

    fn get_event_loop_delay(&self) -> Value {
        self.recorder.snapshot()
    }
}

fn event_loop_delay_json(samples: &[f64], monitoring: bool) -> Value {
    if !monitoring || samples.is_empty() {
        return json!({
            "p50": 0,
            "p90": 0,
            "p99": 0,
            "max": 0,
            "mean": 0,
            "monitoring": monitoring,
        });
    }
    let mut sorted = samples
        .iter()
        .copied()
        .filter(|sample| sample.is_finite())
        .collect::<Vec<_>>();
    if sorted.is_empty() {
        return event_loop_delay_json(&[], monitoring);
    }
    sorted.sort_by(|left, right| left.total_cmp(right));
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    json!({
        "p50": js_number(percentile(&sorted, 50.0)),
        "p90": js_number(percentile(&sorted, 90.0)),
        "p99": js_number(percentile(&sorted, 99.0)),
        "max": js_number(round2(*sorted.last().unwrap_or(&0.0))),
        "mean": js_number(round2(mean)),
        "monitoring": true,
    })
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((pct / 100.0) * sorted.len() as f64).ceil() as usize;
    round2(sorted[rank.saturating_sub(1).min(sorted.len() - 1)])
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
