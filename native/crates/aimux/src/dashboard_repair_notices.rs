use serde_json::{Map, Value, json};

pub fn run_record_dashboard_repair_notice_contract_case(input: &Value) -> Value {
    let host = input.get("host").cloned().unwrap_or_else(|| json!({}));
    let notice = input.get("notice").expect("repair notice");
    let opts = input.get("opts").unwrap_or(&Value::Null);
    let entry = repair_notice_entry(notice, 1_770_000_000_000);
    let previous = host
        .get("dashboardRepairNotices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let notices = previous
        .into_iter()
        .chain(std::iter::once(entry.clone()))
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();

    let mut host_object = Map::new();
    host_object.insert("dashboardRepairNotices".to_owned(), Value::Array(notices));

    let mut render_calls = Vec::new();
    let flash_enabled = opts.get("flash").and_then(Value::as_bool) != Some(false);
    let dashboard_mode = host
        .get("mode")
        .and_then(Value::as_str)
        .is_none_or(|mode| mode == "dashboard");
    if flash_enabled && dashboard_mode {
        host_object.insert("footerFlash".to_owned(), entry["message"].clone());
        host_object.insert(
            "footerFlashTicks".to_owned(),
            opts.get("ticks").cloned().unwrap_or_else(|| json!(4)),
        );
        render_calls.push(json!([]));
    }

    json!({
        "result": entry,
        "host": Value::Object(host_object),
        "calls": { "renderCurrentDashboardView": render_calls },
    })
}

fn repair_notice_entry(notice: &Value, at: u64) -> Value {
    let mut entry = Map::new();
    entry.insert("kind".to_owned(), notice["kind"].clone());
    entry.insert("phase".to_owned(), notice["phase"].clone());
    entry.insert("message".to_owned(), notice["message"].clone());
    entry.insert("at".to_owned(), json!(at));
    if let Some(error) = stringify_error(notice.get("error")) {
        entry.insert("error".to_owned(), json!(error));
    }
    Value::Object(entry)
}

fn stringify_error(error: Option<&Value>) -> Option<String> {
    match error {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(value) => Some(value.to_string()),
    }
}
