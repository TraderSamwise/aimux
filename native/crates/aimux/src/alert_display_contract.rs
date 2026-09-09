use serde_json::Value;

pub fn alert_display_contract(api: &str, input: &Value) -> Value {
    match api {
        "sessionAlertTitle" => Value::String(session_alert_title(
            string_field(input, "kind").unwrap_or(""),
            string_field(input, "sessionId"),
            string_field(input, "fallback"),
            input.get("context").unwrap_or(&Value::Null),
        )),
        "contextualizeAlertInput" => contextualize_alert_input(
            input.get("alert").unwrap_or(&Value::Null),
            input.get("context").unwrap_or(&Value::Null),
        ),
        _ => Value::Null,
    }
}

fn contextualize_alert_input(alert: &Value, context: &Value) -> Value {
    let kind = string_field(alert, "kind").unwrap_or("");
    let category = alert_category_label(kind);
    let reason = alert_reason_label(kind, string_field(alert, "dedupeKey"));
    let subject = session_alert_title(
        kind,
        string_field(alert, "sessionId"),
        string_field(alert, "title"),
        context,
    );
    let body_reason = if kind == "needs_input" {
        category
    } else {
        reason
    };
    let body_subject = if kind == "needs_input" {
        session_alert_subject(string_field(alert, "sessionId"), context).unwrap_or(subject.clone())
    } else {
        subject.clone()
    };
    let mut output = alert.as_object().cloned().unwrap_or_default();
    output.insert(
        "title".to_owned(),
        Value::String(alert_display_title(alert, context, category)),
    );
    output.insert(
        "message".to_owned(),
        Value::String(alert_message_body(
            body_reason,
            &body_subject,
            string_field(alert, "message").unwrap_or(""),
        )),
    );
    if let Some(project_name) =
        string_field(alert, "projectName").filter(|value| !value.trim().is_empty())
    {
        output.insert(
            "projectName".to_owned(),
            Value::String(project_name.trim().to_owned()),
        );
    }
    if let Some(project_root) =
        string_field(alert, "projectRoot").filter(|value| !value.trim().is_empty())
    {
        output.insert(
            "projectRoot".to_owned(),
            Value::String(project_root.trim().to_owned()),
        );
    }
    if let Some(worktree_path) =
        string_field(alert, "worktreePath").or_else(|| string_field(context, "worktreePath"))
    {
        output.insert(
            "worktreePath".to_owned(),
            Value::String(worktree_path.to_owned()),
        );
    }
    if let Some(worktree_name) = string_field(alert, "worktreeName")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .or_else(|| display_worktree_label(context))
    {
        output.insert("worktreeName".to_owned(), Value::String(worktree_name));
    }
    if let Some(branch) = string_field(alert, "branch").or_else(|| string_field(context, "branch"))
    {
        output.insert("branch".to_owned(), Value::String(branch.to_owned()));
    }
    output.insert(
        "categoryLabel".to_owned(),
        Value::String(category.to_owned()),
    );
    output.insert("reasonLabel".to_owned(), Value::String(reason.to_owned()));
    Value::Object(output)
}

fn compact_session_id(session_id: &str) -> String {
    let Some((head, tail)) = session_id.rsplit_once('-') else {
        return session_id.to_owned();
    };
    if tail.len() >= 4 && tail.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        head.to_owned()
    } else {
        session_id.to_owned()
    }
}

fn display_worktree_label(context: &Value) -> Option<String> {
    if let Some(worktree_name) =
        string_field(context, "worktreeName").filter(|value| !value.trim().is_empty())
    {
        return Some(worktree_name.trim().to_owned());
    }
    if let Some(branch) = string_field(context, "branch").filter(|value| !value.trim().is_empty()) {
        return Some(branch.trim().to_owned());
    }
    string_field(context, "worktreePath")
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(value)
                .to_owned()
        })
}

fn alert_category_label(kind: &str) -> &'static str {
    match kind {
        "needs_input" => "Needs input",
        "next_step" => "Next step",
        "task_done" => "Done",
        "task_failed" => "Error",
        "blocked" => "Blocked",
        "message_waiting" => "Message",
        "handoff_waiting" => "Handoff",
        "task_assigned" => "Task",
        "review_waiting" => "Review",
        _ => "Activity",
    }
}

fn alert_reason_label(kind: &str, dedupe_key: Option<&str>) -> &'static str {
    match kind {
        "needs_input" if dedupe_key.is_some_and(|key| key.starts_with("idle-needs-input:")) => {
            "Agent stopped after a turn"
        }
        "needs_input" => "Agent is waiting for input",
        "next_step" => "Agent stopped after a turn",
        "task_done" => "Agent or service finished",
        "task_failed" => "Agent or service errored",
        "blocked" => "Agent is blocked",
        "message_waiting" => "Message is waiting",
        "handoff_waiting" => "Handoff is waiting",
        "task_assigned" => "Task was assigned",
        "review_waiting" => "Review is waiting",
        _ => "Notification",
    }
}

fn alert_location_title(alert: &Value, context: &Value) -> String {
    let project = string_field(alert, "projectName").unwrap_or("aimux");
    let worktree = string_field(alert, "worktreeName")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .or_else(|| display_worktree_label(context));
    let branch = string_field(alert, "branch")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| string_field(context, "branch").filter(|value| !value.trim().is_empty()));
    let worktree_with_branch = match (worktree, branch) {
        (Some(worktree), Some(branch)) if branch != worktree => format!("{worktree} ({branch})"),
        (Some(worktree), _) => worktree,
        _ => String::new(),
    };
    if worktree_with_branch.is_empty() {
        project.to_owned()
    } else {
        format!("{project} / {worktree_with_branch}")
    }
}

fn alert_display_title(alert: &Value, context: &Value, category: &str) -> String {
    let location = alert_location_title(alert, context);
    if string_field(alert, "kind") == Some("needs_input") {
        location
    } else {
        format!("[{category}] {location}")
    }
}

fn alert_message_body(reason: &str, subject: &str, message: &str) -> String {
    let detail = message.trim();
    let subject = subject.trim();
    let parts = [reason, subject]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(": ");
    let comparable = detail.trim_end_matches(['.', '!', '?']);
    if detail.is_empty() || comparable == reason || detail == subject || detail == parts {
        if parts.is_empty() {
            detail.to_owned()
        } else {
            parts
        }
    } else {
        format!("{parts} - {detail}")
    }
}

fn session_alert_subject(session_id: Option<&str>, context: &Value) -> Option<String> {
    let session_id = session_id?;
    let label = string_field(context, "label")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| string_field(context, "command").filter(|value| !value.trim().is_empty()))
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| compact_session_id(session_id));
    let worktree = display_worktree_label(context);
    Some(match worktree {
        Some(worktree) => format!("{label} @ {worktree}"),
        None => label,
    })
}

fn session_alert_title(
    kind: &str,
    session_id: Option<&str>,
    fallback: Option<&str>,
    context: &Value,
) -> String {
    let title = fallback.map(str::trim).filter(|value| !value.is_empty());
    let Some(subject) = session_alert_subject(session_id, context) else {
        return title.unwrap_or("aimux").to_owned();
    };
    match kind {
        "needs_input" => format!("{subject} needs input"),
        "next_step" => format!("{subject} ready for next step"),
        "task_failed" => {
            if title.is_none()
                || session_id.is_some_and(|id| {
                    title == Some(format!("{id} errored").as_str())
                        || title == Some(format!("{id} failed").as_str())
                })
            {
                format!("{subject} errored")
            } else {
                title.unwrap_or_default().to_owned()
            }
        }
        "task_done" => {
            let compact = session_id.map(compact_session_id).unwrap_or_default();
            let generic = [
                string_field(context, "label").unwrap_or(""),
                string_field(context, "command").unwrap_or(""),
                compact.as_str(),
                "service",
                "shell",
            ];
            if title.is_none() || title.is_some_and(|title| generic.contains(&title)) {
                format!("{subject} finished")
            } else {
                title.unwrap_or_default().to_owned()
            }
        }
        _ => title
            .map(|title| {
                if title.contains(&subject) {
                    title.to_owned()
                } else if let Some(session_id) = session_id.filter(|id| title.contains(*id)) {
                    title.replace(session_id, &subject)
                } else {
                    format!("{subject}: {title}")
                }
            })
            .unwrap_or(subject),
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
