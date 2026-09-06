use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub fn run_lifecycle_orphans_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "isLifecycleValidationProcessArgs" => json!(is_lifecycle_validation_process_args(
            str_field(input, "args")
        )),
        "isLifecycleValidationTmuxSession" => json!(is_lifecycle_validation_tmux_session(
            str_field(input, "sessionName"),
            input.get("tmux").unwrap_or(&Value::Null),
        )),
        "cleanupLifecycleValidationOrphans" => cleanup_lifecycle_validation_orphans(input),
        _ => panic!("unknown lifecycle orphans contract api: {api}"),
    }
}

fn is_lifecycle_validation_process_args(args: &str) -> bool {
    has_direct_validation_native_node_entry(args)
        || (has_aimux_native_entry(args) && has_validation_home(args))
}

fn has_direct_validation_native_node_entry(args: &str) -> bool {
    let tokens = args.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if *token != "node" && !token.ends_with("/node") {
            continue;
        }
        let mut candidate_index = index + 1;
        while tokens
            .get(candidate_index)
            .is_some_and(|candidate| candidate.starts_with("--"))
        {
            candidate_index += 1;
        }
        let Some(candidate) = tokens.get(candidate_index) else {
            continue;
        };
        if is_validation_native_entry(candidate) {
            return true;
        }
    }
    false
}

fn is_validation_native_entry(path: &str) -> bool {
    let Some(native_tail) = path.split("/.aimux/native/local-").nth(1) else {
        return false;
    };
    let Some((build, rest)) = native_tail.split_once('/') else {
        return false;
    };
    let Some((prefix, suffix)) = build.split_once("-lifecycle-") else {
        return false;
    };
    !prefix.is_empty()
        && prefix.chars().all(|ch| ch.is_ascii_hexdigit())
        && (suffix.starts_with("validate") || suffix.starts_with("visible"))
        && (rest.starts_with("dist/launcher-bin.js") || rest.starts_with("dist/main.js"))
}

fn has_aimux_native_entry(args: &str) -> bool {
    args.contains("/.aimux/native/")
        && (args.contains("/dist/launcher-bin.js") || args.contains("/dist/main.js"))
}

fn has_validation_home(args: &str) -> bool {
    args.contains("/tmp/aimux-home-validate") || args.contains("/tmp/aimux-home-lifecycle")
}

fn is_lifecycle_validation_tmux_session(session_name: &str, tmux: &Value) -> bool {
    if is_validation_session_name(session_name) {
        return true;
    }
    let project_root = tmux_option(tmux, session_name, "@aimux-project-root");
    let state_dir = tmux_option(tmux, session_name, "@aimux-project-state-dir");
    is_validation_option(&project_root) || is_validation_option(&state_dir)
}

fn is_validation_session_name(session_name: &str) -> bool {
    let body = session_name.strip_prefix("aimux-").unwrap_or(session_name);
    let body = body.strip_prefix("aimux-").unwrap_or(body);
    body.starts_with("lifecycle-validate")
        || body.starts_with("lifecycle-visible")
        || body.starts_with("smoke-lifecycle-validate")
        || body.starts_with("smoke-lifecycle-visible")
}

fn is_validation_option(value: &str) -> bool {
    value.contains("/tmp/aimux-validate")
        || value.contains("/tmp/aimux-lifecycle")
        || value.contains("/tmp/aimux-home-validate")
        || value.contains("/tmp/aimux-home-lifecycle")
}

fn cleanup_lifecycle_validation_orphans(input: &Value) -> Value {
    let current_pid = number_field(input, "currentPid");
    let tmux = input.get("tmux").unwrap_or(&Value::Null);
    let mut killed_sessions = Vec::<Value>::new();
    let mut attempted_tmux_sessions = Vec::<String>::new();
    let mut tmux_sessions = Vec::<String>::new();
    let failed_tmux_sessions = Vec::<String>::new();
    let mut errors = Vec::<String>::new();

    if bool_field(tmux, "available") {
        for session_name in unique_sorted_strings(
            array_field(tmux, "sessions")
                .iter()
                .filter_map(Value::as_str),
        ) {
            if !is_lifecycle_validation_tmux_session(&session_name, tmux) {
                continue;
            }
            attempted_tmux_sessions.push(session_name.clone());
            killed_sessions.push(json!(session_name));
            tmux_sessions.push(session_name);
        }
    }

    let processes = array_field(input, "processes");
    let parents = parent_map(input);
    let live_pane_pids = int_set(array_field(input, "livePanePids"));
    let orphaned_dashboard_pids =
        select_orphaned_dashboards(processes, &parents, current_pid, &live_pane_pids)
            .into_iter()
            .collect::<HashSet<_>>();
    let mut candidate_pids = processes
        .iter()
        .filter_map(|entry| {
            let pid = number_field(entry, "pid");
            let args = str_field(entry, "args");
            if pid == current_pid {
                None
            } else if is_lifecycle_validation_process_args(args)
                || orphaned_dashboard_pids.contains(&pid)
            {
                Some(pid)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    candidate_pids.sort_unstable();
    candidate_pids.dedup();

    let mut read_counters = HashMap::<i64, usize>::new();
    let mut alive = int_set(array_field(input, "alivePids"));
    let kill_removes_alive = input
        .get("killRemovesAlive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut attempted_process_pids = Vec::<i64>::new();
    let mut process_pids = Vec::<i64>::new();
    let mut failed_process_pids = Vec::<i64>::new();
    let mut killed_processes = Vec::<Value>::new();

    for pid in candidate_pids {
        let latest_args = read_process_args(input, processes, pid, &mut read_counters);
        if latest_args.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                current_pid,
                &live_pane_pids,
            )
        }) {
            continue;
        }
        attempted_process_pids.push(pid);
        killed_processes.push(json!([pid, "SIGTERM"]));
        if kill_removes_alive {
            alive.remove(&pid);
        }
        if !alive.contains(&pid) {
            continue;
        }
        let args_before_kill = read_process_args(input, processes, pid, &mut read_counters);
        if args_before_kill.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                current_pid,
                &live_pane_pids,
            )
        }) {
            failed_process_pids.push(pid);
            errors.push(format!("pid {pid}: command changed before SIGKILL"));
            continue;
        }
        killed_processes.push(json!([pid, "SIGKILL"]));
        if kill_removes_alive {
            alive.remove(&pid);
        }
        if !alive.contains(&pid) {
            process_pids.push(pid);
        } else {
            failed_process_pids.push(pid);
            errors.push(format!("pid {pid}: still alive after SIGKILL"));
        }
    }

    for pid in &attempted_process_pids {
        if !failed_process_pids.contains(pid) && !alive.contains(pid) && !process_pids.contains(pid)
        {
            process_pids.push(*pid);
        }
    }

    json!({
        "result": {
            "attemptedProcessPids": unique_sorted_numbers(attempted_process_pids),
            "processPids": unique_sorted_numbers(process_pids),
            "failedProcessPids": unique_sorted_numbers(failed_process_pids),
            "attemptedTmuxSessions": unique_sorted_strings(attempted_tmux_sessions.iter().map(String::as_str)),
            "tmuxSessions": unique_sorted_strings(tmux_sessions.iter().map(String::as_str)),
            "failedTmuxSessions": unique_sorted_strings(failed_tmux_sessions.iter().map(String::as_str)),
            "errors": errors,
        },
        "killedProcesses": killed_processes,
        "killedSessions": killed_sessions,
    })
}

fn is_reapable(
    pid: i64,
    args: &str,
    orphaned_dashboard_pids: &HashSet<i64>,
    parents: &HashMap<i64, i64>,
    current_pid: i64,
    live_pane_pids: &HashSet<i64>,
) -> bool {
    is_lifecycle_validation_process_args(args)
        || (is_dashboard_process_args(args)
            && orphaned_dashboard_pids.contains(&pid)
            && !select_orphaned_dashboards(
                &[json!({ "pid": pid, "args": args })],
                parents,
                current_pid,
                live_pane_pids,
            )
            .is_empty())
}

fn is_dashboard_process_args(args: &str) -> bool {
    args.contains("--tmux-dashboard-internal") || args.contains("__dashboard-internal-native")
}

fn select_orphaned_dashboards(
    processes: &[Value],
    parents: &HashMap<i64, i64>,
    current_pid: i64,
    live_pane_pids: &HashSet<i64>,
) -> Vec<i64> {
    processes
        .iter()
        .filter_map(|entry| {
            let pid = number_field(entry, "pid");
            if pid == current_pid || !is_dashboard_process_args(str_field(entry, "args")) {
                return None;
            }
            let shell = parents.get(&pid)?;
            let grandparent = parents.get(shell);
            if grandparent == Some(&1)
                || !live_pane_pids.is_empty()
                    && !has_live_pane_ancestor(pid, parents, live_pane_pids)
            {
                Some(pid)
            } else {
                None
            }
        })
        .collect()
}

fn has_live_pane_ancestor(
    pid: i64,
    parents: &HashMap<i64, i64>,
    live_pane_pids: &HashSet<i64>,
) -> bool {
    let mut seen = HashSet::new();
    let mut current = Some(pid);
    while let Some(pid) = current {
        if pid <= 1 || seen.contains(&pid) {
            return false;
        }
        if live_pane_pids.contains(&pid) {
            return true;
        }
        seen.insert(pid);
        current = parents.get(&pid).copied();
    }
    false
}

fn read_process_args(
    input: &Value,
    processes: &[Value],
    pid: i64,
    read_counters: &mut HashMap<i64, usize>,
) -> Option<String> {
    if let Some(sequence) = input
        .get("readProcessArgsSequence")
        .and_then(|sequences| sequences.get(pid.to_string()))
        .and_then(Value::as_array)
    {
        let counter = read_counters.entry(pid).or_default();
        let index = (*counter).min(sequence.len().saturating_sub(1));
        *counter += 1;
        return sequence
            .get(index)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    if let Some(args) = input
        .get("readProcessArgs")
        .and_then(|args| args.get(pid.to_string()))
        .and_then(Value::as_str)
    {
        return Some(args.to_string());
    }
    processes
        .iter()
        .find(|entry| number_field(entry, "pid") == pid)
        .and_then(|entry| entry.get("args"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn parent_map(input: &Value) -> HashMap<i64, i64> {
    array_field(input, "parents")
        .iter()
        .filter_map(|entry| {
            let pair = entry.as_array()?;
            Some((pair.first()?.as_i64()?, pair.get(1)?.as_i64()?))
        })
        .collect()
}

fn tmux_option(tmux: &Value, session_name: &str, option: &str) -> String {
    tmux.get("options")
        .and_then(|options| options.get(format!("{session_name}:{option}")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn int_set(values: &[Value]) -> HashSet<i64> {
    values.iter().filter_map(Value::as_i64).collect()
}

fn unique_sorted_numbers(mut values: Vec<i64>) -> Vec<i64> {
    values.retain(|value| *value > 0);
    values.sort_unstable();
    values.dedup();
    values
}

fn unique_sorted_strings<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut values = values
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}
