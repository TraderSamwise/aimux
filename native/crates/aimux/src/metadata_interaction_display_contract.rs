use serde_json::{Value, json};

pub fn run_metadata_interaction_display_contract_case(input: &Value) -> Value {
    let api = input
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("summarizeInteractionForDisplay");
    match api {
        "summarizeInteractionForDisplay" => summarize_interaction_for_display(input),
        api => panic!("unknown metadata interaction display contract api: {api}"),
    }
}

fn summarize_interaction_for_display(input: &Value) -> Value {
    let case_input = input.get("input").unwrap_or(input);
    if str_field(case_input, "type") == "question" {
        let questions = question_records(
            case_input.get("payload").unwrap_or(&Value::Null),
            case_input.get("summary").and_then(Value::as_str),
        );
        if !questions.is_empty() {
            let prompts = questions
                .iter()
                .filter_map(|question| trimmed_string(question.get("question")))
                .collect::<Vec<_>>();
            return json!({
                "title": "AskUserQuestion",
                "message": questions
                    .iter()
                    .enumerate()
                    .map(|(index, question)| format_question_text(question, index, questions.len()))
                    .collect::<Vec<_>>()
                    .join("\n\n"),
                "summary": prompts.join("; "),
            });
        }
    }

    let summary = trimmed_string(case_input.get("summary"));
    let readable_summary = match summary {
        Some(summary) if parse_object_string(&summary).is_none() => Some(summary),
        _ => None,
    };
    let mut output = json!({
        "title": format!(
            "{} needs a response",
            str_field(case_input, "sessionId")
        ),
        "message": readable_summary.clone().unwrap_or_else(|| {
            format!(
                "Agent is waiting on a {} response.",
                str_field(case_input, "type")
            )
        }),
    });
    if let Some(summary) = readable_summary {
        output["summary"] = Value::String(summary);
    }
    output
}

fn question_records(payload: &Value, summary: Option<&str>) -> Vec<Value> {
    let from_payload = question_records_from_source(payload)
        .into_iter()
        .filter(|question| trimmed_string(question.get("question")).is_some())
        .collect::<Vec<_>>();
    if !from_payload.is_empty() {
        return from_payload;
    }
    summary
        .and_then(parse_object_string)
        .map(|parsed| {
            question_records_from_source(&parsed)
                .into_iter()
                .filter(|question| trimmed_string(question.get("question")).is_some())
                .collect()
        })
        .unwrap_or_default()
}

fn question_records_from_source(source: &Value) -> Vec<Value> {
    if let Some(questions) = source.get("questions").and_then(Value::as_array) {
        return questions
            .iter()
            .filter(|question| question.is_object())
            .cloned()
            .collect();
    }
    if source.is_object() {
        return vec![source.clone()];
    }
    Vec::new()
}

fn format_question_text(question: &Value, index: usize, total: usize) -> String {
    let prompt = trimmed_string(question.get("question")).unwrap_or_default();
    let prefix = if total > 1 {
        format!("{}. ", index + 1)
    } else {
        String::new()
    };
    let labels = question_option_labels(question);
    if labels.is_empty() {
        format!("{prefix}{prompt}")
    } else {
        format!("{prefix}{prompt}\nOptions: {}", labels.join("; "))
    }
}

fn question_option_labels(question: &Value) -> Vec<String> {
    question
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    if let Some(label) = option.as_str() {
                        trimmed_text(label)
                    } else {
                        trimmed_string(option.get("label"))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_object_string(value: &str) -> Option<Value> {
    let text = value.trim();
    if !text.starts_with('{') {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(text).ok()?;
    parsed.is_object().then_some(parsed)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_text)
}

fn trimmed_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
