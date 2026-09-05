use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::desktop_state::{DesktopStateInput, build_desktop_state};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};

const NOTIFICATION_TAG: &str = "notification";
const NEEDS_INPUT_KIND: &str = "needs_input";
const DEFAULT_PROJECT_LIST_LIMIT: usize = 200;
const BUCKET_STRIDE: i64 = 1_000_000;

pub fn route_coordination_worklist_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET")
        || project_service_pathname(path) != routes::COORDINATION_WORKLIST
    {
        return None;
    }

    let project_state_dir = context.project_state_dir();
    let exchange = read_runtime_exchange(runtime_exchange_path(&project_state_dir));
    let desktop_state = if let Some(state) = context.desktop_state.as_ref() {
        state.clone()
    } else {
        let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
            Ok(topology) => topology,
            Err(error) => {
                return Some(ProjectServiceDispatchResponse::json(
                    500,
                    json!({ "ok": false, "error": error }),
                ));
            }
        };
        let metadata = load_metadata_state(&project_state_dir);
        build_desktop_state(DesktopStateInput {
            project_root: context.project_root().to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata.sessions,
            exchange: &exchange,
        })
    };
    let params = query_params(path);
    let participant = trimmed_query(&params, "participant").unwrap_or_else(|| "user".into());
    let threads = build_coordination_thread_entries(&exchange, &participant);
    let notifications = notification_records(&exchange)
        .into_iter()
        .take(DEFAULT_PROJECT_LIST_LIMIT)
        .collect::<Vec<_>>();
    let sessions = array_field(&desktop_state, "sessions");
    let teammates = array_field(&desktop_state, "teammates");
    let services = array_field(&desktop_state, "services");
    let view = build_coordination_view(
        sessions,
        teammates,
        services,
        &notifications,
        &threads,
        &participant,
    );

    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({
            "ok": true,
            "serviceInfo": service_info(),
            "worklist": view["worklist"],
            "model": view["model"],
            "threads": threads,
        }),
    ))
}

pub fn build_coordination_view(
    sessions: &[Value],
    teammates: &[Value],
    services: &[Value],
    notifications: &[Value],
    threads: &[Value],
    current_participant: &str,
) -> Value {
    let model = build_coordination_model(sessions, teammates, services, notifications, threads);
    let worklist = build_coordination_worklist(&model, threads, current_participant);
    json!({ "model": model, "worklist": worklist })
}

pub fn build_coordination_model(
    sessions: &[Value],
    teammates: &[Value],
    services: &[Value],
    notifications: &[Value],
    threads: &[Value],
) -> Value {
    let mut by_session: Vec<(String, Vec<Value>)> = Vec::new();
    let mut standalone: Vec<(String, Vec<Value>)> = Vec::new();
    for notification in notifications {
        if let Some(session_id) = string_field(notification, "sessionId") {
            push_group(&mut by_session, session_id, notification.clone());
        } else {
            let key = string_field(notification, "dedupeKey")
                .filter(|key| !key.is_empty())
                .or_else(|| string_field(notification, "id"))
                .unwrap_or("");
            push_group(&mut standalone, key, notification.clone());
        }
    }

    let mut items = Vec::new();
    for (session_id, group) in by_session {
        let reachable = resolve_reachability(&session_id, sessions, teammates, services);
        items.push(build_model_item(
            &session_id,
            Some(&session_id),
            group,
            reachable,
            threads,
        ));
    }
    for (key, group) in standalone {
        items.push(build_model_item(
            &key,
            None,
            group,
            Reachable::none(),
            threads,
        ));
    }
    items.sort_by(|left, right| {
        integer_field(right, "urgency")
            .cmp(&integer_field(left, "urgency"))
            .then_with(|| latest_unread_at(right).cmp(latest_unread_at(left)))
    });

    let actionable = items
        .iter()
        .filter(|item| bool_field(item, "actionable"))
        .cloned()
        .collect::<Vec<_>>();
    let unreachable = items
        .iter()
        .filter(|item| string_field(item, "reachability") == Some("missing"))
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "items": items,
        "actionable": actionable,
        "unreachable": unreachable,
    })
}

pub fn build_coordination_worklist(
    model: &Value,
    threads: &[Value],
    current_participant: &str,
) -> Value {
    let mut items = Vec::new();
    for item in array_field(model, "items") {
        let bucket = notification_bucket(item);
        let mut row = Map::new();
        insert_string(
            &mut row,
            "key",
            &format!("n:{}", string_field(item, "key").unwrap_or("")),
        );
        insert_string(&mut row, "kind", "notification");
        insert_optional(&mut row, "sessionId", string_field(item, "sessionId"));
        insert_string(
            &mut row,
            "type",
            if item.get("sessionId").is_some() {
                "msg"
            } else {
                "note"
            },
        );
        insert_string(&mut row, "bucket", bucket);
        insert_string(
            &mut row,
            "title",
            string_field(item, "title").unwrap_or("aimux"),
        );
        row.insert(
            "urgency".into(),
            Value::from(notification_urgency(item, bucket)),
        );
        insert_string(
            &mut row,
            "reachability",
            string_field(item, "reachability").unwrap_or("none"),
        );
        row.insert(
            "actionable".into(),
            Value::Bool(bool_field(item, "actionable")),
        );
        row.insert("stale".into(), Value::Bool(bool_field(item, "stale")));
        insert_optional(
            &mut row,
            "when",
            item.get("latestUnread")
                .and_then(|latest| string_field(latest, "createdAt")),
        );
        row.insert("notification".into(), item.clone());
        items.push(Value::Object(row));
    }

    for entry in threads {
        let thread = entry.get("thread").unwrap_or(&Value::Null);
        let waiting_on_you = string_array(thread, "waitingOn")
            .iter()
            .any(|participant| participant == current_participant);
        let pending = integer_field(entry, "pendingDeliveries") > 0;
        let actionable = waiting_on_you || pending;
        let bucket = if actionable { "awake" } else { "handled" };
        let secondary = if waiting_on_you {
            300
        } else if pending {
            200
        } else {
            50
        };
        let mut row = Map::new();
        insert_string(
            &mut row,
            "key",
            &format!("t:{}", string_field(thread, "id").unwrap_or("")),
        );
        insert_string(&mut row, "kind", "thread");
        insert_string(
            &mut row,
            "type",
            thread_type(string_field(thread, "kind").unwrap_or("conversation")),
        );
        insert_string(&mut row, "bucket", bucket);
        insert_string(
            &mut row,
            "title",
            string_field(entry, "displayTitle").unwrap_or(""),
        );
        row.insert(
            "urgency".into(),
            Value::from(bucket_urgency(bucket, secondary)),
        );
        insert_string(&mut row, "reachability", "none");
        row.insert("actionable".into(), Value::Bool(actionable));
        row.insert("stale".into(), Value::Bool(false));
        insert_optional(&mut row, "when", string_field(thread, "updatedAt"));
        row.insert("thread".into(), entry.clone());
        items.push(Value::Object(row));
    }

    items.sort_by(|left, right| {
        integer_field(right, "urgency")
            .cmp(&integer_field(left, "urgency"))
            .then_with(|| {
                string_field(right, "when")
                    .unwrap_or("")
                    .cmp(string_field(left, "when").unwrap_or(""))
            })
    });
    let needs_you = items
        .iter()
        .filter(|item| matches!(string_field(item, "bucket"), Some("awake" | "asleep")))
        .cloned()
        .collect::<Vec<_>>();
    let tail = items
        .iter()
        .filter(|item| {
            matches!(
                string_field(item, "bucket"),
                Some("handled" | "unreachable")
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    json!({ "items": items, "needsYou": needs_you, "tail": tail })
}

pub fn build_coordination_thread_entries(
    exchange: &Value,
    current_participant: &str,
) -> Vec<Value> {
    let tasks = array_field(exchange, "tasks");
    let mut family_by_root: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for task in tasks {
        let root = string_field(task, "reviewOf")
            .or_else(|| string_field(task, "id"))
            .unwrap_or("");
        family_by_root.entry(root.into()).or_default().push(task);
    }
    for family in family_by_root.values_mut() {
        family.sort_by(|left, right| {
            string_field(left, "createdAt")
                .unwrap_or("")
                .cmp(string_field(right, "createdAt").unwrap_or(""))
        });
    }

    let mut threads = array_field(exchange, "threads")
        .iter()
        .filter(|thread| {
            !string_array(thread, "tags")
                .iter()
                .any(|tag| tag == NOTIFICATION_TAG)
        })
        .collect::<Vec<_>>();
    threads.sort_by(|left, right| {
        string_field(right, "updatedAt")
            .unwrap_or("")
            .cmp(string_field(left, "updatedAt").unwrap_or(""))
    });

    let mut entries = threads
        .into_iter()
        .map(|thread| {
            let thread_id = string_field(thread, "id").unwrap_or("");
            let mut messages = array_field(exchange, "messages")
                .iter()
                .filter(|message| string_field(message, "threadId") == Some(thread_id))
                .cloned()
                .collect::<Vec<_>>();
            messages.sort_by(|left, right| {
                string_field(left, "ts")
                    .unwrap_or("")
                    .cmp(string_field(right, "ts").unwrap_or(""))
            });
            let latest_message = messages.last().cloned();
            let pending_deliveries = messages
                .iter()
                .map(pending_recipients)
                .map(|recipients| recipients.len())
                .sum::<usize>();
            let latest_pending_recipients = messages
                .iter()
                .rev()
                .map(pending_recipients)
                .find(|recipients| !recipients.is_empty())
                .unwrap_or_default();
            let task = string_field(thread, "taskId").and_then(|task_id| {
                tasks
                    .iter()
                    .find(|task| string_field(task, "id") == Some(task_id))
            });
            let waiting_on_me = string_array(thread, "waitingOn")
                .iter()
                .any(|participant| participant == current_participant);
            let unread = string_array(thread, "unreadBy")
                .iter()
                .any(|participant| participant == current_participant);
            let blocked = string_field(thread, "status") == Some("blocked");
            let task_assigned = task.is_some_and(|task| {
                matches!(
                    string_field(task, "status"),
                    Some("assigned" | "in_progress" | "blocked")
                )
            });
            let urgency = i64::from(waiting_on_me) * 10
                + i64::from(blocked) * 8
                + pending_deliveries as i64 * 4
                + i64::from(unread) * 3
                + i64::from(task_assigned) * 2;
            let state_label = if blocked {
                "blocked".to_owned()
            } else if waiting_on_me {
                "on me".to_owned()
            } else if !string_array(thread, "waitingOn").is_empty() {
                format!("on {}", string_array(thread, "waitingOn").join(", "))
            } else {
                task.and_then(|task| string_field(task, "status"))
                    .or_else(|| string_field(thread, "status"))
                    .unwrap_or("")
                    .to_owned()
            };
            let family_root = task.map(|task| {
                string_field(task, "reviewOf")
                    .or_else(|| string_field(task, "id"))
                    .unwrap_or("")
            });
            let family_task_ids = family_root
                .and_then(|root| family_by_root.get(root))
                .map(|family| {
                    family
                        .iter()
                        .filter_map(|task| string_field(task, "id").map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let title = string_field(thread, "title")
                .filter(|title| !title.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{} {}",
                        string_field(thread, "kind").unwrap_or("conversation"),
                        thread_id
                    )
                });
            let mut entry = Map::new();
            entry.insert("thread".into(), thread.clone());
            if let Some(latest_message) = latest_message {
                entry.insert("latestMessage".into(), latest_message);
            }
            entry.insert("displayTitle".into(), Value::String(title));
            entry.insert("messages".into(), Value::Array(messages));
            entry.insert("pendingDeliveries".into(), Value::from(pending_deliveries));
            entry.insert(
                "latestPendingRecipients".into(),
                Value::Array(
                    latest_pending_recipients
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
            if let Some(task) = task {
                entry.insert("task".into(), task.clone());
            }
            entry.insert("urgency".into(), Value::from(urgency));
            entry.insert("stateLabel".into(), Value::String(state_label));
            if let Some(family_root) = family_root {
                entry.insert(
                    "familyRootTaskId".into(),
                    Value::String(family_root.to_owned()),
                );
            }
            entry.insert(
                "familyTaskIds".into(),
                Value::Array(family_task_ids.into_iter().map(Value::String).collect()),
            );
            Value::Object(entry)
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        integer_field(right, "urgency")
            .cmp(&integer_field(left, "urgency"))
            .then_with(|| {
                let right_updated = right
                    .get("thread")
                    .and_then(|thread| string_field(thread, "updatedAt"))
                    .unwrap_or("");
                let left_updated = left
                    .get("thread")
                    .and_then(|thread| string_field(thread, "updatedAt"))
                    .unwrap_or("");
                right_updated.cmp(left_updated)
            })
    });
    entries
}

#[derive(Clone, Copy)]
struct Reachable<'a> {
    reachability: &'static str,
    live_label: Option<&'a str>,
    attention_score: i64,
}

impl Reachable<'_> {
    fn none() -> Self {
        Self {
            reachability: "none",
            live_label: None,
            attention_score: 0,
        }
    }
}

fn resolve_reachability<'a>(
    session_id: &str,
    sessions: &'a [Value],
    teammates: &'a [Value],
    services: &'a [Value],
) -> Reachable<'a> {
    if let Some(session) = sessions
        .iter()
        .chain(teammates.iter())
        .find(|session| string_field(session, "id") == Some(session_id))
    {
        let reachability = if matches!(string_field(session, "status"), Some("offline" | "exited"))
        {
            "offline"
        } else {
            "live"
        };
        return Reachable {
            reachability,
            live_label: session_live_label(session),
            attention_score: session_attention_score(session),
        };
    }
    if let Some(service) = services
        .iter()
        .find(|service| string_field(service, "id") == Some(session_id))
    {
        return Reachable {
            reachability: if string_field(service, "status") == Some("running") {
                "live"
            } else {
                "offline"
            },
            live_label: None,
            attention_score: 0,
        };
    }
    Reachable {
        reachability: "missing",
        live_label: None,
        attention_score: 0,
    }
}

fn build_model_item(
    key: &str,
    session_id: Option<&str>,
    group: Vec<Value>,
    reachable: Reachable<'_>,
    threads: &[Value],
) -> Value {
    let mut unread = group
        .iter()
        .filter(|notification| bool_field(notification, "unread"))
        .cloned()
        .collect::<Vec<_>>();
    unread.sort_by(|left, right| {
        string_field(right, "createdAt")
            .unwrap_or("")
            .cmp(string_field(left, "createdAt").unwrap_or(""))
    });
    let latest_unread = unread.first().cloned();
    let thread = session_id.and_then(|session_id| thread_for_session(session_id, threads));
    let pending_deliveries = thread
        .map(|thread| integer_field(thread, "pendingDeliveries"))
        .unwrap_or_default();
    let has_unread_needs_input = group.iter().any(|notification| {
        bool_field(notification, "unread")
            && string_field(notification, "kind") == Some(NEEDS_INPUT_KIND)
    });
    let stale = reachable.reachability == "live"
        && is_notification_stale(reachable.live_label, has_unread_needs_input);
    let actionable = reachable.reachability != "missing"
        && (!unread.is_empty() || pending_deliveries > 0)
        && !stale;
    let bucket = model_bucket(reachable.reachability, actionable, stale);
    let urgency = (10 - bucket) * BUCKET_STRIDE
        + reachable.attention_score * 1000
        + unread.len() as i64 * 10
        + pending_deliveries * 5;
    let title = latest_unread
        .as_ref()
        .and_then(|notification| string_field(notification, "title"))
        .or_else(|| group.first().and_then(|item| string_field(item, "title")))
        .unwrap_or("aimux");
    let mut item = Map::new();
    insert_string(&mut item, "key", key);
    insert_optional(&mut item, "sessionId", session_id);
    insert_string(&mut item, "title", title);
    insert_string(&mut item, "reachability", reachable.reachability);
    insert_optional(&mut item, "liveLabel", reachable.live_label);
    item.insert(
        "attentionScore".into(),
        Value::from(reachable.attention_score),
    );
    item.insert("urgency".into(), Value::from(urgency));
    item.insert("notifications".into(), Value::Array(group));
    item.insert("unreadCount".into(), Value::from(unread.len()));
    if let Some(latest_unread) = latest_unread {
        item.insert("latestUnread".into(), latest_unread);
    }
    if let Some(thread) = thread {
        item.insert("thread".into(), thread.clone());
    }
    item.insert("pendingDeliveries".into(), Value::from(pending_deliveries));
    item.insert("actionable".into(), Value::Bool(actionable));
    item.insert("stale".into(), Value::Bool(stale));
    Value::Object(item)
}

fn thread_for_session<'a>(session_id: &str, threads: &'a [Value]) -> Option<&'a Value> {
    let mut selected = None;
    for entry in threads.iter().filter(|entry| {
        let thread = entry.get("thread").unwrap_or(&Value::Null);
        string_array(thread, "participants")
            .iter()
            .any(|participant| participant == session_id)
            || string_field(thread, "owner") == Some(session_id)
            || string_array(thread, "waitingOn")
                .iter()
                .any(|participant| participant == session_id)
    }) {
        if selected.is_none_or(|current| {
            integer_field(entry, "urgency") > integer_field(current, "urgency")
        }) {
            selected = Some(entry);
        }
    }
    selected
}

pub fn is_notification_stale(live_label: Option<&str>, has_unread_needs_input: bool) -> bool {
    has_unread_needs_input
        && live_label.is_some_and(|label| {
            !matches!(
                label,
                "needs_input" | "needs_response" | "blocked" | "error"
            )
        })
}

fn notification_records(exchange: &Value) -> Vec<Value> {
    let mut records = array_field(exchange, "threads")
        .iter()
        .filter(|thread| {
            string_array(thread, "tags")
                .iter()
                .any(|tag| tag == NOTIFICATION_TAG)
        })
        .filter_map(|thread| {
            let thread_id = string_field(thread, "id")?;
            let message = latest_message(exchange, thread_id)?;
            Some(notification_record(exchange, thread, message))
        })
        .filter(|record| !bool_field(record, "cleared"))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        string_field(right, "createdAt")
            .unwrap_or("")
            .cmp(string_field(left, "createdAt").unwrap_or(""))
    });
    records
}

fn notification_record(exchange: &Value, thread: &Value, message: &Value) -> Value {
    let thread_id = string_field(thread, "id").unwrap_or("");
    let entry = array_field(exchange, "inbox").iter().find(|entry| {
        string_field(entry, "subjectKind") == Some("thread")
            && string_field(entry, "subjectId") == Some(thread_id)
    });
    let mut record = Map::new();
    insert_string(
        &mut record,
        "id",
        metadata_string(message, "notificationRecordId").unwrap_or(thread_id),
    );
    insert_string(
        &mut record,
        "title",
        string_field(thread, "title").unwrap_or(""),
    );
    insert_optional(
        &mut record,
        "subtitle",
        metadata_string(message, "notificationSubtitle"),
    );
    insert_string(
        &mut record,
        "body",
        string_field(message, "body").unwrap_or(""),
    );
    for (field, metadata_key) in [
        ("sessionId", "notificationSessionId"),
        ("targetKey", "notificationTargetKey"),
        ("targetKind", "notificationTargetKind"),
        ("kind", "notificationKind"),
        ("projectName", "notificationProjectName"),
        ("projectRoot", "notificationProjectRoot"),
        ("worktreePath", "notificationWorktreePath"),
        ("worktreeName", "notificationWorktreeName"),
        ("branch", "notificationBranch"),
        ("categoryLabel", "notificationCategoryLabel"),
        ("reasonLabel", "notificationReasonLabel"),
    ] {
        insert_optional(&mut record, field, metadata_string(message, metadata_key));
    }
    record.insert(
        "unread".into(),
        Value::Bool(entry.is_some_and(|entry| string_field(entry, "state") != Some("done"))),
    );
    record.insert(
        "cleared".into(),
        Value::Bool(metadata_boolean(message, "notificationCleared")),
    );
    insert_string(
        &mut record,
        "createdAt",
        string_field(thread, "createdAt").unwrap_or(""),
    );
    insert_string(
        &mut record,
        "updatedAt",
        string_field(thread, "updatedAt").unwrap_or(""),
    );
    insert_optional(
        &mut record,
        "dedupeKey",
        metadata_string(message, "notificationDedupeKey"),
    );
    if let Some(interaction) = notification_interaction(message) {
        record.insert("interaction".into(), interaction);
    }
    Value::Object(record)
}

fn notification_interaction(message: &Value) -> Option<Value> {
    let id = metadata_string(message, "notificationInteractionId")?;
    let interaction_type = metadata_string(message, "notificationInteractionType")?;
    let mut interaction = Map::new();
    insert_string(&mut interaction, "id", id);
    insert_string(&mut interaction, "type", interaction_type);
    insert_optional(
        &mut interaction,
        "summary",
        metadata_string(message, "notificationInteractionSummary"),
    );
    interaction.insert(
        "telemetry".into(),
        Value::Bool(metadata_boolean(
            message,
            "notificationInteractionTelemetry",
        )),
    );
    insert_optional(
        &mut interaction,
        "toolName",
        metadata_string(message, "notificationInteractionToolName"),
    );
    insert_optional(
        &mut interaction,
        "toolInputJSON",
        metadata_string(message, "notificationInteractionToolInputJSON"),
    );
    Some(Value::Object(interaction))
}

fn latest_message<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    array_field(exchange, "messages")
        .iter()
        .filter(|message| string_field(message, "threadId") == Some(thread_id))
        .max_by(|left, right| {
            string_field(left, "ts")
                .unwrap_or("")
                .cmp(string_field(right, "ts").unwrap_or(""))
        })
}

fn session_live_label(session: &Value) -> Option<&str> {
    session
        .get("semantic")
        .and_then(|semantic| semantic.get("user"))
        .and_then(|user| string_field(user, "label"))
        .or_else(|| {
            let attention = string_field(session, "attention");
            if matches!(
                attention,
                Some("error" | "blocked" | "needs_input" | "needs_response")
            ) {
                return attention;
            }
            match string_field(session, "activity") {
                Some("error") => Some("error"),
                Some("done") => Some("done"),
                Some("interrupted") => Some("interrupted"),
                Some("running" | "waiting") => Some("working"),
                _ if matches!(string_field(session, "status"), Some("offline" | "exited")) => {
                    Some("offline")
                }
                _ if string_field(session, "status") == Some("running") => Some("ready"),
                _ => Some("idle"),
            }
        })
}

fn session_attention_score(session: &Value) -> i64 {
    session
        .get("semantic")
        .and_then(|semantic| semantic.get("presentation"))
        .and_then(|presentation| presentation.get("attentionScore"))
        .and_then(Value::as_i64)
        .unwrap_or_else(|| match string_field(session, "attention") {
            Some("error") => 5,
            Some("needs_input" | "needs_response") => 4,
            Some("blocked") => 3,
            _ => 0,
        })
}

fn pending_recipients(message: &Value) -> Vec<String> {
    let delivered = string_array(message, "deliveredTo");
    string_array(message, "to")
        .into_iter()
        .filter(|recipient| !delivered.iter().any(|delivered| delivered == recipient))
        .collect()
}

fn notification_bucket(item: &Value) -> &'static str {
    if string_field(item, "reachability") == Some("missing") {
        "unreachable"
    } else if bool_field(item, "stale") || !bool_field(item, "actionable") {
        "handled"
    } else if string_field(item, "reachability") == Some("offline") {
        "asleep"
    } else {
        "awake"
    }
}

fn notification_urgency(item: &Value, bucket: &str) -> i64 {
    bucket_urgency(
        bucket,
        integer_field(item, "attentionScore") * 100
            + integer_field(item, "unreadCount") * 10
            + integer_field(item, "pendingDeliveries") * 5,
    )
}

fn bucket_urgency(bucket: &str, secondary: i64) -> i64 {
    bucket_rank(bucket) * BUCKET_STRIDE + secondary.clamp(0, BUCKET_STRIDE - 1)
}

fn bucket_rank(bucket: &str) -> i64 {
    match bucket {
        "awake" => 4,
        "asleep" => 3,
        "handled" => 2,
        "unreachable" => 1,
        _ => 0,
    }
}

fn model_bucket(reachability: &str, actionable: bool, stale: bool) -> i64 {
    if actionable && reachability == "live" {
        0
    } else if actionable && reachability == "offline" {
        1
    } else if actionable {
        2
    } else if stale {
        3
    } else if reachability == "missing" {
        5
    } else {
        4
    }
}

fn thread_type(kind: &str) -> &str {
    match kind {
        "task" | "review" | "handoff" | "conversation" => kind,
        _ => "conversation",
    }
}

fn latest_unread_at(item: &Value) -> &str {
    item.get("latestUnread")
        .and_then(|latest| string_field(latest, "createdAt"))
        .unwrap_or("")
}

fn push_group(groups: &mut Vec<(String, Vec<Value>)>, key: &str, value: Value) {
    if let Some((_, values)) = groups.iter_mut().find(|(existing, _)| existing == key) {
        values.push(value);
    } else {
        groups.push((key.to_owned(), vec![value]));
    }
}

fn service_info() -> Value {
    get_project_service_manifest()
        .ok()
        .and_then(|manifest| serde_json::to_value(manifest).ok())
        .unwrap_or_else(|| json!({}))
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn integer_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn metadata_string<'a>(message: &'a Value, key: &str) -> Option<&'a str> {
    message
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn metadata_boolean(message: &Value, key: &str) -> bool {
    message
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        insert_string(map, key, value);
    }
}
