use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub fn interaction_requests_contract(case: &Value) -> Value {
    run_registry(&case["input"])
}

fn run_registry(input: &Value) -> Value {
    let mut registry = Registry::default();
    let mut aliases = BTreeMap::new();
    let mut outputs = Vec::new();
    for operation in input["ops"].as_array().into_iter().flatten() {
        match operation["op"].as_str().unwrap_or_default() {
            "register" => {
                let request = registry.register(&operation["input"]);
                if let Some(alias) = operation["saveAs"].as_str() {
                    aliases.insert(alias.to_owned(), string_field(&request, "id"));
                }
                let mut output = json!({ "op": "register", "request": request });
                if let Some(alias) = operation["sameAs"].as_str() {
                    output["sameAs"] = Value::Bool(
                        output["request"]["id"]
                            == Value::String(aliases.get(alias).cloned().unwrap_or_default()),
                    );
                }
                outputs.push(output);
            }
            "get" => {
                let id = resolve_id(operation, "id", &aliases);
                outputs.push(json!({ "op": "get", "request": registry.get(&id) }));
            }
            "listPending" => outputs.push(json!({
                "op": "listPending",
                "requests": registry.list_pending(operation.get("sessionId").and_then(Value::as_str)),
            })),
            "resolve" => {
                let id = resolve_id(operation, "id", &aliases);
                let request = registry.settle(&id, "resolved", operation.get("response").cloned());
                update_live_request_outputs(&mut outputs, &id, &registry);
                outputs.push(json!({ "op": "resolve", "request": request }));
            }
            "cancel" => {
                let id = resolve_id(operation, "id", &aliases);
                let request = registry.settle(&id, "cancelled", None);
                update_live_request_outputs(&mut outputs, &id, &registry);
                outputs.push(json!({ "op": "cancel", "request": request }));
            }
            "cancelSession" => {
                let ids = registry.cancel_session(string_field(operation, "sessionId"));
                for id in ids {
                    update_live_request_outputs(&mut outputs, &id, &registry);
                }
                outputs.push(json!({ "op": "cancelSession", "pending": registry.list_pending(None) }));
            }
            "waitResolved" => {
                let request = registry.register(&operation["input"]);
                if let Some(alias) = operation["saveAs"].as_str() {
                    aliases.insert(alias.to_owned(), string_field(&request, "id"));
                }
                let id = string_field(&request, "id");
                let request = registry.settle(&id, "resolved", operation.get("response").cloned());
                outputs.push(json!({ "op": "waitResolved", "request": request }));
            }
            "waitTimeout" => {
                let request = registry.register(&operation["input"]);
                if let Some(alias) = operation["saveAs"].as_str() {
                    aliases.insert(alias.to_owned(), string_field(&request, "id"));
                }
                let id = string_field(&request, "id");
                let request = registry.settle(&id, "timed_out", None);
                outputs.push(json!({ "op": "waitTimeout", "request": request }));
            }
            "sleep" => outputs.push(json!({
                "op": "sleep",
                "ms": operation["ms"],
            })),
            _ => {}
        }
    }
    Value::Array(outputs)
}

#[derive(Default)]
struct Registry {
    requests: BTreeMap<String, Value>,
    generated_count: usize,
}

impl Registry {
    fn register(&mut self, input: &Value) -> Value {
        let dedupe_key = input
            .get("dedupeKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let Some(dedupe_key) = &dedupe_key
            && let Some(existing) = self.find_pending_by_dedupe_key(dedupe_key)
        {
            return existing;
        }
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                self.generated_count += 1;
                format!("<id:{}>", self.generated_count)
            });
        let mut request = Map::new();
        request.insert("id".into(), Value::String(id.clone()));
        insert_optional_string(&mut request, "sessionId", input.get("sessionId"));
        insert_optional_string(&mut request, "projectRoot", input.get("projectRoot"));
        if let Some(dedupe_key) = dedupe_key {
            request.insert("dedupeKey".into(), Value::String(dedupe_key));
        }
        insert_optional_string(&mut request, "type", input.get("type"));
        request.insert(
            "payload".into(),
            input.get("payload").cloned().unwrap_or_else(|| json!({})),
        );
        request.insert("status".into(), Value::String("pending".into()));
        request.insert("createdAt".into(), Value::String("<ts:1>".into()));
        let request = Value::Object(request);
        self.requests.insert(id, request.clone());
        request
    }

    fn get(&self, id: &str) -> Value {
        self.requests.get(id).cloned().unwrap_or(Value::Null)
    }

    fn list_pending(&self, session_id: Option<&str>) -> Value {
        Value::Array(
            self.requests
                .values()
                .filter(|request| {
                    string_field(request, "status") == "pending"
                        && session_id.is_none_or(|session_id| {
                            string_field(request, "sessionId") == session_id
                        })
                })
                .cloned()
                .collect(),
        )
    }

    fn settle(&mut self, id: &str, status: &str, response: Option<Value>) -> Value {
        let Some(request) = self.requests.get_mut(id) else {
            return Value::Null;
        };
        if string_field(request, "status") != "pending" {
            return Value::Null;
        }
        let Some(request_object) = request.as_object_mut() else {
            return Value::Null;
        };
        request_object.insert("status".into(), Value::String(status.into()));
        request_object.insert("resolvedAt".into(), Value::String("<ts:1>".into()));
        if let Some(response) = response {
            request_object.insert("response".into(), response);
        }
        Value::Object(request_object.clone())
    }

    fn cancel_session(&mut self, session_id: String) -> Vec<String> {
        let ids = self
            .requests
            .iter()
            .filter_map(|(id, request)| {
                (string_field(request, "status") == "pending"
                    && string_field(request, "sessionId") == session_id)
                    .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in &ids {
            self.settle(id, "cancelled", None);
        }
        ids
    }

    fn find_pending_by_dedupe_key(&self, dedupe_key: &str) -> Option<Value> {
        self.requests
            .values()
            .find(|request| {
                string_field(request, "status") == "pending"
                    && string_field(request, "dedupeKey") == dedupe_key
            })
            .cloned()
    }
}

fn update_live_request_outputs(outputs: &mut [Value], id: &str, registry: &Registry) {
    let current = registry.get(id);
    for output in outputs {
        if output
            .get("request")
            .and_then(|request| request.get("id"))
            .and_then(Value::as_str)
            == Some(id)
        {
            output["request"] = current.clone();
        }
    }
}

fn resolve_id(operation: &Value, field: &str, aliases: &BTreeMap<String, String>) -> String {
    let raw = string_field(operation, field);
    aliases.get(&raw).cloned().unwrap_or(raw)
}

fn insert_optional_string(target: &mut Map<String, Value>, field: &str, value: Option<&Value>) {
    if let Some(value) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(field.into(), Value::String(value.to_owned()));
    }
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
