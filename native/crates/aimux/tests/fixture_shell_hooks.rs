use aimux::shell_hooks_contract::run_shell_hooks_contract_case;
use serde::Deserialize;
use serde_json::Value;
use std::fs;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/shell/hooks.json");

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
fn shell_hooks_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("shell hooks fixture parses");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        if let Some(project_state_dir) = case.input.get("projectStateDir").and_then(Value::as_str) {
            let _ = fs::remove_dir_all(project_state_dir);
        }
        let actual = run_shell_hooks_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
