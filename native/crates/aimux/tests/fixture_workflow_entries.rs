use aimux::project_service::coordination_worklist::{
    build_coordination_thread_entries, build_workflow_entries, describe_workflow_next_action,
    filter_workflow_entries,
};
use serde_json::{Value, json};

const WORKFLOW_ENTRIES: &str =
    include_str!("../../../../testdata/contracts/v1/workflow/entries.json");

#[test]
fn fixture_workflow_entries_match_typescript() {
    let contract: Value = serde_json::from_str(WORKFLOW_ENTRIES).expect("valid workflow fixture");
    let cases = contract["cases"].as_array().expect("workflow cases");
    assert_eq!(cases.len(), 4, "unexpected workflow case count");

    let mut failures = Vec::new();
    for case in cases {
        let input = &case["input"];
        let exchange = &input["exchange"];
        let participant = input["participant"].as_str().unwrap_or("user");
        let workflow_entries = build_workflow_entries(exchange, participant, false);
        let coordination_thread_entries = build_coordination_thread_entries(exchange, participant);
        let actual = json!({
            "workflowEntries": workflow_entries,
            "coordinationThreadEntries": coordination_thread_entries,
            "filters": {
                "all": filter_workflow_entries(&build_workflow_entries(exchange, participant, false), "all", participant),
                "onMe": filter_workflow_entries(&build_workflow_entries(exchange, participant, false), "on_me", participant),
                "blocked": filter_workflow_entries(&build_workflow_entries(exchange, participant, false), "blocked", participant),
                "families": filter_workflow_entries(&build_workflow_entries(exchange, participant, false), "families", participant),
            },
            "nextActions": build_workflow_entries(exchange, participant, false)
                .iter()
                .map(|entry| {
                    let mut action = serde_json::Map::new();
                    action.insert("threadId".into(), entry["thread"]["id"].clone());
                    if let Some(task_id) = entry.get("task").and_then(|task| task.get("id")) {
                        action.insert("taskId".into(), task_id.clone());
                    }
                    action.insert(
                        "action".into(),
                        Value::String(describe_workflow_next_action(entry, participant)),
                    );
                    Value::Object(action)
                })
                .collect::<Vec<_>>(),
        });
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
        "{} workflow parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
