use serde::Deserialize;

const METADATA: &str = include_str!("../../../../testdata/contracts/v1/cli/metadata-command.json");
const LOGS: &str = include_str!("../../../../testdata/contracts/v1/cli/logs-command.json");
const WORK_OUTLINE: &str =
    include_str!("../../../../testdata/contracts/v1/cli/work-outline-command.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
}

#[test]
#[ignore = "checklist: CLI wrapper execution parity belongs to fenced core_cli* implementation"]
fn metadata_cli_command_contract_is_captured() {
    assert_fixture(METADATA, 4);
}

#[test]
#[ignore = "checklist: CLI wrapper execution parity belongs to fenced core_cli* implementation"]
fn logs_cli_command_contract_is_captured() {
    assert_fixture(LOGS, 4);
}

#[test]
#[ignore = "checklist: CLI wrapper execution parity belongs to fenced core_cli* implementation"]
fn work_outline_cli_command_contract_is_captured() {
    assert_fixture(WORK_OUTLINE, 4);
}

fn assert_fixture(fixture: &str, expected_count: usize) {
    let contract: Contract = serde_json::from_str(fixture).expect("cli wrapper fixture parses");
    assert_eq!(contract.cases.len(), expected_count);
    assert!(contract.cases.iter().all(|case| !case.id.is_empty()));
}
