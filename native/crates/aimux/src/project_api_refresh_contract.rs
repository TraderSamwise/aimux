use serde_json::{Value, json};

pub fn run_project_api_refresh_contract_case(input: &Value) -> Value {
    let mut state = RefreshState::default();
    let mut timeline = Vec::new();
    for op in input
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match op.get("op").and_then(Value::as_str).unwrap_or_default() {
            "trigger" => {
                state.trigger(&mut timeline);
                timeline.push(state.step(op, "trigger"));
            }
            "resolve" => {
                state.resolve(&mut timeline);
                timeline.push(state.step(op, "resolve"));
            }
            "awaitAll" => {
                state.await_all();
                timeline.push(state.step(op, "awaitAll"));
            }
            other => panic!("unknown project api refresh op: {other}"),
        }
    }
    Value::Array(timeline)
}

#[derive(Debug, Default)]
struct RefreshState {
    call_count: usize,
    pending_refreshes: usize,
    in_flight: bool,
    rerun_requested: bool,
}

impl RefreshState {
    fn trigger(&mut self, timeline: &mut Vec<Value>) {
        if self.in_flight {
            self.rerun_requested = true;
            return;
        }
        self.refresh(timeline);
        self.in_flight = true;
    }

    fn resolve(&mut self, timeline: &mut Vec<Value>) {
        if !self.in_flight {
            return;
        }
        if self.rerun_requested {
            self.rerun_requested = false;
            self.refresh(timeline);
        } else {
            self.in_flight = false;
        }
    }

    fn await_all(&mut self) {
        self.in_flight = false;
        self.rerun_requested = false;
    }

    fn refresh(&mut self, timeline: &mut Vec<Value>) {
        self.call_count += 1;
        self.pending_refreshes += 1;
        timeline.push(json!({ "step": "refresh", "callCount": self.call_count }));
    }

    fn step(&self, op: &Value, fallback: &str) -> Value {
        json!({
            "step": op.get("label").and_then(Value::as_str).unwrap_or(fallback),
            "callCount": self.call_count,
            "pendingRefreshes": self.pending_refreshes,
        })
    }
}
