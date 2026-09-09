use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const DASHBOARD_ARGS: [&str; 2] = ["--tmux-dashboard-internal", "__dashboard-internal-native"];
const NATIVE_BUILD_PREFIX: &str = "/.aimux/native/";

pub fn run_dashboard_orphans_contract_case(input: &Value) -> Value {
    match string_field(input, "api") {
        "dashboardBuildOf" => Value::Array(
            value_array(input, "args")
                .iter()
                .map(|args| {
                    let args = args.as_str().unwrap_or_default();
                    json!({ "args": args, "build": dashboard_build_of(args) })
                })
                .collect(),
        ),
        "isDashboardProcessArgs" => Value::Array(
            value_array(input, "args")
                .iter()
                .map(|args| {
                    let args = args.as_str().unwrap_or_default();
                    json!({ "args": args, "dashboard": is_dashboard_process_args(args) })
                })
                .collect(),
        ),
        "selectStaleDashboards" => Value::Array(select_stale_dashboards(
            value_array(input, "processes"),
            string_field(input, "currentBuild"),
            number_field_i64(input, "currentPid").unwrap_or_default(),
        )),
        "selectOrphanedDashboards" => Value::Array(select_orphaned_dashboards(
            value_array(input, "processes"),
            parent_map(input),
            number_field_i64(input, "currentPid").unwrap_or_default(),
            number_set(input, "livePanePids"),
        )),
        api => panic!("unknown dashboard-orphans api: {api}"),
    }
}

fn dashboard_build_of(args: &str) -> Option<String> {
    let start = args.find(NATIVE_BUILD_PREFIX)? + NATIVE_BUILD_PREFIX.len();
    let tail = &args[start..];
    let end = tail
        .char_indices()
        .find_map(|(index, ch)| (ch == '/' || ch.is_whitespace()).then_some(index))
        .unwrap_or(tail.len());
    (end > 0).then(|| tail[..end].to_owned())
}

fn is_dashboard_process_args(args: &str) -> bool {
    DASHBOARD_ARGS
        .iter()
        .any(|entrypoint| args.contains(entrypoint))
}

fn select_stale_dashboards(
    processes: Vec<Value>,
    current_build: &str,
    current_pid: i64,
) -> Vec<Value> {
    if current_build.trim().is_empty() {
        return Vec::new();
    }
    processes
        .into_iter()
        .filter(|process| {
            if number_field_i64(process, "pid") == Some(current_pid) {
                return false;
            }
            let args = string_field(process, "args");
            if !is_dashboard_process_args(args) {
                return false;
            }
            dashboard_build_of(args)
                .map(|build| build != current_build)
                .unwrap_or(false)
        })
        .collect()
}

fn select_orphaned_dashboards(
    processes: Vec<Value>,
    parents: BTreeMap<i64, i64>,
    current_pid: i64,
    live_pane_pids: BTreeSet<i64>,
) -> Vec<Value> {
    processes
        .into_iter()
        .filter(|process| {
            if number_field_i64(process, "pid") == Some(current_pid) {
                return false;
            }
            if !is_dashboard_process_args(string_field(process, "args")) {
                return false;
            }
            let Some(shell) = number_field_i64(process, "pid").and_then(|pid| parents.get(&pid))
            else {
                return false;
            };
            let grandparent = parents.get(shell);
            if grandparent == Some(&1) {
                return true;
            }
            !live_pane_pids.is_empty()
                && !has_live_pane_ancestor(
                    number_field_i64(process, "pid").unwrap_or_default(),
                    &parents,
                    &live_pane_pids,
                )
        })
        .collect()
}

fn has_live_pane_ancestor(
    pid: i64,
    parents: &BTreeMap<i64, i64>,
    live_pane_pids: &BTreeSet<i64>,
) -> bool {
    let mut seen = BTreeSet::new();
    let mut current = Some(pid);
    while let Some(pid) = current {
        if pid <= 1 || seen.contains(&pid) {
            break;
        }
        if live_pane_pids.contains(&pid) {
            return true;
        }
        seen.insert(pid);
        current = parents.get(&pid).copied();
    }
    false
}

fn parent_map(input: &Value) -> BTreeMap<i64, i64> {
    value_array(input, "parents")
        .into_iter()
        .filter_map(|pair| {
            let values = pair.as_array()?;
            Some((values.first()?.as_i64()?, values.get(1)?.as_i64()?))
        })
        .collect()
}

fn number_set(input: &Value, field: &str) -> BTreeSet<i64> {
    value_array(input, field)
        .into_iter()
        .filter_map(|value| value.as_i64())
        .collect()
}

fn value_array(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {field}"))
}

fn number_field_i64(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}
