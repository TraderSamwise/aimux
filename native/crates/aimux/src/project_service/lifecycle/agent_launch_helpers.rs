use serde_json::{Value, json};
use std::path::Path;

use super::ids::{sha256_hex, short_id};
use super::json_helpers::{array_field, string_array_field, string_field, trimmed_string};
use super::runtime_adapter::{AsyncProjectLifecycleRuntime, ProjectLifecycleRuntime};
use crate::tool_capabilities::supports_exact_backend_resume;

pub(super) fn tool_config_key_for_session(session: &Value) -> Option<String> {
    trimmed_string(session.get("toolConfigKey"))
        .or_else(|| trimmed_string(session.get("tool")))
        .or_else(|| trimmed_string(session.get("command")))
}

pub(super) fn should_relaunch_agent_fresh(session: &Value, _derived: Option<&Value>) -> bool {
    trimmed_string(session.get("backendSessionId")).is_none()
        && session.get("freshRelaunchAllowed").and_then(Value::as_bool) == Some(true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MissingBackendSessionDisposition {
    Unchanged,
    RecordBackendSession(String),
    AllowFreshRelaunch,
    Blocked(String),
}

pub(super) fn missing_backend_session_disposition(
    runtime: &mut impl ProjectLifecycleRuntime,
    session: &Value,
    project_root: &str,
    topology: &Value,
) -> MissingBackendSessionDisposition {
    let disposition = missing_backend_session_disposition_from_ids(
        session,
        project_root,
        sole_unidentified_claimant(topology, session, project_root),
        |tool_key, cwd, created_after_ms| match tool_key {
            // Claude's id is dictated at launch, so it never reaches the
            // narrowing pass and has no use for the floor.
            "claude" => runtime.claude_backend_session_ids_for_cwd(cwd),
            "codex" => runtime.codex_backend_session_ids_for_cwd(cwd, created_after_ms),
            _ => unreachable!("only tools with transcript discovery reach this callback"),
        },
    );
    match disposition {
        MissingBackendSessionDisposition::RecordBackendSession(id) => {
            if let Some(owner) = backend_session_claimed_by_other(topology, session, &id) {
                MissingBackendSessionDisposition::Blocked(format!(
                    "Discovered conversation already belongs to session {owner}"
                ))
            } else {
                MissingBackendSessionDisposition::RecordBackendSession(id)
            }
        }
        other => other,
    }
}

pub(super) fn missing_backend_session_disposition_async_runtime(
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    session: &Value,
    project_root: &str,
    topology: &Value,
) -> MissingBackendSessionDisposition {
    let disposition = missing_backend_session_disposition_from_ids(
        session,
        project_root,
        sole_unidentified_claimant(topology, session, project_root),
        |tool_key, cwd, created_after_ms| match tool_key {
            // Claude's id is dictated at launch, so it never reaches the
            // narrowing pass and has no use for the floor.
            "claude" => runtime.claude_backend_session_ids_for_cwd(cwd),
            "codex" => runtime.codex_backend_session_ids_for_cwd(cwd, created_after_ms),
            _ => unreachable!("only tools with transcript discovery reach this callback"),
        },
    );
    match disposition {
        MissingBackendSessionDisposition::RecordBackendSession(id) => {
            if let Some(owner) = backend_session_claimed_by_other(topology, session, &id) {
                MissingBackendSessionDisposition::Blocked(format!(
                    "Discovered conversation already belongs to session {owner}"
                ))
            } else {
                MissingBackendSessionDisposition::RecordBackendSession(id)
            }
        }
        other => other,
    }
}

pub(crate) fn backend_session_claimed_by_other(
    topology: &Value,
    session: &Value,
    backend_id: &str,
) -> Option<String> {
    let session_id = string_field(session, "id");
    let tool = tool_config_key_for_session(session);
    array_field(topology, "sessions")
        .into_iter()
        .find(|other| {
            string_field(other, "id") != session_id
                && tool_config_key_for_session(
                    &crate::runtime_topology::topology_session_to_session_state(other, topology),
                ) == tool
                && trimmed_string(other.get("backendSessionId")).as_deref() == Some(backend_id)
        })
        .map(|other| string_field(&other, "id"))
}

/// Whether this agent is the only one in its checkout that could claim a
/// transcript -- restorable, same tool, and with no conversation recorded
/// yet.
///
/// Two such agents cannot be told apart by time alone: if one's own transcript
/// never appeared, the other's survives the floor and gets adopted. Counting
/// them is the whole check, and it needs the topology, which only the callers
/// of this module have.
///
/// "Restorable" is everything that is not graveyarded, rather than a list of
/// the statuses that are. An OFFLINE sibling is the case this missed: it can
/// be restored into its old conversation, so it can still claim one, and
/// leaving it out made this agent look like the only claimant and adopt its
/// transcript -- two agents in one conversation, which the narrowing below
/// calls worse than refusing. A deny-list also fails closed when a new status
/// appears, where an allow-list would silently stop counting it.
///
/// Graveyarded siblings are excluded deliberately -- not because the checkout
/// is gone, which graveyarding a session does not do, but because the stop and
/// resume routes refuse them outright, so they cannot come back to claim
/// anything. Counting them would mean a checkout that ever held an agent could
/// never narrow again.
pub(crate) fn sole_unidentified_claimant(
    topology: &Value,
    session: &Value,
    project_root: &str,
) -> bool {
    let cwd =
        trimmed_string(session.get("worktreePath")).unwrap_or_else(|| project_root.to_owned());
    let tool = tool_config_key_for_session(session);
    let session_id = string_field(session, "id");
    array_field(topology, "sessions")
        .into_iter()
        .filter(|other| string_field(other, "id") != session_id)
        .filter(|other| string_field(other, "status") != "graveyard")
        .filter(|other| trimmed_string(other.get("backendSessionId")).is_none())
        .filter(|other| tool_config_key_for_session(other) == tool)
        // Compared the way DISCOVERY compares checkouts, not by raw string.
        // Two rows whose `worktreePath` differ only by a trailing slash -- or
        // by /tmp versus /private/tmp -- each saw no sibling in "their"
        // checkout while both scans resolved to the same directory, so both
        // could adopt the same transcript in one pass.
        .all(|other| {
            !crate::backend_session_ids::is_same_checkout(
                &trimmed_string(other.get("worktreePath"))
                    .unwrap_or_else(|| project_root.to_owned()),
                &cwd,
            )
        })
}

fn missing_backend_session_disposition_from_ids(
    session: &Value,
    project_root: &str,
    sole_unidentified_claimant: bool,
    mut ids_for_cwd: impl FnMut(
        &str,
        &str,
        Option<u128>,
    ) -> Result<std::collections::BTreeSet<String>, String>,
) -> MissingBackendSessionDisposition {
    if trimmed_string(session.get("backendSessionId")).is_some() {
        return MissingBackendSessionDisposition::Unchanged;
    }
    let Some(tool_key) = tool_config_key_for_session(session) else {
        return MissingBackendSessionDisposition::Blocked(
            "Cannot inspect history for an unknown agent tool".into(),
        );
    };
    let tool_label = match tool_key.as_str() {
        "claude" => "Claude",
        "codex" => "Codex",
        // These tools do not have an exact backend conversation to discover.
        "aider" | "shell" => return MissingBackendSessionDisposition::AllowFreshRelaunch,
        _ => {
            return MissingBackendSessionDisposition::Blocked(format!(
                "Agent tool \"{tool_key}\" has no supported backend history discovery"
            ));
        }
    };
    let cwd =
        trimmed_string(session.get("worktreePath")).unwrap_or_else(|| project_root.to_owned());
    let mut ids = match ids_for_cwd(&tool_key, &cwd, None) {
        Ok(ids) => ids,
        Err(error) => {
            return MissingBackendSessionDisposition::Blocked(format!(
                "{tool_label} session history for {cwd} could not be inspected: {error}"
            ));
        }
    };
    match ids.len() {
        0 => MissingBackendSessionDisposition::AllowFreshRelaunch,
        1 => MissingBackendSessionDisposition::RecordBackendSession(
            ids.pop_first().expect("one discovered backend session"),
        ),
        count if sole_unidentified_claimant => {
            narrow_by_launch_time(session, &tool_key, &cwd, tool_label, count, ids_for_cwd)
        }
        count => MissingBackendSessionDisposition::Blocked(format!(
            "{tool_label} has {count} possible resumable sessions for {cwd} and more than one \
             agent there has no conversation of its own; choose one before restarting"
        )),
    }
}

/// A reused checkout has a transcript per conversation, so "which of these is
/// THIS agent's" is unanswerable by cwd alone -- which is why a worktree you
/// have worked in twice could not be restored at all.
///
/// It is answerable by time: the agent's own conversation is the one opened
/// after the agent was. The floor is the session's `createdAt` and the
/// rollout's own `session_meta` timestamp, never the file's mtime, which keeps
/// moving for as long as anyone is talking.
///
/// Narrowing to NOTHING means every transcript here predates this agent. For
/// THIS caller that is a refusal rather than a licence to start fresh: it is
/// being asked which conversation to resume, and it has no answer.
///
/// The restart guard reads the same state and correctly concludes the
/// opposite, that there is nothing of this agent's to lose. The two are not
/// in conflict because they are asked different questions -- "which one do I
/// reopen" has no answer here, while "is there anything to protect" has the
/// answer no. The guard only treats it that way once an undateable transcript
/// naming the checkout has been ruled out, which is the case this comment
/// used to fold in as "missing or unreadable".
///
/// Narrowing to ONE is not proof that one is THIS agent's, either. If a second
/// id-less agent shares the checkout and its own transcript is missing --
/// codex died before writing `session_meta`, or it was pruned -- the survivor
/// is its neighbour's, and adopting it puts two agents in one conversation.
/// Only the sole unidentified claimant in a checkout may narrow; the caller
/// decides that, because only it can see the other sessions.
fn narrow_by_launch_time(
    session: &Value,
    tool_key: &str,
    cwd: &str,
    tool_label: &str,
    count: usize,
    mut ids_for_cwd: impl FnMut(
        &str,
        &str,
        Option<u128>,
    ) -> Result<std::collections::BTreeSet<String>, String>,
) -> MissingBackendSessionDisposition {
    let ambiguous = || {
        MissingBackendSessionDisposition::Blocked(format!(
            "{tool_label} has {count} possible resumable sessions for {cwd}; choose one before restarting"
        ))
    };
    let Some(launched_ms) = trimmed_string(session.get("createdAt"))
        .as_deref()
        .and_then(crate::backend_session_ids::iso_timestamp_ms)
    else {
        return ambiguous();
    };
    let mut narrowed = match ids_for_cwd(tool_key, cwd, Some(launched_ms)) {
        Ok(ids) => ids,
        Err(error) => {
            return MissingBackendSessionDisposition::Blocked(format!(
                "{tool_label} session history for {cwd} could not be inspected: {error}"
            ));
        }
    };
    match narrowed.len() {
        1 => MissingBackendSessionDisposition::RecordBackendSession(
            narrowed.pop_first().expect("one narrowed backend session"),
        ),
        0 => MissingBackendSessionDisposition::Blocked(format!(
            "{tool_label} has {count} resumable sessions for {cwd}, none opened after this agent started; choose one before restarting"
        )),
        _ => ambiguous(),
    }
}

pub(super) fn can_resume_with_backend_session_id(
    tool_config: &Value,
    backend_session_id: Option<&str>,
) -> bool {
    backend_session_id.is_some_and(|id| !id.trim().is_empty())
        && supports_exact_backend_resume(Some(tool_config))
}

pub(super) fn resume_args(tool_config: &Value, backend_session_id: &str) -> Vec<String> {
    string_array_field(tool_config.get("resumeArgs"))
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", backend_session_id))
        .collect()
}

/// How to reopen a session Claude still has running in the background.
///
/// `--resume` REFUSES one of those: it prints "run `claude attach <id>`" and
/// exits 1, so resuming it launched a process that died on the spot and left an
/// empty pane behind a restore that reported success. The conversation is not
/// gone; it has to be attached to instead.
pub(super) fn attach_args(tool_config: &Value, background_short_id: &str) -> Option<Vec<String>> {
    let pattern = string_array_field(tool_config.get("attachArgs"));
    if pattern.is_empty() {
        return None;
    }
    Some(
        pattern
            .into_iter()
            .map(|arg| arg.replace("{backgroundId}", background_short_id))
            .collect(),
    )
}

pub(super) fn compose_tool_launch(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> (Vec<String>, Vec<String>) {
    let configured = strip_tool_action_args(tool_config, saved_args);
    let base_args = string_array_field(tool_config.get("args"));
    let (leading, trailing) = match configured.strip_prefix(base_args.as_slice()) {
        Some(trailing) => (base_args.as_slice(), trailing),
        None => (&[][..], configured.as_slice()),
    };
    (
        leading
            .iter()
            .chain(action_args)
            .chain(trailing)
            .cloned()
            .collect(),
        configured,
    )
}

pub(super) fn compose_tool_args(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> Vec<String> {
    let base_args = string_array_field(tool_config.get("args"));
    let trailing_args = if !base_args.is_empty()
        && saved_args.len() >= base_args.len()
        && base_args
            .iter()
            .enumerate()
            .all(|(index, arg)| saved_args.get(index) == Some(arg))
    {
        saved_args[base_args.len()..].to_vec()
    } else {
        saved_args.to_vec()
    };
    base_args
        .into_iter()
        .chain(action_args.iter().cloned())
        .chain(trailing_args)
        .collect()
}

pub(super) fn strip_tool_action_args(tool_config: &Value, args: &[String]) -> Vec<String> {
    let patterns = ["resumeArgs", "forkArgs"]
        .into_iter()
        .filter_map(|key| tool_config.get(key))
        .map(|value| string_array_field(Some(value)))
        .filter(|pattern| !pattern.is_empty())
        .collect::<Vec<_>>();
    if patterns.is_empty() {
        return args.to_vec();
    }
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let consumed = patterns
            .iter()
            .map(|pattern| matched_action_arg_length(pattern, args, index))
            .max()
            .unwrap_or(0);
        if consumed > 0 {
            index += consumed;
        } else {
            kept.push(args[index].clone());
            index += 1;
        }
    }
    kept
}

fn matched_action_arg_length(pattern: &[String], args: &[String], index: usize) -> usize {
    let mut matched = 0;
    while matched < pattern.len() && index + matched < args.len() {
        let expected = &pattern[matched];
        let actual = &args[index + matched];
        let is_placeholder = expected == "{sessionId}";
        if if is_placeholder {
            actual.starts_with('-')
        } else {
            actual != expected
        } {
            break;
        }
        matched += 1;
    }
    matched
}

#[derive(Clone, Debug)]
pub(super) struct AgentLaunchOverride {
    pub(super) command: String,
    pub(super) args: Vec<String>,
    pub(super) env: Vec<(String, String)>,
}

pub(super) fn launch_override(value: Option<&Value>) -> Option<AgentLaunchOverride> {
    let value = value?.as_object()?;
    let command = trimmed_string(value.get("command"))?;
    Some(AgentLaunchOverride {
        command,
        args: string_array_field(value.get("args")),
        env: string_record_entries(value.get("env")),
    })
}

pub(super) fn string_record_entries(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn launch_backend_session_id(
    tool_config: &Value,
    command: &str,
    args: &[String],
) -> Option<String> {
    let is_configured = trimmed_string(tool_config.get("command")).as_deref() == Some(command);
    if !is_configured {
        return None;
    }
    let executable = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if executable == "claude" {
        extract_claude_backend_session_id_from_args(args)
    } else if executable == "codex" {
        extract_codex_backend_session_id_from_args(args)
    } else {
        None
    }
}

pub(super) fn resolve_native_fork_args(
    source_session: &Value,
    target_tool_key: &str,
    tool_config: &Value,
    launch_override: Option<&AgentLaunchOverride>,
) -> Option<Vec<String>> {
    let fork_pattern = string_array_field(tool_config.get("forkArgs"));
    if fork_pattern.is_empty() {
        return None;
    }
    if tool_config_key_for_session(source_session).as_deref() != Some(target_tool_key) {
        return None;
    }
    if let Some(override_command) = launch_override.map(|launch| launch.command.as_str())
        && trimmed_string(tool_config.get("command")).as_deref() != Some(override_command)
    {
        return None;
    }
    let backend_session_id = trimmed_string(source_session.get("backendSessionId"))?;
    let fork_args = fork_pattern
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", &backend_session_id))
        .collect::<Vec<_>>();
    let saved_args = launch_override
        .map(|launch| launch.args.clone())
        .unwrap_or_default();
    Some(compose_tool_args(tool_config, &fork_args, &saved_args))
}

pub(super) fn should_skip_claude_session_id_injection(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--resume"
            || arg.starts_with("--resume=")
            || arg == "--session-id"
            || arg.starts_with("--session-id=")
            || arg == "--continue"
            || arg == "-c"
    })
}

pub(super) fn extract_claude_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--resume=") {
            return non_flag(value);
        }
        if let Some(value) = arg.strip_prefix("--session-id=") {
            return non_flag(value);
        }
        if matches!(arg.as_str(), "--resume" | "--session-id") {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

pub(super) fn extract_codex_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "resume" || arg == "fork" {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

fn non_flag(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('-')).then(|| trimmed.to_owned())
}

pub(super) fn generated_session_id_for_launch(
    topology: &Value,
    command: &str,
    backend_session_id: Option<&str>,
) -> String {
    let executable = command_executable(command);
    let Some(backend_session_id) = backend_session_id else {
        return format!(
            "{executable}-{}",
            short_id().chars().take(6).collect::<String>()
        );
    };
    for session in array_field(topology, "sessions") {
        if string_field(&session, "backendSessionId") == backend_session_id
            && command_executable(&string_field(&session, "command")) == executable
        {
            return string_field(&session, "id");
        }
    }
    let existing_ids = array_field(topology, "sessions")
        .into_iter()
        .map(|session| string_field(&session, "id"))
        .collect::<Vec<_>>();
    derive_aimux_session_id_from_backend_session_id(command, backend_session_id, &existing_ids)
}

fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: &[String],
) -> String {
    let executable = command_executable(command);
    let slug = backend_session_id_slug(backend_session_id);
    let max = 16.min(slug.len());
    for length in 6.min(slug.len())..=max {
        let candidate = format!("{executable}-{}", &slug[..length]);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = sha256_hex(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let prefix_len = 6.min(slug.len());
    let fallback_base = format!("{executable}-{}-{suffix}", &slug[..prefix_len]);
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
        .filter(|char| char.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        sha256_hex(backend_session_id)
    } else {
        normalized
    }
}

pub(super) fn command_executable(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_owned()
}

pub(super) fn inject_codex_developer_instructions(
    args: Vec<String>,
    key: &str,
    instructions: &str,
) -> Vec<String> {
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args;
    }
    let insertion_index = first_codex_positional_arg_index(&args);
    let mut injected = Vec::new();
    injected.extend(args[..insertion_index].iter().cloned());
    injected.push("-c".into());
    injected.push(format!("{key}={}", json!(instructions)));
    injected.extend(args[insertion_index..].iter().cloned());
    injected
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
            let name = arg.split('=').next().unwrap_or(arg);
            if CODEX_OPTIONS_WITH_VALUE.contains(&name) && !arg.contains('=') {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if CODEX_OPTIONS_WITH_VALUE.contains(&arg.as_str()) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

const CODEX_OPTIONS_WITH_VALUE: &[&str] = &[
    "-a",
    "--add-dir",
    "--ask-for-approval",
    "-c",
    "--cd",
    "--config",
    "-i",
    "--image",
    "--local-provider",
    "-m",
    "--model",
    "-p",
    "--profile",
    "--remote",
    "--remote-auth-token-env",
    "-s",
    "--sandbox",
];

#[cfg(test)]
mod missing_backend_disposition_tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn claude_missing_backend_has_three_distinct_dispositions() {
        let session = json!({ "toolConfigKey": "claude", "worktreePath": "/repo/wt" });
        let decide = |result: Result<BTreeSet<String>, String>| {
            missing_backend_session_disposition_from_ids(
                &session,
                "/repo",
                true,
                |tool, cwd, _created_after_ms| {
                    assert_eq!((tool, cwd), ("claude", "/repo/wt"));
                    result.clone()
                },
            )
        };
        assert_eq!(
            decide(Ok(BTreeSet::new())),
            MissingBackendSessionDisposition::AllowFreshRelaunch
        );
        assert_eq!(
            decide(Ok(BTreeSet::from(["backend-id".into()]))),
            MissingBackendSessionDisposition::RecordBackendSession("backend-id".into())
        );
        let MissingBackendSessionDisposition::Blocked(reason) =
            decide(Err("permission denied".into()))
        else {
            panic!("lookup failure must block, never authorize a fresh start");
        };
        assert!(
            reason.contains("Claude")
                && reason.contains("/repo/wt")
                && reason.contains("permission denied"),
            "{reason}"
        );
        assert!(matches!(
            decide(Ok(BTreeSet::from(["one".into(), "two".into()]))),
            MissingBackendSessionDisposition::Blocked(_)
        ));
    }

    #[test]
    fn known_backend_history_is_preserved_even_after_an_agent_error() {
        let session = json!({ "toolConfigKey": "claude", "backendSessionId": "known", "freshRelaunchAllowed": true });
        assert_eq!(
            missing_backend_session_disposition_from_ids(
                &session,
                "/repo",
                true,
                |_, _, _| panic!("known identity needs no rediscovery")
            ),
            MissingBackendSessionDisposition::Unchanged
        );
        assert!(!should_relaunch_agent_fresh(
            &session,
            Some(&json!({"activity": "error", "attention": "error"}))
        ));
    }

    /// Two transcripts in one checkout used to be the end of the road. The
    /// one opened after the agent was is the agent's own.
    #[test]
    fn a_launch_time_floor_resolves_two_codex_transcripts() {
        let session = json!({
            "toolConfigKey": "codex",
            "worktreePath": "/repo/wt",
            "createdAt": "2026-08-15T00:00:00.000Z",
        });
        let disposition = missing_backend_session_disposition_from_ids(
            &session,
            "/repo",
            true,
            |_tool, _cwd, created_after_ms| {
                Ok(if created_after_ms.is_some() {
                    BTreeSet::from(["newer".to_owned()])
                } else {
                    BTreeSet::from(["older".to_owned(), "newer".to_owned()])
                })
            },
        );
        assert_eq!(
            disposition,
            MissingBackendSessionDisposition::RecordBackendSession("newer".into())
        );
    }

    /// Narrowing to NOTHING is not an empty history.
    ///
    /// Every transcript here predates the agent, so its own is missing or
    /// unreadable. Reading that as "no conversation exists" hands back a
    /// fresh start and drops whatever is actually there -- and `0` is the arm
    /// that already means AllowFreshRelaunch one level up, so the mistake
    /// costs nothing to make.
    #[test]
    fn narrowing_away_every_candidate_refuses_rather_than_starting_fresh() {
        let session = json!({
            "toolConfigKey": "codex",
            "worktreePath": "/repo/wt",
            "createdAt": "2026-08-15T00:00:00.000Z",
        });
        let disposition = missing_backend_session_disposition_from_ids(
            &session,
            "/repo",
            true,
            |_tool, _cwd, created_after_ms| {
                Ok(if created_after_ms.is_some() {
                    BTreeSet::new()
                } else {
                    BTreeSet::from(["older".to_owned(), "other".to_owned()])
                })
            },
        );
        assert!(
            matches!(disposition, MissingBackendSessionDisposition::Blocked(ref reason)
                if reason.contains("none opened after this agent started")),
            "{disposition:?}"
        );
    }

    /// Narrowing to one is not proof that one is YOURS.
    ///
    /// A second id-less agent in the same checkout whose own transcript never
    /// appeared -- codex died before writing `session_meta`, or it was pruned
    /// -- leaves its neighbour's as the only survivor. Adopting it puts two
    /// agents in one conversation, which is worse than the refusal it
    /// replaces, so a shared checkout does not narrow at all.
    #[test]
    fn a_second_unidentified_agent_in_the_checkout_blocks_narrowing() {
        let session = json!({
            "toolConfigKey": "codex",
            "worktreePath": "/repo/wt",
            "createdAt": "2026-08-15T00:00:00.000Z",
        });
        let disposition = missing_backend_session_disposition_from_ids(
            &session,
            "/repo",
            false,
            |_tool, _cwd, _created_after_ms| {
                Ok(BTreeSet::from(["older".to_owned(), "newer".to_owned()]))
            },
        );
        assert!(
            matches!(disposition, MissingBackendSessionDisposition::Blocked(ref reason)
                if reason.contains("more than one")),
            "{disposition:?}"
        );
    }

    /// And the predicate that decides it, against a real topology.
    #[test]
    fn sole_claimant_counts_restorable_id_less_agents_in_the_same_checkout() {
        let me = json!({ "id": "codex-me", "toolConfigKey": "codex", "worktreePath": "/wt", "status": "running" });
        let case = |others: Value| {
            let mut sessions = vec![me.clone()];
            if let Value::Array(rows) = others {
                sessions.extend(rows);
            }
            sole_unidentified_claimant(&json!({ "sessions": sessions }), &me, "/repo")
        };

        assert!(case(json!([])), "alone");
        assert!(
            !case(json!([
                { "id": "codex-twin", "toolConfigKey": "codex", "worktreePath": "/wt", "status": "running" }
            ])),
            "a live id-less twin in the same checkout"
        );
        assert!(
            case(json!([
                { "id": "codex-elsewhere", "toolConfigKey": "codex", "worktreePath": "/other", "status": "running" }
            ])),
            "another checkout cannot take this one's transcript"
        );
        assert!(
            !case(json!([
                { "id": "codex-offline", "toolConfigKey": "codex", "worktreePath": "/wt", "status": "offline" }
            ])),
            "an offline agent can be restored into its conversation, so it is still a claimant"
        );
        assert!(
            case(json!([
                { "id": "codex-buried", "toolConfigKey": "codex", "worktreePath": "/wt", "status": "graveyard" }
            ])),
            "a graveyarded agent's checkout is gone, so it will never come back for it"
        );
        assert!(
            !case(json!([
                { "id": "codex-odd", "toolConfigKey": "codex", "worktreePath": "/wt", "status": "something-new" }
            ])),
            "an unrecognised status counts, so a new one fails closed rather than silently"
        );
        assert!(
            case(json!([
                { "id": "codex-known", "toolConfigKey": "codex", "worktreePath": "/wt",
                  "status": "running", "backendSessionId": "already-has-one" }
            ])),
            "an agent that already knows its own conversation is not a claimant"
        );
        assert!(
            case(json!([
                { "id": "claude-other", "toolConfigKey": "claude", "worktreePath": "/wt", "status": "running" }
            ])),
            "a different tool does not write codex transcripts"
        );
    }

    /// Without a `createdAt` there is no floor, so the old refusal stands
    /// rather than a guess at which transcript is newest.
    #[test]
    fn no_launch_time_leaves_the_ambiguity_refused() {
        let session = json!({ "toolConfigKey": "codex", "worktreePath": "/repo/wt" });
        let disposition = missing_backend_session_disposition_from_ids(
            &session,
            "/repo",
            true,
            |_tool, _cwd, _created_after_ms| Ok(BTreeSet::from(["a".to_owned(), "b".to_owned()])),
        );
        assert!(
            matches!(disposition, MissingBackendSessionDisposition::Blocked(ref reason)
                if reason.contains("2 possible resumable sessions")),
            "{disposition:?}"
        );
    }

    #[test]
    fn every_tool_without_a_backend_id_gets_an_explicit_disposition() {
        for tool in ["aider", "shell"] {
            assert_eq!(
                missing_backend_session_disposition_from_ids(
                    &json!({"toolConfigKey": tool}),
                    "/repo",
                    true,
                    |_, _, _| panic!("no exact backend store exists")
                ),
                MissingBackendSessionDisposition::AllowFreshRelaunch
            );
        }
        for session in [json!({"toolConfigKey": "custom"}), json!({})] {
            assert!(matches!(
                missing_backend_session_disposition_from_ids(
                    &session,
                    "/repo",
                    true,
                    |_, _, _| panic!("no supported store exists")
                ),
                MissingBackendSessionDisposition::Blocked(_)
            ));
        }
    }
}
