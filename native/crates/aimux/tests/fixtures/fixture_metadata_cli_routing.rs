use aimux::daemon::text::metadata::{MetadataCliResult, parse_runtime_metadata_cli_args};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/metadata-cli/routing.json");

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
fn metadata_cli_routing_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("metadata cli routing fixture parses");
    assert_eq!(contract.cases.len(), 6);
    let mut failures = Vec::new();
    for case in contract.cases {
        let args = case
            .input
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{} has args array", case.id))
            .iter()
            .map(|value| value.as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        let actual = metadata_cli_result_to_json(parse_runtime_metadata_cli_args(&args));
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "metadata cli routing parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn metadata_cli_result_to_json(result: MetadataCliResult) -> Value {
    match result {
        MetadataCliResult::Endpoint => json!({ "ok": true, "command": "endpoint" }),
        MetadataCliResult::Post { route_path, body } => {
            json!({ "ok": true, "command": "post", "routePath": route_path, "body": body })
        }
        MetadataCliResult::Error(error) => json!({ "ok": false, "error": error }),
    }
}
