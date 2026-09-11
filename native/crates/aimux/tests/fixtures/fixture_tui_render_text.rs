use aimux::tui_render::text::{compose_two_pane, strip_ansi};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../../testdata/contracts/v1/tui/render-text.json");

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
fn tui_render_text_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("tui render text fixture parses");
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
    match input["api"].as_str().unwrap_or_default() {
        "composeTwoPane" => json!(compose_two_pane(
            string_array(&input["left"]).as_slice(),
            string_array(&input["right"]).as_slice(),
            input["cols"].as_u64().unwrap_or_default() as usize,
            input.get("separator").and_then(Value::as_str),
        )),
        "stripAnsi" => json!(strip_ansi(input["text"].as_str().expect("text"))),
        api => panic!("unknown tui render text api: {api}"),
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}
