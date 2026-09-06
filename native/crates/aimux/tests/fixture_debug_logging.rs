use aimux::debug_logging_contract::run_debug_logging_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/debug/logging.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn debug_logging_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("debug logging fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_debug_logging_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
