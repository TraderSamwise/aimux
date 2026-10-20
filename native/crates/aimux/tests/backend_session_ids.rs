use aimux::backend_session_ids::{
    BackendSessionDiscoveryOptions, CodexConversationPresence, build_agent_identity_error_payload,
    build_agent_identity_payload, claude_backend_session_ids_for_cwd, claude_transcript_path,
    codex_conversation_presence, discover_backend_session_id_with_options,
    discover_claude_backend_session_id, discover_codex_backend_session_id,
    relocate_claude_transcript, render_agent_identity_lines, resolve_agent_identity,
    resolve_agent_identity_with_options,
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
