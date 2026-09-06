use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const RECENT_OUTPUT_READ_LIMIT: usize = 100;

#[derive(Debug, Clone, Default)]
pub struct AgentOutputReadMetrics {
    inner: Arc<Mutex<AgentOutputReadMetricsState>>,
}

#[derive(Debug, Clone, Default)]
struct AgentOutputReadMetricsState {
    total: OutputReadCounter,
    by_source: BTreeMap<String, OutputReadCounter>,
    by_source_mode: BTreeMap<String, OutputReadCounter>,
    by_source_purpose: BTreeMap<String, OutputReadCounter>,
    recent: Vec<Value>,
}

#[derive(Debug, Clone, Default)]
struct OutputReadCounter {
    count: u64,
    errors: u64,
    changed: u64,
    unchanged: u64,
    unknown_change: u64,
    coalesced: u64,
    total_ms: u64,
    max_ms: u64,
    total_output_bytes: u64,
    max_output_bytes: u64,
    total_response_bytes: u64,
    max_response_bytes: u64,
    last_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputReadRecord {
    pub source: String,
    pub session_id: String,
    pub changed: Option<bool>,
    pub coalesced: bool,
    pub error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputReadMetricRecord {
    pub source: String,
    pub session_id: String,
    pub mode: Option<String>,
    pub purpose: Option<String>,
    pub requested_start_line: Option<i64>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub capture_line_limit: Option<i64>,
    pub output_bytes: u64,
    pub response_bytes: u64,
    pub duration_ms: u64,
    pub coalesced: bool,
    pub changed: Option<bool>,
    pub error: Option<String>,
}

impl AgentOutputReadMetrics {
    pub fn record(&self, record: AgentOutputReadRecord) {
        self.record_metric_at(
            AgentOutputReadMetricRecord {
                source: record.source,
                session_id: record.session_id,
                mode: None,
                purpose: None,
                requested_start_line: None,
                start_line: None,
                end_line: None,
                capture_line_limit: None,
                output_bytes: 0,
                response_bytes: 0,
                duration_ms: 0,
                coalesced: record.coalesced,
                changed: record.changed,
                error: record.error.then(|| "error".to_owned()),
            },
            now_iso(),
        );
    }

    pub fn record_metric_at(&self, record: AgentOutputReadMetricRecord, at: String) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.total.record(&record, &at);
        state
            .by_source
            .entry(record.source.clone())
            .or_default()
            .record(&record, &at);
        if let Some(mode) = &record.mode {
            state
                .by_source_mode
                .entry(format!("{}:{mode}", record.source))
                .or_default()
                .record(&record, &at);
        }
        if let Some(purpose) = &record.purpose {
            state
                .by_source_purpose
                .entry(format!("{}:{purpose}", record.source))
                .or_default()
                .record(&record, &at);
        }
        state.recent.push(record.to_recent_json(&at));
        let remove_count = state.recent.len().saturating_sub(RECENT_OUTPUT_READ_LIMIT);
        if remove_count > 0 {
            state.recent.drain(0..remove_count);
        }
    }

    pub fn snapshot(&self) -> Value {
        let Ok(state) = self.inner.lock() else {
            return empty_snapshot();
        };
        json!({
            "total": state.total.to_json(),
            "bySource": counters_to_json(&state.by_source),
            "bySourceMode": counters_to_json(&state.by_source_mode),
            "bySourcePurpose": counters_to_json(&state.by_source_purpose),
            "recent": state.recent,
        })
    }
}

impl OutputReadCounter {
    fn record(&mut self, record: &AgentOutputReadMetricRecord, at: &str) {
        self.count += 1;
        if record.error.is_some() {
            self.errors += 1;
        }
        match record.changed {
            Some(true) => self.changed += 1,
            Some(false) => self.unchanged += 1,
            None => self.unknown_change += 1,
        }
        if record.coalesced {
            self.coalesced += 1;
        }
        self.total_ms += record.duration_ms;
        self.max_ms = self.max_ms.max(record.duration_ms);
        self.total_output_bytes += record.output_bytes;
        self.max_output_bytes = self.max_output_bytes.max(record.output_bytes);
        self.total_response_bytes += record.response_bytes;
        self.max_response_bytes = self.max_response_bytes.max(record.response_bytes);
        self.last_at = Some(at.to_owned());
    }

    fn to_json(&self) -> Value {
        json!({
            "count": self.count,
            "errors": self.errors,
            "changed": self.changed,
            "unchanged": self.unchanged,
            "unknownChange": self.unknown_change,
            "coalesced": self.coalesced,
            "totalMs": self.total_ms,
            "maxMs": self.max_ms,
            "totalOutputBytes": self.total_output_bytes,
            "maxOutputBytes": self.max_output_bytes,
            "totalResponseBytes": self.total_response_bytes,
            "maxResponseBytes": self.max_response_bytes,
            "lastAt": self.last_at,
        })
    }
}

impl AgentOutputReadMetricRecord {
    fn to_recent_json(&self, at: &str) -> Value {
        let mut map = Map::new();
        insert_string(&mut map, "source", &self.source);
        insert_string(&mut map, "sessionId", &self.session_id);
        insert_optional_string(&mut map, "mode", self.mode.as_deref());
        insert_optional_string(&mut map, "purpose", self.purpose.as_deref());
        insert_optional_i64(&mut map, "requestedStartLine", self.requested_start_line);
        insert_optional_i64(&mut map, "startLine", self.start_line);
        insert_optional_i64(&mut map, "endLine", self.end_line);
        insert_optional_i64(&mut map, "captureLineLimit", self.capture_line_limit);
        insert_nonzero_u64(&mut map, "outputBytes", self.output_bytes);
        insert_nonzero_u64(&mut map, "durationMs", self.duration_ms);
        insert_nonzero_u64(&mut map, "responseBytes", self.response_bytes);
        if self.coalesced {
            map.insert("coalesced".to_owned(), Value::Bool(true));
        }
        if let Some(changed) = self.changed {
            map.insert("changed".to_owned(), Value::Bool(changed));
        }
        insert_optional_string(&mut map, "error", self.error.as_deref());
        insert_string(&mut map, "at", at);
        Value::Object(map)
    }
}

fn counters_to_json(counters: &BTreeMap<String, OutputReadCounter>) -> Value {
    let mut map = Map::new();
    for (source, counter) in counters {
        map.insert(source.clone(), counter.to_json());
    }
    Value::Object(map)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn insert_optional_i64(map: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), Value::Number(value.into()));
    }
}

fn insert_nonzero_u64(map: &mut Map<String, Value>, key: &str, value: u64) {
    if value > 0 {
        map.insert(key.to_owned(), Value::Number(value.into()));
    }
}

fn empty_snapshot() -> Value {
    json!({
        "total": OutputReadCounter::default().to_json(),
        "bySource": {},
        "bySourceMode": {},
        "bySourcePurpose": {},
        "recent": [],
    })
}

fn now_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
