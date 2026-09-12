use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, is_session_notification_focused,
    load_notification_context_state, update_notification_context,
};
use aimux::project_service::notifications::{
    NotificationMutation, NotificationQuery, NotificationWriteInput, add_notification,
    clear_notifications, list_notification_snapshot, mark_notifications_read, upsert_notification,
};
use aimux::project_service::project_events::ProjectEventBus;
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const NOTIFICATIONS_STORE: &str =
    include_str!("../../../../../testdata/contracts/v1/notifications/store.json");

struct TestProject {
    base: PathBuf,
    root: PathBuf,
    state_dir: PathBuf,
    events: ProjectEventBus,
}

impl TestProject {
    fn new(label: &str, seed: bool) -> Self {
        let base = std::env::temp_dir().join(format!(
            "aimux-notifications-store-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&base);
        let root = base.join("repo");
        create_dir_all(root.join(".git")).expect("create git dir");
        let state_dir = base.join("state");
        create_dir_all(&state_dir).expect("create state dir");
        if seed {
            write_runtime_exchange(runtime_exchange_path(&state_dir), &seed_exchange())
                .expect("seed exchange");
        }
        Self {
            base,
            root,
            state_dir,
            events: ProjectEventBus::default(),
        }
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.base);
    }
}

#[test]
fn fixture_notifications_store_matches_typescript() {
    let contract: Value = serde_json::from_str(NOTIFICATIONS_STORE).expect("valid fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("notification store cases");
    assert_eq!(cases.len(), 12, "unexpected notifications-store case count");
    let mut failures = Vec::new();
    for case in cases {
        let scenario = case["input"]["scenario"].as_str().unwrap_or("case");
        let project = TestProject::new(scenario, seeded_scenario(scenario));
        let raw = run_case(&project, &case["input"]);
        assert_dynamic_structure(&raw, case["id"].as_str().unwrap_or("case"));
        let actual = if output_is_dynamic(&case["output"]) {
            normalize_dynamic(raw, &project.base)
        } else {
            raw
        };
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} notifications-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn seeded_scenario(scenario: &str) -> bool {
    matches!(
        scenario,
        "list" | "filter-unread-session-limit" | "mark-read" | "clear" | "unread-count"
    )
}

fn run_case(project: &TestProject, input: &Value) -> Value {
    match input["scenario"].as_str().unwrap_or_default() {
        "list" => snapshot_value(list_notification_snapshot(
            &project.state_dir,
            NotificationQuery {
                limit: Some(10),
                ..NotificationQuery::default()
            },
        )),
        "filter-unread-session-limit" => snapshot_value(list_notification_snapshot(
            &project.state_dir,
            NotificationQuery {
                unread_only: true,
                session_id: Some("codex-2".into()),
                limit: Some(1),
                ..NotificationQuery::default()
            },
        )),
        "mark-read" => {
            let updated = mark_notifications_read(
                &project.state_dir,
                NotificationMutation {
                    id: Some("record-2".into()),
                    session_id: Some("codex-2".into()),
                    ..NotificationMutation::default()
                },
            )
            .expect("mark notification read");
            let exchange = read_runtime_exchange(runtime_exchange_path(&project.state_dir));
            json!({
                "updated": updated,
                "inbox": exchange["inbox"],
                "snapshot": snapshot_value(list_notification_snapshot(&project.state_dir, NotificationQuery::default())),
            })
        }
        "clear" => {
            let cleared = clear_notifications(
                &project.state_dir,
                NotificationMutation {
                    ids: Some(vec!["record-1".into(), "record-2".into()]),
                    ..NotificationMutation::default()
                },
            )
            .expect("clear notifications");
            let exchange = read_runtime_exchange(runtime_exchange_path(&project.state_dir));
            json!({
                "cleared": cleared,
                "messages": exchange["messages"],
                "snapshot": snapshot_value(list_notification_snapshot(&project.state_dir, NotificationQuery::default())),
                "includeCleared": snapshot_value(list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery { include_cleared: true, ..NotificationQuery::default() },
                )),
            })
        }
        "unread-count" => json!({
            "all": unread_count(&project.state_dir, None),
            "codex1": unread_count(&project.state_dir, Some("codex-1")),
            "codex2": unread_count(&project.state_dir, Some("codex-2")),
        }),
        "add-notifications" => {
            let first = add_notification(
                &project.state_dir,
                notification_input(json!({
                    "title": "Build done",
                    "body": "All tests passed",
                    "sessionId": "claude-1",
                    "kind": "task_done",
                    "projectRoot": project_root(project),
                })),
            )
            .expect("add first notification");
            let second = add_notification(
                &project.state_dir,
                notification_input(json!({
                    "title": "Need input",
                    "body": "Approve migration",
                    "sessionId": "claude-2",
                    "kind": "needs_input",
                    "projectRoot": project_root(project),
                })),
            )
            .expect("add second notification");
            json!({
                "first": first,
                "second": second,
                "snapshot": snapshot_value(list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery { include_cleared: true, ..NotificationQuery::default() },
                )),
                "exchange": exchange(project),
            })
        }
        "upsert-session-target" => {
            let first = upsert_notification(
                &project.state_dir,
                notification_input(json!({
                    "title": "codex needs input",
                    "body": "approve command",
                    "sessionId": "codex-1",
                    "kind": "needs_input",
                    "projectRoot": project_root(project),
                })),
            )
            .expect("upsert first notification");
            let second = upsert_notification(
                &project.state_dir,
                notification_input(json!({
                    "title": "codex finished",
                    "body": "done",
                    "sessionId": "codex-1",
                    "kind": "task_done",
                    "projectRoot": project_root(project),
                })),
            )
            .expect("upsert second notification");
            json!({
                "first": first,
                "second": second,
                "snapshot": snapshot_value(list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery {
                        include_cleared: true,
                        session_id: Some("codex-1".into()),
                        ..NotificationQuery::default()
                    },
                )),
                "exchange": exchange(project),
            })
        }
        "focused-alert" => {
            update_notification_context(
                &project.state_dir,
                NotificationContextSource::Tui,
                NotificationContextPatch {
                    focused: Some(true),
                    screen: Some(Some("agent".into())),
                    session_id: Some(Some("codex-1".into())),
                    panel_open: None,
                },
            );
            let published = publish_alert(
                project,
                json!({
                    "kind": "needs_input",
                    "sessionId": "codex-1",
                    "title": "codex needs input",
                    "message": "ready",
                    "projectName": "aimux",
                    "projectRoot": project_root(project),
                    "worktreeName": "notifications",
                    "worktreePath": project_root(project) + "/.aimux/worktrees/notifications",
                    "branch": "notifications",
                    "categoryLabel": "Needs input",
                    "reasonLabel": "Agent is waiting for input",
                }),
            );
            json!({
                "published": published,
                "events": event_values(project),
                "contexts": serde_json::to_value(load_notification_context_state(&project.state_dir)).unwrap(),
                "unreadCount": unread_count(&project.state_dir, Some("codex-1")),
                "snapshot": snapshot_value(list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery {
                        include_cleared: true,
                        session_id: Some("codex-1".into()),
                        ..NotificationQuery::default()
                    },
                )),
                "exchange": exchange(project),
            })
        }
        "live-alert-event-id" => {
            let published = publish_alert(
                project,
                json!({
                    "kind": "needs_input",
                    "sessionId": "codex-1",
                    "title": "codex needs input",
                    "message": "ready",
                    "projectName": "aimux",
                    "projectRoot": project_root(project),
                    "worktreeName": "notifications",
                    "worktreePath": project_root(project) + "/.aimux/worktrees/notifications",
                    "branch": "notifications",
                    "categoryLabel": "Needs input",
                    "reasonLabel": "Agent is waiting for input",
                }),
            );
            json!({
                "published": published,
                "events": event_values(project),
                "record": list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery {
                        include_cleared: true,
                        session_id: Some("codex-1".into()),
                        ..NotificationQuery::default()
                    },
                ).notifications.first().cloned().unwrap_or(Value::Null),
                "exchange": exchange(project),
            })
        }
        "alert-project-update" => {
            let published = publish_alert(
                project,
                json!({
                    "kind": "message_waiting",
                    "sessionId": "codex-1",
                    "title": "Message waiting",
                    "message": "Please review",
                }),
            );
            json!({
                "published": published,
                "events": event_values(project),
                "exchange": exchange(project),
            })
        }
        "multiple-alert-sources" => {
            publish_alert(
                project,
                json!({
                    "kind": "needs_input",
                    "sessionId": "claude-1",
                    "title": "claude-1 needs input",
                    "message": "from hook",
                }),
            );
            publish_alert(
                project,
                json!({
                    "kind": "notification",
                    "sessionId": "claude-1",
                    "title": "Claude Code",
                    "message": "from terminal notification",
                }),
            );
            json!({
                "notifications": list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery {
                        include_cleared: true,
                        session_id: Some("claude-1".into()),
                        ..NotificationQuery::default()
                    },
                ).notifications,
                "exchange": exchange(project),
            })
        }
        "dedupe-and-interaction-alerts" => {
            publish_alert(
                project,
                json!({
                    "kind": "needs_input",
                    "sessionId": "claude-1",
                    "title": "claude-1 needs input",
                    "message": "first",
                    "dedupeKey": "needs_input:claude-1",
                }),
            );
            publish_alert(
                project,
                json!({
                    "kind": "needs_input",
                    "sessionId": "claude-1",
                    "title": "claude-1 needs input",
                    "message": "second",
                    "dedupeKey": "needs_input:claude-1",
                }),
            );
            publish_alert(
                project,
                json!({
                    "kind": "interaction_request",
                    "sessionId": "claude-1",
                    "title": "claude-1 needs a response",
                    "message": "Approve command",
                    "interaction": {
                        "id": "interaction-1",
                        "type": "permission",
                        "summary": "Bash: yarn test",
                        "telemetry": true,
                        "toolName": "Bash",
                        "toolInputJSON": "{\"command\":\"yarn test\"}",
                    },
                }),
            );
            json!({
                "notifications": list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery {
                        include_cleared: true,
                        session_id: Some("claude-1".into()),
                        ..NotificationQuery::default()
                    },
                ).notifications,
                "exchange": exchange(project),
            })
        }
        scenario => json!({ "error": format!("unknown scenario: {scenario}") }),
    }
}

fn unread_count(state_dir: &Path, session_id: Option<&str>) -> usize {
    list_notification_snapshot(
        state_dir,
        NotificationQuery {
            unread_only: true,
            session_id: session_id.map(str::to_owned),
            ..NotificationQuery::default()
        },
    )
    .notifications
    .len()
}

fn project_root(project: &TestProject) -> String {
    project.root.to_string_lossy().into_owned()
}

fn exchange(project: &TestProject) -> Value {
    read_runtime_exchange(runtime_exchange_path(&project.state_dir))
}

fn event_values(project: &TestProject) -> Value {
    Value::Array(
        project
            .events
            .events_since(0, None)
            .into_iter()
            .map(|record| record.event)
            .collect(),
    )
}

fn publish_alert(project: &TestProject, alert: Value) -> bool {
    let session_id = optional_string(alert.get("sessionId"));
    let force_notify = alert.get("forceNotify") == Some(&Value::Bool(true));
    let focused = session_id
        .as_deref()
        .is_some_and(|session_id| is_session_notification_focused(&project.state_dir, session_id));
    let notification = notification_input(json!({
        "title": string_field(&alert, "title"),
        "body": string_field(&alert, "message"),
        "sessionId": session_id,
        "kind": optional_string(alert.get("kind")),
        "projectName": optional_string(alert.get("projectName")),
        "projectRoot": optional_string(alert.get("projectRoot")),
        "worktreePath": optional_string(alert.get("worktreePath")),
        "worktreeName": optional_string(alert.get("worktreeName")),
        "branch": optional_string(alert.get("branch")),
        "categoryLabel": optional_string(alert.get("categoryLabel")),
        "reasonLabel": optional_string(alert.get("reasonLabel")),
        "dedupeKey": optional_string(alert.get("dedupeKey")),
        "unread": force_notify || !focused,
        "interaction": alert.get("interaction").cloned(),
        "forceNotify": force_notify,
    }));
    let Ok(record) = add_notification(&project.state_dir, notification.clone()) else {
        return false;
    };
    project
        .events
        .publish_alert_from_notification(&project.root, &notification, &record);
    true
}

fn notification_input(value: Value) -> NotificationWriteInput {
    NotificationWriteInput {
        title: string_field(&value, "title"),
        subtitle: optional_string(value.get("subtitle")),
        body: string_field(&value, "body"),
        session_id: optional_string(value.get("sessionId")),
        target_key: optional_string(value.get("targetKey")),
        target_kind: optional_string(value.get("targetKind")),
        kind: optional_string(value.get("kind")),
        project_name: optional_string(value.get("projectName")),
        project_root: optional_string(value.get("projectRoot")),
        worktree_path: optional_string(value.get("worktreePath")),
        worktree_name: optional_string(value.get("worktreeName")),
        branch: optional_string(value.get("branch")),
        category_label: optional_string(value.get("categoryLabel")),
        reason_label: optional_string(value.get("reasonLabel")),
        dedupe_key: optional_string(value.get("dedupeKey")),
        created_at: optional_string(value.get("createdAt")),
        unread: value.get("unread").and_then(Value::as_bool).unwrap_or(true),
        interaction: value
            .get("interaction")
            .cloned()
            .filter(|value| !value.is_null()),
        force_notify: value
            .get("forceNotify")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn string_field(value: &Value, key: &str) -> String {
    optional_string(value.get(key)).unwrap_or_default()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn snapshot_value(snapshot: aimux::project_service::notifications::NotificationSnapshot) -> Value {
    let mut value = json!({
        "notifications": snapshot.notifications,
        "total": snapshot.total,
        "unreadCount": snapshot.unread_count,
        "truncated": snapshot.truncated,
    });
    if let Some(limit) = snapshot.limit {
        value["limit"] = Value::from(limit);
    }
    value
}

fn output_is_dynamic(value: &Value) -> bool {
    serde_json::to_string(value)
        .expect("serialize output")
        .contains("<ts>")
}

fn normalize_dynamic(value: Value, base: &Path) -> Value {
    let mut normalizer = DynamicNormalizer::new(base);
    normalizer.normalize(value)
}

struct DynamicNormalizer {
    root: String,
    ids: Vec<(String, String)>,
}

impl DynamicNormalizer {
    fn new(base: &Path) -> Self {
        Self {
            root: base.to_string_lossy().into_owned(),
            ids: Vec::new(),
        }
    }

    fn normalize(&mut self, value: Value) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|item| self.normalize(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        if key == "projectId" {
                            (key, Value::String("<project-id>".into()))
                        } else {
                            (key, self.normalize(value))
                        }
                    })
                    .collect(),
            ),
            Value::String(text) => Value::String(self.normalize_string(&text)),
            value => value,
        }
    }

    fn normalize_string(&mut self, input: &str) -> String {
        let rooted = input.replace(&self.root, "<root>");
        let with_timestamps = replace_iso_timestamps(&rooted);
        replace_dynamic_notification_ids(&with_timestamps, |id| self.id_token(id))
    }

    fn id_token(&mut self, id: &str) -> String {
        if let Some((_, token)) = self.ids.iter().find(|(seen, _)| seen == id) {
            return token.clone();
        }
        let token = format!("<id:{}>", self.ids.len() + 1);
        self.ids.push((id.to_owned(), token.clone()));
        token
    }
}

fn replace_iso_timestamps(input: &str) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        if index + 24 <= input.len() && is_iso_timestamp(&input[index..index + 24]) {
            output.push_str("<ts>");
            index += 24;
        } else {
            let character = input[index..].chars().next().expect("valid utf-8");
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn replace_dynamic_notification_ids(input: &str, mut token: impl FnMut(&str) -> String) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        if let Some((end, token_id)) = generated_notification_id_end(&input[index..]) {
            let id = &input[index..index + end];
            if token_id {
                output.push_str(&token(id));
            } else {
                output.push_str(id);
            }
            index += end;
        } else if index + 36 <= input.len() && is_uuid(&input[index..index + 36]) {
            output.push_str(&token(&input[index..index + 36]));
            index += 36;
        } else {
            let character = input[index..].chars().next().expect("valid utf-8");
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn generated_notification_id_end(input: &str) -> Option<(usize, bool)> {
    for prefix in ["notification-record-", "notification-"] {
        if let Some(rest) = input.strip_prefix(prefix) {
            let suffix_len = rest
                .bytes()
                .take_while(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
                })
                .count();
            if suffix_len > 0 {
                let suffix = &rest[..suffix_len];
                return Some((prefix.len() + suffix_len, suffix.contains('-')));
            }
        }
    }
    None
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

fn assert_dynamic_structure(value: &Value, label: &str) {
    let mut failures = Vec::new();
    assert_dynamic_structure_at(value, "$", &mut failures);
    assert!(
        failures.is_empty(),
        "{label} dynamic structure failures:\n{}",
        failures.join("\n")
    );
}

fn assert_dynamic_structure_at(value: &Value, path: &str, failures: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_dynamic_structure_at(item, &format!("{path}[{index}]"), failures);
            }
        }
        Value::Object(map) => {
            if let (Some(created), Some(updated)) = (
                timestamp_key(map.get("createdAt")),
                timestamp_key(map.get("updatedAt")),
            ) && created > updated
            {
                failures.push(format!("{path}: createdAt is after updatedAt"));
            }
            if let (Some(ts), Some(delivered)) = (
                timestamp_key(map.get("ts")),
                timestamp_key(map.get("deliveredAt")),
            ) && ts > delivered
            {
                failures.push(format!("{path}: ts is after deliveredAt"));
            }
            for (key, nested) in map {
                if matches!(
                    key.as_str(),
                    "id" | "threadId"
                        | "messageId"
                        | "lastMessageId"
                        | "notificationId"
                        | "projectId"
                ) && nested.as_str().is_some_and(|text| text.trim().is_empty())
                {
                    failures.push(format!("{path}.{key}: id-like field is empty"));
                }
                assert_dynamic_structure_at(nested, &format!("{path}.{key}"), failures);
            }
        }
        _ => {}
    }
}

fn timestamp_key(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    is_iso_timestamp(text).then(|| text.to_owned())
}

fn seed_exchange() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "threads": [
            {
                "id": "thread-1",
                "title": "Needs input",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-01-01T00:00:01.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z",
                "createdBy": "aimux",
                "participants": ["aimux", "codex-1"],
                "tags": ["notification"]
            },
            {
                "id": "thread-2",
                "title": "Build done",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-01-01T00:00:02.000Z",
                "updatedAt": "2026-01-01T00:00:04.000Z",
                "createdBy": "aimux",
                "participants": ["aimux", "codex-2"],
                "tags": ["notification"]
            },
            {
                "id": "thread-other",
                "title": "Workflow",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-01-01T00:00:05.000Z",
                "updatedAt": "2026-01-01T00:00:05.000Z",
                "createdBy": "user",
                "participants": ["user", "codex-1"],
                "tags": []
            }
        ],
        "messages": [
            {
                "id": "message-1",
                "threadId": "thread-1",
                "ts": "2026-01-01T00:00:01.000Z",
                "from": "aimux",
                "to": ["codex-1"],
                "kind": "note",
                "body": "old body",
                "metadata": {
                    "notificationRecordId": "record-1",
                    "notificationSessionId": "codex-1",
                    "notificationTargetKey": "session:codex-1",
                    "notificationTargetKind": "session"
                }
            },
            {
                "id": "message-2",
                "threadId": "thread-2",
                "ts": "2026-01-01T00:00:04.000Z",
                "from": "aimux",
                "to": ["codex-2"],
                "kind": "note",
                "body": "new body",
                "metadata": {
                    "notificationRecordId": "record-2",
                    "notificationSessionId": "codex-2",
                    "notificationTargetKey": "session:codex-2",
                    "notificationTargetKind": "session",
                    "notificationKind": "needs_input",
                    "notificationInteractionId": "interact-2",
                    "notificationInteractionType": "permission",
                    "notificationInteractionSummary": "Allow command",
                    "notificationInteractionTelemetry": true
                }
            },
            {
                "id": "message-other",
                "threadId": "thread-other",
                "ts": "2026-01-01T00:00:05.000Z",
                "from": "user",
                "to": ["codex-1"],
                "kind": "request",
                "body": "not a notification"
            }
        ],
        "tasks": [],
        "handoffs": [],
        "reviews": [],
        "waits": [],
        "inbox": [
            {
                "id": "inbox:codex-1:thread:thread-1",
                "participantId": "codex-1",
                "subjectKind": "thread",
                "subjectId": "thread-1",
                "state": "done",
                "urgency": 0,
                "updatedAt": "2026-01-01T00:00:03.000Z"
            },
            {
                "id": "inbox:codex-2:thread:thread-2",
                "participantId": "codex-2",
                "subjectKind": "thread",
                "subjectId": "thread-2",
                "state": "unread",
                "urgency": 3,
                "updatedAt": "2026-01-01T00:00:04.000Z"
            }
        ],
        "planRefs": [],
        "continuityRefs": [],
        "attachmentRefs": []
    })
}
