use aimux::cli_wrappers_contract::{
    run_cli_logs_command_contract_case, run_cli_metadata_command_contract_case,
    run_cli_work_outline_command_contract_case,
};
use serde::Deserialize;
use serde_json::{Value, json};

const METADATA: &str = include_str!("../../../../testdata/contracts/v1/cli/metadata-command.json");
const LOGS: &str = include_str!("../../../../testdata/contracts/v1/cli/logs-command.json");
const WORK_OUTLINE: &str =
    include_str!("../../../../testdata/contracts/v1/cli/work-outline-command.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
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
fn metadata_cli_command_contract_is_captured() {
    assert_fixture(
        METADATA,
        "src/cli/metadata.test.ts",
        4,
        run_cli_metadata_command_contract_case,
    );
}

#[test]
fn logs_cli_command_contract_is_captured() {
    assert_fixture(
        LOGS,
        "src/cli/logs.test.ts",
        4,
        run_cli_logs_command_contract_case,
    );
}

#[test]
fn work_outline_cli_command_contract_is_captured() {
    assert_fixture(
        WORK_OUTLINE,
        "src/cli/work-outline.test.ts",
        4,
        run_cli_work_outline_command_contract_case,
    );
}

fn assert_fixture(fixture: &str, source: &str, expected_count: usize, run: fn(&Value) -> Value) {
    let contract: Contract = serde_json::from_str(fixture).expect("cli wrapper fixture parses");
    assert_eq!(contract.source, source);
    assert_eq!(contract.cases.len(), expected_count);
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        let actual = run(&json!({ "api": case.api, "input": case.input }));
        assert_eq!(actual, case.output, "{} ({})", case.id, case.api);
    }
}
