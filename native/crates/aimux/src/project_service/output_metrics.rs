use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const RECENT_OUTPUT_READ_LIMIT: usize = 20;

#[derive(Debug, Clone, Default)]
pub struct AgentOutputReadMetrics {
    inner: Arc<Mutex<AgentOutputReadMetricsState>>,
}

#[derive(Debug, Clone, Default)]
struct AgentOutputReadMetricsState {
    total: OutputReadCounter,
    by_source: BTreeMap<String, OutputReadCounter>,
    recent: Vec<Value>,
}

#[derive(Debug, Clone, Default)]
struct OutputReadCounter {
    count: u64,
    changed: u64,
    unchanged: u64,
    coalesced: u64,
    errors: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputReadRecord {
    pub source: String,
    pub session_id: String,
    pub changed: Option<bool>,
    pub coalesced: bool,
    pub error: bool,
}

impl AgentOutputReadMetrics {
    pub fn record(&self, record: AgentOutputReadRecord) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.total.record(&record);
        state
            .by_source
            .entry(record.source.clone())
            .or_default()
            .record(&record);
        state.recent.push(json!({
            "source": record.source,
            "sessionId": record.session_id,
            "changed": record.changed,
            "coalesced": record.coalesced,
            "error": record.error,
        }));
        let remove_count = state.recent.len().saturating_sub(RECENT_OUTPUT_READ_LIMIT);
        if remove_count > 0 {
            state.recent.drain(0..remove_count);
        }
    }

    pub fn snapshot(&self) -> Value {
        let Ok(state) = self.inner.lock() else {
            return empty_snapshot();
        };
        let mut by_source = Map::new();
        for (source, counter) in &state.by_source {
            by_source.insert(source.clone(), counter.to_json());
        }
        json!({
            "total": state.total.to_json(),
            "bySource": by_source,
            "recent": state.recent,
        })
    }
}

impl OutputReadCounter {
    fn record(&mut self, record: &AgentOutputReadRecord) {
        self.count += 1;
        if record.changed == Some(true) {
            self.changed += 1;
        } else if record.changed == Some(false) {
            self.unchanged += 1;
        }
        if record.coalesced {
            self.coalesced += 1;
        }
        if record.error {
            self.errors += 1;
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "count": self.count,
            "changed": self.changed,
            "unchanged": self.unchanged,
            "coalesced": self.coalesced,
            "errors": self.errors,
        })
    }
}

fn empty_snapshot() -> Value {
    json!({
        "total": { "count": 0, "changed": 0, "unchanged": 0, "coalesced": 0, "errors": 0 },
        "bySource": {},
        "recent": [],
    })
}
