use serde::Deserialize;

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
}

#[test]
#[ignore = "checklist: TranscriptReconciler scan parity has no Rust public API yet"]
fn fixture_transcript_reconciler_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TRANSCRIPT_RECONCILER).expect("transcript reconciler fixture parses");
    assert_eq!(contract.cases.len(), 13);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "TranscriptReconciler.scan"));
}
