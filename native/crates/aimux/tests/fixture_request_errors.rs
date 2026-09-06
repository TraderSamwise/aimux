use aimux::request_errors_contract::{
    RequestErrorValue, is_transient_request_error, request_error_message,
};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/request-errors/classification.json");

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
    api: String,
    input: Input,
    output: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    value: RequestErrorValue,
}

#[test]
fn request_errors_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("request-errors fixture parses");
    assert_eq!(contract.cases.len(), 18);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = match case.api.as_str() {
            "getErrorMessage" => Value::String(request_error_message(&case.input.value)),
            "isTransientRequestError" => Value::Bool(is_transient_request_error(&case.input.value)),
            api => panic!("unknown request-errors api: {api}"),
        };
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
