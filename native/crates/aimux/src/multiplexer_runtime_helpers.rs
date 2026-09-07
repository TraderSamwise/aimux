use crate::session_launch::resolve_default_scribe_launch;
use crate::tui_render::text::{
    strip_ansi, truncate_ansi, truncate_plain, wrap_key_value, wrap_text,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS: i64 = 120_000;

pub fn run_multiplexer_runtime_helpers_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "dashboardProjectRoot" => dashboard_project_root_case(input),
        "pruneRuntimeGuardRepairAttempts" => prune_runtime_guard_repair_attempts_case(input),
        "handleDashboardSubscreenNavigationKey" => {
            handle_dashboard_subscreen_navigation_key_case(input)
        }
        "renderSessionDetails+textHelpers" => render_session_details_case(input),
        "resolveDefaultScribeLaunch" => resolve_default_scribe_launch_case(input),
        "deriveAimuxSessionIdFromBackendSessionId+summarizeLaunchArgs+injectCodexDeveloperInstructions" => {
            session_launch_helpers_case(input)
        }
        "getSessionsByWorktree+getScopedSessionEntries+getSessionWorktreePath" => {
            session_worktree_helpers_case(input)
        }
        "getSessionLabel+applySessionLabel+applyDashboardSessionLabel" => {
            session_label_helpers_case(input)
        }
        "stripSgr+reconcileAgentActivity+resolveRunningSession" => {
            session_runtime_core_helpers_case(input)
        }
        "attentionScore+getPreferredThreadIndexForParticipant+describeHandoffState" => {
            subscreen_attention_helpers_case(input)
        }
        api => panic!("unknown multiplexer runtime helper api: {api}"),
    }
}

fn dashboard_project_root_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "hosts")
            .iter()
            .map(|host| {
                let project_root = host
                    .get("projectRoot")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                Value::String(if project_root.is_empty() {
                    "<REPO>".into()
                } else {
                    project_root.to_owned()
                })
            })
            .collect(),
    )
}

fn prune_runtime_guard_repair_attempts_case(input: &Value) -> Value {
    let now = input.get("now").and_then(Value::as_i64).unwrap_or_default();
    Value::Array(
        array_field(input, "attempts")
            .iter()
            .filter_map(Value::as_i64)
            .filter(|attempt| now - *attempt < RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS)
            .map(Value::from)
            .collect(),
    )
}

fn handle_dashboard_subscreen_navigation_key_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(|scenario| {
                let current_screen = string_field(scenario, "currentScreen");
                let key = string_field(scenario, "key");
                let shifted = value_field(scenario, "event")
                    .get("shift")
                    .and_then(Value::as_bool)
                    == Some(true);
                let mut calls = Vec::new();
                let mut screen = current_screen.clone();
                let handled = match key.as_str() {
                    "d" if current_screen != "dashboard" && !shifted => {
                        screen = "dashboard".into();
                        calls.extend([
                            call("dashboardState.setScreen", vec![json!("dashboard")]),
                            call("writeDashboardClientStatuslineFile", vec![]),
                            call("persistDashboardUiState", vec![]),
                            call("tmuxRuntimeManager.refreshStatus", vec![]),
                            call("renderDashboard", vec![]),
                        ]);
                        true
                    }
                    "c" if current_screen != "coordination" && !shifted => {
                        calls.push(call("showCoordination", vec![]));
                        true
                    }
                    "p" if current_screen != "project" && !shifted => {
                        calls.push(call("showProject", vec![]));
                        true
                    }
                    "l" if current_screen != "library" && !shifted => {
                        calls.push(call("showLibrary", vec![]));
                        true
                    }
                    "t" if current_screen != "topology" && !shifted => {
                        calls.push(call("showTopology", vec![]));
                        true
                    }
                    "g" if current_screen != "graveyard" && !shifted => {
                        calls.push(call("showGraveyard", vec![]));
                        true
                    }
                    _ => false,
                };
                json!({
                    "scenario": scenario,
                    "handled": handled,
                    "screen": screen,
                    "calls": calls,
                })
            })
            .collect(),
    )
}

fn render_session_details_case(input: &Value) -> Value {
    let session = value_field(input, "session");
    let width = input.get("width").and_then(Value::as_u64).unwrap_or(0) as usize;
    let height = input.get("height").and_then(Value::as_u64).unwrap_or(0) as usize;
    let details = render_session_details(session, width, height);
    json!({
        "details": details,
        "wrapKeyValue": wrap_key_value("Path", "/repo/.aimux/worktrees/feature/subdir", 32),
        "wrapText": wrap_text(&string_field(input, "text"), 18),
        "truncatePlain": truncate_plain(&string_field(input, "text"), 24),
        "truncateAnsi": truncate_ansi(&string_field(input, "ansi"), 12),
        "basename": basename_for_host("/repo/.aimux/worktrees/feature"),
    })
}

fn resolve_default_scribe_launch_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "configs")
            .iter()
            .map(resolve_default_scribe_launch)
            .collect(),
    )
}

fn session_launch_helpers_case(input: &Value) -> Value {
    json!({
        "ids": array_field(input, "backendCases")
            .iter()
            .map(|case| Value::String(derive_aimux_session_id_from_backend_session_id(
                &string_field(case, "command"),
                &string_field(case, "backendSessionId"),
                &array_field(case, "existingIds")
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>(),
            )))
            .collect::<Vec<_>>(),
        "summarized": summarize_launch_args(&array_field(input, "launchArgs")),
        "injected": inject_codex_developer_instructions(
            &array_field(input, "codexArgs"),
            &string_field(input, "developerKey"),
            &string_field(input, "instructions"),
        ),
        "blankInjection": inject_codex_developer_instructions(
            &array_field(input, "codexArgs"),
            "",
            &string_field(input, "instructions"),
        ),
    })
}

fn session_worktree_helpers_case(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let worktrees = worktree_pairs(input);
    let groups = sessions_by_worktree(&sessions, &worktrees);
    json!({
        "worktreePath": worktrees.get("codex-1").cloned().unwrap_or_default(),
        "groups": groups
            .into_iter()
            .map(|(path, ids)| json!({ "path": path, "ids": ids }))
            .collect::<Vec<_>>(),
        "scoped": sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| !is_project_control_session(session))
            .map(|(index, session)| json!({
                "id": string_field(session, "id"),
                "index": index,
            }))
            .collect::<Vec<_>>(),
    })
}

fn session_label_helpers_case(input: &Value) -> Value {
    let mut labels = map_from_pairs(value_field(input, "sessionLabels"));
    let mut offline_sessions = array_field(input, "offlineSessions");
    let mut dashboard_sessions_cache = array_field(input, "dashboardSessionsCache");
    let mut dashboard_worktree_groups_cache = array_field(input, "dashboardWorktreeGroupsCache");
    let mut dashboard_state = value_field(input, "dashboardState").clone();

    let before = json!({
        "live": get_session_label("live-1", &labels, &offline_sessions),
        "offline": get_session_label("offline-1", &labels, &offline_sessions),
        "missing": get_session_label("missing-1", &labels, &offline_sessions),
    });
    apply_session_label(
        "offline-1",
        "  New Offline  ",
        &mut labels,
        &mut offline_sessions,
    );
    apply_session_label("live-1", " ", &mut labels, &mut offline_sessions);
    apply_dashboard_session_label(
        "live-1",
        "  New Dashboard  ",
        &mut dashboard_sessions_cache,
        &mut dashboard_worktree_groups_cache,
        &mut dashboard_state,
    );

    json!({
        "before": before,
        "labels": labels,
        "offlineSessions": offline_sessions,
        "dashboardSessionsCache": dashboard_sessions_cache,
        "dashboardWorktreeGroupsCache": dashboard_worktree_groups_cache,
        "dashboardState": dashboard_state,
    })
}

fn session_runtime_core_helpers_case(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let activities = array_field(input, "activityCases")
        .iter()
        .map(|case| {
            reconcile_agent_activity(
                case.get("reported").and_then(Value::as_str),
                case.get("activityText").and_then(Value::as_str),
                value_field(case, "paneState"),
            )
        })
        .collect::<Vec<_>>();
    let resolve = ["live-1", "exited-1", "missing-1"]
        .iter()
        .map(|id| resolve_running_session(&sessions, id))
        .collect::<Vec<_>>();
    json!({
        "stripped": strip_ansi(&string_field(input, "text")),
        "activities": activities,
        "resolve": resolve,
    })
}

fn subscreen_attention_helpers_case(input: &Value) -> Value {
    let scores = array_field(input, "attentionInputs")
        .iter()
        .map(attention_score)
        .collect::<Vec<_>>();
    let handoff_states = array_field(input, "handoffs")
        .iter()
        .map(describe_handoff_state)
        .collect::<Vec<_>>();
    json!({
        "scores": scores,
        "preferredIndex": preferred_thread_index(&string_field(input, "participant"), &array_field(input, "entries")),
        "missingIndex": preferred_thread_index("missing-1", &array_field(input, "entries")),
        "handoffStates": handoff_states,
    })
}

fn render_session_details(session: &Value, width: usize, height: usize) -> Vec<String> {
    let mut lines = vec!["\x1b[1mDetails\x1b[0m".to_owned()];
    push_key_value(
        &mut lines,
        "Agent",
        string_or(session, "label", "command"),
        width,
    );
    push_key_value(
        &mut lines,
        "Canonical",
        string_or(session, "toolConfigKey", "command"),
        width,
    );
    push_key_value(&mut lines, "Aimux ID", string_field(session, "id"), width);
    if has_string(session, "backendSessionId") {
        push_key_value(
            &mut lines,
            "Backend ID",
            string_field(session, "backendSessionId"),
            width,
        );
    }
    if string_field(session, "command") != string_or(session, "toolConfigKey", "command") {
        push_key_value(
            &mut lines,
            "Command",
            string_field(session, "command"),
            width,
        );
    }
    if has_string(session, "worktreeName") || has_string(session, "worktreeBranch") {
        let mut worktree = string_or_literal(session, "worktreeName", "main");
        if has_string(session, "worktreeBranch") {
            worktree.push_str(" · ");
            worktree.push_str(&string_field(session, "worktreeBranch"));
        }
        push_key_value(&mut lines, "Worktree", worktree, width);
    }
    for key in ["cwd", "prUrl"] {
        if has_string(session, key) {
            let label = match key {
                "cwd" => "CWD",
                "prUrl" => "URL",
                _ => "URL",
            };
            push_key_value(&mut lines, label, string_field(session, key), width);
        }
    }
    if session.get("prNumber").is_some()
        || has_string(session, "prTitle")
        || has_string(session, "prUrl")
    {
        let mut pr = format!(
            "PR #{}",
            session
                .get("prNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default()
        );
        if has_string(session, "prTitle") {
            pr.push_str(": ");
            pr.push_str(&string_field(session, "prTitle"));
        }
        let insert_at = lines
            .iter()
            .position(|line| line.starts_with("URL: "))
            .unwrap_or(lines.len());
        lines.splice(insert_at..insert_at, wrap_key_value("PR", &pr, width));
    }
    if has_string(session, "repoOwner") || has_string(session, "repoName") {
        push_key_value(
            &mut lines,
            "Repo",
            format!(
                "{}/{}",
                string_or_literal(session, "repoOwner", "?"),
                string_or_literal(session, "repoName", "?")
            ),
            width,
        );
    }
    if has_string(session, "repoRemote") {
        push_key_value(
            &mut lines,
            "Remote",
            string_field(session, "repoRemote"),
            width,
        );
    }
    let semantic = value_field(session, "semantic");
    if !semantic.is_null() {
        push_key_value(
            &mut lines,
            "State",
            value_field(value_field(semantic, "presentation"), "statusLabel")
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            width,
        );
        let attention = value_field(value_field(semantic, "user"), "attention")
            .as_str()
            .unwrap_or("none");
        if attention != "none" {
            push_key_value(&mut lines, "Attention", attention.to_owned(), width);
        }
        let notifications = value_field(semantic, "notifications");
        if notifications
            .get("unreadCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
        {
            push_key_value(
                &mut lines,
                "Unread",
                notifications
                    .get("unreadCount")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .to_string(),
                width,
            );
        }
        if has_string(notifications, "latestText") {
            push_key_value(
                &mut lines,
                "Latest",
                string_field(notifications, "latestText"),
                width,
            );
        }
        if semantic
            .get("activityNewCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
        {
            push_key_value(
                &mut lines,
                "New activity",
                semantic
                    .get("activityNewCount")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .to_string(),
                width,
            );
        }
    }
    if has_string(value_field(session, "lastEvent"), "message") {
        push_key_value(
            &mut lines,
            "Last",
            string_field(value_field(session, "lastEvent"), "message"),
            width,
        );
    }
    while lines.len() < height {
        lines.push(String::new());
    }
    lines.truncate(height);
    lines
}

fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: &BTreeSet<String>,
) -> String {
    let command_executable = basename_for_host(command);
    let slug = backend_session_id_slug(backend_session_id);
    for length in 6.min(slug.len())..=16.min(slug.len()) {
        let candidate = format!("{}-{}", command_executable, &slug[..length]);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = hex_sha256(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let fallback_base = format!(
        "{}-{}-{}",
        command_executable,
        &slug[..6.min(slug.len())],
        suffix
    );
    if !existing_ids.contains(&fallback_base) {
        return fallback_base;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{fallback_base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn backend_session_id_slug(backend_session_id: &str) -> String {
    let normalized = backend_session_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        hex_sha256(backend_session_id)
    } else {
        normalized
    }
}

fn summarize_launch_args(args: &[Value]) -> Vec<Value> {
    let mut redact_next = false;
    args.iter()
        .filter_map(Value::as_str)
        .map(|arg| {
            if redact_next {
                redact_next = false;
                return Value::String("<redacted>".into());
            }
            let summarized = summarize_launch_arg(arg);
            redact_next = sensitive_option_arg(arg) && !arg.contains('=');
            Value::String(summarized)
        })
        .collect()
}

fn summarize_launch_arg(arg: &str) -> String {
    if let Some(index) = arg.find('=')
        && (sensitive_option_arg(&arg[..index]) || sensitive_env_arg(&arg[..index]))
    {
        return format!("{}=<redacted>", &arg[..index]);
    }
    if arg.chars().count() > 100 {
        format!("{}...", arg.chars().take(100).collect::<String>())
    } else {
        arg.to_owned()
    }
}

fn inject_codex_developer_instructions(
    args: &[Value],
    key: &str,
    instructions: &str,
) -> Vec<Value> {
    let args = args
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args.into_iter().map(Value::String).collect();
    }
    let index = first_codex_positional_arg_index(&args);
    let mut out = Vec::new();
    out.extend(args[..index].iter().cloned().map(Value::String));
    out.push(Value::String("-c".into()));
    out.push(Value::String(format!(
        "{}={}",
        key,
        serde_json::to_string(instructions).expect("serialize instructions")
    )));
    out.extend(args[index..].iter().cloned().map(Value::String));
    out
}

fn first_codex_positional_arg_index(args: &[String]) -> usize {
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return index;
        }
        if arg.starts_with("--") {
            let (name, has_value) = arg
                .split_once('=')
                .map(|(name, _)| (name, true))
                .unwrap_or((arg, false));
            if codex_option_with_value(name) && !has_value {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if codex_option_with_value(arg) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

fn sessions_by_worktree(
    sessions: &[Value],
    worktrees: &BTreeMap<String, String>,
) -> Vec<(Option<String>, Vec<String>)> {
    let mut groups = Vec::<(Option<String>, Vec<String>)>::new();
    for session in sessions {
        let id = string_field(session, "id");
        let path = worktrees.get(&id).cloned();
        if let Some((_, ids)) = groups.iter_mut().find(|(existing, _)| existing == &path) {
            ids.push(id);
        } else {
            groups.push((path, vec![id]));
        }
    }
    groups
}

fn get_session_label(
    session_id: &str,
    labels: &BTreeMap<String, String>,
    offline_sessions: &[Value],
) -> Value {
    if let Some(label) = labels.get(session_id) {
        return Value::String(label.clone());
    }
    offline_sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .and_then(|session| session.get("label").and_then(Value::as_str))
        .map(|label| Value::String(label.to_owned()))
        .unwrap_or(Value::Null)
}

fn apply_session_label(
    session_id: &str,
    label: &str,
    labels: &mut BTreeMap<String, String>,
    offline_sessions: &mut [Value],
) {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        labels.remove(session_id);
    } else {
        labels.insert(session_id.to_owned(), trimmed.to_owned());
    }
    for session in offline_sessions {
        if session.get("id").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        if let Some(object) = session.as_object_mut() {
            if trimmed.is_empty() {
                object.remove("label");
            } else {
                object.insert("label".into(), Value::String(trimmed.to_owned()));
            }
        }
    }
}

fn apply_dashboard_session_label(
    session_id: &str,
    label: &str,
    dashboard_sessions_cache: &mut [Value],
    dashboard_worktree_groups_cache: &mut [Value],
    dashboard_state: &mut Value,
) {
    let trimmed = label.trim();
    apply_label_to_sessions(dashboard_sessions_cache, session_id, trimmed);
    for group in dashboard_worktree_groups_cache {
        if let Some(sessions) = group.get_mut("sessions").and_then(Value::as_array_mut) {
            apply_label_to_sessions(sessions, session_id, trimmed);
        }
    }
    if let Some(sessions) = dashboard_state
        .get_mut("worktreeSessions")
        .and_then(Value::as_array_mut)
    {
        apply_label_to_sessions(sessions, session_id, trimmed);
    }
}

fn apply_label_to_sessions(sessions: &mut [Value], session_id: &str, label: &str) {
    for session in sessions {
        if session.get("id").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        if let Some(object) = session.as_object_mut() {
            if label.is_empty() {
                object.remove("label");
            } else {
                object.insert("label".into(), Value::String(label.to_owned()));
            }
        }
    }
}

fn reconcile_agent_activity(
    reported: Option<&str>,
    activity_text: Option<&str>,
    pane_state: &Value,
) -> Value {
    if pane_state
        .get("interruptedVisible")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Value::String("interrupted".into());
    }
    let has_activity = activity_text.is_some_and(|text| !text.is_empty());
    if !has_activity {
        return reported.map(Value::from).unwrap_or(Value::Null);
    }
    match reported {
        Some("waiting" | "error" | "interrupted") => Value::String(reported.unwrap().to_owned()),
        _ => Value::String("running".into()),
    }
}

fn resolve_running_session(sessions: &[Value], session_id: &str) -> Value {
    let session = sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id));
    if let Some(session) = session
        && session.get("exited").and_then(Value::as_bool) != Some(true)
    {
        return json!({ "ok": true, "value": session_id });
    }
    json!({ "ok": false, "error": format!("Session \"{session_id}\" is not running") })
}

fn attention_score(entry: &Value) -> Value {
    let semantic = value_field(entry, "semantic");
    let user = value_field(semantic, "user");
    let notifications = value_field(semantic, "notifications");
    let score = match user.get("attention").and_then(Value::as_str) {
        Some("error") => 5,
        Some("needs_input" | "needs_response") => 4,
        Some("blocked") => 3,
        _ if notifications
            .get("unreadCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0 =>
        {
            2
        }
        _ if semantic
            .get("activityNewCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
            || user.get("label").and_then(Value::as_str) == Some("done") =>
        {
            1
        }
        _ => 0,
    };
    Value::from(score)
}

fn preferred_thread_index(participant_id: &str, entries: &[Value]) -> i64 {
    let mut scored = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            array_field(value_field(entry, "thread"), "participants")
                .iter()
                .any(|participant| participant.as_str() == Some(participant_id))
        })
        .map(|(index, entry)| {
            let thread = value_field(entry, "thread");
            let waiting_on_me =
                contains_string(value_field(thread, "waitingOn"), participant_id) as i64 * 3;
            let unread =
                contains_string(value_field(thread, "unreadBy"), participant_id) as i64 * 2;
            let owns_waiting = (thread.get("owner").and_then(Value::as_str) == Some(participant_id)
                && !array_field(thread, "waitingOn").is_empty())
                as i64;
            (
                index,
                string_field(thread, "updatedAt"),
                waiting_on_me + unread + owns_waiting,
            )
        })
        .collect::<Vec<_>>();
    if scored.is_empty() {
        return -1;
    }
    scored.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
    scored[0].0 as i64
}

fn describe_handoff_state(thread: &Value) -> Value {
    if thread.get("status").and_then(Value::as_str) == Some("done") {
        return Value::String(format!(
            "completed by {}",
            thread
                .get("owner")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    let waiting_on = array_field(thread, "waitingOn")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !waiting_on.is_empty() {
        return Value::String(format!(
            "{} waiting on {}",
            thread
                .get("owner")
                .or_else(|| thread.get("createdBy"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
            waiting_on.join(", ")
        ));
    }
    let owner = thread.get("owner").and_then(Value::as_str);
    let created_by = thread.get("createdBy").and_then(Value::as_str);
    if let Some(owner) = owner
        && Some(owner) != created_by
    {
        return Value::String(format!("accepted by {owner}"));
    }
    let recipients = array_field(thread, "participants")
        .iter()
        .filter_map(Value::as_str)
        .filter(|participant| Some(*participant) != created_by)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Value::String(format!(
        "awaiting acceptance from {}",
        if recipients.is_empty() {
            "recipient".into()
        } else {
            recipients.join(", ")
        }
    ))
}

fn push_key_value(lines: &mut Vec<String>, key: &str, value: String, width: usize) {
    lines.extend(wrap_key_value(key, &value, width));
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn map_from_pairs(value: &Value) -> BTreeMap<String, String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some((
                pair.first()?.as_str()?.to_owned(),
                pair.get(1)?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

fn worktree_pairs(input: &Value) -> BTreeMap<String, String> {
    map_from_pairs(value_field(input, "worktreePairs"))
}

fn is_project_control_session(session: &Value) -> bool {
    value_field(session, "team")
        .get("projectControl")
        .and_then(Value::as_bool)
        == Some(true)
}

fn string_or(value: &Value, preferred: &str, fallback: &str) -> String {
    value
        .get(preferred)
        .and_then(Value::as_str)
        .or_else(|| value.get(fallback).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn string_or_literal(value: &Value, preferred: &str, fallback: &str) -> String {
    value
        .get(preferred)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn has_string(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn basename_for_host(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(value)
        .to_owned()
}

fn sensitive_option_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    let lower = lower.trim_start_matches('-');
    [
        "token",
        "secret",
        "password",
        "pass",
        "key",
        "credential",
        "auth",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn sensitive_env_arg(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASS",
        "KEY",
        "CREDENTIAL",
        "AUTH",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn codex_option_with_value(arg: &str) -> bool {
    matches!(
        arg,
        "-a" | "--add-dir"
            | "--ask-for-approval"
            | "-c"
            | "--cd"
            | "--config"
            | "-i"
            | "--image"
            | "--local-provider"
            | "-m"
            | "--model"
            | "-p"
            | "--profile"
            | "--remote"
            | "--remote-auth-token-env"
            | "-s"
            | "--sandbox"
    )
}

fn contains_string(value: &Value, needle: &str) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(needle)))
}

fn hex_sha256(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
