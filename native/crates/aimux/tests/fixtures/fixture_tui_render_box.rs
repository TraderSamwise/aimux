use aimux::tui_render::box_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../../testdata/contracts/v1/tui/render-box.json");

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
fn tui_render_box_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("tui render box fixture parses");
    assert_eq!(contract.cases.len(), 6);

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
    let spec = &input["spec"];
    let body = spec["body"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    Value::String(render_overlay_box(&OverlayBoxSpec {
        title: spec["title"].as_str().unwrap_or_default(),
        body: &body,
        cols: spec["cols"].as_u64().unwrap_or_default() as usize,
        rows: spec["rows"].as_u64().unwrap_or_default() as usize,
        variant: match spec["variant"].as_str() {
            Some("red") => OverlayVariant::Red,
            _ => OverlayVariant::Blue,
        },
        icon: spec.get("icon").and_then(Value::as_str),
    }))
}
