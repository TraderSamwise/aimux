use aimux::runtime_guard_repair_start_contract::run_runtime_guard_repair_start_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const RUNTIME_GUARD_REPAIR_START: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/runtime-guard-repair-start.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    sources: Vec<String>,
    subject: String,
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
fn fixture_runtime_guard_repair_start_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(RUNTIME_GUARD_REPAIR_START)
        .expect("runtime guard repair fixture parses");
    assert_eq!(contract.subject, "runtime guard repair start branch");
    assert_eq!(contract.case_count, 1);
    assert_eq!(contract.cases.len(), contract.case_count);
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/dashboard-control.test.ts".to_string())
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert!(
            contract.sources.contains(&case.source),
            "case {} source {} is not declared",
            case.id,
            case.source
        );
        assert_eq!(case.api, "startRuntimeGuardRepairStartBranch");
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
        let actual = run_runtime_guard_repair_start_contract_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} runtime guard repair start parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
