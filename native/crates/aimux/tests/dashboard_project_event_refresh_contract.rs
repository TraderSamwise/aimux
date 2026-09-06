use aimux::dashboard_project_events::{
    dashboard_project_refresh_work, should_render_after_project_event_refresh,
    DashboardProjectRefreshWork,
};
use aimux::project_api_contract::PROJECT_API_VIEWS;
use serde_json::{json, Value};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-project-event-refresh.contract.v1.json");

#[test]
fn dashboard_project_event_refresh_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard project event refresh contract");
    let cases = contract["cases"].as_array().expect("event refresh cases");
    assert_eq!(cases.len(), 9, "unexpected event refresh case count");

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
        "{} dashboard-project-event-refresh parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let screen = input["screen"].as_str();
    let views = if input["eventName"].as_str() == Some("ready") {
        PROJECT_API_VIEWS
            .iter()
            .map(|view| (*view).to_owned())
            .collect::<Vec<_>>()
    } else {
        input["views"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let work = dashboard_project_refresh_work(&views, screen);
    let applied_refresh = did_refresh_apply(input, &work);
    let mut calls = work
        .iter()
        .map(|work| Value::String(work.as_str().to_owned()))
        .collect::<Vec<_>>();
    if work.contains(&DashboardProjectRefreshWork::Graveyard) && applied_refresh {
        calls.push(Value::String("graveyard-frame".to_owned()));
    }
    let render = should_render_after_project_event_refresh(&work, applied_refresh, true);
    if render {
        calls.push(Value::String("render".to_owned()));
    }
    json!({
        "calls": calls,
        "renders": if render { 1 } else { 0 },
    })
}

fn did_refresh_apply(input: &Value, work: &[DashboardProjectRefreshWork]) -> bool {
    work.iter().any(|item| match item {
        DashboardProjectRefreshWork::DashboardModel => {
            !input["modelThrows"].as_bool().unwrap_or(false)
                && input.get("modelResult").and_then(Value::as_bool) != Some(false)
        }
        DashboardProjectRefreshWork::Coordination => {
            !input["coordinationThrows"].as_bool().unwrap_or(false)
                && input.get("coordinationResult").and_then(Value::as_bool) != Some(false)
        }
        DashboardProjectRefreshWork::Project => input["rejectResource"].as_str() != Some("project"),
        DashboardProjectRefreshWork::Topology => {
            input["rejectResource"].as_str() != Some("topology")
        }
        DashboardProjectRefreshWork::Library => input["rejectResource"].as_str() != Some("library"),
        DashboardProjectRefreshWork::Graveyard => {
            input["rejectResource"].as_str() != Some("graveyard")
        }
    })
}
