use aimux::dashboard_tui_visibility::{
    DashboardTuiVisibilityState, TuiVisibilityReason, consume_dashboard_tui_visibility_wake,
    find_tmux_pane_for_process, mark_dashboard_tui_visible, parse_process_parent_rows,
    parse_process_parents, parse_tmux_pane_rows, parse_tmux_visibility,
    read_dashboard_tui_visibility_for_state, read_tmux_tui_visibility_from_values,
};
use serde_json::{Value, json};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-tui-visibility.contract.v1.json");

#[test]
fn dashboard_tui_visibility_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard tui visibility contract");
    let cases = contract["cases"].as_array().expect("visibility cases");
    assert_eq!(cases.len(), 14, "unexpected visibility case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
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
        "{} dashboard-tui-visibility parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    match case["api"].as_str().expect("case api") {
        "parseTmuxVisibility" => serde_json::to_value(parse_tmux_visibility(
            input["raw"].as_str(),
            input["paneId"].as_str(),
        ))
        .expect("snapshot json"),
        "parseTmuxPaneRows" => serde_json::to_value(parse_tmux_pane_rows(input["raw"].as_str()))
            .expect("pane rows json"),
        "parseProcessParents" => json!(
            parse_process_parent_rows(input["raw"].as_str())
                .into_iter()
                .map(|(pid, ppid)| json!([pid, ppid]))
                .collect::<Vec<_>>()
        ),
        "findTmuxPaneForProcess" => {
            let panes = parse_tmux_pane_rows(input["panes"].as_str());
            let parents = parse_process_parents(input["parents"].as_str());
            serde_json::to_value(find_tmux_pane_for_process(
                &panes,
                &parents,
                input["pid"].as_i64().unwrap_or_default(),
            ))
            .expect("pane json")
        }
        "readTmuxTuiVisibility" => {
            let pane_id = input["env"]["TMUX_PANE"].as_str();
            serde_json::to_value(read_tmux_tui_visibility_from_values(
                pane_id,
                input["directRaw"].as_str(),
                input["directThrows"].as_bool().unwrap_or(false),
                input["panes"].as_str(),
                input["parents"].as_str(),
                input["pid"].as_i64().unwrap_or_default(),
            ))
            .expect("snapshot json")
        }
        "readDashboardTuiVisibilityForHost" => run_host_visibility_case(case),
        "markDashboardTuiVisible" => run_mark_visible_case(),
        other => panic!("unexpected api {other}"),
    }
}

fn run_host_visibility_case(case: &Value) -> Value {
    match case["name"].as_str().expect("case name") {
        "host cache is reused within cache window" => {
            let mut calls = 0;
            let mut state = DashboardTuiVisibilityState::default();
            let first = read_dashboard_tui_visibility_for_state(&mut state, false, 1000, || {
                calls += 1;
                parse_tmux_visibility(Some("1\t0"), Some("%1"))
            });
            let second = read_dashboard_tui_visibility_for_state(&mut state, false, 1100, || {
                calls += 1;
                parse_tmux_visibility(Some("1\t1"), Some("%1"))
            });
            json!({
                "first": first,
                "second": second,
                "calls": calls,
                "host": host_json(&state, true, false),
            })
        }
        "hidden to visible transition records wake" => {
            let mut state = DashboardTuiVisibilityState {
                dashboard_tui_visibility: Some(parse_tmux_visibility(Some("1\t0"), Some("%1"))),
                dashboard_tui_visibility_checked_at: 1000,
                ..DashboardTuiVisibilityState::default()
            };
            let snapshot = read_dashboard_tui_visibility_for_state(&mut state, true, 2000, || {
                parse_tmux_visibility(Some("1\t1"), Some("%1"))
            });
            let first_wake = consume_dashboard_tui_visibility_wake(&mut state);
            let second_wake = consume_dashboard_tui_visibility_wake(&mut state);
            json!({
                "snapshot": snapshot,
                "firstWake": first_wake,
                "secondWake": second_wake,
                "host": host_json(&state, true, true),
            })
        }
        other => panic!("unexpected host visibility case {other}"),
    }
}

fn run_mark_visible_case() -> Value {
    let mut state = DashboardTuiVisibilityState {
        dashboard_tui_visibility: Some(parse_tmux_visibility(Some("1\t0"), Some("%1"))),
        dashboard_tui_visibility_checked_at: 1000,
        dashboard_hidden_visibility_recheck_at: 5000,
        dashboard_hidden_visibility_skip_ticks: 3,
        ..DashboardTuiVisibilityState::default()
    };
    mark_dashboard_tui_visible(&mut state, 2000, Some("%1"));
    let first_wake = consume_dashboard_tui_visibility_wake(&mut state);
    let second_wake = consume_dashboard_tui_visibility_wake(&mut state);
    json!({
        "host": host_json(&state, false, true),
        "firstWake": first_wake,
        "secondWake": second_wake,
    })
}

fn host_json(
    state: &DashboardTuiVisibilityState,
    include_started: bool,
    include_wake_field: bool,
) -> Value {
    let mut host = serde_json::Map::new();
    if include_started {
        host.insert(
            "startedInDashboard".to_owned(),
            Value::Bool(state.started_in_dashboard),
        );
    }
    if let Some(snapshot) = &state.dashboard_tui_visibility {
        host.insert(
            "dashboardTuiVisibility".to_owned(),
            serde_json::to_value(snapshot).expect("snapshot json"),
        );
    }
    if state.dashboard_tui_visibility_checked_at != 0 {
        host.insert(
            "dashboardTuiVisibilityCheckedAt".to_owned(),
            Value::Number(state.dashboard_tui_visibility_checked_at.into()),
        );
    }
    if state.dashboard_hidden_visibility_recheck_at != 0
        || !include_started && state.dashboard_hidden_visibility_skip_ticks == 0
    {
        host.insert(
            "dashboardHiddenVisibilityRecheckAt".to_owned(),
            Value::Number(state.dashboard_hidden_visibility_recheck_at.into()),
        );
    }
    if state.dashboard_hidden_visibility_skip_ticks != 0
        || !include_started && state.dashboard_hidden_visibility_recheck_at == 0
    {
        host.insert(
            "dashboardHiddenVisibilitySkipTicks".to_owned(),
            Value::Number(state.dashboard_hidden_visibility_skip_ticks.into()),
        );
    }
    if state.dashboard_tui_visibility_wake_pending || include_wake_field {
        host.insert(
            "dashboardTuiVisibilityWakePending".to_owned(),
            Value::Bool(state.dashboard_tui_visibility_wake_pending),
        );
    }
    Value::Object(host)
}

#[test]
fn non_dashboard_host_matches_typescript_fallback() {
    let mut state = DashboardTuiVisibilityState {
        started_in_dashboard: false,
        ..DashboardTuiVisibilityState::default()
    };

    assert_eq!(
        read_dashboard_tui_visibility_for_state(&mut state, false, 1000, || {
            panic!("read should not be called")
        }),
        aimux::dashboard_tui_visibility::visible_fallback(None, TuiVisibilityReason::NotTmux)
    );
}
