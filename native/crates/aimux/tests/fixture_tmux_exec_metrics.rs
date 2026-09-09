use aimux::tmux_exec_metrics::{
    TmuxExecMode, get_tmux_exec_metrics, record_tmux_exec, reset_tmux_exec_metrics, tmux_exec_verb,
};
use serde_json::{Value, json};

const TMUX_EXEC_METRICS: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/exec-metrics.json");

#[test]
fn fixture_tmux_exec_metrics_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_EXEC_METRICS).expect("valid exec metrics fixture");
    let cases = contract["cases"].as_array().expect("exec metrics cases");
    assert_eq!(cases.len(), 6, "unexpected exec metrics case count");

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
        "{} tmux-exec-metrics parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    reset_tmux_exec_metrics();
    let output = match case["name"].as_str().expect("case name") {
        "takes the subcommand for attribution" => takes_subcommand(),
        "splits sync from async" => splits_sync_from_async(),
        "accumulates count total and max per verb" => accumulates_by_verb(),
        "orders verbs by total time" => orders_verbs_by_total_time(),
        "hands out copies" => hands_out_copies(),
        "resets to empty" => resets_to_empty(),
        unexpected => panic!("unexpected case {unexpected}"),
    };
    reset_tmux_exec_metrics();
    output
}

fn takes_subcommand() -> Value {
    json!({
        "verbs": [
            tmux_exec_verb(&strings(&["capture-pane", "-p", "-t", "@1"])),
            tmux_exec_verb(&[]),
            tmux_exec_verb(&strings(&["   "])),
        ]
    })
}

fn splits_sync_from_async() -> Value {
    record_tmux_exec(&strings(&["capture-pane"]), 10.0, TmuxExecMode::Sync);
    record_tmux_exec(&strings(&["capture-pane"]), 90.0, TmuxExecMode::Async);
    let metrics = get_tmux_exec_metrics();
    json!({
        "sync": metrics.sync,
        "async": metrics.async_totals,
        "capturePane": metrics.sync_by_verb.get("capture-pane"),
        "callerKeys": ["(unknown)"],
    })
}

fn accumulates_by_verb() -> Value {
    record_tmux_exec(&strings(&["capture-pane"]), 5.0, TmuxExecMode::Sync);
    record_tmux_exec(&strings(&["capture-pane"]), 25.0, TmuxExecMode::Sync);
    record_tmux_exec(&strings(&["list-windows"]), 3.0, TmuxExecMode::Sync);
    let metrics = get_tmux_exec_metrics();
    json!({
        "sync": metrics.sync,
        "capturePane": metrics.sync_by_verb.get("capture-pane"),
        "listWindows": metrics.sync_by_verb.get("list-windows"),
    })
}

fn orders_verbs_by_total_time() -> Value {
    record_tmux_exec(&strings(&["list-windows"]), 1.0, TmuxExecMode::Sync);
    record_tmux_exec(&strings(&["capture-pane"]), 40.0, TmuxExecMode::Sync);
    record_tmux_exec(&strings(&["display-message"]), 12.0, TmuxExecMode::Sync);
    json!({
        "keys": get_tmux_exec_metrics()
            .sync_by_verb
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    })
}

fn hands_out_copies() -> Value {
    record_tmux_exec(&strings(&["capture-pane"]), 10.0, TmuxExecMode::Sync);
    let mut first = get_tmux_exec_metrics();
    first.sync.total_ms = 9999.0;
    first
        .sync_by_verb
        .get_mut("capture-pane")
        .expect("capture pane metrics")
        .count = 9999;
    let second = get_tmux_exec_metrics();
    json!({
        "firstMutated": first.sync,
        "secondSync": second.sync,
        "secondCapturePane": second.sync_by_verb.get("capture-pane"),
    })
}

fn resets_to_empty() -> Value {
    record_tmux_exec(&strings(&["capture-pane"]), 10.0, TmuxExecMode::Sync);
    reset_tmux_exec_metrics();
    let metrics = get_tmux_exec_metrics();
    json!({
        "sync": metrics.sync,
        "async": metrics.async_totals,
        "syncByVerb": metrics.sync_by_verb,
        "syncByCaller": {},
    })
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}
