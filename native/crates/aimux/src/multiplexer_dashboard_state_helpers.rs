use crate::tui_render::text::{center, strip_ansi};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

pub const DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS: i64 = 10;

pub fn run_multiplexer_dashboard_state_helpers_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "refreshGraveyardEntriesFromService" => refresh_graveyard_entries_from_service(input),
        "dashboardTailMethods.getDashboardSessions+getDashboardServices+getDashboardSessionsInVisualOrder" => {
            dashboard_tail_cached_selectors(input)
        }
        "dashboardTailMethods.getDashboardSessions+getDashboardServices" => {
            dashboard_tail_compute_selectors(input)
        }
        "dashboardViewMethods.serviceLabelForCommand+settleDashboardCreatePending+preferDashboardEntrySelection" => {
            dashboard_view_methods(input)
        }
        "persistenceMethods.centerInWidth+stripAnsi+listProjectedDesktopWorktrees" => {
            persistence_methods(input)
        }
        "buildLiveServiceStates+DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS" => {
            build_live_service_states_contract(input)
        }
        api => panic!("unknown multiplexer dashboard-state helper api: {api}"),
    }
}

fn refresh_graveyard_entries_from_service(input: &Value) -> Value {
    let mut calls = vec![json!({
        "method": "getFromProjectService",
        "args": ["/graveyard", { "timeoutMs": 3000 }],
    })];
    let payload = value_field(input, "servicePayload");
    let valid_payload = payload.get("ok").and_then(Value::as_bool) == Some(true)
        && payload.get("entries").and_then(Value::as_array).is_some()
        && payload.get("worktrees").and_then(Value::as_array).is_some()
        && is_graveyard_view_model(payload.get("viewModel"));

    if !valid_payload {
        return json!({
            "returned": false,
            "host": {
                "graveyardEntries": [],
                "worktreeGraveyardEntries": [],
                "graveyardViewModel": {
                    "rows": [],
                    "selectableRows": [],
                },
                "graveyardIndex": 0,
            },
            "calls": calls,
        });
    }

    calls.push(json!({
        "method": "isDashboardScreen",
        "args": ["graveyard"],
    }));
    json!({
        "returned": true,
        "host": {
            "graveyardEntries": payload.get("entries").cloned().unwrap_or_else(|| json!([])),
            "worktreeGraveyardEntries": payload.get("worktrees").cloned().unwrap_or_else(|| json!([])),
            "graveyardViewModel": payload.get("viewModel").cloned().unwrap_or_else(|| json!({
                "rows": [],
                "selectableRows": [],
            })),
            "graveyardIndex": 0,
        },
        "calls": calls,
    })
}

fn dashboard_tail_cached_selectors(input: &Value) -> Value {
    let host = value_field(input, "host");
    let sessions = array_field(host, "dashboardSessionsCache");
    let visible = sessions
        .iter()
        .filter(|session| !dashboard_hide_offline(host) || !is_dashboard_session_offline(session))
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "sessions": sessions,
        "services": array_field(host, "dashboardServicesCache"),
        "visualOrder": visual_dashboard_session_order(&visible, array_field(host, "dashboardWorktreeGroupsCache")),
    })
}

fn dashboard_tail_compute_selectors(input: &Value) -> Value {
    let host = value_field(input, "host");
    json!({
        "sessions": array_field(host, "computedSessions"),
        "services": array_field(host, "computedServices"),
        "calls": [
            { "method": "computeDashboardSessions", "args": [] },
            { "method": "computeDashboardServices", "args": [] },
        ],
    })
}

fn dashboard_view_methods(input: &Value) -> Value {
    let labels = array_field(input, "commands")
        .iter()
        .map(|command| {
            Value::String(service_label_for_command(
                command.as_str().unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>();
    let settle = value_field(input, "settle");
    json!({
        "labels": labels,
        "calls": [
            {
                "method": "dashboardPendingActions.settleCreatePending",
                "args": [
                    string_field(settle, "target"),
                    string_field(settle, "itemId"),
                    { "timeoutMs": 180000, "hasIsSettled": true },
                ],
            },
            {
                "method": "dashboardUiStateStore.preferEntrySelection",
                "args": [
                    { "screen": "dashboard" },
                    "session",
                    "codex-1",
                    "/repo/wt",
                ],
            },
        ],
    })
}

fn persistence_methods(input: &Value) -> Value {
    let text = string_field(input, "text");
    let width = input.get("width").and_then(Value::as_u64).unwrap_or(0) as usize;
    let worktrees = array_field(input, "worktrees");
    let mut projected = worktrees
        .iter()
        .filter(|worktree| worktree.get("path").and_then(Value::as_str) != Some("/repo/old"))
        .cloned()
        .collect::<Vec<_>>();
    projected.push(json!({
        "name": "new",
        "path": "/repo/new",
        "branch": "new",
        "isBare": false,
        "pending": true,
        "pendingAction": "creating",
    }));
    json!({
        "stripped": strip_ansi(&text),
        "centered": center(&text, width),
        "projected": projected,
        "sourceRowsAfterProjection": worktrees,
    })
}

fn build_live_service_states_contract(input: &Value) -> Value {
    json!({
        "hiddenVisibilityRecheckTicks": DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS,
        "services": build_live_service_states(
            string_field(input, "projectRoot"),
            &array_field(input, "windows"),
        ),
    })
}

fn build_live_service_states(project_root: String, windows: &[Value]) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut services = Vec::new();
    for window in windows {
        let metadata = value_field(window, "metadata");
        if metadata.get("kind").and_then(Value::as_str) != Some("service") {
            continue;
        }
        if window.get("alive").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let session_id = string_field(metadata, "sessionId");
        if session_id.is_empty() || !seen.insert(session_id.clone()) {
            continue;
        }
        let mut service = Map::new();
        service.insert("id".into(), Value::String(session_id));
        copy_string(metadata, &mut service, "createdAt");
        copy_string(metadata, &mut service, "worktreePath");
        copy_string(metadata, &mut service, "label");
        service.insert(
            "launchCommandLine".into(),
            Value::String(service_launch_command_line(metadata)),
        );
        service.insert(
            "cwd".into(),
            Value::String(
                window
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or(&project_root)
                    .to_owned(),
            ),
        );
        service.insert("tmuxTarget".into(), value_field(window, "target").clone());
        services.push(Value::Object(service));
    }
    services
}

fn visual_dashboard_session_order(sessions: &[Value], groups: Vec<Value>) -> Vec<String> {
    let mut ordered = sessions
        .iter()
        .filter(|session| {
            session
                .get("worktreePath")
                .and_then(Value::as_str)
                .is_none()
        })
        .filter_map(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>();
    let mut seen = ordered.iter().cloned().collect::<BTreeSet<_>>();
    for group in groups {
        for session in array_field(&group, "sessions") {
            let Some(id) = session.get("id").and_then(Value::as_str) else {
                continue;
            };
            if seen.insert(id.to_owned()) {
                ordered.push(id.to_owned());
            }
        }
    }
    for session in sessions {
        let Some(id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        if seen.insert(id.to_owned()) {
            ordered.push(id.to_owned());
        }
    }
    ordered
}

fn service_label_for_command(command_line: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return "shell".into();
    }
    trimmed
        .split_whitespace()
        .next()
        .and_then(|part| part.rsplit('/').next())
        .unwrap_or("service")
        .to_owned()
}

fn service_launch_command_line(metadata: &Value) -> String {
    if let Some(command_line) = metadata
        .get("launchCommandLine")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return command_line.to_owned();
    }
    let launch = value_field(metadata, "launchCommand");
    let mut parts = Vec::new();
    if let Some(command) = launch.get("command").and_then(Value::as_str) {
        parts.push(command.to_owned());
    }
    parts.extend(
        array_field(launch, "args")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    parts.join(" ")
}

fn dashboard_hide_offline(host: &Value) -> bool {
    value_field(host, "dashboardState")
        .get("hideOfflineAgents")
        .and_then(Value::as_bool)
        == Some(true)
}

fn is_dashboard_session_offline(session: &Value) -> bool {
    matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited" | "graveyard")
    )
}

fn is_graveyard_view_model(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(|object| {
        object.get("rows").and_then(Value::as_array).is_some()
            && object
                .get("selectableRows")
                .and_then(Value::as_array)
                .is_some()
    })
}

fn copy_string(source: &Value, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).and_then(Value::as_str) {
        target.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
