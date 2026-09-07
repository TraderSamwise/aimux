use serde::Deserialize;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/unimplemented/src-modules.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    case_count: usize,
    assertion_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    source: String,
    missing_api: String,
    ownership_fence: String,
    output: serde_json::Value,
}

#[test]
#[ignore = "checklist-only: remaining corpora sit behind core_cli*, daemon_*, project_service/routes/, dashboard_*, or tmux* ownership fences"]
fn unimplemented_src_module_checklist_is_loaded() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("unimplemented src module fixture parses");
    assert_eq!(contract.case_count, contract.cases.len());
    assert_eq!(contract.cases.len(), 31);
    let assertion_count: usize = contract
        .cases
        .iter()
        .map(|case| {
            assert!(
                case.source.starts_with("src/") && case.source.ends_with(".test.ts"),
                "unexpected source {}",
                case.source
            );
            assert!(
                !case.missing_api.trim().is_empty(),
                "missing API reason for {}",
                case.source
            );
            assert!(
                !case.ownership_fence.trim().is_empty(),
                "missing fence for {}",
                case.source
            );
            case.output["numTotalTests"].as_u64().unwrap_or(0) as usize
        })
        .sum();
    assert_eq!(contract.assertion_count, assertion_count);
}
