use aimux::visual_client_leases_contract::VisualClientLeaseRegistry;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn run_metadata_output_previews_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "mergeExposePreviewSnapshots" => {
            merge_expose_preview_snapshots(input.get("captureSnapshot"), input.get("tapSnapshot"))
                .unwrap_or(Value::Null)
        }
        "measureAgentOutputReadSequence" => measure_agent_output_read_sequence(input),
        "touchVisualClientLease" => touch_visual_client_lease_sequence(input),
        "defaultDiagnostics" => default_diagnostics(),
        api => panic!("unknown metadata output previews contract api: {api}"),
    }
}

fn merge_expose_preview_snapshots(
    capture_snapshot: Option<&Value>,
    tap_snapshot: Option<&Value>,
) -> Option<Value> {
    let capture_snapshot = capture_snapshot.filter(|value| !value.is_null());
    let tap_snapshot = tap_snapshot.filter(|value| !value.is_null());
    let Some(tap_snapshot) = tap_snapshot else {
        return capture_snapshot.cloned();
    };
    let Some(capture_snapshot) = capture_snapshot else {
        return Some(json!({
            "output": str_field(tap_snapshot, "output"),
            "capturedAt": str_field(tap_snapshot, "capturedAt"),
            "source": str_field(tap_snapshot, "source"),
            "windowId": str_field(tap_snapshot, "windowId"),
        }));
    };
    let tap_output = str_field(tap_snapshot, "output");
    let capture_output = str_field(capture_snapshot, "output");
    if tap_output.is_empty() {
        return Some(capture_snapshot.clone());
    }
    if capture_output.is_empty() || tap_output.starts_with(capture_output) {
        return Some(json!({
            "output": tap_output,
            "capturedAt": str_field(tap_snapshot, "capturedAt"),
            "source": str_field(tap_snapshot, "source"),
            "windowId": str_field(tap_snapshot, "windowId"),
        }));
    }
    if capture_output.ends_with(tap_output) {
        return Some(capture_snapshot.clone());
    }
    let separator = if capture_output.ends_with('\n') || tap_output.starts_with('\n') {
        ""
    } else {
        "\n"
    };
    Some(json!({
        "output": format!("{capture_output}{separator}{tap_output}"),
        "capturedAt": str_field(tap_snapshot, "capturedAt"),
        "source": str_field(tap_snapshot, "source"),
        "windowId": str_field(tap_snapshot, "windowId"),
    }))
}

fn measure_agent_output_read_sequence(input: &Value) -> Value {
    let mut calls = Vec::new();
    let mut seen_keys = BTreeSet::new();
    let mut cached_results = BTreeMap::<String, Value>::new();
    let mut measurements = Vec::new();
    for read in array_field(input, "reads") {
        let read_input = read.get("input").unwrap_or(&Value::Null);
        let key = coalesce_key(read_input);
        let coalesced = seen_keys.contains(&key);
        let result = if coalesced {
            cached_results
                .get(&key)
                .cloned()
                .unwrap_or_else(|| read_result(input, read_input))
        } else {
            let result = read_result(input, read_input);
            seen_keys.insert(key.clone());
            cached_results.insert(key, result.clone());
            calls.push(read_call(read_input));
            result
        };
        measurements.push(json!({
            "result": result,
            "coalesced": coalesced,
            "duration": "<duration-ms>",
        }));
    }
    json!({
        "measurements": measurements,
        "calls": calls,
    })
}

fn read_result(input: &Value, read_input: &Value) -> Value {
    let mut output = "";
    for read_output in array_field(input, "readOutputs") {
        let matcher = read_output.get("match").unwrap_or(&Value::Null);
        if optional_str(matcher, "mode") == optional_str(read_input, "mode")
            && optional_str(matcher, "purpose") == optional_str(read_input, "purpose")
        {
            output = str_field(read_output, "output");
            break;
        }
    }
    let mut result = Map::new();
    result.insert(
        "sessionId".to_owned(),
        Value::String(str_field(read_input, "sessionId").to_owned()),
    );
    result.insert("output".to_owned(), Value::String(output.to_owned()));
    if let Some(start_line) = read_input.get("startLine").and_then(Value::as_i64) {
        result.insert("startLine".to_owned(), Value::from(start_line));
    }
    Value::Object(result)
}

fn read_call(read_input: &Value) -> Value {
    let mut call = Map::new();
    for field in ["sessionId", "startLine", "mode", "purpose"] {
        if let Some(value) = read_input.get(field) {
            call.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(call)
}

fn coalesce_key(read_input: &Value) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        str_field(read_input, "sessionId"),
        read_input
            .get("startLine")
            .and_then(Value::as_i64)
            .map(|value| value.to_string())
            .unwrap_or_default(),
        read_input
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("full"),
        read_input
            .get("purpose")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn touch_visual_client_lease_sequence(input: &Value) -> Value {
    let mut registry = VisualClientLeaseRegistry::default();
    let mut touches = Vec::new();
    for touch in array_field(input, "touches") {
        let touch_input = touch.get("input").unwrap_or(&Value::Null);
        if !touch_input
            .get("requestedPreview")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !touch_input
                .get("requestedChatPreview")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            touches.push(json!({ "active": false }));
            continue;
        }
        let url = str_field(touch, "url");
        let kind = query_param(url, "clientKind").or_else(|| {
            touch_input
                .get("defaultKind")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let client_id = query_param(url, "clientId").unwrap_or_else(|| {
            format!(
                "{}:{}",
                aimux::visual_client_leases_contract::parse_visual_client_kind(kind.as_deref()),
                str_field(touch, "remoteAddress")
                    .strip_prefix("::ffff:")
                    .unwrap_or(str_field(touch, "remoteAddress"))
            )
        });
        let lease_input = json!({
            "id": client_id,
            "kind": kind,
            "surface": str_field(touch_input, "surface"),
            "requestedPreview": touch_input.get("requestedPreview").and_then(Value::as_bool).unwrap_or(false),
            "requestedChatPreview": touch_input.get("requestedChatPreview").and_then(Value::as_bool).unwrap_or(false),
            "ttlMs": query_param(url, "clientTtlMs"),
        });
        registry.touch(&lease_input, 1_800_000_000_000);
        touches.push(json!({ "active": registry.has_active_preview_clients(1_800_000_000_000) }));
    }
    json!({
        "touches": touches,
        "diagnostics": {
            "clients": normalize_lease_times(registry.snapshot(1_800_000_000_000)),
            "cache": null,
            "taps": null,
            "hotSnapshots": {
                "enabled": false,
                "scheduled": false,
                "refreshing": false,
                "workerRunning": false,
            },
        },
    })
}

fn default_diagnostics() -> Value {
    json!({
        "clients": {
            "active": [],
            "counts": {
                "tui": 0,
                "web": 0,
                "mobile": 0,
                "expose": 0,
                "api": 0,
            },
            "activePreviewClients": 0,
        },
        "hotSnapshots": {
            "enabled": false,
            "scheduled": false,
            "refreshing": false,
            "workerRunning": false,
        },
        "cache": null,
        "taps": null,
    })
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == name {
            return Some(value.to_owned());
        }
    }
    None
}

fn normalize_lease_times(value: Value) -> Value {
    fn visit(value: Value, seen: &mut BTreeMap<String, String>, next: &mut usize) -> Value {
        match value {
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|value| visit(value, seen, next))
                    .collect(),
            ),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        if matches!(key.as_str(), "startedAt" | "updatedAt" | "expiresAt")
                            && let Some(text) = value.as_str()
                        {
                            let token = seen.entry(text.to_owned()).or_insert_with(|| {
                                let token = format!("<ts:{next}>");
                                *next += 1;
                                token
                            });
                            return (key, Value::String(token.clone()));
                        }
                        (key, visit(value, seen, next))
                    })
                    .collect(),
            ),
            value => value,
        }
    }
    visit(value, &mut BTreeMap::new(), &mut 1)
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn optional_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
