use aimux::backend_session_ids::{
    BackendSessionDiscoveryOptions, build_agent_identity_error_payload,
    build_agent_identity_payload, claude_transcript_path, discover_backend_session_id_with_options,
    discover_claude_backend_session_id, discover_codex_backend_session_id,
    render_agent_identity_lines, resolve_agent_identity, resolve_agent_identity_with_options,
};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
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
