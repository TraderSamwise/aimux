use serde_json::{Map, Value};

pub(super) fn find_by_id(value: &Value, key: &str, id: &str) -> Option<Value> {
    array_field(value, key)
        .into_iter()
        .find(|item| string_field(item, "id") == id)
}

pub(super) fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn string_array_field(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn string_field_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

pub(super) fn object_insert_mut(value: &mut Value, key: &str, inserted: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Some(map) = value.as_object_mut() {
        if inserted.is_null() {
            map.remove(key);
        } else {
            map.insert(key.into(), inserted);
        }
    }
}

pub(super) fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub(super) fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_owned)
}

pub(super) fn trimmed_owned(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}
