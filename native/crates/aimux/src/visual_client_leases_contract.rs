use crate::visual_client_leases::{VisualClientLeaseRegistry, parse_iso_millis};
use serde_json::{Value, json};

pub fn run_registry_steps(initial_now: &str, steps: &[Value]) -> Value {
    let mut now_ms = parse_iso_millis(initial_now).expect("fixture initialNow must parse");
    let mut registry = VisualClientLeaseRegistry::default();
    let mut outputs = Vec::new();
    for step in steps {
        now_ms += step.get("advanceMs").and_then(Value::as_i64).unwrap_or(0);
        match step.get("op").and_then(Value::as_str).unwrap_or_default() {
            "touch" => outputs.push(json!({
                "op": "touch",
                "lease": registry.touch(&step["input"], now_ms),
            })),
            "snapshot" => outputs.push(json!({
                "op": "snapshot",
                "snapshot": registry.snapshot(now_ms),
            })),
            "hasActivePreviewClients" => outputs.push(json!({
                "op": "hasActivePreviewClients",
                "value": registry.has_active_preview_clients(now_ms),
            })),
            _ => {
                outputs.push(json!({ "op": step["op"].clone(), "error": "unsupported operation" }))
            }
        }
    }
    Value::Array(outputs)
}
