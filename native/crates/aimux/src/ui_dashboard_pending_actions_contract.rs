use serde_json::{Map, Value};

pub fn run_dashboard_pending_actions_contract_case(input: &Value) -> Value {
    let values = input
        .get("values")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("dashboard pending-actions case missing values"));

    Value::Array(
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let mut output = Map::new();
                if !(index == 0 && value.is_null()) {
                    output.insert("value".to_owned(), value.clone());
                }
                output.insert(
                    "blocking".to_owned(),
                    Value::Bool(is_blocking_pending_dashboard_action_kind(value.as_str())),
                );
                Value::Object(output)
            })
            .collect(),
    )
}

pub fn is_blocking_pending_dashboard_action_kind(value: Option<&str>) -> bool {
    matches!(
        value,
        Some(
            "creating"
                | "forking"
                | "migrating"
                | "switching"
                | "starting"
                | "stopping"
                | "graveyarding"
                | "renaming"
                | "removing"
        )
    )
}
