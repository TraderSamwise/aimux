use aimux::cli_attachment_contract::{mime_type_for_published_attachment, relay_http_url};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/attachment.json");

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
fn cli_attachment_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli attachment fixture parses");
    assert_eq!(contract.cases.len(), 5);

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
        "mimeTypeForPublishedAttachment" => json!(mime_type_for_published_attachment(
            input["filePath"].as_str().expect("file path")
        )),
        "relayHttpUrl" => json!(relay_http_url(
            input["relayUrl"].as_str().expect("relay URL")
        )),
        api => panic!("unknown cli attachment api: {api}"),
    }
}
