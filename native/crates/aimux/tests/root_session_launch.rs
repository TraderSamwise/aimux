use aimux::root_session_launch::{launchable_offline_session_ids, parse_root_resume_args};
use serde_json::json;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn root_resume_parser_accepts_optional_tool_filter_only() {
    assert_eq!(
        parse_root_resume_args(&args(&["--resume"]))
            .unwrap()
            .tool_filter,
        None
    );
    assert_eq!(
        parse_root_resume_args(&args(&["--resume", "codex"]))
            .unwrap()
            .tool_filter,
        Some("codex".into())
    );
    assert!(parse_root_resume_args(&args(&["--resume", "--json"])).is_none());
    assert!(parse_root_resume_args(&args(&["--restore"])).is_none());
    assert!(parse_root_resume_args(&args(&["--resume", "codex", "extra"])).is_none());
}

#[test]
fn launchable_offline_sessions_filter_by_tool_fields() {
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-06T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "kind": "agent", "label": "codex", "cwd": "/repo", "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "node-2", "rigId": "rig-1", "kind": "agent", "label": "claude", "cwd": "/repo", "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "node-3", "rigId": "rig-1", "kind": "agent", "label": "live", "cwd": "/repo", "status": "running", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-old", "nodeId": "node-1", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "claude-old", "nodeId": "node-2", "tool": "claude", "toolConfigKey": "claude", "command": "claude", "args": [], "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "codex-live", "nodeId": "node-3", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "running", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "bindings": [],
        "edges": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    });

    assert_eq!(
        launchable_offline_session_ids(&topology, None),
        ["codex-old", "claude-old"]
    );
    assert_eq!(
        launchable_offline_session_ids(&topology, Some("codex")),
        ["codex-old"]
    );
    assert!(launchable_offline_session_ids(&topology, Some("aider")).is_empty());
}
