use aimux::project_service::agent_output_projection::project_agent_output_with_ansi;
use aimux::project_service::agent_output_projection::{
    merge_published_attachments_contract, messages_from_parsed_agent_output_contract,
    transcript_message_text_contract,
};
use serde_json::{Value, json};

const TRANSCRIPT: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/transcript.json");

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
fn fixture_agent_transcript_standalone_apis_match_typescript() {
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
        "unexpected standalone transcript API case count"
    );
    let mut failures = Vec::new();
    for case in missing {
        let actual = match case["api"].as_str() {
            Some("messagesFromParsedAgentOutput") => messages_from_parsed_agent_output_contract(
                &case["input"]["parsed"],
                &case["input"]["options"],
            ),
            Some("transcriptMessageText") => {
                let parts = case["input"]["parts"]
                    .as_array()
                    .expect("transcriptMessageText parts");
                transcript_message_text_contract(parts)
            }
            Some("mergePublishedAttachments") => {
                let messages = case["input"]["messages"]
                    .as_array()
                    .expect("mergePublishedAttachments messages");
                let published = case["input"]["published"]
                    .as_array()
                    .expect("mergePublishedAttachments published");
                merge_published_attachments_contract(messages, published)
            }
            api => panic!("unexpected transcript API {api:?}"),
        };
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} standalone transcript API parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize standalone transcript failures")
    );
}
