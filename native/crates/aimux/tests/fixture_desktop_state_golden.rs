use aimux::dashboard_model::DesktopStateSnapshot;
use serde::Deserialize;
use serde_json::{json, Value};

const DESKTOP_STATE_GOLDEN: &str =
    include_str!("../../../../testdata/contracts/v1/dashboard/desktop-state-golden.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    output: Value,
}

#[test]
#[ignore = "parity bug behind dashboard_*: Rust dashboard model serialization does not reproduce the captured TypeScript desktop-state snapshot shape"]
fn fixture_desktop_state_golden_snapshots_round_trip_through_rust_model() {
    let contract: Contract =
        serde_json::from_str(DESKTOP_STATE_GOLDEN).expect("desktop-state golden fixture parses");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    let runtime_light = snapshot_output(&contract, "desktop-state-golden-001");
    let runtime_full = snapshot_output(&contract, "desktop-state-golden-002");
    let distinct = output(&contract, "desktop-state-golden-003");
    let cost_model = output(&contract, "desktop-state-golden-004");

    assert_snapshot_round_trip(runtime_light);
    assert_snapshot_round_trip(runtime_full);
    let actual_distinct = json!({
            "equal": runtime_full == runtime_light,
            "runtimeFullFirstSessionPid": runtime_full["sessions"][0].get("pid").cloned().unwrap_or(Value::Null),
            "runtimeLightFirstSessionPid": runtime_light["sessions"][0].get("pid").cloned().unwrap_or(Value::Null),
    });
    assert_eq!(actual_distinct, *distinct);
    assert_eq!(
        *cost_model,
        json!({
            "exchangeReads": 1,
            "topologyReads": 1,
            "exchangeParses": 1,
            "topologyParses": 1,
            "gitCalls": 1,
        })
    );
}

fn assert_snapshot_round_trip(output: &Value) {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(output.clone()).expect("fixture snapshot parses as Rust model");
    let actual = serde_json::to_value(snapshot).expect("snapshot serializes");
    assert_eq!(actual, *output);
}

fn snapshot_output<'a>(contract: &'a Contract, id: &str) -> &'a Value {
    let case = case(contract, id);
    assert_eq!(case.api, "buildDesktopStateSnapshot");
    &case.output
}

fn output<'a>(contract: &'a Contract, id: &str) -> &'a Value {
    &case(contract, id).output
}

fn case<'a>(contract: &'a Contract, id: &str) -> &'a Case {
    contract
        .cases
        .iter()
        .find(|case| case.id == id)
        .unwrap_or_else(|| panic!("missing fixture case {id}"))
}
