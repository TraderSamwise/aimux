use aimux::loop_watcher::{LoopSendKind, LoopWatcher};
use serde_json::{Value, json};

const NOW: i64 = 1_788_000_000_000;

fn scan_input(worklist: Value) -> Value {
    json!({
        "sessions": [
            {"id": "supervisor", "status": "running", "tool": "codex"},
            {"id": "available", "status": "running", "tool": "codex"}
        ],
        "metadata": {"sessions": {
            "supervisor": {"overseer": true, "derived": {"activity": "busy"}},
            "available": {"derived": {"activity": "idle"}}
        }},
        "config": {"idleFleetDwellMs": 0, "reconciliationDwellMs": 0},
        "pendingInteractions": [],
        "runtimeExchange": {"tasks": [], "threads": []},
        "coordinationWorklist": worklist
    })
}

#[test]
fn work_inventory_empty_present_and_unavailable_are_distinct() {
    let empty = scan_input(json!({"needsYou": []}));
    assert!(LoopWatcher::new().plan_sends(&empty, NOW).is_empty());

    let present = scan_input(json!({"needsYou": [{
        "key": "t:inspectable-thread", "kind": "thread", "actionable": true,
        "title": "Actual work", "thread": {"thread": {
            "id": "inspectable-thread", "status": "open", "waitingOn": ["missing-owner"]
        }}
    }]}));
    let sends = LoopWatcher::new().plan_sends(&present, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::IdleFleet);
    assert!(sends[0].text.contains("Visible unowned work:"));
    assert!(sends[0].text.contains("Actual work"));

    let unavailable = scan_input(json!({"error": "permission denied reading thread store"}));
    let sends = LoopWatcher::new().plan_sends(&unavailable, NOW);
    assert_eq!(sends.len(), 1, "unavailable inventory must remain visible");
    assert!(sends[0].text.contains("Work inventory unavailable"));
    assert!(
        sends[0]
            .text
            .contains("permission denied reading thread store")
    );
    assert!(!sends[0].text.contains("Visible unowned work:"));
    assert!(!sends[0].text.contains("unassigned-worklist"));
}

#[test]
fn incomplete_park_metadata_does_not_hide_a_real_stall() {
    let mut input = scan_input(json!({"needsYou": []}));
    input["runtimeExchange"]["tasks"] = json!([{
        "id": "pending-work", "status": "pending", "description": "real queued work"
    }]);
    for invalid_key in [Value::Null, json!("wrong-incarnation")] {
        input["metadata"]["sessions"]["available"]["loopAlertsParked"] = json!({
            "sessionKey": invalid_key, "workKey": "[]"
        });
        let sends = LoopWatcher::new().plan_sends(&input, NOW);
        assert!(
            sends
                .iter()
                .any(|send| send.kind == LoopSendKind::IdleFleet),
            "an unidentifiable session cannot inherit an invalid park record"
        );
    }
}
