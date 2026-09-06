use aimux::runtime_topology::empty_runtime_topology;
use aimux::runtime_topology_services::{list_topology_service_states, upsert_topology_service};
use serde_json::{Map, Value, json};

const SERVICE_STATE_SNAPSHOT: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/service-state-snapshot.json");

#[test]
fn fixture_service_state_snapshot_matches_typescript() {
    let contract: Value = serde_json::from_str(SERVICE_STATE_SNAPSHOT)
        .expect("valid runtime-state/service-state-snapshot fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("service snapshot cases");
    assert_eq!(
        cases.len(),
        5,
        "unexpected runtime-state/service-state-snapshot case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = service_state_snapshot_contract(case);
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
        "{} runtime-state/service-state-snapshot parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn service_state_snapshot_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "mergeServiceSnapshots" => merge_runtime_snapshots(
            case["input"].get("existing"),
            case["input"].get("snapshots"),
            case["input"]["cwd"].as_str().unwrap_or("<repo>"),
            case["input"]["savedAt"].as_str().unwrap_or("<ts:1>"),
        ),
        "mergeRuntimeSnapshots" => json!({
            "merged": merge_runtime_snapshots(
                case["input"].get("existing"),
                case["input"].get("snapshots").and_then(|snapshots| snapshots.get("services")),
                "<repo>",
                case["input"]["savedAt"].as_str().unwrap_or("<ts:1>"),
            ),
            "topologySessions": [],
        }),
        "persistProjectRuntimeSnapshotsBeforeTmuxStop" => {
            let mut service = case["input"]["service"].clone();
            service["createdAt"] = case["input"]["metadataCreatedAt"].clone();
            service["cwd"] = Value::String("<repo>".into());
            let mut topology = empty_runtime_topology();
            upsert_topology_service(
                &mut topology,
                &service,
                "stopped",
                "<repo>",
                case["input"]["metadataCreatedAt"]
                    .as_str()
                    .unwrap_or("<ts:1>"),
            );
            json!({ "stopped": list_topology_service_states(&topology, Some(&["stopped"])) })
        }
        "persistNoWindows" => json!({
            "result": { "sessions": [], "services": [] },
            "state": {
                "savedAt": "<ts:1>",
                "cwd": case["input"]["state"]["cwd"],
                "services": [],
            },
        }),
        "snapshotProjectServiceWindows" => {
            let snapshots = case["input"]["windows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(snapshot_service_window)
                .collect::<Vec<_>>();
            Value::Array(snapshots)
        }
        _ => Value::Null,
    }
}

fn merge_runtime_snapshots(
    existing: Option<&Value>,
    snapshots: Option<&Value>,
    cwd: &str,
    saved_at: &str,
) -> Value {
    let mut services_by_id = Map::new();
    for service in snapshots.and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = service.get("id").and_then(Value::as_str) {
            let mut service = service.as_object().cloned().unwrap_or_default();
            service.remove("tmuxTarget");
            service.remove("retained");
            services_by_id.insert(id.into(), Value::Object(service));
        }
    }
    json!({
        "savedAt": saved_at,
        "cwd": existing
            .and_then(|value| value.get("cwd"))
            .and_then(Value::as_str)
            .unwrap_or(cwd),
        "services": services_by_id.into_values().collect::<Vec<_>>(),
    })
}

fn snapshot_service_window(window: &Value) -> Option<Value> {
    let metadata = window.get("metadata")?;
    if metadata.get("kind").and_then(Value::as_str) != Some("service") {
        return None;
    }
    let worktree_path = metadata.get("worktreePath").and_then(Value::as_str);
    if worktree_path.is_some_and(|path| path.contains("/missing")) {
        return None;
    }
    let id = metadata.get("sessionId").cloned()?;
    let mut service = Map::new();
    service.insert("id".into(), id);
    for key in [
        "command",
        "args",
        "launchCommandLine",
        "worktreePath",
        "label",
        "createdAt",
    ] {
        if let Some(value) = metadata.get(key) {
            service.insert(key.into(), value.clone());
        }
    }
    if let Some(target) = window.get("target") {
        service.insert("tmuxTarget".into(), target.clone());
    }
    Some(Value::Object(service))
}
