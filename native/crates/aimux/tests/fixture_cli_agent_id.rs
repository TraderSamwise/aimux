use aimux::backend_session_ids::{
    AgentIdentityError, ResolvedAgentIdentity, build_agent_identity_error_payload,
    build_agent_identity_payload, render_agent_identity_lines,
};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/agent-id.json");

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
fn cli_agent_id_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli agent-id fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_case(input: &Value) -> Value {
    match input["api"].as_str().unwrap_or_default() {
        "buildAgentIdentityPayload" => build_agent_identity_payload(
            input["projectRoot"].as_str().expect("project root"),
            &resolved_identity(&input["identity"]),
        ),
        "renderAgentIdentityLines" => json!(render_agent_identity_lines(&input["payload"])),
        "buildAgentIdentityErrorPayload" => build_agent_identity_error_payload(
            input["projectRoot"].as_str().expect("project root"),
            &AgentIdentityError {
                session_id: input["identity"]["sessionId"]
                    .as_str()
                    .expect("session id")
                    .to_owned(),
                reason: input["identity"]["reason"]
                    .as_str()
                    .expect("reason")
                    .to_owned(),
            },
        ),
        api => panic!("unknown cli agent-id api: {api}"),
    }
}

fn resolved_identity(input: &Value) -> ResolvedAgentIdentity {
    ResolvedAgentIdentity {
        session_id: string_field(input, "sessionId").unwrap_or_default(),
        backend_session_id: string_field(input, "backendSessionId").unwrap_or_default(),
        source: match input["source"].as_str().unwrap_or_default() {
            "discovered" => "discovered",
            _ => "topology",
        },
        tool: string_field(input, "tool"),
        tool_config_key: string_field(input, "toolConfigKey"),
        command: string_field(input, "command"),
        status: string_field(input, "status"),
        worktree_path: string_field(input, "worktreePath"),
    }
}

fn string_field(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
