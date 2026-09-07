use aimux::transcript_reconciler_contract::run_transcript_reconciler_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const TRANSCRIPT_RECONCILER: &str =
    include_str!("../../../../testdata/contracts/v1/agent-output/transcript-reconciler.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_transcript_reconciler_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TRANSCRIPT_RECONCILER).expect("transcript reconciler fixture parses");
    assert_eq!(contract.cases.len(), 13);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "TranscriptReconciler.scan");
        let actual = run_transcript_reconciler_contract_case(&case.input);
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
        "{} transcript reconciler parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
