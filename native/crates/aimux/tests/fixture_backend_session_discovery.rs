use serde_json::Value;

const BACKEND_SESSION_DISCOVERY: &str =
    include_str!("../../../../testdata/contracts/v1/backend-session-discovery/discovery.json");

#[test]
#[ignore = "backend-session-discovery parity reaches core_cli/session bootstrap and filesystem discovery surfaces outside this ownership slice"]
fn fixture_backend_session_discovery_cases_are_contract_checklist() {
    let contract: Value =
        serde_json::from_str(BACKEND_SESSION_DISCOVERY).expect("valid backend discovery fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("backend discovery cases");
    assert_eq!(cases.len(), 16, "unexpected backend discovery case count");
}
