use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const NO_CAPACITY: usize = usize::MAX;

pub const RELAY_OUTBOX_BACKLOG: &str = "relay-outbox";
pub const HOSTED_OUTBOX_BACKLOG: &str = "hosted-outbox";
pub const AGENT_INPUT_DELIVERY_BACKLOG: &str = "agent-input-delivery";
pub const SSE_PROJECT_EVENTS_BACKLOG: &str = "sse-subscribers/project-events";
pub const SSE_AGENT_OUTPUT_BACKLOG: &str = "sse-subscribers/agent-output";
pub const SSE_AGENT_INTERACTION_BACKLOG: &str = "sse-subscribers/agent-interaction";
pub const SSE_SUBSCRIBER_BACKLOG_CAPACITY: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BacklogMetricSnapshot {
    pub name: String,
    pub status: BacklogMetricStatus,
    pub current_depth: Option<usize>,
    pub high_water_mark: Option<usize>,
    pub capacity: Option<usize>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BacklogMetricStatus {
    Ok,
    Unavailable,
}

impl BacklogMetricStatus {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BacklogMetric {
    inner: Arc<BacklogMetricInner>,
}

#[derive(Debug)]
struct BacklogMetricInner {
    name: String,
    current_depth: AtomicUsize,
    high_water_mark: AtomicUsize,
    capacity: AtomicUsize,
    error: Mutex<Option<String>>,
}

pub fn backlog_metric(name: &str, capacity: Option<usize>) -> BacklogMetric {
    registry().metric(name, capacity)
}

pub fn record_backlog_depth(name: &str, depth: usize, capacity: Option<usize>) {
    backlog_metric(name, capacity).set_depth(depth);
}

pub fn record_backlog_error(name: &str, capacity: Option<usize>, error: impl Into<String>) {
    backlog_metric(name, capacity).set_error(error.into());
}

pub fn backlog_snapshots() -> Vec<BacklogMetricSnapshot> {
    registry().snapshots()
}

impl BacklogMetric {
    pub fn set_depth(&self, depth: usize) {
        self.inner.current_depth.store(depth, Ordering::Relaxed);
        raise_high_water(&self.inner.high_water_mark, depth);
        if let Ok(mut error) = self.inner.error.lock() {
            *error = None;
        }
    }

    pub fn increment(&self) {
        let depth = self
            .inner
            .current_depth
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        raise_high_water(&self.inner.high_water_mark, depth);
        if let Ok(mut error) = self.inner.error.lock() {
            *error = None;
        }
    }

    pub fn decrement(&self) {
        let mut current = self.inner.current_depth.load(Ordering::Relaxed);
        loop {
            let next = current.saturating_sub(1);
            match self.inner.current_depth.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }

    pub fn set_error(&self, message: String) {
        if let Ok(mut error) = self.inner.error.lock() {
            *error = Some(message);
        }
    }

    pub fn snapshot(&self) -> BacklogMetricSnapshot {
        self.inner.snapshot()
    }
}

impl BacklogMetricInner {
    fn new(name: &str, capacity: Option<usize>) -> Self {
        Self {
            name: name.to_owned(),
            current_depth: AtomicUsize::new(0),
            high_water_mark: AtomicUsize::new(0),
            capacity: AtomicUsize::new(capacity.unwrap_or(NO_CAPACITY)),
            error: Mutex::new(None),
        }
    }

    fn declare_capacity(&self, capacity: Option<usize>) {
        let Some(capacity) = capacity else {
            return;
        };
        let mut current = self.capacity.load(Ordering::Relaxed);
        while current == NO_CAPACITY {
            match self.capacity.compare_exchange_weak(
                current,
                capacity,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    fn snapshot(&self) -> BacklogMetricSnapshot {
        let error = match self.error.lock() {
            Ok(error) => error.clone(),
            Err(_) => Some("backlog metric error state is unavailable".to_owned()),
        };
        let capacity = match self.capacity.load(Ordering::Relaxed) {
            NO_CAPACITY => None,
            value => Some(value),
        };
        if let Some(error) = error {
            return BacklogMetricSnapshot {
                name: self.name.clone(),
                status: BacklogMetricStatus::Unavailable,
                current_depth: None,
                high_water_mark: Some(self.high_water_mark.load(Ordering::Relaxed)),
                capacity,
                error: Some(error),
            };
        }
        BacklogMetricSnapshot {
            name: self.name.clone(),
            status: BacklogMetricStatus::Ok,
            current_depth: Some(self.current_depth.load(Ordering::Relaxed)),
            high_water_mark: Some(self.high_water_mark.load(Ordering::Relaxed)),
            capacity,
            error: None,
        }
    }
}

#[derive(Debug, Default)]
struct BacklogMetricRegistry {
    metrics: Mutex<BTreeMap<String, BacklogMetric>>,
}

impl BacklogMetricRegistry {
    fn metric(&self, name: &str, capacity: Option<usize>) -> BacklogMetric {
        let mut metrics = self
            .metrics
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let metric = metrics
            .entry(name.to_owned())
            .or_insert_with(|| BacklogMetric {
                inner: Arc::new(BacklogMetricInner::new(name, capacity)),
            })
            .clone();
        metric.inner.declare_capacity(capacity);
        metric
    }

    fn snapshots(&self) -> Vec<BacklogMetricSnapshot> {
        let metrics = self
            .metrics
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        metrics.values().map(BacklogMetric::snapshot).collect()
    }
}

fn registry() -> &'static BacklogMetricRegistry {
    static REGISTRY: OnceLock<BacklogMetricRegistry> = OnceLock::new();
    REGISTRY.get_or_init(BacklogMetricRegistry::default)
}

fn raise_high_water(high_water: &AtomicUsize, depth: usize) {
    let mut current = high_water.load(Ordering::Relaxed);
    while depth > current {
        match high_water.compare_exchange_weak(current, depth, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => return,
            Err(actual) => current = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_metric_moves_current_and_high_water_independently() {
        let metric = backlog_metric("test/backlog-moves", Some(4));
        metric.set_depth(0);

        metric.increment();
        metric.increment();
        metric.decrement();

        let snapshot = metric.snapshot();
        assert_eq!(snapshot.status, BacklogMetricStatus::Ok);
        assert_eq!(snapshot.current_depth, Some(1));
        assert_eq!(snapshot.high_water_mark, Some(2));
        assert_eq!(snapshot.capacity, Some(4));
    }

    #[test]
    fn backlog_metric_reports_error_instead_of_zero() {
        let metric = backlog_metric("test/backlog-error", Some(4));
        metric.set_depth(3);
        metric.set_error("probe failed".to_owned());

        let snapshot = metric.snapshot();
        assert_eq!(snapshot.status, BacklogMetricStatus::Unavailable);
        assert_eq!(snapshot.current_depth, None);
        assert_eq!(snapshot.high_water_mark, Some(3));
        assert_eq!(snapshot.error.as_deref(), Some("probe failed"));
    }

    #[test]
    fn backlog_metric_late_capacity_declaration_is_not_lost() {
        let name = "test/backlog-late-capacity";
        let uncapped = backlog_metric(name, None);
        uncapped.set_depth(2);

        let capped = backlog_metric(name, Some(8));
        capped.set_depth(3);

        let snapshot = capped.snapshot();
        assert_eq!(snapshot.current_depth, Some(3));
        assert_eq!(snapshot.high_water_mark, Some(3));
        assert_eq!(snapshot.capacity, Some(8));
    }
}
