use aimux::agent_display::{
    AgentDisplayInput, agent_compact_identity, agent_role_label, agent_short_name,
    agent_tool_name, is_generated_agent_label,
};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/agent-display/labels.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn agent_display_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("agent-display fixture parses");
    assert_eq!(contract.cases.len(), 13);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_agent_display_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_agent_display_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    let default_agent = Value::Null;
    let agent = AgentDisplayInput::from_value(input.get("agent").unwrap_or(&default_agent));
    match api {
        "agentToolName" => json!(agent_tool_name(&agent)),
        "isGeneratedAgentLabel" => json!(is_generated_agent_label(
            input
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            &agent
        )),
        "agentShortName" => json!(agent_short_name(&agent)),
        "agentRoleLabel" => json!(agent_role_label(&agent)),
        "agentCompactIdentity" => json!(agent_compact_identity(&agent)),
        _ => panic!("unknown agent display contract api: {api}"),
    }
}
