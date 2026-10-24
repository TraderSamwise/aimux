use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Default)]
pub struct SessionSemanticsInput {
    pub status: String,
    /// Input queued for this agent that has not been delivered yet. Distinct
    /// from `thread_pending_count`, which counts runtime-exchange messages.
    pub queued_input_count: i64,
    pub restore_notice: Option<String>,
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
    /// The sub-agent summary's own label, so the row's chip for it is the same
    /// string the chat header and the details pane render.
    pub subagent_label: Option<String>,
    pub input_delivery: Option<Value>,
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
    let default_compact_hint = compact_hint(CompactHintInput {
        user: &user,
        notifications: &notifications,
        thread_unread_count,
        activity_new_count,
        pending_delivery_count,
        queued_input_count: input.queued_input_count,
        waiting_on_me_count,
        waiting_on_them_count,
        blocked_count,
        has_active_task: input.has_active_task,
    });
    let urgent_attention = matches!(
        user.get("attention").and_then(Value::as_str),
        Some("error" | "blocked" | "needs_input" | "needs_response")
    );
    let actionable_pressure = matches!(pressure, "blocked" | "waiting_on_user");
    let compact_hint = if urgent_attention || actionable_pressure {
        default_compact_hint
    } else {
        super::input_delivery_receipt::delivery_display_label(input.input_delivery.as_ref())
            .map(|label| Value::String(label.to_owned()))
            .unwrap_or(default_compact_hint)
    };
    // The row's chips, decided here so the dashboard row and the app row stop
    // answering "what is going on with this agent" differently.
    let mut row_chips =
        crate::agent_row_chips::agent_row_chips(&crate::agent_row_chips::RowChipsInput {
            offline: row_chips_offline(&input, &user),
            restore_notice: input.restore_notice.clone(),
            waiting_on_me_count,
            workflow_blocked_count: blocked_count,
            subagent_label: input.subagent_label.clone(),
            thread_unread_count,
            activity_new_count,
            pending_delivery_count,
            queued_input_count: input.queued_input_count,
            waiting_on_them_count,
            family_count,
        });
    if let Some(label) =
        super::input_delivery_receipt::delivery_display_label(input.input_delivery.as_ref())
    {
        row_chips.insert(
            0,
            crate::agent_row_chips::RowChip {
                kind: "input-delivery".into(),
                label: label.to_owned(),
                tone: if row_chips_offline(&input, &user) {
                    crate::agent_row_chips::RowChipTone::Muted
                } else {
                    crate::agent_row_chips::RowChipTone::Attention
                },
            },
        );
    }
    let presentation = json!({
        // The action itself, not the bucket `user.label` coarsens it into:
        // `creating`, `forking` and `migrating` all become `starting` there,
        // and this string is rendered verbatim by the tmux bar and the Team
        // overlay beside a row that says `Forking`. `user.label` is left alone
        // -- ranking and the Exposé chip read it.
        "statusLabel": status_label_for(
            input
                .pending_action
                .as_deref()
                .filter(|action| crate::transient_state::is_transient_state(action))
                .unwrap_or_else(|| user.get("label").and_then(Value::as_str).unwrap_or("idle")),
        ),
        "compactHint": compact_hint,
        "attentionScore": attention_score(&user, &notifications, activity_new_count, pending_delivery_count),
        "rowChips": row_chips,
    });
    let mut semantic = Map::new();
    if let Some(delivery) = input.input_delivery {
        semantic.insert("inputDelivery".into(), delivery);
    }
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
    // Only when there is some: every recorded snapshot predates this field.
    if input.queued_input_count > 0 {
        semantic.insert(
            "queuedInputCount".into(),
            Value::from(input.queued_input_count),
        );
    }
    semantic.insert("waitingOnMeCount".into(), Value::from(waiting_on_me_count));
    semantic.insert(
        "waitingOnThemCount".into(),
        Value::from(waiting_on_them_count),
    );
    semantic.insert("blockedCount".into(), Value::from(blocked_count));
    semantic.insert("familyCount".into(), Value::from(family_count));
    Value::Object(semantic)
}

/// Whether the row's chips should read muted, by exactly the rule the
/// dashboard renderer applies.
///
/// Not just the user label: `runtime_lifecycle` answers `error` BEFORE it
/// answers `offline`, so an agent that failed and then exited has
/// `label: "error"` while the renderer's `is_session_offline` says it is gone.
/// Deciding from the label alone flipped that agent's chips from muted to
/// attention the moment the decision moved here -- the same error-before-
/// offline hole `desktop_state` patches with `raw_status != "offline"`.
///
/// A pending action means something is happening right now, so it is never
/// offline; no transient action is ever spelled `offline`, which is why the
/// renderer's `pending_action.is_some() -> false` and this agree.
fn row_chips_offline(input: &SessionSemanticsInput, user: &Value) -> bool {
    if input
        .pending_action
        .as_deref()
        .is_some_and(|action| !action.trim().is_empty())
    {
        return false;
    }
    user.get("label").and_then(Value::as_str) == Some("offline")
        || matches!(input.status.as_str(), "offline" | "exited")
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

/// `ps` printed the three raw axes, so a session whose window had died read
/// `offline  done/normal`. It now answers with `presentation.statusLabel`,
/// the published word the bar, the overlay and the app row all render.
pub fn agent_one_answer(
    status: Option<&str>,
    pending_action: Option<&str>,
    activity: Option<&str>,
    attention: Option<&str>,
    has_active_task: bool,
) -> String {
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status: normalized_session_status(status).to_owned(),
        pending_action: pending_action.map(str::to_owned),
        activity: activity.map(str::to_owned),
        attention: attention.map(str::to_owned),
        has_active_task,
        ..Default::default()
    });
    // `user.label` is the machine key, not the published word: it says
    // `needs_response` where every surface says "needs reply", and
    // `graveyarding` where the row says "Removing".
    semantic
        .get("presentation")
        .and_then(|presentation| presentation.get("statusLabel"))
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_owned()
}

/// Which sessions hold an assignment still in flight. Sharing only the
/// predicate was not enough: the agent list picked one task by a different
/// rule first, so a leading `pending` task hid a later `in_progress` one.
pub fn active_task_session_ids(tasks: &[Value]) -> std::collections::BTreeSet<String> {
    tasks
        .iter()
        .filter(|task| task_status_is_active(string_field(task, "status").as_deref()))
        .filter_map(|task| {
            string_field(task, "assignedTo").or_else(|| string_field(task, "assignee"))
        })
        .collect()
}

/// The statuses `user_state` counts as an assignment still in flight. The
/// agent list keeps a wider set on the record, so reading `task` presence
/// instead made `ps` answer `ready` where the row answered `next_step`.
fn task_status_is_active(status: Option<&str>) -> bool {
    matches!(status, Some("assigned" | "in_progress" | "blocked"))
}

/// Raw topology statuses narrowed to the four the derivation is written
/// against. Feeding it raw `starting` made `ps` answer `idle` for the same
/// agent every other surface called working.
pub fn normalized_session_status(status: Option<&str>) -> &'static str {
    match status {
        Some("running") => "running",
        Some("idle") => "idle",
        Some("starting") => "waiting",
        Some("offline") => "offline",
        _ => "offline",
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

/// The published word for a `user.label` or a transient action. Exposed so
/// one test can compare it against the row's and the chip's own maps over the
/// whole vocabulary, not only the states a fixture happens to reach.
pub fn published_status_label(label: &str) -> &str {
    status_label_for(label)
}

fn status_label_for(label: &str) -> &str {
    match label {
        "needs_input" => "needs input",
        // "needs reply", not "needs answer". One state had three words:
        // this said "needs answer", the TUI row said "Needs response", and
        // Exposé's chip said "Needs reply" -- and the app row, which now reads
        // this one, used to say "Needs reply" too. The majority spelling wins
        // so that moving the row onto this word is not a visible change for
        // the one state where the three disagreed.
        "needs_response" => "needs reply",
        "next_step" => "next step",
        "working" => "working",
        "ready" => "ready",
        // This string is published and rendered verbatim by the tmux status
        // bar and the Team overlay, which were reading the raw action -- so
        // killing a teammate said `graveyarding` there and `Removing` on the
        // row for the same agent.
        other if crate::transient_state::is_transient_state(other) => {
            crate::transient_state::transient_state_label(other)
        }
        other => other,
    }
}

/// How much an agent needs the user, as one number.
///
/// This is the only place it is decided. Three copies of this ladder had
/// drifted: the TUI's own version in `dashboard_controller` omitted the
/// `pending_delivery_count` term, so an agent with undelivered messages
/// ranked 0 there and 2 here -- and `u`, which jumps to the next agent
/// needing attention, skipped it. `tmux_control`'s version had neither the
/// unread nor the activity term.
///
/// Public so a test fixture can build a row the service could actually emit.
/// `dashboard_controller`'s fixture used to hardcode a score of 0 beside an
/// attention of `blocked`, which this function cannot produce, and every
/// attention test in that file passed against it.
pub fn attention_score_for(
    attention: Option<&str>,
    label: Option<&str>,
    unread_count: i64,
    pending_delivery_count: i64,
    activity_new_count: i64,
) -> i64 {
    match attention {
        Some("error") => 5,
        Some("needs_input" | "needs_response") => 4,
        Some("blocked") => 3,
        _ if unread_count > 0 || pending_delivery_count > 0 => 2,
        _ if activity_new_count > 0 || label == Some("done") => 1,
        _ => 0,
    }
}

fn attention_score(
    user: &Value,
    notifications: &Value,
    activity_new_count: i64,
    pending_delivery_count: i64,
) -> i64 {
    attention_score_for(
        user.get("attention").and_then(Value::as_str),
        user.get("label").and_then(Value::as_str),
        integer_field(notifications, "unreadCount"),
        pending_delivery_count,
        activity_new_count,
    )
}

struct CompactHintInput<'a> {
    user: &'a Value,
    notifications: &'a Value,
    thread_unread_count: i64,
    activity_new_count: i64,
    pending_delivery_count: i64,
    queued_input_count: i64,
    waiting_on_me_count: i64,
    waiting_on_them_count: i64,
    blocked_count: i64,
    has_active_task: bool,
}

fn compact_hint(input: CompactHintInput<'_>) -> Value {
    // Ahead of everything the agent has to say: the user's own message has
    // not gone in. The statusline and the tmux bar read this, and for a row
    // whose two chip slots are already full it is the only place it appears.
    if input.queued_input_count > 0 {
        return Value::String(format!(
            "{} queued",
            capped_count_label(input.queued_input_count)
        ));
    }
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
            capped_count_label(integer_field(input.notifications, "unreadCount"))
        )),
        _ if input.waiting_on_me_count > 0 => Some("on you".to_owned()),
        _ if input.blocked_count > 0 => Some("blocked task".to_owned()),
        _ if input.waiting_on_them_count > 0 => Some("on them".to_owned()),
        _ if input.thread_unread_count > 0 => Some(format!(
            "{} thread",
            capped_count_label(input.thread_unread_count)
        )),
        _ if input.activity_new_count > 0 => Some(format!(
            "{} new",
            capped_count_label(input.activity_new_count)
        )),
        _ if input.pending_delivery_count > 0 => Some(format!(
            "{} pending",
            capped_count_label(input.pending_delivery_count)
        )),
        _ if input.has_active_task => Some("task".to_owned()),
        _ => None,
    };
    hint.map(Value::String).unwrap_or(Value::Null)
}

/// The published label for an unread count.
///
/// One rule, because four surfaces render this number: the TUI row badge, the
/// app badge, `compactHint` below and the statusline's top line. `min(99)` was
/// not a cap -- it rendered "99 unread" when there were 150, which states a
/// wrong number rather than marking it as capped.
pub fn capped_count_label(count: i64) -> String {
    if count > 99 {
        "99+".to_owned()
    } else {
        count.to_string()
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_row_chips::RowChipTone;

    fn chips(semantic: &Value) -> Vec<crate::agent_row_chips::RowChip> {
        crate::agent_row_chips::published_row_chips(
            semantic
                .get("presentation")
                .and_then(|presentation| presentation.get("rowChips")),
        )
    }

    fn busy(status: &str, attention: &str) -> SessionSemanticsInput {
        SessionSemanticsInput {
            status: status.to_owned(),
            attention: Some(attention.to_owned()),
            thread_unread_count: 3,
            workflow_on_me_count: 2,
            ..SessionSemanticsInput::default()
        }
    }

    #[test]
    fn the_row_chips_are_published_with_the_rest_of_the_presentation() {
        let semantic = derive_session_semantics(busy("running", "normal"));
        let chips = chips(&semantic);
        assert_eq!(
            chips
                .iter()
                .map(|chip| chip.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["waiting-on-me", "threads-unread"],
            "the facts the badge cannot carry, in the service's order"
        );
        assert_eq!(chips[0].tone, RowChipTone::Attention);
    }

    /// The error-before-offline hole, pinned.
    ///
    /// `runtime_lifecycle` answers `error` before it answers `offline`, so an
    /// agent that failed and then exited reads `label: "error"` -- while the
    /// dashboard's own `is_session_offline` says it is gone. Deciding the chip
    /// tones from the label alone flipped exactly that agent's chips from
    /// muted to attention when this moved into the service.
    #[test]
    fn an_agent_that_failed_and_then_exited_still_reads_as_gone() {
        let semantic = derive_session_semantics(busy("exited", "error"));
        assert_eq!(
            semantic["user"]["label"], "error",
            "the label is error, which is the whole trap"
        );
        let chips = chips(&semantic);
        assert!(!chips.is_empty(), "positive control: it still has facts");
        assert!(
            chips.iter().all(|chip| chip.tone == RowChipTone::Muted),
            "nothing is happening, so nothing shouts: {chips:?}"
        );
    }

    #[test]
    fn a_live_agent_with_the_same_facts_still_shouts() {
        let chips = chips(&derive_session_semantics(busy("running", "normal")));
        assert!(chips.iter().any(|chip| chip.tone != RowChipTone::Muted));
    }

    #[test]
    fn an_agent_mid_action_is_not_gone_whatever_its_status_says() {
        // A pending action means something is happening right now. The
        // renderer refuses offline for any pending action, and so does this.
        let mut input = busy("exited", "error");
        input.pending_action = Some("starting".to_owned());
        let chips = chips(&derive_session_semantics(input));
        assert!(chips.iter().any(|chip| chip.tone != RowChipTone::Muted));
    }
}
