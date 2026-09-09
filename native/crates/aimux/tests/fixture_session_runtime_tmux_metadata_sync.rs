use aimux::session_runtime_tmux_metadata_sync_contract::run_session_runtime_tmux_metadata_sync_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/session-runtime-tmux-metadata-sync.json"
);

#[derive(Debug, Deserialize)]
struct Contract {
    source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    source: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_session_runtime_tmux_metadata_sync_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("session runtime tmux metadata sync fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-runtime-core.ts");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/session-runtime-core.ts");
        let actual = run_session_runtime_tmux_metadata_sync_contract_case(&case.input);
        if actual != case.output {
            failures.push(serde_json::json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} session runtime tmux metadata sync parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
