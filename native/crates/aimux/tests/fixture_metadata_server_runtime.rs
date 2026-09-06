#[path = "../src/metadata_server_runtime_contract.rs"]
mod metadata_server_runtime_contract;

use metadata_server_runtime_contract::run_metadata_server_runtime_contract_case;
use serde::Deserialize;
use serde_json::Value;

const AGENT_INPUT: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/agent-input.json");
const DASHBOARD_CLIENT_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/dashboard-client-state.json");
const EXPOSE_SOCKET: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/expose-socket.json");
const HTTP: &str = include_str!("../../../../testdata/contracts/v1/metadata-server/http.json");
const LIBRARY_DOCUMENTS: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/library-documents.json");
const LIFECYCLE_MUTATION_QUEUE: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/lifecycle-mutation-queue.json");

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
    input: Value,
    output: Value,
}

#[test]
fn metadata_agent_input_contract_matches_typescript() {
    assert_fixture("metadata agent input", AGENT_INPUT, 4);
}

#[test]
fn metadata_dashboard_client_state_contract_matches_typescript() {
    assert_fixture("metadata dashboard client state", DASHBOARD_CLIENT_STATE, 2);
}

#[test]
fn metadata_expose_socket_contract_matches_typescript() {
    assert_fixture("metadata expose socket", EXPOSE_SOCKET, 3);
}

#[test]
fn metadata_http_contract_matches_typescript() {
    assert_fixture("metadata http", HTTP, 5);
}

#[test]
fn metadata_library_documents_contract_matches_typescript() {
    assert_fixture("metadata library documents", LIBRARY_DOCUMENTS, 1);
}

#[test]
fn metadata_lifecycle_mutation_queue_contract_matches_typescript() {
    assert_fixture(
        "metadata lifecycle mutation queue",
        LIFECYCLE_MUTATION_QUEUE,
        7,
    );
}

fn assert_fixture(label: &str, fixture: &str, expected_count: usize) {
    let contract: Contract =
        serde_json::from_str(fixture).expect("metadata runtime fixture parses");
    assert_eq!(contract.cases.len(), expected_count);
    let mut failures = Vec::new();
    for case in contract.cases {
        let mut input = case.input;
        if input.get("api").is_none()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("api".to_owned(), Value::String(case.api));
        }
        let actual = run_metadata_server_runtime_contract_case(&input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        label,
        failures.join("\n\n")
    );
}
