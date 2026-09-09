use aimux::daemon_state::{get_daemon_host_from, get_daemon_port_from, load_daemon_state_with};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const DAEMON_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/daemon-state/state.json");

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_daemon_state_matches_typescript() {
    let contract: Value = serde_json::from_str(DAEMON_STATE).expect("valid daemon state fixture");
    let cases = contract["cases"].as_array().expect("daemon-state cases");
    assert_eq!(cases.len(), 16, "unexpected daemon-state case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "loadDaemonState" => load_daemon_state_case(&case["input"]),
            "getDaemonHost" => result_value(get_daemon_host_from(case["input"]["env"].as_str())),
            "getDaemonPort" => result_value(get_daemon_port_from(case["input"]["env"].as_str())),
            _ => Value::Null,
        };
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} daemon-state parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn load_daemon_state_case(input: &Value) -> Value {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/state.json");
    if let Some(raw_state) = input.get("rawState") {
        fs::create_dir_all(path.parent().expect("parent")).expect("create daemon dir");
        let bytes = match raw_state {
            Value::String(value) => value.clone(),
            _ => serde_json::to_string(raw_state).expect("serialize raw state"),
        };
        fs::write(&path, bytes).expect("write daemon state");
    }

    serde_json::to_value(load_daemon_state_with(&path, |root| {
        root == Path::new("<gitProject>")
    }))
    .expect("serialize loaded daemon state")
}

fn result_value<T>(result: Result<T, String>) -> Value
where
    T: serde::Serialize,
{
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

struct TestDir(std::path::PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join("rust-daemon-state-fixture-tests")
            .join(format!("{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
