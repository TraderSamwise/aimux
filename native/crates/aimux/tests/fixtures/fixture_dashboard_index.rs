use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../../testdata/contracts/v1/dashboard/index.json");

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
fn dashboard_index_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("dashboard index fixture parses");
    assert_eq!(contract.cases.len(), 1);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_dashboard_index_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "dashboard index parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_dashboard_index_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "derivedStatusLabel" => Value::Array(
            input
                .get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|session| Value::String(derived_status_label(session)))
                .collect(),
        ),
        api => panic!("unknown dashboard index api: {api}"),
    }
}

fn derived_status_label(session: &Value) -> String {
    if let Some(pending_action) = session.get("pendingAction").and_then(Value::as_str) {
        return pending_action.to_owned();
    }
    if let Some(status_label) = session
        .get("semantic")
        .and_then(|semantic| semantic.get("presentation"))
        .and_then(|presentation| presentation.get("statusLabel"))
        .and_then(Value::as_str)
    {
        return status_label.to_owned();
    }
    match session
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
    {
        "waiting" => "thinking".to_owned(),
        status => status.to_owned(),
    }
}
