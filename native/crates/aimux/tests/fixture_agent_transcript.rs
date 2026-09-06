use aimux::project_service::agent_output_projection::project_agent_output_with_ansi;
use serde_json::{Value, json};

const TRANSCRIPT: &str =
    include_str!("../../../../testdata/contracts/v1/agent-output/transcript.json");

#[test]
fn fixture_agent_transcript_messages_from_agent_output_matches_typescript() {
    let contract: Value = serde_json::from_str(TRANSCRIPT).expect("valid transcript fixture json");
    let cases = contract["cases"]
        .as_array()
        .expect("transcript fixture cases");
    let implemented_cases: Vec<&Value> = cases
        .iter()
        .filter(|case| case["api"].as_str() == Some("messagesFromAgentOutput"))
        .collect();
    assert!(
        !implemented_cases.is_empty(),
        "transcript fixture must include messagesFromAgentOutput cases"
    );

    let mut failures = Vec::new();
    for case in implemented_cases {
        let input = &case["input"];
        let raw = input["output"].as_str().expect("case output text");
        let ansi = input["outputAnsi"].as_str();
        let tool = input["tool"].as_str();
        let expected = case["output"].clone();
        let actual = Value::Array(project_agent_output_with_ansi(raw, ansi, tool).messages);
        if actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} transcript projection parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
#[ignore = "Rust has no standalone messagesFromParsedAgentOutput/transcriptMessageText/mergePublishedAttachments API yet"]
fn fixture_agent_transcript_unimplemented_apis_are_contract_checklist() {
    let contract: Value = serde_json::from_str(TRANSCRIPT).expect("valid transcript fixture json");
    let cases = contract["cases"]
        .as_array()
        .expect("transcript fixture cases");
    let missing: Vec<&Value> = cases
        .iter()
        .filter(|case| case["api"].as_str() != Some("messagesFromAgentOutput"))
        .collect();
    assert_eq!(
        missing.len(),
        41,
        "unexpected transcript unimplemented API case count"
    );
}
