use serde_json::{Value, json};

use crate::tui_render::text::wrap_key_value;

pub fn render_session_details_contract_case(case: &Value) -> Value {
    let input = &case["input"];
    let width = input["width"].as_u64().unwrap_or(0) as usize;
    let height = input["height"].as_u64().unwrap_or(0) as usize;
    let session = input.get("session").filter(|value| !value.is_null());
    json!({ "lines": render_session_details(session, width, height) })
}

pub fn render_session_details(session: Option<&Value>, width: usize, height: usize) -> Vec<String> {
    let Some(session) = session else {
        return vec![String::new(); height];
    };
    let mut lines = Vec::new();
    lines.push("\x1b[1mDetails\x1b[0m".to_owned());
    lines.extend(wrap_key_value(
        "Agent",
        string_field(session, "label")
            .or_else(|| string_field(session, "command"))
            .unwrap_or_default()
            .as_str(),
        width,
    ));
    lines.extend(wrap_key_value(
        "Canonical",
        string_field(session, "toolConfigKey")
            .or_else(|| string_field(session, "command"))
            .unwrap_or_default()
            .as_str(),
        width,
    ));
    lines.extend(wrap_key_value(
        "Aimux ID",
        string_field(session, "id").unwrap_or_default().as_str(),
        width,
    ));
    if let Some(backend_session_id) = string_field(session, "backendSessionId") {
        lines.extend(wrap_key_value("Backend ID", &backend_session_id, width));
    }
    let command = string_field(session, "command").unwrap_or_default();
    let canonical = string_field(session, "toolConfigKey").unwrap_or_else(|| command.clone());
    if command != canonical {
        lines.extend(wrap_key_value("Command", &command, width));
    }
    if string_field(session, "worktreeName").is_some()
        || string_field(session, "worktreeBranch").is_some()
    {
        let mut worktree = string_field(session, "worktreeName").unwrap_or_else(|| "main".into());
        if let Some(branch) = string_field(session, "worktreeBranch") {
            worktree.push_str(" · ");
            worktree.push_str(&branch);
        }
        lines.extend(wrap_key_value("Worktree", &worktree, width));
    }
    if let Some(cwd) = string_field(session, "cwd") {
        lines.extend(wrap_key_value("CWD", &cwd, width));
    }
    if session.get("prNumber").is_some()
        || string_field(session, "prTitle").is_some()
        || string_field(session, "prUrl").is_some()
    {
        let mut header = format!(
            "PR{}",
            number_field(session, "prNumber")
                .map(|number| format!(" #{number}"))
                .unwrap_or_default()
        );
        if let Some(title) = string_field(session, "prTitle") {
            header.push_str(": ");
            header.push_str(&title);
        }
        lines.extend(wrap_key_value("PR", &header, width));
        if let Some(url) = string_field(session, "prUrl") {
            lines.extend(wrap_key_value("URL", &url, width));
        }
    }
    if string_field(session, "repoOwner").is_some() || string_field(session, "repoName").is_some() {
        lines.extend(wrap_key_value(
            "Repo",
            &format!(
                "{}/{}",
                string_field(session, "repoOwner").unwrap_or_else(|| "?".into()),
                string_field(session, "repoName").unwrap_or_else(|| "?".into())
            ),
            width,
        ));
    }
    if let Some(remote) = string_field(session, "repoRemote") {
        lines.extend(wrap_key_value("Remote", &remote, width));
    }
    if let Some(semantic) = session.get("semantic") {
        if let Some(status) = semantic
            .get("presentation")
            .and_then(|value| string_field(value, "statusLabel"))
        {
            lines.extend(wrap_key_value("State", &status, width));
        }
        if let Some(attention) = semantic
            .get("user")
            .and_then(|value| string_field(value, "attention"))
            .filter(|value| value != "none")
        {
            lines.extend(wrap_key_value("Attention", &attention, width));
        }
        if let Some(unread) = semantic
            .get("notifications")
            .and_then(|value| number_field(value, "unreadCount"))
            .filter(|value| *value > 0)
        {
            lines.extend(wrap_key_value("Unread", &unread.to_string(), width));
        }
        if let Some(latest) = semantic
            .get("notifications")
            .and_then(|value| string_field(value, "latestText"))
        {
            lines.extend(wrap_key_value("Latest", &latest, width));
        }
        if let Some(new_count) =
            number_field(semantic, "activityNewCount").filter(|value| *value > 0)
        {
            lines.extend(wrap_key_value(
                "New activity",
                &new_count.to_string(),
                width,
            ));
        }
    }
    if let Some(last) = session
        .get("lastEvent")
        .and_then(|value| string_field(value, "message"))
    {
        lines.extend(wrap_key_value("Last", &last, width));
    }
    if string_field(session, "threadName").is_some() || string_field(session, "threadId").is_some()
    {
        lines.extend(wrap_key_value(
            "Thread",
            string_field(session, "threadName")
                .or_else(|| string_field(session, "threadId"))
                .unwrap_or_default()
                .as_str(),
            width,
        ));
    }
    let thread_unread = number_field(session, "threadUnreadCount").unwrap_or(0);
    let waiting_on_me = number_field(session, "threadWaitingOnMeCount").unwrap_or(0);
    let waiting_on_them = number_field(session, "threadWaitingOnThemCount").unwrap_or(0);
    let pending = number_field(session, "threadPendingCount").unwrap_or(0);
    if thread_unread > 0 || waiting_on_me > 0 || waiting_on_them > 0 || pending > 0 {
        lines.extend(wrap_key_value(
            "Threads",
            &format!(
                "{thread_unread} unread · {waiting_on_me} on me · {waiting_on_them} on them · {pending} pending"
            ),
            width,
        ));
    }
    let services = session
        .get("services")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|service| {
            string_field(service, "url")
                .or_else(|| number_field(service, "port").map(|port| format!(":{port}")))
        })
        .collect::<Vec<_>>();
    if !services.is_empty() {
        lines.extend(wrap_key_value("Services", &services.join(", "), width));
    }
    lines.resize(height, String::new());
    lines.truncate(height);
    lines
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
