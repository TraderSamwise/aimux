use aimux::project_service::agent_output_projection::{
    audit_agent_output_parser_contract, project_agent_output, project_agent_output_with_source,
};
use serde_json::{Value, json};

const PARSER_ADVERSARIAL: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/parser-adversarial.json");
const PARSER_FUZZ: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/parser-fuzz.json");
const PARSER_AUDIT: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/parser-audit.json");
const PARSER_ACTIVITY_TEXT: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/parser-activity-text.json");

#[test]
fn fixture_agent_output_parser_adversarial_matches_typescript() {
    assert_parser_contract("parser-adversarial", PARSER_ADVERSARIAL);
}

#[test]
fn fixture_agent_output_parser_fuzz_matches_typescript() {
    assert_parser_contract("parser-fuzz", PARSER_FUZZ);
}

#[test]
fn fixture_agent_output_parser_activity_text_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PARSER_ACTIVITY_TEXT).expect("valid parser activity fixture json");
    let cases = contract["cases"]
        .as_array()
        .expect("parser activity fixture cases");
    assert!(
        !cases.is_empty(),
        "parser activity fixture must contain cases"
    );
    let mut failures = Vec::new();
    for case in cases {
        let raw = case["input"]["raw"].as_str().expect("case input raw");
        let tool = case["input"]["options"]["tool"].as_str();
        let expected = case["output"].clone();
        let actual = Value::String(project_agent_output(raw, tool).activity_text);
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
        "{} parser activity-text parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn keeps_claude_task_output_progress_out_of_assistant_chat_messages() {
    let raw = [
        "⏺ Sign-up takes no prefilled address, which matters.",
        "",
        "Task Output a214a37629dc53118",
        "  ⎿  Read output (ctrl+o to expand)",
        "",
        "Agent \"Audit phase 4 plan\" finished · 1m 41s",
        "",
        "⏺ Now the route, and the two comments that assert the old rule.",
        "",
        "Task Output a51ccfed03dad09ee",
        "  Audit phase 4 implementation",
        "    Waiting for task (esc to give additional instructions)",
    ]
    .join("\n");

    let projection = project_agent_output(&raw, Some("claude"));
    let block_types: Vec<&str> = projection
        .parsed
        .get("blocks")
        .and_then(Value::as_array)
        .expect("blocks")
        .iter()
        .map(|block| block["type"].as_str().expect("block type"))
        .collect();

    assert_eq!(block_types, ["response", "status", "response", "status"]);
    assert!(
        projection.parsed["blocks"][1]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Task Output a214a37629dc53118"))
    );
    assert!(
        projection.parsed["blocks"][3]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Waiting for task"))
    );
    let message_text: Vec<&str> = projection
        .messages
        .iter()
        .map(|message| message["text"].as_str().expect("message text"))
        .collect();
    assert_eq!(
        message_text,
        [
            "Sign-up takes no prefilled address, which matters.",
            "Now the route, and the two comments that assert the old rule.",
        ]
    );
}

#[test]
fn fixture_agent_output_parser_audit_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PARSER_AUDIT).expect("valid parser audit fixture json");
    let cases = contract["cases"]
        .as_array()
        .expect("parser audit fixture cases");
    assert_eq!(cases.len(), 22, "unexpected parser audit case count");
    let mut failures = Vec::new();
    for case in cases {
        let expected = case["output"].clone();
        let actual = audit_agent_output_parser_contract(&case["input"]);
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
        "{} parser audit parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn assert_parser_contract(label: &str, fixture: &str) {
    let contract: Value = serde_json::from_str(fixture).expect("valid parser fixture json");
    let cases = contract["cases"].as_array().expect("parser fixture cases");
    assert!(!cases.is_empty(), "{label} must contain cases");

    let mut failures = Vec::new();
    for case in cases {
        let id = case["id"].as_str().unwrap_or("<missing id>");
        let raw = case["input"]["raw"].as_str().expect("case input raw");
        let tool = case["input"]["options"]["tool"].as_str();
        let include_source = case["input"]["options"]["includeSource"]
            .as_bool()
            .unwrap_or(false);
        let expected = case["output"].clone();
        let actual = project_agent_output_with_source(raw, tool, include_source).parsed;
        if actual != expected {
            failures.push(json!({
                "id": id,
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{label}: {} parser parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
