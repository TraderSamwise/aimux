use serde_json::Value;

pub fn external_notification_title(_event: &Value) -> String {
    "Aimux".to_owned()
}

pub fn external_notification_body(event: &Value) -> String {
    let kind = string_field(event, "kind");
    let mut detail = non_empty(string_field(event, "message"))
        .or_else(|| non_empty(string_field(event, "body")))
        .or_else(|| non_empty(string_field(event, "sessionId")))
        .or_else(|| non_empty(kind))
        .unwrap_or("Aimux")
        .to_owned();

    if kind == "needs_input" {
        if let Some((_, tail)) = detail.rsplit_once(" - ") {
            detail = tail.trim().to_owned();
        }
        detail = detail.replace("waiting for your input", "waiting for input");
        detail = detail.trim_end_matches(['.', '!', '?']).to_owned();
        if let Some(worktree) = worktree_display_name(event)
            && !detail.contains(&format!(" in {worktree}"))
        {
            detail = format!("{detail} in {worktree}");
        }
    } else if kind == "notification"
        && detail.starts_with("Notification:")
        && let Some((_, tail)) = detail.rsplit_once(" - ")
    {
        detail = tail.trim().to_owned();
    }
    detail
}

fn worktree_display_name(event: &Value) -> Option<&str> {
    non_empty(string_field(event, "worktreeName"))
        .or_else(|| non_empty(string_field(event, "branch")))
        .or_else(|| path_basename(string_field(event, "worktreePath")))
}

fn path_basename(path: &str) -> Option<&str> {
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    path.rsplit('/').next().and_then(non_empty)
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
