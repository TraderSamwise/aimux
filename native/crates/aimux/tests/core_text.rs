use aimux::core_text::*;
use serde_json::json;

#[test]
fn renders_daemon_and_host_status_with_typescript_fallbacks() {
    assert_eq!(
        render_core_daemon_status_lines(&json!({ "daemon": null, "projects": [], "relay": {} })),
        vec!["aimux daemon is not running."]
    );
    assert_eq!(
        render_core_daemon_status_lines(&json!({
            "daemon": { "pid": 12, "port": 49152 },
            "projects": [{ "serviceAlive": true }, {}],
            "relay": { "status": "connected", "relayUrl": "wss://relay.example" }
        })),
        vec![
            "Daemon pid=12 port=49152",
            "Known projects: 2",
            "Live project services: 1",
            "Relay: connected (wss://relay.example)",
        ]
    );
    assert_eq!(
        render_core_host_status_lines(&json!({ "projectRoot": "/repo" }), false),
        vec!["No known control service for /repo"]
    );
    assert_eq!(
        render_core_host_status_lines(
            &json!({
                "serviceAlive": true,
                "projectService": { "pid": 7 },
                "metadataEndpoint": { "port": 1000 },
                "expectedServiceManifest": null,
                "sessionName": null
            }),
            true
        ),
        vec![
            "Service: live",
            "Service pid=7",
            "Metadata: {\"port\":1000}",
            "Expected manifest: null",
            "Tmux session: null",
        ]
    );
}

#[test]
fn renders_remote_auth_and_whoami_without_credentials() {
    assert_eq!(
        render_core_remote_status_lines(&json!({ "credentials": null, "relay": {} })),
        vec!["Not logged in. Run `aimux login` to enable remote access."]
    );
    assert_eq!(
        render_core_remote_status_lines(&json!({
            "credentials": { "remoteEnabled": true, "relayUrl": "wss://relay.example" },
            "relay": { "status": "disconnected", "lastError": "refused" }
        })),
        vec![
            "Remote access: enabled",
            "Relay: wss://relay.example",
            "Connection: disconnected",
            "Last error: refused",
        ]
    );
    assert_eq!(
        render_core_login_lines(&json!({ "userId": "user-1", "relay": { "status": "connected" } })),
        vec![
            "",
            "✓ Logged in as user-1",
            "Remote access is enabled (connection: connected)."
        ]
    );
    assert_eq!(
        core_whoami_json(
            &json!({ "credentials": { "userId": "user-1", "relayUrl": "wss://relay.example", "remoteEnabled": true, "token": "secret" } })
        ),
        json!({ "loggedIn": true, "userId": "user-1", "relayUrl": "wss://relay.example", "remoteEnabled": true })
    );
}

#[test]
fn renders_agent_and_team_details() {
    assert_eq!(
        render_core_agent_ps_lines(&json!({ "agents": [{
            "id": "codex-1", "tool": "codex", "role": "builder", "status": "working",
            "activity": "editing", "attention": "needed", "overseer": true,
            "loop": { "active": true, "goal": "ship" }, "worktreePath": "/repo/wt",
            "task": { "description": "Implement port", "status": "active" }
        }] })),
        vec![
            "codex-1  [codex:builder]  working  editing/needed  {overseer loop:ship}",
            "    worktree: /repo/wt",
            "    task: Implement port (active)",
        ]
    );
    assert_eq!(
        render_core_agent_list_lines(&json!({
            "projectRoot": "/repo",
            "agents": [
                {
                    "id": "codex-2", "toolConfigKey": "codex-heavy", "tool": "codex",
                    "status": "working", "activity": "editing", "scribe": true,
                    "loop": { "active": true }
                },
                {
                    "id": "codex-1", "tool": "codex", "role": "builder", "status": "idle",
                    "attention": "needed", "overseer": true, "backendSessionId": "backend-1",
                    "loop": { "active": true, "goal": "ship" }, "worktreePath": "/repo/wt",
                    "task": { "description": "Implement port", "status": "active" }
                }
            ]
        })),
        vec![
            "Main Checkout  /repo",
            "  working  canonical=codex-heavy  aimux=codex-2  state=editing  scribe loop",
            "",
            "wt  /repo/wt",
            "  idle  canonical=codex  aimux=codex-1  backend=backend-1  state=needed  role=builder overseer loop=ship",
            "    task: Implement port (active)",
        ]
    );
    assert_eq!(
        render_core_agent_input_lines(&json!({
            "sessionId": "codex-1",
            "delivery": { "state": "held", "reason": "visible-unsubmitted-input" }
        })),
        vec!["queued for codex-1"]
    );
    assert_eq!(
        render_core_agent_input_lines(&json!({ "sessionId": "codex-1" })),
        vec!["delivered to codex-1"]
    );
    assert_eq!(
        render_core_team_show_lines(&json!({ "config": {
            "roles": { "builder": { "description": "Writes code", "reviewedBy": "lead", "canEdit": true } },
            "defaultRole": "builder"
        } })),
        vec![
            "Team Roles:",
            "  builder: Writes code (reviewed by: lead, can edit)",
            "",
            "Default role: builder",
        ]
    );
    assert_eq!(
        render_core_team_add_lines(&json!({ "role": "  " })),
        vec!["Error: role is required for this operation."]
    );
}

#[test]
fn team_roles_preserve_json_insertion_order() {
    assert_eq!(
        render_core_team_show_lines(&json!({ "config": {
            "roles": {
                "zeta": { "description": "Second in lexical order" },
                "alpha": { "description": "First in lexical order" }
            },
            "defaultRole": "zeta"
        } })),
        vec![
            "Team Roles:",
            "  zeta: Second in lexical order",
            "  alpha: First in lexical order",
            "",
            "Default role: zeta",
        ]
    );
}

#[test]
fn renders_worktree_and_graveyard_tables() {
    assert_eq!(
        render_core_worktree_list_lines(&json!({ "worktrees": [] })),
        vec!["No worktrees found."]
    );
    assert_eq!(
        render_core_worktree_list_lines(
            &json!({ "worktrees": [{ "name": "feat", "branch": "feature/x", "path": "/repo/feat" }] })
        ),
        vec![
            "Name                          Branch                             Path",
            "-----------------------------------------------------------------------------------------------",
            "feat                          feature/x                          /repo/feat",
        ]
    );
    assert_eq!(
        render_core_graveyard_lines(
            &json!({ "entries": [{ "id": "a1", "tool": "codex", "backendSessionId": "thread-1" }], "worktrees": [] })
        ),
        vec![
            "Agents",
            "ID                       Tool           Backend Session ID",
            "----------------------------------------------------------------------",
            "a1                       codex          thread-1",
        ]
    );
    assert_eq!(
        render_core_graveyard_lines(
            &json!({ "entries": [{ "id": "a1", "command": null, "tool": "codex", "backendSessionId": null }], "worktrees": [] })
        ),
        vec![
            "Agents",
            "ID                       Tool           Backend Session ID",
            "----------------------------------------------------------------------",
            "a1                       codex          (none)",
        ]
    );
}

#[test]
fn renders_worktree_cache_cleanup_summary() {
    assert_eq!(
        render_core_worktree_cache_cleanup_lines(&json!({
            "dryRun": true,
            "reclaimableBytes": 1536,
            "reclaimedBytes": 0,
            "targets": [
                { "path": "/repo/a/node_modules", "worktreePath": "/repo/a", "sizeBytes": 1024 },
                { "path": "/repo/b/.cache", "worktreePath": "/repo/b", "sizeBytes": 512 }
            ],
            "results": [{ "status": "failed" }],
            "skipped": [{ "reason": "active-runtime" }]
        })),
        vec![
            "Worktree cache cleanup would remove 2 item(s), 1.5KB; 1 failed.",
            "By worktree:",
            "  1.0KB     1 item(s)  /repo/a",
            "   512B     1 item(s)  /repo/b",
            "Targets:",
            "  1.0KB  /repo/a/node_modules",
            "   512B  /repo/b/.cache",
            "Skipped 1 worktree(s) (1 active-runtime).",
        ]
    );
}

#[test]
fn cache_cleanup_keeps_first_seen_worktree_order_for_equal_sizes() {
    let lines = render_core_worktree_cache_cleanup_lines(&json!({
        "dryRun": true,
        "reclaimableBytes": 2,
        "targets": [
            { "path": "/repo/b/.cache", "worktreePath": "/repo/b", "sizeBytes": 1 },
            { "path": "/repo/a/.cache", "worktreePath": "/repo/a", "sizeBytes": 1 }
        ],
        "results": [],
        "skipped": []
    }));

    assert_eq!(lines[2], "     1B     1 item(s)  /repo/b");
    assert_eq!(lines[3], "     1B     1 item(s)  /repo/a");
}

#[test]
fn cache_cleanup_rounds_half_values_like_javascript_to_fixed() {
    let lines = render_core_worktree_cache_cleanup_lines(&json!({
        "dryRun": true,
        "reclaimableBytes": 10752,
        "targets": [
            { "path": "/repo/a/.cache", "worktreePath": "/repo/a", "sizeBytes": 10752 }
        ],
        "results": [],
        "skipped": []
    }));

    assert_eq!(
        lines[0],
        "Worktree cache cleanup would remove 1 item(s), 11KB; 0 failed."
    );
    assert_eq!(lines[2], "   11KB     1 item(s)  /repo/a");
    assert_eq!(lines[4], "   11KB  /repo/a/.cache");
}

#[test]
fn optional_text_fields_use_javascript_truthiness_and_nullish_fallbacks() {
    assert_eq!(
        render_core_remote_status_lines(&json!({
            "credentials": { "remoteEnabled": true, "relayUrl": "wss://relay.example" },
            "relay": { "status": "disconnected", "lastError": "" }
        })),
        vec![
            "Remote access: enabled",
            "Relay: wss://relay.example",
            "Connection: disconnected",
        ]
    );
    assert_eq!(
        render_core_loop_add_lines(&json!({ "sessionId": "codex-1", "goal": "" })),
        vec!["loop on codex-1"]
    );
    assert_eq!(
        render_core_loop_done_lines(&json!({ "sessionId": "codex-1", "eventWarning": "" })),
        vec!["loop done codex-1"]
    );
    assert_eq!(
        render_core_task_list_lines(&json!({
            "tasks": [{
                "id": "t-1",
                "status": "open",
                "description": "Fix it",
                "assignedTo": null,
                "assignee": "sam",
                "tool": "codex"
            }]
        })),
        vec!["t-1  task  open  target=sam", "  Fix it"]
    );
}

#[test]
fn renders_threads_tasks_messages_and_review_follow_up_order() {
    assert_eq!(
        render_core_thread_show_lines(&json!({
            "thread": { "title": "Port", "kind": "handoff", "id": "th-1", "status": "open", "participants": ["sam", "codex"], "owner": "sam", "waitingOn": ["codex"] },
            "messages": [{ "ts": "2026-09-05", "from": "sam", "kind": "message", "body": "Please port it" }]
        })),
        vec![
            "Port (handoff)",
            "id: th-1",
            "status: open",
            "participants: sam, codex",
            "owner: sam",
            "waitingOn: codex",
            "",
            "2026-09-05  sam [message]",
            "  Please port it",
        ]
    );
    assert_eq!(
        render_core_task_show_lines(
            &json!({ "task": { "description": "Port", "type": "task", "id": "t-1", "status": "active", "assignedBy": "sam", "assignedTo": "codex", "prompt": "Translate exactly" } })
        ),
        vec![
            "Port (task)",
            "id: t-1",
            "status: active",
            "assignedBy: sam",
            "assignedTo: codex",
            "",
            "Translate exactly"
        ]
    );
    assert_eq!(
        render_core_message_send_lines(
            &json!({ "thread": { "id": "th-1" }, "message": { "id": "m-1" }, "deliveredTo": ["a", "b"] })
        ),
        vec!["thread th-1", "message m-1", "delivered a,b"]
    );
    assert_eq!(
        render_core_review_request_changes_lines(
            &json!({ "task": { "id": "t-1" }, "thread": { "id": "th-1" }, "followUpTask": { "id": "t-2" } })
        ),
        vec!["task t-1", "follow-up t-2", "thread th-1"]
    );
}
