use aimux::tool_output_watchers::classify_tool_pane;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/tool-output-watchers.json");

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

fn run_tool_output_watchers_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "classifyToolPane" => serde_json::to_value(classify_tool_pane(
            str_field(input, "tool"),
            str_field(input, "text"),
        ))
        .expect("tool pane state serializes"),
        api => panic!("unknown tool output watchers contract api: {api}"),
    }
}

#[test]
fn tool_output_watchers_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tool output watchers fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_tool_output_watchers_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
