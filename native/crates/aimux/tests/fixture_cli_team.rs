use aimux::core_text::{render_core_team_init_lines, render_core_team_show_lines};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/team.json");

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
fn cli_team_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli team fixture parses");
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
        "renderTeamShowLines" => json!(render_core_team_show_lines(&team_payload(input))),
        "renderTeamInitLines" => json!(render_core_team_init_lines(&team_payload(input))),
        "buildTeamCliPayload" => team_payload(input),
        api => panic!("unknown cli team api: {api}"),
    }
}

fn team_payload(input: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    if let Some(project_root) = input.get("projectRoot").and_then(Value::as_str) {
        payload.insert("projectRoot".into(), Value::String(project_root.to_owned()));
    }
    payload.insert("config".into(), input["config"].clone());
    if let Some(role) = input.get("role").and_then(Value::as_str) {
        payload.insert("role".into(), Value::String(role.to_owned()));
    }
    Value::Object(payload)
}
