use aimux::backend_session_ids::{
    BackendSessionDiscoveryOptions, CodexConversationPresence, backend_session_id_is_discoverable,
    build_agent_identity_error_payload, build_agent_identity_payload,
    claude_backend_session_ids_for_cwd, claude_transcript_path, codex_conversation_presence,
    codex_conversation_presence_since, codex_scan_for_cwd,
    discover_backend_session_id_with_options, discover_claude_backend_session_id,
    discover_codex_backend_session_id, presence_from_scan, relocate_claude_transcript,
    render_agent_identity_lines, resolve_agent_identity, resolve_agent_identity_with_options,
};
use aimux::config::default_config;
use aimux::tool_capabilities::{
    exact_backend_resume_unacquirable_reason, supports_exact_backend_resume,
};
use serde_json::json;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const UUID_A: &str = "0710a963-a473-430f-9f9a-e27dd4546328";
const UUID_B: &str = "11111111-2222-3333-4444-555555555555";

#[test]
fn resolves_agent_identity_from_topology() {
    let topology = json!({
        "sessions": [{
            "id": "claude-gone",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "status": "graveyard",
            "backendSessionId": "0f0e2b1a-1111-2222-3333-444455556666",
            "worktreePath": "/repo",
        }],
        "nodes": [],
        "bindings": [],
    });

    let identity =
        resolve_agent_identity("/repo", "claude-gone", &topology).expect("resolved identity");
    assert_eq!(identity.session_id, "claude-gone");
    assert_eq!(
        identity.backend_session_id,
        "0f0e2b1a-1111-2222-3333-444455556666"
    );
    assert_eq!(identity.source, "topology");

    let payload = build_agent_identity_payload("/repo", &identity);
    assert_eq!(
        payload,
        json!({
            "ok": true,
            "projectRoot": "/repo",
            "canonical": "claude",
            "aimuxId": "claude-gone",
            "backendSessionId": "0f0e2b1a-1111-2222-3333-444455556666",
            "source": "topology",
            "status": "graveyard",
            "worktreePath": "/repo",
        })
    );
    assert_eq!(
        render_agent_identity_lines(&payload),
        vec![
            "claude-gone  canonical=claude  backend=0f0e2b1a-1111-2222-3333-444455556666  status=graveyard  source=topology",
            "worktree: /repo",
        ]
    );
}

#[test]
fn reports_missing_topology_rows_like_typescript() {
    let error =
        resolve_agent_identity("/repo", "ghost-1", &json!({ "sessions": [] })).expect_err("error");
    assert_eq!(
        error.reason,
        "Agent \"ghost-1\" is not managed in runtime topology"
    );
    assert_eq!(
        build_agent_identity_error_payload("/repo", &error),
        json!({
            "ok": false,
            "projectRoot": "/repo",
            "sessionId": "ghost-1",
            "error": "Agent \"ghost-1\" is not managed in runtime topology",
        })
    );
}

#[test]
fn recovers_codex_backend_session_id_from_single_matching_transcript() {
    let temp = temp_dir("aimux-codex-discovery");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript(&sessions_dir, "14", UUID_A, "/repo");

    let topology = json!({
        "sessions": [{
            "id": "codex-main",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "status": "running",
        }],
        "nodes": [],
        "bindings": [],
    });
    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };

    let identity = resolve_agent_identity_with_options("/repo", "codex-main", &topology, &options)
        .expect("discovered identity");
    assert_eq!(identity.backend_session_id, UUID_A);
    assert_eq!(identity.source, "discovered");
    assert_eq!(
        discover_backend_session_id_with_options(Some("codex"), Some("/repo"), &options),
        Some(UUID_A.into())
    );

    remove_dir_all(temp).ok();
}

#[test]
fn refuses_ambiguous_codex_transcripts() {
    let temp = temp_dir("aimux-codex-ambiguous");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript(&sessions_dir, "14", UUID_A, "/repo");
    write_codex_transcript(&sessions_dir, "15", UUID_B, "/repo");

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };

    assert_eq!(discover_codex_backend_session_id("/repo", &options), None);
    remove_dir_all(temp).ok();
}

#[test]
fn discovers_claude_transcript_from_encoded_project_dir() {
    let projects_dir = temp_dir("aimux-claude-projects");
    let transcript = claude_transcript_path(
        "/Users/x/cs/proj/.aimux/worktrees/chat-sync",
        UUID_A,
        Some(&projects_dir),
    );
    create_dir_all(transcript.parent().expect("parent")).expect("mkdir");
    write(&transcript, "{}\n").expect("write transcript");

    assert_eq!(
        transcript,
        projects_dir
            .join("-Users-x-cs-proj--aimux-worktrees-chat-sync")
            .join(format!("{UUID_A}.jsonl"))
    );
    assert_eq!(
        discover_claude_backend_session_id(
            "/Users/x/cs/proj/.aimux/worktrees/chat-sync",
            Some(&projects_dir)
        ),
        Some(UUID_A.into())
    );

    remove_dir_all(projects_dir).ok();
}

#[test]
fn claude_history_distinguishes_absence_candidates_and_inspection_errors() {
    let projects_dir = temp_dir("aimux-claude-three-outcomes");
    assert_eq!(
        claude_backend_session_ids_for_cwd("/repo", Some(&projects_dir)).unwrap(),
        Default::default()
    );

    let path = claude_transcript_path("/repo", UUID_A, Some(&projects_dir));
    create_dir_all(path.parent().unwrap()).unwrap();
    write(
        &path,
        format!(
            "{}\n",
            json!({ "type": "user", "cwd": "/repo", "sessionId": UUID_A })
        ),
    )
    .unwrap();
    assert_eq!(
        claude_backend_session_ids_for_cwd("/repo", Some(&projects_dir)).unwrap(),
        std::collections::BTreeSet::from([UUID_A.to_owned()])
    );

    write(&path, "not valid json\n").unwrap();
    let error = claude_backend_session_ids_for_cwd("/repo", Some(&projects_dir)).unwrap_err();
    assert!(
        error.contains("failed to parse Claude transcript"),
        "{error}"
    );
    assert!(error.contains(UUID_A), "{error}");
    remove_dir_all(projects_dir).unwrap();
}

#[test]
fn claude_history_does_not_treat_an_unreadable_store_as_absent() {
    let projects_dir = temp_dir("aimux-claude-unreadable-store");
    let not_a_directory = projects_dir.join("file");
    write(&not_a_directory, "not a directory").unwrap();
    let error = claude_backend_session_ids_for_cwd("/repo", Some(&not_a_directory)).unwrap_err();
    assert!(
        error.contains("failed to read Claude projects dir"),
        "{error}"
    );
    assert!(error.contains("file"), "{error}");
    remove_dir_all(projects_dir).unwrap();
}

#[test]
fn claude_history_keeps_all_ambiguous_candidates_and_ignores_subagent_files() {
    let projects_dir = temp_dir("aimux-claude-ambiguous");
    for id in [UUID_A, UUID_B] {
        let path = claude_transcript_path("/repo", id, Some(&projects_dir));
        create_dir_all(path.parent().unwrap()).unwrap();
        write(&path, "{}\n").unwrap();
    }
    let root = claude_transcript_path("/repo", UUID_A, Some(&projects_dir))
        .parent()
        .unwrap()
        .to_path_buf();
    write(root.join("agent-child.jsonl"), "not a conversation").unwrap();
    create_dir_all(root.join("22222222-2222-3333-4444-555555555555.jsonl")).unwrap();
    assert_eq!(
        claude_backend_session_ids_for_cwd("/repo", Some(&projects_dir)).unwrap(),
        std::collections::BTreeSet::from([UUID_A.to_owned(), UUID_B.to_owned()])
    );
    assert_eq!(
        discover_claude_backend_session_id("/repo", Some(&projects_dir)),
        None
    );
    remove_dir_all(projects_dir).unwrap();
}

#[test]
fn claude_history_checks_cwd_when_encoded_project_directory_names_collide() {
    let projects_dir = temp_dir("aimux-claude-cwd-collision");
    let first = claude_transcript_path("/repo/a.b", UUID_A, Some(&projects_dir));
    let second = claude_transcript_path("/repo/a-b", UUID_B, Some(&projects_dir));
    assert_eq!(
        first.parent(),
        second.parent(),
        "Claude encoding is not injective"
    );
    create_dir_all(first.parent().unwrap()).unwrap();
    write(
        &first,
        format!(
            "{{\"type\":\"file-history-snapshot\"}}\n{}\n",
            json!({ "cwd": "/repo/a.b", "sessionId": UUID_A })
        ),
    )
    .unwrap();
    write(
        &second,
        format!("{}\n", json!({ "cwd": "/repo/a-b", "sessionId": UUID_B })),
    )
    .unwrap();
    for cwd in ["/repo/a.b", "/repo/a-b"] {
        let error = claude_backend_session_ids_for_cwd(cwd, Some(&projects_dir)).unwrap_err();
        assert!(error.contains("records cwd"), "{error}");
        assert!(error.contains("colliding project directory"), "{error}");
        assert!(error.contains(cwd), "{error}");
    }
    remove_dir_all(projects_dir).unwrap();
}

#[test]
fn relocated_claude_history_cannot_be_mistaken_for_an_empty_store() {
    let projects_dir = temp_dir("aimux-claude-relocated-history");
    let source_cwd = "/repo/old-worktree";
    let target_cwd = "/repo/new-worktree";
    let source = claude_transcript_path(source_cwd, UUID_A, Some(&projects_dir));
    create_dir_all(source.parent().unwrap()).unwrap();
    write(
        &source,
        format!(
            "{}\n",
            json!({ "type": "user", "cwd": source_cwd, "sessionId": UUID_A })
        ),
    )
    .unwrap();
    assert!(relocate_claude_transcript(
        source_cwd,
        target_cwd,
        UUID_A,
        Some(&projects_dir)
    ));
    let target = claude_transcript_path(target_cwd, UUID_A, Some(&projects_dir));
    assert_eq!(
        std::fs::read(&source).unwrap(),
        std::fs::read(&target).unwrap()
    );
    let error = claude_backend_session_ids_for_cwd(target_cwd, Some(&projects_dir)).unwrap_err();
    assert!(error.contains("relocated history"), "{error}");
    assert!(
        error.contains(source_cwd) && error.contains(target_cwd) && error.contains(UUID_A),
        "{error}"
    );
    remove_dir_all(projects_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn claude_history_does_not_silently_drop_a_transcript_that_cannot_be_inspected() {
    let projects_dir = temp_dir("aimux-claude-uninspectable-entry");
    let path = claude_transcript_path("/repo", UUID_A, Some(&projects_dir));
    create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(projects_dir.join("missing-target"), &path).unwrap();
    let error = claude_backend_session_ids_for_cwd("/repo", Some(&projects_dir)).unwrap_err();
    assert!(
        error.contains("failed to inspect Claude transcript"),
        "{error}"
    );
    assert!(error.contains(UUID_A), "{error}");
    remove_dir_all(projects_dir).unwrap();
}

fn write_codex_transcript_at(
    sessions_dir: &Path,
    day: &str,
    uuid: &str,
    cwd: &str,
    timestamp: &str,
) {
    let dir = sessions_dir.join("2026").join("08").join(day);
    create_dir_all(&dir).expect("mkdir");
    let path = dir.join(format!("rollout-2026-08-{day}T00-00-00-{uuid}.jsonl"));
    write(
        &path,
        format!(
            "{}\n",
            json!({
                "timestamp": timestamp,
                "type": "session_meta",
                "payload": { "id": uuid, "cwd": cwd, "originator": "codex-tui" },
            })
        ),
    )
    .expect("write codex transcript");
}

fn write_codex_transcript(sessions_dir: &Path, day: &str, uuid: &str, cwd: &str) {
    let dir = sessions_dir.join("2026").join("08").join(day);
    create_dir_all(&dir).expect("mkdir");
    let path = dir.join(format!("rollout-2026-08-{day}T00-00-00-{uuid}.jsonl"));
    write(
        path,
        format!(
            "{}\n",
            json!({
                "timestamp": "2026-08-08T00:00:00.000Z",
                "type": "session_meta",
                "payload": { "id": uuid, "cwd": cwd, "originator": "codex-tui" },
            })
        ),
    )
    .expect("write codex transcript");
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    create_dir_all(&path).expect("mkdir temp");
    path
}

/// A reused checkout has a transcript per conversation, which is why
/// `refuses_ambiguous_codex_transcripts` exists: by cwd alone, "which of these
/// belongs to this agent" has no answer, and a worktree you had worked in
/// twice could not be restored at all.
///
/// It is answerable by time. The agent's own conversation is the one OPENED
/// after the agent was, and `session_meta` carries the instant it was opened.
#[test]
fn a_launch_time_floor_resolves_what_cwd_alone_cannot() {
    let temp = temp_dir("aimux-codex-floor");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript_at(
        &sessions_dir,
        "14",
        UUID_A,
        "/repo",
        "2026-08-14T00:00:00.000Z",
    );
    write_codex_transcript_at(
        &sessions_dir,
        "15",
        UUID_B,
        "/repo",
        "2026-08-15T12:00:00.000Z",
    );

    let unfiltered = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &unfiltered),
        None,
        "by cwd alone the two are still indistinguishable"
    );

    // An agent launched between them: only the later conversation is its own.
    let floor = iso_ms("2026-08-15T00:00:00.000Z");
    let narrowed = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        codex_since_ms: Some(floor),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &narrowed),
        Some(UUID_B.into())
    );

    remove_dir_all(temp).ok();
}

/// The floor reads the rollout's OWN timestamp, never the file's mtime.
///
/// mtime is a different fact: a transcript is appended to for as long as its
/// conversation lives, so an old one someone is still talking in looks newer
/// than a launch that just happened. Filtering on mtime -- which is what this
/// option did before, and why neither production caller ever set it -- hands
/// back the wrong conversation here.
#[test]
fn the_floor_ignores_a_stale_transcript_that_is_still_being_written() {
    let temp = temp_dir("aimux-codex-mtime");
    let sessions_dir = temp.join("sessions");
    let old = sessions_dir
        .join("2026")
        .join("08")
        .join("14")
        .join(format!("rollout-2026-08-14T00-00-00-{UUID_A}.jsonl"));
    write_codex_transcript_at(
        &sessions_dir,
        "14",
        UUID_A,
        "/repo",
        "2026-08-14T00:00:00.000Z",
    );
    // Touched now: the conversation is old, the file is not.
    write(&old, read_to_string(&old).expect("read back")).expect("touch");

    // The control: without a floor this transcript IS discoverable, so the
    // assertion below cannot pass because the fixture is broken.
    let unfiltered = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &unfiltered),
        Some(UUID_A.into()),
        "the fixture has to be discoverable for the floor to mean anything"
    );

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        codex_since_ms: Some(iso_ms("2026-08-15T00:00:00.000Z")),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &options),
        None,
        "a conversation opened before the floor is not this agent's, however \
         recently it was written to"
    );

    remove_dir_all(temp).ok();
}

fn iso_ms(value: &str) -> u128 {
    aimux::backend_session_ids::iso_timestamp_ms(value).expect("parseable timestamp")
}

/// A timestamp that will not parse is not an absent one.
///
/// Falling through to mtime there reinstates the bug in the direction that
/// INCLUDES the wrong rollout, which is how a stale conversation gets adopted.
#[test]
fn an_unparseable_timestamp_is_not_treated_as_a_missing_one() {
    let temp = temp_dir("aimux-codex-badstamp");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript_at(&sessions_dir, "14", UUID_A, "/repo", "not-a-timestamp");

    // The control: with no floor it is found, so the refusal below is about
    // the timestamp and not about the fixture.
    let unfiltered = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &unfiltered),
        Some(UUID_A.into())
    );

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        codex_since_ms: Some(iso_ms("2026-08-01T00:00:00.000Z")),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        discover_codex_backend_session_id("/repo", &options),
        None,
        "an unreadable opening time cannot satisfy a floor"
    );

    remove_dir_all(temp).ok();
}

/// Three answers, because "nothing here" and "could not look" are different
/// facts and the guard that reads this decides whether a restart may proceed.
#[test]
fn presence_separates_an_empty_store_from_an_unreadable_one() {
    let temp = temp_dir("aimux-codex-presence");
    let sessions_dir = temp.join("sessions");

    // Nothing created yet: the store is not there at all.
    let missing = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        codex_conversation_presence("/repo", &missing),
        CodexConversationPresence::Unknown,
        "a store that is not where we are looking is not an empty one"
    );

    // A real store, holding somebody else's checkout.
    write_codex_transcript(&sessions_dir, "14", UUID_A, "/elsewhere");
    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        codex_conversation_presence("/repo", &options),
        CodexConversationPresence::ConfirmedAbsent,
        "read it, and this checkout genuinely has nothing in it"
    );

    write_codex_transcript(&sessions_dir, "15", UUID_B, "/repo");
    assert_eq!(
        codex_conversation_presence("/repo", &options),
        CodexConversationPresence::Present
    );

    remove_dir_all(temp).ok();
}

/// A symlinked checkout is the same checkout.
///
/// A process records the path it resolved, not the one it was handed, and on
/// macOS `/tmp` and `/var` are symlinks into `/private`. While a mismatch only
/// meant the restart was refused this was harmless; now that the guard reads
/// "found nothing" as "nothing to lose", the same mismatch kills a live
/// conversation.
#[test]
fn a_symlinked_checkout_is_the_same_checkout() {
    let temp = temp_dir("aimux-codex-symlink");
    let real = temp.join("real-checkout");
    create_dir_all(&real).expect("mkdir checkout");
    let link = temp.join("linked-checkout");
    std::os::unix::fs::symlink(&real, &link).expect("symlink");

    let sessions_dir = temp.join("sessions");
    // Codex recorded the resolved path.
    write_codex_transcript(&sessions_dir, "14", UUID_A, real.to_str().expect("utf8"));

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };

    // Aimux asks with the path it handed over, which is the symlink.
    assert_eq!(
        discover_codex_backend_session_id(link.to_str().expect("utf8"), &options),
        Some(UUID_A.into()),
        "the same directory, reached by its other name"
    );
    assert_eq!(
        codex_conversation_presence(link.to_str().expect("utf8"), &options),
        CodexConversationPresence::Present,
        "and the guard must not call that nothing to lose"
    );

    // The control: a genuinely different checkout is still absent, so this is
    // not simply matching everything.
    let other = temp.join("other-checkout");
    create_dir_all(&other).expect("mkdir other");
    assert_eq!(
        codex_conversation_presence(other.to_str().expect("utf8"), &options),
        CodexConversationPresence::ConfirmedAbsent
    );

    remove_dir_all(temp).ok();
}

/// An undateable transcript is not an absent one.
///
/// Discovery drops a rollout whose `session_meta.timestamp` will not parse,
/// because adopting it would reopen the wrong conversation. The restart guard
/// reading that same exclusion as "nothing here to lose" is the direction that
/// kills a live conversation, so presence answers `Unknown` instead.
#[test]
fn a_transcript_we_cannot_date_is_not_confirmed_absence() {
    let temp = temp_dir("aimux-codex-undateable");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript_at(&sessions_dir, "14", UUID_A, "/repo", "not-a-timestamp");

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };

    // It names this checkout and it could not be dated.
    let scan = codex_scan_for_cwd(
        "/repo",
        &BackendSessionDiscoveryOptions {
            codex_since_ms: Some(iso_ms("2026-08-15T00:00:00.000Z")),
            ..options.clone()
        },
    )
    .expect("the store is readable");
    assert!(scan.ids.is_empty(), "discovery still refuses to adopt it");
    assert_eq!(scan.undateable, 1, "but the scan knows it was there");

    assert_eq!(
        codex_conversation_presence_since(
            "/repo",
            Some(iso_ms("2026-08-15T00:00:00.000Z")),
            &options
        ),
        CodexConversationPresence::Unknown,
        "could not tell is not the same as nothing to lose"
    );

    // The control: a dateable transcript below the floor really is absence,
    // so Unknown is not simply what this fixture always returns.
    let dateable = temp_dir("aimux-codex-dateable");
    write_codex_transcript_at(
        &dateable.join("sessions"),
        "14",
        UUID_B,
        "/repo",
        "2026-08-14T00:00:00.000Z",
    );
    assert_eq!(
        codex_conversation_presence_since(
            "/repo",
            Some(iso_ms("2026-08-15T00:00:00.000Z")),
            &BackendSessionDiscoveryOptions {
                codex_sessions_dir: Some(dateable.join("sessions")),
                ..BackendSessionDiscoveryOptions::default()
            }
        ),
        CodexConversationPresence::ConfirmedAbsent
    );

    // And an undateable transcript naming a DIFFERENT checkout is not this
    // checkout's problem -- the floor is applied after the cwd matches.
    assert_eq!(
        codex_conversation_presence_since(
            "/elsewhere",
            Some(iso_ms("2026-08-15T00:00:00.000Z")),
            &options
        ),
        CodexConversationPresence::ConfirmedAbsent
    );

    remove_dir_all(temp).ok();
    remove_dir_all(dateable).ok();
}

/// A trailing slash must not hide a CLAUDE conversation either.
///
/// Claude names its project directory after its own process cwd, which never
/// carries a trailing slash. A `worktreePath` can, and encoding it produced a
/// directory Claude never wrote -- discovery found nothing and restore took
/// the fresh-start path over live history. The codex scan was fixed for this;
/// claude was not.
#[test]
fn a_trailing_slash_does_not_hide_a_claude_conversation() {
    let projects_dir = temp_dir("aimux-claude-slash");
    let transcript = claude_transcript_path("/repo/wt", UUID_A, Some(&projects_dir));
    create_dir_all(transcript.parent().expect("parent")).expect("mkdir");
    write(&transcript, "{}\n").expect("write transcript");

    let options = BackendSessionDiscoveryOptions {
        claude_projects_dir: Some(projects_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };

    assert_eq!(
        discover_claude_backend_session_id("/repo/wt/", Some(&projects_dir)),
        Some(UUID_A.into()),
        "the same checkout, spelled with a slash"
    );
    assert_eq!(
        discover_backend_session_id_with_options(Some("claude"), Some("/repo/wt/"), &options),
        Some(UUID_A.into())
    );
    // The control: a genuinely different checkout is still absent.
    assert_eq!(
        discover_claude_backend_session_id("/repo/other", Some(&projects_dir)),
        None
    );

    remove_dir_all(projects_dir).ok();
}

/// A record naming this checkout that we cannot identify is uncertainty.
///
/// `undateable` used to be reached only by the floor arm, so every earlier
/// reject -- an id that is missing or not a uuid -- counted as neither
/// present nor uncertain and the checkout read as confirmed empty.
#[test]
fn a_transcript_we_cannot_identify_is_not_confirmed_absence() {
    let temp = temp_dir("aimux-codex-unidentifiable");
    let sessions_dir = temp.join("sessions");
    let dir = sessions_dir.join("2026").join("08").join("14");
    create_dir_all(&dir).expect("mkdir");
    // Names this checkout, but its id is not a uuid.
    write(
        dir.join("rollout-2026-08-14T00-00-00-broken.jsonl"),
        format!(
            "{}\n",
            json!({
                "timestamp": "2026-08-14T00:00:00.000Z",
                "type": "session_meta",
                "payload": { "id": "not-a-uuid", "cwd": "/repo" },
            })
        ),
    )
    .expect("write");

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };
    let scan = codex_scan_for_cwd("/repo", &options).expect("store readable");
    assert!(scan.ids.is_empty(), "it is still not adoptable");
    assert_eq!(scan.undateable, 1, "but it is this checkout's uncertainty");
    assert!(
        scan.unreadable.is_empty(),
        "it was attributable, just unusable"
    );
    assert_eq!(
        presence_from_scan(&scan),
        CodexConversationPresence::Unknown
    );

    // The control: the same store asked about a different checkout is
    // genuinely absent, so Unknown is not what this fixture always says.
    let elsewhere = codex_scan_for_cwd("/elsewhere", &options).expect("store readable");
    assert_eq!(elsewhere.undateable, 0);
    assert_eq!(
        presence_from_scan(&elsewhere),
        CodexConversationPresence::ConfirmedAbsent
    );

    remove_dir_all(temp).ok();
}

/// A record we cannot attribute is reported, not absorbed -- and not blocking.
///
/// Only line 1 carries `cwd`, so a rollout whose first line will not parse
/// belongs to no checkout we can name. Treating that as uncertainty for every
/// checkout would let one corrupt file refuse every restart for ever, which
/// is the refusal this module exists to stop.
#[test]
fn a_rollout_we_cannot_attribute_is_reported_not_absorbed() {
    let temp = temp_dir("aimux-codex-unattributable");
    let sessions_dir = temp.join("sessions");
    let dir = sessions_dir.join("2026").join("08").join("14");
    create_dir_all(&dir).expect("mkdir");
    write(
        dir.join("rollout-2026-08-14T00-00-00-partial.jsonl"),
        "{\"timestamp\": \"2026-08-14T00:00:00.000Z\", \"type\": \"session_me",
    )
    .expect("write partial");
    // And a healthy one for a different checkout, so the store is not empty.
    write_codex_transcript(&sessions_dir, "15", UUID_A, "/elsewhere");

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };
    let scan = codex_scan_for_cwd("/repo", &options).expect("store readable");
    assert_eq!(scan.unreadable.len(), 1, "the caller is told which file");
    assert!(
        scan.unreadable[0].to_string_lossy().contains("partial"),
        "{:?}",
        scan.unreadable
    );
    assert_eq!(
        scan.undateable, 0,
        "it is nobody's uncertainty in particular"
    );
    assert_eq!(
        presence_from_scan(&scan),
        CodexConversationPresence::ConfirmedAbsent,
        "one corrupt file must not refuse every restart"
    );

    remove_dir_all(temp).ok();
}

/// A conversation another session has claimed is not this session's.
///
/// The floor excludes transcripts older than the session; it says nothing
/// about who owns the newer ones. A long-lived id-less agent whose neighbours
/// opened conversations after it started saw theirs as possibly its own and
/// refused every restart for ever -- the original bug, for exactly the agents
/// most likely to share a checkout.
#[test]
fn a_conversation_another_session_claimed_is_not_this_ones() {
    let temp = temp_dir("aimux-codex-claimed");
    let sessions_dir = temp.join("sessions");
    // The neighbour opened this one AFTER our session launched.
    write_codex_transcript_at(
        &sessions_dir,
        "16",
        UUID_B,
        "/repo",
        "2026-08-16T00:00:00.000Z",
    );

    let floor = Some(iso_ms("2026-08-15T00:00:00.000Z"));
    let unclaimed = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.clone()),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        codex_conversation_presence_since("/repo", floor, &unclaimed),
        CodexConversationPresence::Present,
        "nobody has claimed it, so it could still be ours"
    );

    let claimed = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        codex_exclude_backend_session_ids: [UUID_B.to_owned()].into_iter().collect(),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        codex_conversation_presence_since("/repo", floor, &claimed),
        CodexConversationPresence::ConfirmedAbsent,
        "the neighbour's recorded id takes its conversation out of the running"
    );

    remove_dir_all(temp).ok();
}

/// Declaring exact resume is not the same as being able to do it.
///
/// A tool whose `resumeArgs` carry `{sessionId}` is treated as exactly
/// resumable, and the restart guard then holds a restart open until that
/// session has a `backendSessionId`. If nothing can ever write one, the
/// guard waits for ever -- which is precisely what codex did to every
/// control-plane restart. So every tool that claims the capability has to
/// have a way to acquire the id.
#[test]
fn every_exact_resume_tool_can_acquire_its_id() {
    let config = default_config();
    let tools = config
        .get("tools")
        .and_then(|tools| tools.as_object())
        .expect("default config ships a tools object");
    assert!(
        tools.len() >= 3,
        "the gate is vacuous if the default config stops shipping tools"
    );

    let mut checked = std::collections::BTreeSet::new();
    for (tool_key, tool_config) in tools {
        if !supports_exact_backend_resume(Some(tool_config)) {
            continue;
        }
        checked.insert(tool_key.clone());
        assert_eq!(
            exact_backend_resume_unacquirable_reason(tool_key, Some(tool_config)),
            None,
            "{tool_key} claims exact resume with no way to ever learn its conversation id"
        );
    }

    // Named rather than counted, so a tool silently losing the declaration
    // shows up here instead of shrinking the gate to nothing.
    // A set, not a list: `preserve_order` means the config's key order would
    // otherwise decide whether this assertion holds.
    assert_eq!(
        checked,
        std::collections::BTreeSet::from(["claude".to_owned(), "codex".to_owned()]),
        "these are the tools the gate is protecting"
    );
}

/// The gate has to be able to fail.
///
/// Claude is told its id at launch and codex's is discoverable afterwards, so
/// the real config cannot exercise the refusal. This is the shape that would
/// reinstate the bug: the claim, with neither acquisition path.
#[test]
fn a_tool_declared_resumable_with_no_way_to_learn_its_id_is_named() {
    let invented = json!({
        "command": "newtool",
        "resumeArgs": ["resume", "{sessionId}"],
        "resumeByBackendSessionId": true,
    });
    assert!(
        supports_exact_backend_resume(Some(&invented)),
        "the fixture has to actually claim the capability or it proves nothing"
    );

    let reason = exact_backend_resume_unacquirable_reason("newtool", Some(&invented))
        .expect("a tool with no sessionIdFlag and no discovery arm must be named");
    assert!(reason.contains("newtool"), "{reason}");

    // Give it the launch flag and the objection goes away.
    let mut told_at_launch = invented.clone();
    told_at_launch["sessionIdFlag"] = json!(["--session-id", "{sessionId}"]);
    assert_eq!(
        exact_backend_resume_unacquirable_reason("newtool", Some(&told_at_launch)),
        None,
        "being told the id at launch is an acquisition path"
    );
}

/// The discoverable list and the discovery match must agree.
///
/// `backend_session_id_is_discoverable` is a hand-written list of the arms in
/// `discover_backend_session_id_with_options`. Comparing the two against each
/// other is the only thing that keeps them in step when someone adds an arm.
#[test]
fn the_discoverable_list_matches_what_discovery_actually_does() {
    let temp = temp_dir("aimux-acquisition-parity");
    let claude_dir = temp.join("claude");
    let codex_dir = temp.join("codex");
    let claude_transcript = claude_transcript_path("/repo", UUID_A, Some(&claude_dir));
    create_dir_all(claude_transcript.parent().expect("parent")).expect("mkdir");
    write(&claude_transcript, "{}\n").expect("write claude transcript");
    write_codex_transcript(&codex_dir, "14", UUID_B, "/repo");

    let options = BackendSessionDiscoveryOptions {
        claude_projects_dir: Some(claude_dir),
        codex_sessions_dir: Some(codex_dir),
        ..BackendSessionDiscoveryOptions::default()
    };

    for (tool_key, expected) in [
        (Some("claude"), Some(UUID_A.to_owned())),
        (Some("codex"), Some(UUID_B.to_owned())),
        (Some("aider"), None),
        (None, None),
    ] {
        let discovered =
            discover_backend_session_id_with_options(tool_key, Some("/repo"), &options);
        assert_eq!(
            discovered, expected,
            "discovery for {tool_key:?} is not what the parity table says"
        );
        assert_eq!(
            backend_session_id_is_discoverable(tool_key),
            discovered.is_some(),
            "the discoverable list disagrees with discovery for {tool_key:?}"
        );
    }

    remove_dir_all(temp).ok();
}

/// A reused checkout answers the wrong question.
///
/// Every agent that ever ran here left a transcript behind, so "this checkout
/// has a conversation" is true from the second agent onward and stays true
/// forever. What a restart guard needs is "does THIS session have one", and
/// the session's launch instant is the only thing that separates them.
#[test]
fn presence_ignores_a_conversation_opened_before_the_session() {
    let temp = temp_dir("aimux-codex-presence-floor");
    let sessions_dir = temp.join("sessions");
    // An earlier agent's transcript, same checkout...
    write_codex_transcript_at(
        &sessions_dir,
        "14",
        UUID_A,
        "/repo",
        "2026-08-14T09:00:00.000Z",
    );
    // ...and one opened after this session launched.
    write_codex_transcript_at(
        &sessions_dir,
        "15",
        UUID_B,
        "/repo",
        "2026-08-15T11:00:00.000Z",
    );

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };

    // Launched between the two: only the later transcript can be its own.
    assert_eq!(
        codex_conversation_presence_since(
            "/repo",
            Some(iso_ms("2026-08-15T10:00:00.000Z")),
            &options
        ),
        CodexConversationPresence::Present,
        "the transcript opened after launch is this session's"
    );

    // Launched after both: it owns nothing, however much the checkout holds.
    assert_eq!(
        codex_conversation_presence_since(
            "/repo",
            Some(iso_ms("2026-08-16T00:00:00.000Z")),
            &options
        ),
        CodexConversationPresence::ConfirmedAbsent,
        "an earlier agent's transcript is not this agent's to protect"
    );

    // The control: with no floor the checkout-wide question still answers
    // Present, which is exactly what made the guard refuse for ever.
    assert_eq!(
        codex_conversation_presence_since("/repo", None, &options),
        CodexConversationPresence::Present
    );
    assert_eq!(
        codex_conversation_presence("/repo", &options),
        CodexConversationPresence::Present,
        "the floorless wrapper keeps its old meaning"
    );

    remove_dir_all(temp).ok();
}

/// A trailing slash is the same checkout.
///
/// `worktreePath` can carry one -- a user-supplied task worktree does -- and
/// comparing the recorded cwd byte-for-byte made a checkout that HAS a
/// conversation read as having none. The guard reads that as "nothing to
/// lose", which is the direction that loses it. The Claude path already
/// trimmed; this one did not.
#[test]
fn a_trailing_slash_does_not_hide_a_conversation() {
    let temp = temp_dir("aimux-codex-slash");
    let sessions_dir = temp.join("sessions");
    write_codex_transcript(&sessions_dir, "14", UUID_A, "/repo/wt");

    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        codex_conversation_presence("/repo/wt/", &options),
        CodexConversationPresence::Present,
        "the same checkout, spelled with a slash"
    );
    assert_eq!(
        discover_codex_backend_session_id("/repo/wt/", &options),
        Some(UUID_A.into())
    );
    // And the control: a genuinely different checkout is still absent.
    assert_eq!(
        codex_conversation_presence("/repo/other", &options),
        CodexConversationPresence::ConfirmedAbsent
    );

    remove_dir_all(temp).ok();
}
