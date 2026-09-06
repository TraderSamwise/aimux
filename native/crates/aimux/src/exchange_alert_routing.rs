use std::collections::BTreeSet;

use serde_json::Value;

pub fn resolve_exchange_alert_routing(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "resolveExchangeMessageAlertRecipients" => {
            string_array(resolve_exchange_message_alert_recipients(&case["input"]))
        }
        "resolveExchangeTaskAssignmentRecipient" => optional_string(
            resolve_exchange_task_assignment_recipient(&case["input"])
                .as_deref(),
        ),
        "resolveExchangeTaskOutcomeRecipient" => {
            optional_string(resolve_exchange_task_outcome_recipient(&case["input"]).as_deref())
        }
        "resolveExchangeReviewOutcomeRecipient" => optional_string(
            resolve_exchange_review_outcome_recipient(&case["input"])
                .as_deref(),
        ),
        _ => Value::Null,
    }
}

pub fn resolve_exchange_message_alert_recipients(input: &Value) -> Vec<String> {
    let explicit = unique_trimmed_array(input.get("explicitRecipients"));
    if !explicit.is_empty() {
        return recipients_excluding_sender(explicit, string_field(input, "from").as_deref());
    }

    let delivered_to = unique_trimmed_array(input.get("message").and_then(|message| message.get("deliveredTo")));
    if !delivered_to.is_empty() {
        return recipients_excluding_sender(delivered_to, string_field(input, "from").as_deref());
    }

    let waiting_on = unique_trimmed_array(input.get("thread").and_then(|thread| thread.get("waitingOn")));
    if !waiting_on.is_empty() {
        return recipients_excluding_sender(waiting_on, string_field(input, "from").as_deref());
    }

    let message_recipients = unique_trimmed_array(input.get("message").and_then(|message| message.get("to")));
    if !message_recipients.is_empty() {
        return recipients_excluding_sender(message_recipients, string_field(input, "from").as_deref());
    }

    recipients_excluding_sender(
        unique_trimmed_array(input.get("fallbackRecipients")),
        string_field(input, "from").as_deref(),
    )
}

pub fn resolve_exchange_task_assignment_recipient(task: &Value) -> Option<String> {
    unique_trimmed([string_field(task, "assignedTo")].into_iter()).into_iter().next()
}

pub fn resolve_exchange_task_outcome_recipient(input: &Value) -> Option<String> {
    let waiting_on = unique_trimmed_array(input.get("thread").and_then(|thread| thread.get("waitingOn")));
    if !waiting_on.is_empty() {
        return recipients_excluding_sender(waiting_on, string_field(input, "from").as_deref())
            .into_iter()
            .next();
    }
    recipients_excluding_sender(
        unique_trimmed([input.get("task").and_then(|task| string_field(task, "assignedBy"))].into_iter()),
        string_field(input, "from").as_deref(),
    )
    .into_iter()
    .next()
}

pub fn resolve_exchange_review_outcome_recipient(task: &Value) -> Option<String> {
    unique_trimmed([string_field(task, "assignedBy")].into_iter()).into_iter().next()
}

fn recipients_excluding_sender(values: Vec<String>, from: Option<&str>) -> Vec<String> {
    let sender = from.map(str::trim).filter(|value| !value.is_empty());
    values
        .into_iter()
        .filter(|recipient| Some(recipient.as_str()) != sender)
        .collect()
}

fn unique_trimmed_array(value: Option<&Value>) -> Vec<String> {
    unique_trimmed(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| item.as_str().map(str::to_owned)),
    )
}

fn unique_trimmed(values: impl Iterator<Item = Option<String>>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for value in values {
        let Some(value) = value.map(|value| value.trim().to_owned()) else {
            continue;
        };
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        unique.push(value);
    }
    unique
}

fn string_array(values: Vec<String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn optional_string(value: Option<&str>) -> Value {
    value.map(|value| Value::String(value.into())).unwrap_or(Value::Null)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
