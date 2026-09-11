use aimux::project_service::project_observability::{
    ProjectObservabilityInput, build_project_observability,
};
use serde_json::{Value, json};

const PROJECT_OBSERVABILITY: &str =
    include_str!("../../../../../testdata/contracts/v1/project-observability/observability.json");

#[test]
fn fixture_project_observability_matches_typescript() {
    let contract: Value = serde_json::from_str(PROJECT_OBSERVABILITY).expect("valid fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("project observability cases");
    assert_eq!(
        cases.len(),
        5,
        "unexpected project-observability case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(&case["input"]);
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
        "{} project-observability parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    build_project_observability(ProjectObservabilityInput {
        sessions: array(input, "sessions"),
        services: array(input, "services"),
        worktrees: array(input, "worktrees"),
        tasks: array(input, "tasks"),
        notifications: array(input, "notifications"),
        notification_unread_count: input
            .get("notificationUnreadCount")
            .and_then(Value::as_u64)
            .map(|value| value as usize),
        story_limit: input
            .get("storyLimit")
            .and_then(Value::as_u64)
            .map(|value| value as usize),
    })
}

fn array(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
