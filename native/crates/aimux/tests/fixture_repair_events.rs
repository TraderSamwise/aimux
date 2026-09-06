use std::fs;
use std::path::PathBuf;

use aimux::repair_events::repair_events_contract;
use serde_json::{Value, json};

const REPAIR_EVENTS: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/repair-events.json");

#[test]
fn fixture_repair_events_match_typescript() {
    let contract: Value =
        serde_json::from_str(REPAIR_EVENTS).expect("valid runtime-state/repair-events fixture");
    let cases = contract["cases"].as_array().expect("repair-events cases");
    assert_eq!(cases.len(), 1, "unexpected repair-events case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = with_home(|home| repair_events_contract(case, home));
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} runtime-state/repair-events parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn with_home(callback: impl FnOnce(&PathBuf) -> Value) -> Value {
    let home = std::env::temp_dir().join(format!(
        "aimux-repair-events-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    fs::create_dir_all(&home).expect("create temp home");
    let result = callback(&home);
    let _ = fs::remove_dir_all(&home);
    result
}
