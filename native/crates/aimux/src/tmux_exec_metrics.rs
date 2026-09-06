use serde::{Serialize, Serializer};
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmuxExecMode {
    Sync,
    Async,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxExecVerbMetrics {
    pub count: u64,
    #[serde(serialize_with = "serialize_js_number")]
    pub total_ms: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub max_ms: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxExecMetrics {
    pub sync: TmuxExecVerbMetrics,
    #[serde(rename = "async")]
    pub async_totals: TmuxExecVerbMetrics,
    pub sync_by_verb: BTreeMap<String, TmuxExecVerbMetrics>,
    pub sync_by_caller: BTreeMap<String, TmuxExecVerbMetrics>,
}

#[derive(Debug, Default)]
struct MetricsState {
    sync: TmuxExecVerbMetrics,
    async_totals: TmuxExecVerbMetrics,
    sync_by_verb: BTreeMap<String, TmuxExecVerbMetrics>,
    sync_by_caller: BTreeMap<String, TmuxExecVerbMetrics>,
}

thread_local! {
    static TMUX_EXEC_METRICS: RefCell<MetricsState> = RefCell::new(MetricsState::default());
}

const UNKNOWN_CALLER: &str = "(unknown)";

pub fn tmux_exec_verb(args: &[String]) -> String {
    args.first()
        .map(|verb| verb.trim())
        .filter(|verb| !verb.is_empty())
        .unwrap_or("(unknown)")
        .to_owned()
}

pub fn record_tmux_exec(args: &[String], ms: f64, mode: TmuxExecMode) {
    TMUX_EXEC_METRICS.with(|metrics| {
        let mut metrics = metrics.borrow_mut();
        match mode {
            TmuxExecMode::Async => {
                accumulate(&mut metrics.async_totals, ms);
            }
            TmuxExecMode::Sync => {
                accumulate(&mut metrics.sync, ms);
                let verb = tmux_exec_verb(args);
                let bucket = metrics.sync_by_verb.entry(verb).or_default();
                accumulate(bucket, ms);
                let bucket = metrics
                    .sync_by_caller
                    .entry(UNKNOWN_CALLER.to_owned())
                    .or_default();
                accumulate(bucket, ms);
            }
        }
    });
}

pub fn get_tmux_exec_metrics() -> TmuxExecMetrics {
    TMUX_EXEC_METRICS.with(|metrics| {
        let metrics = metrics.borrow();
        TmuxExecMetrics {
            sync: metrics.sync,
            async_totals: metrics.async_totals,
            sync_by_verb: heaviest_first(&metrics.sync_by_verb),
            sync_by_caller: heaviest_first(&metrics.sync_by_caller),
        }
    })
}

pub fn reset_tmux_exec_metrics() {
    TMUX_EXEC_METRICS.with(|metrics| {
        *metrics.borrow_mut() = MetricsState::default();
    });
}

fn accumulate(target: &mut TmuxExecVerbMetrics, ms: f64) {
    target.count += 1;
    target.total_ms += ms;
    if ms > target.max_ms {
        target.max_ms = ms;
    }
}

fn heaviest_first(
    entries: &BTreeMap<String, TmuxExecVerbMetrics>,
) -> BTreeMap<String, TmuxExecVerbMetrics> {
    let mut sorted: Vec<_> = entries.iter().collect();
    sorted.sort_by(|(left_key, left), (right_key, right)| {
        right
            .total_ms
            .partial_cmp(&left.total_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_key.cmp(right_key))
    });
    sorted
        .into_iter()
        .map(|(key, metrics)| (key.clone(), *metrics))
        .collect()
}

fn serialize_js_number<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if value.is_finite() && value.fract() == 0.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}
