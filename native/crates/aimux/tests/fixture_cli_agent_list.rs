use aimux::cli_agent_list_contract::{
    render_cli_agents_by_worktree_lines, render_cli_agents_flat_lines,
};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/agent-list.json");

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
fn cli_agent_list_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli agent-list fixture parses");
    assert_eq!(contract.cases.len(), 4);

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
    let agents = input
        .get("agents")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let project_root = input.get("projectRoot").and_then(Value::as_str);
    match input["api"].as_str().unwrap_or_default() {
        "renderAgentsFlatLines" => json!(render_cli_agents_flat_lines(agents, project_root)),
        "renderAgentsByWorktreeLines" => {
            json!(render_cli_agents_by_worktree_lines(agents, project_root))
        }
        api => panic!("unknown cli agent-list api: {api}"),
    }
}
