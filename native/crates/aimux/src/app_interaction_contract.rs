use serde_json::{Value, json};

const CHAT_SCROLL_END_THRESHOLD: f64 = 20.0;

pub fn run_app_interaction_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "canResumeSession" => json!(can_resume_session(
            input.get("session").unwrap_or(&Value::Null)
        )),
        "CHAT_SCROLL_END_THRESHOLD" => json!(20),
        "createChatScrollPolicy" | "chatPolicyAfterNavigationFocus" => {
            json!({ "intent": "pinned" })
        }
        "chatDistanceFromEnd" => number_value(chat_distance_from_end(
            input.get("metrics").unwrap_or(&Value::Null),
        )),
        "isChatPinnedToEnd" => json!(is_chat_pinned_to_end(
            input.get("metrics").unwrap_or(&Value::Null),
            input
                .get("threshold")
                .and_then(Value::as_f64)
                .unwrap_or(CHAT_SCROLL_END_THRESHOLD)
        )),
        "chatPolicyAfterUserScroll" => json!({
            "intent": if is_chat_pinned_to_end(input.get("metrics").unwrap_or(&Value::Null), CHAT_SCROLL_END_THRESHOLD) {
                "pinned"
            } else {
                "reading"
            }
        }),
        "chatCommandForContentChange" => {
            scroll_command_for_policy(input.get("policy").unwrap_or(&Value::Null), "content")
        }
        "chatCommandForKeyboardChange" => {
            scroll_command_for_policy(input.get("policy").unwrap_or(&Value::Null), "keyboard")
        }
        "chatCommandForNavigationFocus" => scroll_to_end_command("navigation"),
        "chatCommandForInitialLayout" => scroll_to_end_command("initial"),
        _ => panic!("unknown app interaction contract api: {api}"),
    }
}

fn can_resume_session(session: &Value) -> bool {
    matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) && session.get("restoreState").and_then(Value::as_str) != Some("blocked")
}

fn chat_distance_from_end(metrics: &Value) -> f64 {
    let content_height = number_field(metrics, "contentHeight");
    let viewport_height = number_field(metrics, "viewportHeight");
    let offset_y = number_field(metrics, "offsetY");
    let scrollable_height = (content_height - viewport_height).max(0.0);
    (scrollable_height - offset_y.max(0.0)).max(0.0)
}

fn is_chat_pinned_to_end(metrics: &Value, threshold: f64) -> bool {
    chat_distance_from_end(metrics) <= threshold
}

fn scroll_command_for_policy(policy: &Value, reason: &str) -> Value {
    if policy.get("intent").and_then(Value::as_str) != Some("pinned") {
        return json!({ "kind": "none" });
    }
    scroll_to_end_command(reason)
}

fn scroll_to_end_command(reason: &str) -> Value {
    json!({ "animated": false, "kind": "scrollToEnd", "reason": reason })
}

fn number_field(value: &Value, field: &str) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(0.0)
}

fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}
