use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn run_app_global_inbox_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "globalInboxRequestKey" => json!(global_inbox_request_keys(input)),
        "mergeGlobalRowsWithPrevious" => json!(merge_global_rows_with_previous(input)),
        api => panic!("unknown app global inbox contract api: {api}"),
    }
}

fn global_inbox_request_keys(input: &Value) -> Vec<String> {
    let mut sequence = 0;
    array_field(input, "calls")
        .iter()
        .map(|call| {
            let args = call.as_array().map(Vec::as_slice).unwrap_or(&[]);
            let kind = args.first().and_then(Value::as_str).unwrap_or_default();
            let source_key = args.get(1).and_then(Value::as_str).unwrap_or_default();
            let explicit_sequence = args.get(2).and_then(Value::as_i64);
            let request_sequence = match explicit_sequence {
                Some(value) => value,
                None => {
                    sequence += 1;
                    sequence
                }
            };
            format!("{kind}\0{source_key}\0<scope:1>\0{request_sequence}")
        })
        .collect()
}

fn merge_global_rows_with_previous(input: &Value) -> Vec<Value> {
    let failed_project_paths = array_field(input, "failedProjectPaths")
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    if failed_project_paths.is_empty() {
        return array_field(input, "nextRows").to_vec();
    }
    let mut rows = array_field(input, "nextRows").to_vec();
    rows.extend(
        array_field(input, "previousRows")
            .iter()
            .filter(|row| failed_project_paths.contains(str_field(row, "projectPath")))
            .cloned(),
    );
    rows
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
