use aimux::dashboard_terminal::run_terminal_host_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const TERMINAL_HOST: &str = include_str!("../../../../../testdata/contracts/v1/terminal/host.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_terminal_host_contract_matches_rust() {
    let contract: Contract =
        serde_json::from_str(TERMINAL_HOST).expect("terminal host fixture parses");
    assert_eq!(contract.cases.len(), 2);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/terminal-host.test.ts");
        let actual = run_terminal_host_contract_case(&case.input);
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
        "{} terminal-host parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
