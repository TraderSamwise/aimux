use aimux::daemon_projects::count_online_desktop_agents;
use serde::Deserialize;
use serde_json::{Value, json};

const PROJECTS_ROUTE_COUNTS: &str =
    include_str!("../../../../testdata/contracts/v1/daemon/projects-route-counts.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_daemon_projects_route_counts_match_typescript() {
    let contract: Contract =
        serde_json::from_str(PROJECTS_ROUTE_COUNTS).expect("daemon projects route fixture parses");
    assert_eq!(contract.source, "src/daemon/projects-route.test.ts");
    assert_eq!(contract.case_count, 3);
    assert_eq!(contract.cases.len(), contract.case_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert_eq!(case.api, "countOnlineDesktopAgents");
        let actual = count_online_desktop_agents(&case.input["state"])
            .map(Value::from)
            .unwrap_or(Value::Null);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} daemon projects route parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
