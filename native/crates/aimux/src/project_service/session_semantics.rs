use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Default)]
pub struct SessionSemanticsInput {
    pub status: String,
    pub pending_action: Option<String>,
    pub activity: Option<String>,
    pub attention: Option<String>,
    pub unseen_count: i64,
    pub notification_unread_count: i64,
    pub latest_notification: Option<Value>,
    pub latest_notification_text: Option<String>,
    pub thread_unread_count: i64,
    pub thread_pending_count: i64,
    pub thread_waiting_on_me_count: i64,
    pub thread_waiting_on_them_count: i64,
    pub workflow_on_me_count: i64,
    pub workflow_blocked_count: i64,
    pub workflow_family_count: i64,
    pub has_active_task: bool,
}

pub fn derive_session_semantics(input: SessionSemanticsInput) -> Value {
    let attention = input.attention.as_deref().unwrap_or("normal").to_owned();
    let activity_new_count = positive(input.unseen_count);
    let thread_unread_count = positive(input.thread_unread_count);
    let pending_delivery_count = positive(input.thread_pending_count);
    let waiting_on_me_count =
        positive(input.thread_waiting_on_me_count).max(positive(input.workflow_on_me_count));
    let waiting_on_them_count = positive(input.thread_waiting_on_them_count);
    let blocked_count = positive(input.workflow_blocked_count);
    let family_count = positive(input.workflow_family_count);
    let lifecycle = runtime_lifecycle(&input);
    let is_alive = !matches!(lifecycle, "offline" | "stopping" | "graveyarding");
    let can_receive_input = is_alive
        && !matches!(lifecycle, "creating" | "starting" | "error")
        && !matches!(attention.as_str(), "error" | "blocked");
    let runtime = json!({
        "lifecycle": lifecycle,
        "isAlive": is_alive,
        "canEnter": !matches!(lifecycle, "creating" | "stopping" | "graveyarding"),
        "canReceiveInput": can_receive_input,
        "canInterrupt": is_alive && !matches!(lifecycle, "creating" | "starting"),
    });
    let notifications = notifications_state(
        positive(input.notification_unread_count),
        input.latest_notification.clone(),
        input.latest_notification_text.clone(),
    );
    let pressure = workflow_pressure(
        pending_delivery_count,
        waiting_on_me_count,
        waiting_on_them_count,
        blocked_count,
    );
    let user = user_state(&input, lifecycle, &attention);
    let orchestration = json!({
        "pressure": pressure,
        "assignedTask": input.has_active_task,
        "canBeAssignedWork": can_receive_input && !input.has_active_task,
    });
    let compact_hint = compact_hint(CompactHintInput {
        user: &user,
        notifications: &notifications,
        thread_unread_count,
        activity_new_count,
        pending_delivery_count,
        waiting_on_me_count,
        waiting_on_them_count,
        blocked_count,
        has_active_task: input.has_active_task,
    });
    let presentation = json!({
        "statusLabel": status_label_for(user.get("label").and_then(Value::as_str).unwrap_or("idle")),
        "compactHint": compact_hint,
        "attentionScore": attention_score(&user, &notifications, activity_new_count, pending_delivery_count),
    });
    let mut semantic = Map::new();
    semantic.insert("runtime".into(), runtime);
    semantic.insert("user".into(), user);
    semantic.insert("notifications".into(), notifications);
    semantic.insert("orchestration".into(), orchestration);
    semantic.insert("presentation".into(), presentation);
    if let Some(activity) = input.activity {
        semantic.insert("activity".into(), Value::String(activity));
    }
    semantic.insert("attention".into(), Value::String(attention));
    semantic.insert("activityNewCount".into(), Value::from(activity_new_count));
    semantic.insert("threadUnreadCount".into(), Value::from(thread_unread_count));
    semantic.insert(
        "pendingDeliveryCount".into(),
        Value::from(pending_delivery_count),
    );
    semantic.insert("waitingOnMeCount".into(), Value::from(waiting_on_me_count));
    semantic.insert(
        "waitingOnThemCount".into(),
        Value::from(waiting_on_them_count),
    );
    semantic.insert("blockedCount".into(), Value::from(blocked_count));
    semantic.insert("familyCount".into(), Value::from(family_count));
    Value::Object(semantic)
}

fn runtime_lifecycle(input: &SessionSemanticsInput) -> &'static str {
    match input.pending_action.as_deref() {
        Some("creating" | "forking" | "migrating") => return "creating",
        Some("starting") => return "starting",
        Some("stopping") => return "stopping",
        Some("graveyarding") => return "graveyarding",
        _ => {}
    }
    if input.attention.as_deref() == Some("error") || input.activity.as_deref() == Some("error") {
        return "error";
    }
    if matches!(input.status.as_str(), "offline" | "exited") {
        return "offline";
    }
    if input.status == "idle"
        || matches!(
            input.activity.as_deref(),
            Some("idle" | "done" | "interrupted")
        )
    {
        return "idle";
    }
    "running"
}

fn workflow_pressure(
    pending_delivery_count: i64,
    waiting_on_me_count: i64,
    waiting_on_them_count: i64,
    blocked_count: i64,
) -> &'static str {
    if blocked_count > 0 {
        "blocked"
    } else if waiting_on_me_count > 0 {
        "waiting_on_user"
    } else if pending_delivery_count > 0 {
        "pending"
    } else if waiting_on_them_count > 0 {
        "waiting_on_them"
    } else {
        "none"
    }
}

fn user_state(input: &SessionSemanticsInput, lifecycle: &str, attention: &str) -> Value {
    match lifecycle {
        "creating" | "starting" => user("starting", "none", "runtime", None),
        "stopping" => user("stopping", "none", "runtime", None),
        "graveyarding" => user("graveyarding", "none", "runtime", None),
        "offline" => user("offline", "none", "runtime", None),
        _ if attention == "error" || input.activity.as_deref() == Some("error") => {
            user("error", "error", "tool", None)
        }
        _ if attention == "blocked" => user("blocked", "blocked", "tool", None),
        _ if attention == "needs_input" => user("needs_input", "needs_input", "tool", None),
        _ if attention == "needs_response" => {
            user("needs_response", "needs_response", "tool", None)
        }
        _ if input.activity.as_deref() == Some("done") => user("done", "none", "tool", None),
        _ if input.activity.as_deref() == Some("interrupted") => {
            user("interrupted", "none", "tool", None)
        }
        _ if matches!(input.activity.as_deref(), Some("running" | "waiting"))
            || input.status == "waiting" =>
        {
            user("working", "none", "runtime", None)
        }
        _ if input.has_active_task => {
            user("next_step", "none", "runtime", Some("task still assigned"))
        }
        _ if input.status == "running" => user("ready", "none", "runtime", None),
        _ => user("idle", "none", "runtime", None),
    }
}

fn user(label: &str, attention: &str, source: &str, reason: Option<&str>) -> Value {
    let mut user = Map::new();
    user.insert("label".into(), Value::String(label.into()));
    user.insert("attention".into(), Value::String(attention.into()));
    user.insert("source".into(), Value::String(source.into()));
    if let Some(reason) = reason {
        user.insert("reason".into(), Value::String(reason.into()));
    }
    Value::Object(user)
}

fn notifications_state(
    unread_count: i64,
    latest_notification: Option<Value>,
    latest_notification_text: Option<String>,
) -> Value {
    let mut notifications = Map::new();
    notifications.insert("unreadCount".into(), Value::from(unread_count));
    if let Some(latest) = latest_notification {
        let latest_text = latest_notification_text
            .or_else(|| string_field(&latest, "body"))
            .or_else(|| string_field(&latest, "title"));
        notifications.insert("latestUnread".into(), latest);
        if let Some(text) = latest_text {
            notifications.insert("latestText".into(), Value::String(text));
        }
    } else if let Some(text) = latest_notification_text {
        notifications.insert("latestText".into(), Value::String(text));
    }
    Value::Object(notifications)
}

fn status_label_for(label: &str) -> &str {
    match label {
        "needs_input" => "needs input",
        "needs_response" => "needs answer",
        "next_step" => "next step",
        "working" => "working",
        "ready" => "ready",
        other => other,
    }
}

fn attention_score(
    user: &Value,
    notifications: &Value,
    activity_new_count: i64,
    pending_delivery_count: i64,
) -> i64 {
    match user.get("attention").and_then(Value::as_str) {
        Some("error") => 5,
        Some("needs_input" | "needs_response") => 4,
        Some("blocked") => 3,
        _ if integer_field(notifications, "unreadCount") > 0 || pending_delivery_count > 0 => 2,
        _ if activity_new_count > 0
            || user.get("label").and_then(Value::as_str) == Some("done") =>
        {
            1
        }
        _ => 0,
    }
}

struct CompactHintInput<'a> {
    user: &'a Value,
    notifications: &'a Value,
    thread_unread_count: i64,
    activity_new_count: i64,
    pending_delivery_count: i64,
    waiting_on_me_count: i64,
    waiting_on_them_count: i64,
    blocked_count: i64,
    has_active_task: bool,
}

fn compact_hint(input: CompactHintInput<'_>) -> Value {
    let hint = match input.user.get("attention").and_then(Value::as_str) {
        Some("error") => Some("error".to_owned()),
        Some("blocked") => Some("blocked".to_owned()),
        Some("needs_input") => Some("on you".to_owned()),
        Some("needs_response") => Some("answer".to_owned()),
        _ if input.user.get("label").and_then(Value::as_str) == Some("next_step") => {
            Some("on you".to_owned())
        }
        _ if integer_field(input.notifications, "unreadCount") > 0 => Some(format!(
            "{} unread",
            integer_field(input.notifications, "unreadCount").min(99)
        )),
        _ if input.waiting_on_me_count > 0 => Some("on you".to_owned()),
        _ if input.blocked_count > 0 => Some("blocked task".to_owned()),
        _ if input.waiting_on_them_count > 0 => Some("on them".to_owned()),
        _ if input.thread_unread_count > 0 => {
            Some(format!("{} thread", input.thread_unread_count.min(99)))
        }
        _ if input.activity_new_count > 0 => {
            Some(format!("{} new", input.activity_new_count.min(99)))
        }
        _ if input.pending_delivery_count > 0 => {
            Some(format!("{} pending", input.pending_delivery_count.min(99)))
        }
        _ if input.has_active_task => Some("task".to_owned()),
        _ => None,
    };
    hint.map(Value::String).unwrap_or(Value::Null)
}

fn positive(value: i64) -> i64 {
    value.max(0)
}

fn integer_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
