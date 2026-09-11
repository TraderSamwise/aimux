use aimux::dashboard_model::{
    DashboardService, DashboardSession, DesktopStateSnapshot, DesktopWorktree, MainCheckoutInfo,
    WorktreeGroup, filter_dashboard_visible_model,
};
use serde::Deserialize;
use serde_json::{Value, json};

const DESKTOP_STATE_COUNTS: &str =
    include_str!("../../../../../testdata/contracts/v1/dashboard/desktop-state-counts.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: CaseInput,
    output: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseInput {
    model: ModelInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInput {
    hide_offline_agents: bool,
    sessions: Vec<DashboardSession>,
    services: Vec<DashboardService>,
    worktree_groups: Vec<WorktreeGroup>,
}

#[test]
fn fixture_dashboard_desktop_state_counts_match_typescript() {
    let contract: Contract =
        serde_json::from_str(DESKTOP_STATE_COUNTS).expect("valid desktop counts fixture");
    assert_eq!(
        contract.cases.len(),
        4,
        "unexpected desktop counts case count"
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        let actual = normalize_dashboard_defaults(run_case(case.input));
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert_eq!(
        failures,
        Vec::<Value>::new(),
        "desktop-state count parity failures"
    );
}

fn run_case(input: CaseInput) -> Value {
    let snapshot = DesktopStateSnapshot {
        sessions: input.model.sessions,
        teammates: Vec::new(),
        services: input.model.services,
        worktrees: Vec::<DesktopWorktree>::new(),
        worktree_groups: input.model.worktree_groups,
        main_checkout_info: MainCheckoutInfo {
            name: "Main Checkout".to_owned(),
            branch: "master".to_owned(),
            extra: Default::default(),
        },
        main_checkout_path: None,
        worktree_removal: None,
        worktree_removals: Vec::new(),
        agent_restore_offer: None,
        operation_failures: Vec::new(),
        extra: Default::default(),
    };
    let visible = filter_dashboard_visible_model(&snapshot, input.model.hide_offline_agents);
    json!({
        "hiddenOfflineAgentCount": visible.hidden_offline_agent_count,
        "sessions": visible.snapshot.sessions,
        "services": visible.snapshot.services,
        "worktreeGroups": visible.snapshot.worktree_groups,
    })
}

fn normalize_dashboard_defaults(mut value: Value) -> Value {
    strip_dashboard_defaults(&mut value);
    value
}

fn strip_dashboard_defaults(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                strip_dashboard_defaults(item);
            }
        }
        Value::Object(object) => {
            for nested in object.values_mut() {
                strip_dashboard_defaults(nested);
            }
            remove_bool_default(object, "pending");
            remove_bool_default(object, "optimistic");
            remove_bool_default(object, "notificationStale");
            remove_bool_default(object, "removing");
            remove_null_default(object, "compactHint");
            for field in [
                "unseenCount",
                "threadUnreadCount",
                "threadWaitingOnMeCount",
                "threadWaitingOnThemCount",
                "threadPendingCount",
                "workflowOnMeCount",
                "workflowBlockedCount",
                "workflowFamilyCount",
                "notificationUnreadCount",
                "notificationNeedsInputUnreadCount",
                "activityNewCount",
                "pendingDeliveryCount",
                "waitingOnMeCount",
                "waitingOnThemCount",
                "blockedCount",
                "familyCount",
                "attentionScore",
            ] {
                remove_zero_default(object, field);
            }
            if let Some(Value::Object(user)) = object.get_mut("user") {
                remove_string_default(user, "attention", "none");
            }
            let empty_notifications = object
                .get("notifications")
                .and_then(Value::as_object)
                .is_some_and(|notifications| {
                    notifications
                        .get("unreadCount")
                        .and_then(Value::as_u64)
                        .unwrap_or_default()
                        == 0
                        && notifications.len() == 1
                });
            if empty_notifications {
                object.remove("notifications");
            }
        }
        _ => {}
    }
}

fn remove_bool_default(object: &mut serde_json::Map<String, Value>, field: &str) {
    if object.get(field).and_then(Value::as_bool) == Some(false) {
        object.remove(field);
    }
}

fn remove_zero_default(object: &mut serde_json::Map<String, Value>, field: &str) {
    if object.get(field).and_then(Value::as_u64) == Some(0) {
        object.remove(field);
    }
}

fn remove_null_default(object: &mut serde_json::Map<String, Value>, field: &str) {
    if object.get(field) == Some(&Value::Null) {
        object.remove(field);
    }
}

fn remove_string_default(object: &mut serde_json::Map<String, Value>, field: &str, default: &str) {
    if object.get(field).and_then(Value::as_str) == Some(default) {
        object.remove(field);
    }
}
