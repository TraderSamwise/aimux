use serde_json::Value;

const RUNTIME_COHERENCE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-coherence/report.json");

#[test]
#[ignore = "runtime-coherence parity depends on daemon_*, tmux*, and process inspection surfaces reserved for codex-u1iogs"]
fn fixture_runtime_coherence_cases_are_contract_checklist() {
    let contract: Value =
        serde_json::from_str(RUNTIME_COHERENCE).expect("valid runtime-coherence fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("runtime coherence cases");
    assert_eq!(cases.len(), 15, "unexpected runtime-coherence case count");
}
