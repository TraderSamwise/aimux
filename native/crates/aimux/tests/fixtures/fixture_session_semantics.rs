use aimux::project_service::agents::describe_session_restorability;
use aimux::project_service::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use aimux::session_recency::session_recency_anchor;
use serde_json::{Map, Value, json};

const SESSION_RECENCY: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/session-recency.json");
const SESSION_RESTORABILITY: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/session-restorability.json");
const SESSION_SEMANTICS: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/session-semantics.json");

#[test]
fn fixture_session_recency_matches_typescript() {
    assert_contract(SESSION_RECENCY, 13, |case| {
        session_recency_anchor(&case["input"])
    });
}

#[test]
fn fixture_session_restorability_matches_typescript() {
    assert_contract(SESSION_RESTORABILITY, 5, |case| {
        let tools = case["input"]["tools"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        describe_session_restorability(&case["input"]["session"], &tools).unwrap_or(Value::Null)
    });
}

#[test]
fn fixture_session_semantics_matches_typescript() {
    assert_contract(SESSION_SEMANTICS, 13, session_semantics_contract);
}

fn assert_contract(fixture: &str, expected_count: usize, actual_for: impl Fn(&Value) -> Value) {
    let contract: Value = serde_json::from_str(fixture).expect("valid session fixture");
    let cases = contract["cases"].as_array().expect("session cases");
    assert_eq!(cases.len(), expected_count, "unexpected session case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = actual_for(case);
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
        "{} session parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn session_semantics_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "deriveSessionSemantics" => {
            let input = &case["input"]["input"];
            let raw_status = case["input"]["rawStatus"]
                .as_str()
                .or_else(|| input["status"].as_str())
                .unwrap_or("idle");
            semantic_observation(
                &derive_session_semantics(semantics_input(input)),
                raw_status,
            )
        }
        "sessionDisplayStatusLabel" if case["input"].get("inputs").is_some() => {
            let labels = case["input"]["inputs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(session_display_status_label)
                .collect::<Vec<_>>();
            json!(labels)
        }
        "sessionDisplayStatusLabel" => {
            let semantic =
                derive_session_semantics(semantics_input(&case["input"]["semanticInput"]));
            let pending_displays = case["input"]["pendingActions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|pending_action| {
                    let input = json!({
                        "status": "running",
                        "pendingAction": pending_action,
                        "semantic": semantic,
                    });
                    session_display_status_label(&input)
                })
                .collect::<Vec<_>>();
            json!({
                "semanticDisplay": session_display_status_label(&json!({ "status": "running", "semantic": semantic })),
                "pendingDisplays": pending_displays,
            })
        }
        _ => Value::Null,
    }
}

fn semantic_observation(semantic: &Value, _raw_status: &str) -> Value {
    let mut output = Map::new();
    output.insert(
        "runtimeCanReceiveInput".into(),
        semantic["runtime"]["canReceiveInput"].clone(),
    );
    output.insert("userLabel".into(), semantic["user"]["label"].clone());
    output.insert(
        "userAttention".into(),
        semantic["user"]["attention"].clone(),
    );
    output.insert(
        "orchestrationPressure".into(),
        semantic["orchestration"]["pressure"].clone(),
    );
    output.insert(
        "orchestrationCanBeAssignedWork".into(),
        semantic["orchestration"]["canBeAssignedWork"].clone(),
    );
    output.insert(
        "statusLabel".into(),
        semantic["presentation"]["statusLabel"].clone(),
    );
    output.insert(
        "compactHint".into(),
        semantic["presentation"]["compactHint"].clone(),
    );
    output.insert(
        "attentionScore".into(),
        semantic["presentation"]["attentionScore"].clone(),
    );
    output.insert(
        "notificationUnreadCount".into(),
        semantic["notifications"]["unreadCount"].clone(),
    );
    if let Some(latest_text) = semantic["notifications"].get("latestText") {
        output.insert("notificationLatestText".into(), latest_text.clone());
    }
    output.insert(
        "notificationHasLatestUnread".into(),
        Value::Bool(semantic["notifications"].get("latestUnread").is_some()),
    );
    Value::Object(output)
}

fn semantics_input(input: &Value) -> SessionSemanticsInput {
    SessionSemanticsInput {
        status: string(input, "status").unwrap_or_else(|| "idle".into()),
        pending_action: string(input, "pendingAction"),
        activity: string(input, "activity"),
        attention: string(input, "attention"),
        unseen_count: integer(input, "unseenCount"),
        notification_unread_count: integer(input, "notificationUnreadCount"),
        latest_notification: input.get("latestNotification").cloned(),
        latest_notification_text: string(input, "latestNotificationText"),
        thread_unread_count: integer(input, "threadUnreadCount"),
        thread_pending_count: integer(input, "threadPendingCount"),
        thread_waiting_on_me_count: integer(input, "threadWaitingOnMeCount"),
        thread_waiting_on_them_count: integer(input, "threadWaitingOnThemCount"),
        workflow_on_me_count: integer(input, "workflowOnMeCount"),
        workflow_blocked_count: integer(input, "workflowBlockedCount"),
        workflow_family_count: integer(input, "workflowFamilyCount"),
        has_active_task: input
            .get("hasActiveTask")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn session_display_status_label(input: &Value) -> String {
    if let Some(pending_action) = input.get("pendingAction").and_then(Value::as_str) {
        return pending_action.to_owned();
    }
    if let Some(semantic) = input.get("semantic") {
        return semantic["presentation"]["statusLabel"]
            .as_str()
            .unwrap_or("idle")
            .to_owned();
    }
    match input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
    {
        "waiting" => "thinking".into(),
        status => status.into(),
    }
}

fn string(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn integer(input: &Value, key: &str) -> i64 {
    input.get(key).and_then(Value::as_i64).unwrap_or_default()
}
