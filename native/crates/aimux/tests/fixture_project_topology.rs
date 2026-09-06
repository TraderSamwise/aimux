use aimux::project_service::project_topology_contract::{
    build_project_topology, health_for_status, rollup_health,
};
use serde_json::{Value, json};

const PROJECT_TOPOLOGY: &str =
    include_str!("../../../../testdata/contracts/v1/project-topology/topology.json");

#[test]
fn fixture_project_topology_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PROJECT_TOPOLOGY).expect("valid project-topology fixture");
    let cases = contract["cases"].as_array().expect("topology cases");
    assert_eq!(cases.len(), 15, "unexpected project-topology case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "healthForStatus" => Value::String(
                health_for_status(
                    case["input"]["status"].as_str(),
                    case["input"]["pendingAction"].as_str(),
                )
                .into(),
            ),
            "rollupHealth" => Value::String(
                rollup_health(
                    case["input"]["healths"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                )
                .into(),
            ),
            "buildProjectTopology" => build_project_topology(&case["input"]),
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
        "{} project-topology parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
