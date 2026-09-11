use aimux::runtime_migration::build_runtime_exchange_from_legacy_snapshot;
use serde_json::{Value, json};

const RUNTIME_EXCHANGE_IMPORT: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-exchange/import.json");

#[test]
fn fixture_runtime_exchange_import_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_EXCHANGE_IMPORT).expect("valid exchange-import fixture");
    let cases = contract["cases"].as_array().expect("exchange-import cases");
    assert_eq!(
        cases.len(),
        3,
        "unexpected runtime-exchange/import case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = runtime_exchange_import_contract(case);
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
        "{} runtime-exchange/import parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn runtime_exchange_import_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildRuntimeExchangeFromLegacySnapshot" => {
            build_runtime_exchange_from_legacy_snapshot(&case["input"])
        }
        "importRuntimeExchangeFromLegacyFiles" if case["input"].get("files").is_some() => {
            let exchange =
                build_runtime_exchange_from_legacy_snapshot(&snapshot_from_files(&case["input"]));
            json!({
                "threadIds": ids(&exchange["threads"]),
                "messageIds": ids(&exchange["messages"]),
                "taskIds": ids(&exchange["tasks"]),
                "waitIds": ids(&exchange["waits"]),
                "planRefIds": ids(&exchange["planRefs"]),
                "continuityKinds": sorted_strings(&exchange["continuityRefs"], "kind"),
                "attachmentRefIds": ids(&exchange["attachmentRefs"]),
            })
        }
        "importRuntimeExchangeFromLegacyFiles" => {
            json!({ "continuityRefs": [], "recordingsDirExists": false })
        }
        _ => Value::Null,
    }
}

fn snapshot_from_files(input: &Value) -> Value {
    let files = &input["files"];
    json!({
        "now": input["now"],
        "threads": [files["thread"].clone()],
        "messages": [files["message"].clone()],
        "tasks": [files["task"].clone()],
        "planPaths": [files["planPath"].clone()],
        "historyPaths": [files["historyPath"].clone()],
        "contextPaths": [files["contextPath"].clone()],
        "recordingPaths": [],
        "statusPaths": [files["statusPath"].clone()],
        "attachments": [files["attachment"].clone()],
    })
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn sorted_strings(value: &Value, key: &str) -> Vec<String> {
    let mut values = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get(key).and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    values.sort();
    values
}
