use aimux::team_contract::{is_project_control_session, select_orphan_teammate_ids};
use serde_json::{Value, json};

const TEAM_SEMANTICS: &str =
    include_str!("../../../../../testdata/contracts/v1/team/semantics.json");

#[test]
fn fixture_team_semantics_matches_typescript() {
    let contract: Value = serde_json::from_str(TEAM_SEMANTICS).expect("valid team fixture");
    let cases = contract["cases"].as_array().expect("team cases");
    assert_eq!(cases.len(), 2, "unexpected team case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = team_actual(case);
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
        "{} team/semantics parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn team_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "selectOrphanTeammates" => json!(select_orphan_teammate_ids(
            case["input"]["sessions"].as_array().expect("sessions"),
            &case["input"]["knownParentIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        )),
        "isProjectControlSessionBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| is_project_control_session(item.get("session")))
                .map(Value::Bool)
                .collect(),
        ),
        api => json!({ "error": format!("unknown team api: {api}") }),
    }
}
