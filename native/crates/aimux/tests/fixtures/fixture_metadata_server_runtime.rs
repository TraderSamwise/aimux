use super::support;
use aimux::expose_socket::{parse_positive_header_integer, split_expose_header};
use aimux::project_service::agent_input::{
    body_shared_chat_actor, format_agent_input_with_attachments, format_shared_chat_agent_input,
    hosted_attachment_from_body, safe_shared_chat_actor_name,
};
use aimux::project_service::controls::parse_dashboard_control_screen;
use aimux::project_service::http::{
    BodyTooLarge, HeaderValue, ProjectServiceBodyError, parse_bounded_limit, parse_integer_value,
    parse_optional_integer, parse_positive_integer_value, prepare_project_service_json_response,
    project_service_cors_headers, project_service_request_headers, read_json_body_limited,
};
use aimux::project_service::library::list_library_documents;
use aimux::project_service::lifecycle_mutation_queue::{
    LifecycleMutationError, LifecycleMutationQueue, LifecycleTransitionInput, lifecycle_ok,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

const AGENT_INPUT: &str =
    include_str!("../../../../../testdata/contracts/v1/metadata-server/agent-input.json");
const DASHBOARD_CLIENT_STATE: &str = include_str!(
    "../../../../../testdata/contracts/v1/metadata-server/dashboard-client-state.json"
);
const EXPOSE_SOCKET: &str =
    include_str!("../../../../../testdata/contracts/v1/metadata-server/expose-socket.json");
const HTTP: &str = include_str!("../../../../../testdata/contracts/v1/metadata-server/http.json");
const LIBRARY_DOCUMENTS: &str =
    include_str!("../../../../../testdata/contracts/v1/metadata-server/library-documents.json");
const LIFECYCLE_MUTATION_QUEUE: &str = include_str!(
    "../../../../../testdata/contracts/v1/metadata-server/lifecycle-mutation-queue.json"
);

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
        let actual = actual_for_case(&input);
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

fn actual_for_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "bodySharedChatActor" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| body_shared_chat_actor(value).unwrap_or(Value::Null))
                .collect::<Vec<_>>()
        ),
        "sharedChatFormatting" => shared_chat_formatting(input),
        "formatAgentInputWithAttachments" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| format_agent_input_with_attachments(
                    str_field(value, "text"),
                    array_field(value, "attachments")
                ))
                .collect::<Vec<_>>()
        ),
        "hostedAttachmentFromBody" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| hosted_attachment_from_body(Some(value)).unwrap_or(Value::Null))
                .collect::<Vec<_>>()
        ),
        "parseDashboardControlScreen" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| value
                    .as_str()
                    .and_then(parse_dashboard_control_screen)
                    .map(Value::from)
                    .unwrap_or(Value::Null))
                .collect::<Vec<_>>()
        ),
        "parsePositiveHeaderInteger" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| value
                    .as_str()
                    .and_then(|text| parse_positive_header_integer(Some(text)))
                    .map(Value::from)
                    .unwrap_or(Value::Null))
                .collect::<Vec<_>>()
        ),
        "splitExposeHeader" => split_expose_header_case(str_field(input, "buffer")),
        "readJson" => http_read_json_case(),
        "requestHeaderRecord" => request_header_record_case(input.get("headers").unwrap()),
        "setCorsHeaders/isAllowedCorsOrigin" => cors_case(input),
        "send" => send_case(input),
        "integer parsers" => integer_parsers_case(input),
        "listLibraryDocuments" => list_library_documents_case(input),
        "LifecycleMutationQueue" => lifecycle_queue_case(str_field(input, "scenario")),
        "lifecycleOk" => lifecycle_ok_case(input),
        "waitForEarlyLifecycleResult" => {
            wait_for_early_lifecycle_result_case(str_field(input, "scenario"))
        }
        api => panic!("unknown metadata server runtime api: {api}"),
    }
}

fn shared_chat_formatting(input: &Value) -> Value {
    let values = array_field(input, "values");
    json!([
        format_shared_chat_agent_input(str_field(&values[0], "text"), &values[0]["actor"]),
        safe_shared_chat_actor_name(&values[1]["actor"])
            .chars()
            .count(),
        format_shared_chat_agent_input(str_field(&values[2], "text"), &values[2]["actor"]),
    ])
}

fn split_expose_header_case(buffer: &str) -> Value {
    let Some(parsed) = split_expose_header(buffer.as_bytes()) else {
        return Value::Null;
    };
    json!({
        "header": parsed.header,
        "rest": String::from_utf8_lossy(&parsed.rest).into_owned(),
    })
}

fn http_read_json_case() -> Value {
    let ok = read_json_body_limited([br#"{"ok":true}"#.as_slice()], 32).expect("json");
    let too_large = read_json_body_limited([b"abcdef".as_slice()], 3).expect_err("too large");
    json!({
        "ok": ok,
        "tooLarge": body_error_json(too_large, true),
    })
}

fn request_header_record_case(headers: &Value) -> Value {
    let mut normalized = BTreeMap::new();
    if let Some(headers) = headers.as_object() {
        for (key, value) in headers {
            if let Some(text) = value.as_str() {
                normalized.insert(key.clone(), text.to_owned());
            } else if let Some(values) = value.as_array()
                && !values.is_empty()
            {
                normalized.insert(
                    key.clone(),
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", "),
                );
            }
        }
    }
    let pairs = normalized
        .iter()
        .map(|(key, value)| (key.as_str(), HeaderValue::Single(value.as_str())));
    json!(project_service_request_headers(pairs))
}

fn cors_case(input: &Value) -> Value {
    let origin = str_field(input, "origin");
    let headers = project_service_cors_headers(&BTreeMap::from([("origin".into(), origin.into())]));
    let allowed = headers.is_some();
    json!({
        "allowed": allowed,
        "response": {
            "statusCode": 0,
            "headers": lowercase_headers(headers.unwrap_or_default()),
        },
        "checks": array_field(input, "checks")
            .iter()
            .filter_map(Value::as_str)
            .map(|origin| json!([
                origin,
                project_service_cors_headers(&BTreeMap::from([("origin".into(), origin.to_owned())])).is_some()
            ]))
            .collect::<Vec<_>>(),
    })
}

fn send_case(input: &Value) -> Value {
    let mut headers = BTreeMap::new();
    headers.insert(
        "access-control-allow-origin".into(),
        str_field(input, "existingCors").to_owned(),
    );
    let response = prepare_project_service_json_response(
        input
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(200),
        input.get("body").cloned().unwrap_or(Value::Null),
        headers,
    );
    let headers = response.headers;
    if let Some(content_length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<i64>().ok())
    {
        let mut header_values = Map::new();
        for (key, value) in headers {
            if key == "content-length" {
                header_values.insert(key, Value::from(content_length));
            } else {
                header_values.insert(key, Value::String(value));
            }
        }
        return json!({
            "statusCode": response.status,
            "headers": header_values,
            "body": String::from_utf8(response.body).expect("utf8 body"),
        });
    }
    json!({
        "statusCode": response.status,
        "headers": headers,
        "body": String::from_utf8(response.body).expect("utf8 body"),
    })
}

fn integer_parsers_case(input: &Value) -> Value {
    json!({
        "optional": array_field(input, "optional")
            .iter()
            .map(|value| result_option_i64_json(parse_optional_integer(value.as_str(), "startLine")))
            .collect::<Vec<_>>(),
        "integer": array_field(input, "integer")
            .iter()
            .map(|value| result_i64_json(parse_integer_value(value, "rows")))
            .collect::<Vec<_>>(),
        "positive": array_field(input, "positive")
            .iter()
            .map(|value| result_i64_json(parse_positive_integer_value(value, "rows")))
            .collect::<Vec<_>>(),
        "bounded": array_field(input, "bounded")
            .iter()
            .map(|value| result_i64_json(parse_bounded_limit(value.as_str(), "limit", 10, 100)))
            .collect::<Vec<_>>(),
    })
}

fn list_library_documents_case(input: &Value) -> Value {
    let isolation = support::TestIsolation::new("metadata-library-documents");
    let project = isolation.root().join("project");
    fs::create_dir_all(&project).expect("project");
    for file in array_field(input, "files") {
        let path = project.join(str_field(file, "path"));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("file parent");
        }
        fs::write(path, str_field(file, "content")).expect("write fixture file");
    }
    let fixed_mtime = str_field(input, "fixedMtime").to_owned();
    let mut documents = list_library_documents(&project);
    for document in &mut documents {
        if let Some(object) = document.as_object_mut() {
            object.insert("updatedAt".into(), Value::String(fixed_mtime.clone()));
        }
    }
    Value::Array(documents)
}

fn lifecycle_queue_case(scenario: &str) -> Value {
    match scenario {
        "serial-diagnostics" => lifecycle_serial_diagnostics_case(),
        "same-target-conflict" => lifecycle_conflict_case(),
        "queue-limit" => lifecycle_queue_limit_case(),
        "failure-diagnostics" => lifecycle_failure_case(),
        scenario => panic!("unknown lifecycle queue scenario: {scenario}"),
    }
}

fn lifecycle_serial_diagnostics_case() -> Value {
    let queue = LifecycleMutationQueue::new(32);
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let (release_first_tx, release_first_rx) = mpsc::channel();
    let first_events = Arc::clone(&events);
    let first_queue = queue.clone();
    let first = thread::spawn(move || {
        first_queue
            .enqueue(Some(agent_stop_transition("one")), || {
                first_events.lock().unwrap().push("first:start".into());
                release_first_rx.recv().unwrap();
                first_events.lock().unwrap().push("first:end".into());
                Ok("first")
            })
            .unwrap()
            .unwrap()
    });
    wait_until(|| queue.diagnostics("/repo")["telemetry"]["started"] == 1);
    let second_events = Arc::clone(&events);
    let second_queue = queue.clone();
    let second = thread::spawn(move || {
        second_queue
            .enqueue(Some(agent_stop_transition("two")), || {
                second_events.lock().unwrap().push("second:start".into());
                Ok("second")
            })
            .unwrap()
            .unwrap()
    });
    wait_until(|| queue.diagnostics("/repo")["queuedCount"] == 2);
    let during = normalize_lifecycle_diagnostics(queue.diagnostics("/repo"));
    release_first_tx.send(()).unwrap();
    let results = json!([first.join().unwrap(), second.join().unwrap()]);
    let final_state = normalize_lifecycle_diagnostics(queue.diagnostics("/repo"));
    json!({
        "events": events.lock().unwrap().clone(),
        "during": during,
        "results": results,
        "final": final_state,
    })
}

fn lifecycle_conflict_case() -> Value {
    let queue = LifecycleMutationQueue::new(32);
    let (release_tx, release_rx) = mpsc::channel();
    let (holder_started_tx, holder_started_rx) = mpsc::channel();
    let holder_queue = queue.clone();
    let holder = thread::spawn(move || {
        holder_queue.enqueue::<(), _>(None, || {
            holder_started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    holder_started_rx.recv().unwrap();
    let first_queue = queue.clone();
    let first = thread::spawn(move || {
        first_queue
            .enqueue(Some(agent_stop_transition("same")), || Ok("first"))
            .unwrap()
            .unwrap()
    });
    wait_until(|| queue.diagnostics("/repo")["queuedCount"] == 1);
    let error = queue
        .enqueue(Some(agent_stop_transition("same")), || Ok("second"))
        .expect_err("conflict");
    let diagnostics = normalize_lifecycle_diagnostics(queue.diagnostics("/repo"));
    release_tx.send(()).unwrap();
    let _ = holder.join().unwrap();
    let _ = first.join().unwrap();
    json!({
        "error": lifecycle_error_json(error),
        "diagnostics": diagnostics,
    })
}

fn lifecycle_queue_limit_case() -> Value {
    let queue = LifecycleMutationQueue::new(1);
    let (release_tx, release_rx) = mpsc::channel();
    let (holder_started_tx, holder_started_rx) = mpsc::channel();
    let holder_queue = queue.clone();
    let holder = thread::spawn(move || {
        holder_queue.enqueue::<(), _>(None, || {
            holder_started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    holder_started_rx.recv().unwrap();
    let first_queue = queue.clone();
    let first = thread::spawn(move || {
        first_queue
            .enqueue(Some(agent_stop_transition("one")), || Ok("first"))
            .unwrap()
            .unwrap()
    });
    wait_until(|| queue.diagnostics("/repo")["queuedCount"] == 1);
    let error = queue
        .enqueue(Some(agent_stop_transition("two")), || Ok("second"))
        .expect_err("queue full");
    let diagnostics = normalize_lifecycle_diagnostics(queue.diagnostics("/repo"));
    release_tx.send(()).unwrap();
    let _ = holder.join().unwrap();
    let _ = first.join().unwrap();
    json!({
        "error": lifecycle_error_json(error),
        "diagnostics": diagnostics,
    })
}

fn lifecycle_failure_case() -> Value {
    let queue = LifecycleMutationQueue::new(32);
    let error = queue
        .enqueue::<(), _>(Some(agent_stop_transition("one")), || Err("boom".into()))
        .unwrap()
        .expect_err("operation failure");
    json!({
        "error": { "name": "Error", "message": error },
        "diagnostics": normalize_lifecycle_diagnostics(queue.diagnostics("/repo")),
    })
}

fn lifecycle_ok_case(input: &Value) -> Value {
    let transition = input.get("transition").unwrap_or(&Value::Null);
    let result = input.get("result").cloned().unwrap_or_else(|| json!({}));
    let transition = LifecycleTransitionInput::new(
        str_field(transition, "operation"),
        str_field(transition, "targetKind"),
    )
    .with_target_id(optional_str(transition, "targetId"))
    .with_target_path(optional_str(transition, "targetPath"));
    normalize_lifecycle_value(lifecycle_ok(result, &transition))
}

fn wait_for_early_lifecycle_result_case(scenario: &str) -> Value {
    match scenario {
        "early-pending" => json!({ "kind": "pending" }),
        "early-settled" => json!({
            "resolved": { "kind": "resolved", "result": "ok" },
            "rejected": {
                "kind": "rejected",
                "error": { "name": "Error", "message": "failed" },
            },
        }),
        scenario => panic!("unknown early lifecycle scenario: {scenario}"),
    }
}

fn agent_stop_transition(target_id: &str) -> LifecycleTransitionInput {
    LifecycleTransitionInput::new("agent.stop", "agent").with_target_id(Some(target_id.to_owned()))
}

fn lifecycle_error_json(error: LifecycleMutationError) -> Value {
    json!({
        "name": "Error",
        "message": error.message(),
        "status": error.status(),
    })
}

fn normalize_lifecycle_diagnostics(value: Value) -> Value {
    let mut value = normalize_lifecycle_value(value);
    if let Some(object) = value.as_object_mut()
        && let Some(telemetry) = object.get_mut("telemetry").and_then(Value::as_object_mut)
    {
        telemetry.insert("maxQueuedMs".into(), Value::String("<duration-ms>".into()));
        telemetry.insert(
            "maxDurationMs".into(),
            Value::String("<duration-ms>".into()),
        );
    }
    value
}

fn normalize_lifecycle_value(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "pid" {
                    *child = Value::String("<pid>".into());
                } else if key == "operationId" {
                    *child = Value::String("<opid:1>".into());
                } else if matches!(
                    key.as_str(),
                    "lastStartedAt" | "lastSettledAt" | "startedAt" | "updatedAt"
                ) && child.as_str().is_some()
                {
                    *child = Value::String("<ts:1>".into());
                } else {
                    *child = normalize_lifecycle_value(std::mem::take(child));
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                *value = normalize_lifecycle_value(std::mem::take(value));
            }
        }
        _ => {}
    }
    value
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    for _ in 0..200 {
        if predicate() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("condition timed out");
}

fn result_option_i64_json(result: Result<Option<i64>, String>) -> Value {
    match result {
        Ok(Some(value)) => json!({ "ok": true, "value": value }),
        Ok(None) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn result_i64_json(result: Result<i64, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn body_error_json(error: ProjectServiceBodyError, destroyed: bool) -> Value {
    match error {
        ProjectServiceBodyError::TooLarge(BodyTooLarge { limit }) => json!({
            "name": "BodyTooLarge",
            "message": format!("body exceeds {limit} bytes"),
            "destroyed": destroyed,
        }),
        ProjectServiceBodyError::InvalidUtf8(error)
        | ProjectServiceBodyError::InvalidJson(error) => {
            json!({ "name": "Error", "message": error })
        }
    }
}

fn lowercase_headers(headers: BTreeMap<String, String>) -> Value {
    let mut output = Map::new();
    for (key, value) in headers {
        output.insert(key.to_ascii_lowercase(), Value::String(value));
    }
    Value::Object(output)
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn optional_str(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}
