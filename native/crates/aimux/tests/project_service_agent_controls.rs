use aimux::daemon_state::{
    MetadataState, load_metadata_state, metadata_state_path, save_metadata_state,
};
use aimux::loop_watcher::{load_loop_watcher_state, loop_watcher_state_path};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_roles::load_agent_role_registry;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn loop_route_sets_and_clears_loop_metadata_with_provenance() {
    let project = temp_project("loop");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let add = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": " worker-1 ",
            "active": true,
            "goal": " ship ",
            "source": "dashboard",
            "updatedBy": "dashboard",
            "updatedBySessionId": "boss",
            "updatedByRole": "overseer",
            "reason": "keep moving"
        })),
    );

    assert_eq!(add.status, 200);
    assert_eq!(add.body["ok"], true);
    assert_eq!(add.body["sessionId"], "worker-1");
    assert_eq!(add.body["loop"]["active"], true);
    assert_eq!(add.body["loop"]["goal"], "ship");
    assert_eq!(add.body["loop"]["source"], "dashboard");
    assert!(add.body["loop"]["since"].as_str().unwrap().ends_with('Z'));
    let state = load_metadata_state(&state_dir);
    let worker = &state.sessions["worker-1"];
    assert_eq!(worker["loop"], add.body["loop"]);
    assert_eq!(worker["loopLastAction"]["action"], "add");
    assert_eq!(worker["loopLastAction"]["goal"], "ship");
    assert_eq!(worker["loopLastAction"]["source"], "dashboard");
    assert_eq!(worker["loopLastAction"]["updatedBySessionId"], "boss");

    let remove = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": false,
            "action": "done",
            "source": "overseer",
            "reason": "complete"
        })),
    );

    assert_eq!(remove.status, 200);
    assert!(remove.body["loop"].is_null());
    assert_eq!(remove.body["loopLastAction"]["action"], "done");
    assert_eq!(remove.body["loopLastAction"]["source"], "overseer");
    let state = load_metadata_state(&state_dir);
    let worker = &state.sessions["worker-1"];
    assert!(worker.get("loop").is_none());
    assert_eq!(worker["loopLastAction"], remove.body["loopLastAction"]);
    cleanup(project);
}

#[test]
fn loop_provenance_truncates_like_javascript_utf16_slice() {
    let project = temp_project("loop-utf16");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let emoji_reason = "😀".repeat(300);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "updatedBy": emoji_reason,
            "reason": "😀".repeat(1200)
        })),
    );

    assert_eq!(response.status, 200);
    let state = load_metadata_state(&state_dir);
    let updated_by = state.sessions["worker-1"]["loop"]["updatedBy"]
        .as_str()
        .unwrap();
    let reason = state.sessions["worker-1"]["loop"]["reason"]
        .as_str()
        .unwrap();
    assert_eq!(updated_by.encode_utf16().count(), 500);
    assert_eq!(reason.encode_utf16().count(), 2000);
    cleanup(project);
}

#[test]
fn loop_alert_pause_requires_active_loop_and_persists_under_watcher_state() {
    let project = temp_project("loop-alert-pause");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "worker-1".into(),
                json!({
                    "loop": {
                        "active": true,
                        "since": "2026-09-09T00:00:00.000Z",
                        "goal": "ship",
                        "source": "human"
                    }
                }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({
            "sessionId": "worker-1",
            "paused": true,
            "updatedBy": "sam",
            "reason": "human is intervening"
        })),
    );
    assert_eq!(pause.status, 200);
    assert_eq!(pause.body["paused"], true);
    assert_eq!(pause.body["pause"]["pausedBy"], "sam");
    assert_eq!(pause.body["pause"]["reason"], "human is intervening");

    let watcher = load_loop_watcher_state(loop_watcher_state_path(&state_dir))
        .expect("watcher state must load");
    assert!(watcher.paused_loop_alert("worker-1").is_some());

    let unpause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "sessionId": "worker-1", "paused": false })),
    );
    assert_eq!(unpause.status, 200);
    assert_eq!(unpause.body["paused"], false);
    assert_eq!(unpause.body["cleared"], true);
    let watcher = load_loop_watcher_state(loop_watcher_state_path(&state_dir))
        .expect("watcher state must load");
    assert!(watcher.paused_loop_alert("worker-1").is_none());
    cleanup(project);
}

#[test]
fn loop_alert_pause_for_non_looping_agent_fails_loud_instead_of_creating_stale_pause() {
    let project = temp_project("loop-alert-pause-missing-loop");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([("worker-1".into(), json!({}))]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "sessionId": "worker-1", "paused": true })),
    );
    assert_eq!(pause.status, 409);
    assert!(
        pause.body["error"]
            .as_str()
            .unwrap()
            .contains("session is not in a loop")
    );
    cleanup(project);
}

#[test]
fn loop_alert_pause_reports_metadata_unavailable_instead_of_not_in_loop_when_metadata_is_corrupt() {
    let project = temp_project("loop-alert-pause-corrupt-metadata");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(metadata_state_path(&state_dir), "{not-json").unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "sessionId": "worker-1", "paused": true })),
    );

    assert_eq!(pause.status, 500);
    assert_eq!(pause.body["reason"], "metadata-unavailable");
    assert!(
        pause.body["error"]
            .as_str()
            .unwrap()
            .contains("parse metadata state")
    );
    assert!(
        !pause.body["error"]
            .as_str()
            .unwrap()
            .contains("session is not in a loop")
    );
    cleanup(project);
}

#[test]
fn global_loop_alert_pause_persists_with_expiry_and_can_resume() {
    let project = temp_project("global-loop-alert-pause");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({
            "global": true,
            "paused": true,
            "durationMs": 60000,
            "updatedBy": "dashboard",
            "reason": "human intervention"
        })),
    );

    assert_eq!(pause.status, 200);
    assert_eq!(pause.body["global"], true);
    assert_eq!(pause.body["paused"], true);
    assert_eq!(pause.body["loopAlertState"]["globalPause"]["enabled"], true);
    assert_eq!(
        pause.body["loopAlertState"]["globalPause"]["reason"],
        "human intervention"
    );

    let resume = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "global": true, "paused": false })),
    );

    assert_eq!(resume.status, 200);
    assert_eq!(resume.body["paused"], false);
    assert_eq!(
        resume.body["loopAlertState"]["globalPause"]["enabled"],
        false
    );
    cleanup(project);
}

#[test]
fn loop_alert_state_is_readable_without_mutating_pause_state() {
    let project = temp_project("global-loop-alert-state-read");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({
            "global": true,
            "paused": true,
            "durationMs": 60000,
            "updatedBy": "dashboard",
            "reason": "human intervention"
        })),
    );
    assert_eq!(pause.status, 200);
    assert_eq!(pause.body["loopAlertState"]["globalPause"]["enabled"], true);
    assert_eq!(
        pause.body["loopAlertState"]["globalPause"]["reason"],
        "human intervention"
    );

    let state_path = loop_watcher_state_path(&state_dir);
    let before_read = read_to_string(&state_path).expect("watcher state file");

    let first_read =
        route_project_service_request(&context, "GET", routes::agents::LOOP_ALERTS, None);
    let after_first_read = read_to_string(&state_path).expect("watcher state after first read");

    assert_eq!(first_read.status, 200);
    assert_eq!(first_read.body["ok"], true);
    assert_eq!(
        first_read.body["loopAlertState"]["globalPause"]["enabled"],
        true
    );
    assert_eq!(
        first_read.body["loopAlertState"]["globalPause"]["reason"],
        "human intervention"
    );
    assert_eq!(
        after_first_read, before_read,
        "GET /agents/loop-alerts must not rewrite or toggle watcher state"
    );

    let second_read =
        route_project_service_request(&context, "GET", routes::agents::LOOP_ALERTS, None);
    let after_second_read = read_to_string(&state_path).expect("watcher state after second read");

    assert_eq!(second_read.status, 200);
    assert_eq!(
        second_read.body["loopAlertState"]["globalPause"]["enabled"],
        true
    );
    assert_eq!(
        second_read.body["loopAlertState"],
        first_read.body["loopAlertState"]
    );
    assert_eq!(
        after_second_read, before_read,
        "repeated reads must leave the pause state unchanged"
    );

    let resume = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "global": true, "paused": false })),
    );
    assert_eq!(resume.status, 200);
    assert_eq!(resume.body["paused"], false);
    assert_eq!(
        resume.body["loopAlertState"]["globalPause"]["enabled"],
        false
    );

    cleanup(project);
}

#[test]
fn loop_and_control_routes_validate_required_fields() {
    let project = temp_project("validation");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let missing_session =
        route_project_service_request(&context, "POST", routes::agents::LOOP, Some(&json!({})));
    assert_eq!(missing_session.status, 400);
    assert_eq!(missing_session.body["error"], "sessionId is required");

    let missing_active = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss" })),
    );
    assert_eq!(missing_active.status, 400);
    assert_eq!(missing_active.body["error"], "active (boolean) is required");

    let wrong_method = route_project_service_request(&context, "GET", routes::agents::SCRIBE, None);
    assert_eq!(wrong_method.status, 405);
    cleanup(project);
}

#[test]
fn overseer_route_promotes_agent_without_demoting_other_overseers() {
    let project = temp_project("overseer");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss-2", "active": true })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["overseer"], true);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["boss-1"]["overseer"], true);
    assert_eq!(state.sessions["boss-2"]["overseer"], true);
    assert_eq!(state.sessions["boss-2"]["role"], "overseer");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["sessions"]["boss-2"]["role"], "overseer");
    assert_eq!(
        registry["sessions"]["boss-2"]["lane"],
        json!({ "kind": "supervisor" })
    );

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "boss-2",
            "active": false,
            "worktreePath": "/repo/supervisor-demoted"
        })),
    );
    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["overseer"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["boss-2"]["overseer"], false);
    assert_eq!(state.sessions["boss-2"]["projectControl"], false);
    cleanup(project);
}

#[test]
fn overseer_route_demotes_with_derived_worktree_target() {
    let project = temp_project("overseer-demote-derived");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "boss".into(),
                json!({
                    "overseer": true,
                    "role": "overseer",
                    "team": { "role": "overseer", "teamId": "overseer" },
                    "effectiveLane": { "kind": "worktree", "worktreePath": "/repo/worktrees/boss" },
                    "runtimeWorkingDirectory": "/repo/worktrees/boss",
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss", "active": false })),
    );

    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["overseer"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["boss"]["overseer"], false);
    assert_eq!(
        state.sessions["boss"]["worktreePath"],
        "/repo/worktrees/boss"
    );
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["sessions"]["boss"]["lane"],
        json!({ "kind": "worktree", "worktreePath": "/repo/worktrees/boss" })
    );
    cleanup(project);
}

#[test]
fn overseer_route_demotes_floating_supervisor_to_project_root() {
    let project = temp_project("overseer-demote-root");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "boss".into(),
                json!({
                    "overseer": true,
                    "role": "overseer",
                    "team": { "role": "overseer", "teamId": "overseer" },
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss", "active": false })),
    );

    assert_eq!(clear.status, 200);
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["boss"]["worktreePath"],
        project.to_string_lossy().as_ref()
    );
    cleanup(project);
}

#[test]
fn scribe_route_demotes_with_derived_worktree_target() {
    let project = temp_project("scribe-demote-derived");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "scribe".into(),
                json!({
                    "scribe": true,
                    "role": "scribe",
                    "team": { "role": "scribe", "teamId": "scribe" },
                    "effectiveLane": { "kind": "worktree", "worktreePath": "/repo/worktrees/scribe" },
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "scribe", "active": false })),
    );

    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["scribe"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["scribe"]["worktreePath"],
        "/repo/worktrees/scribe"
    );
    cleanup(project);
}

#[test]
fn overseer_route_migrates_coder_to_supervisor_lane_until_relaunch() {
    let project = temp_project("overseer-migrate");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "worker".into(),
                json!({
                    "tool": "codex",
                    "worktreePath": "/repo/worktrees/worker",
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "worker", "active": true })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["overseer"], true);
    let state = load_metadata_state(&state_dir);
    let worker = &state.sessions["worker"];
    assert_eq!(worker["role"], "overseer");
    assert_eq!(worker["overseer"], true);
    assert!(worker.get("worktreePath").is_none());
    assert_eq!(worker["pendingRelaunchForRole"], true);
    assert_eq!(worker["effectiveRole"], "coder");
    assert_eq!(
        worker["effectiveLane"],
        json!({ "kind": "worktree", "worktreePath": "/repo/worktrees/worker" })
    );
    assert_eq!(worker["runtimeWorkingDirectory"], "/repo/worktrees/worker");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["sessions"]["worker"]["role"], "overseer");
    assert_eq!(
        registry["sessions"]["worker"]["lane"],
        json!({ "kind": "supervisor" })
    );
    assert_eq!(
        registry["sessions"]["worker"]["effectiveLane"],
        json!({ "kind": "worktree", "worktreePath": "/repo/worktrees/worker" })
    );
    cleanup(project);
}

#[test]
fn scribe_route_promotes_and_clear_sets_false_override() {
    let project = temp_project("scribe");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "scribe-2", "active": true })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["scribe"], true);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["scribe-1"]["scribe"], true);
    assert_eq!(state.sessions["scribe-2"]["scribe"], true);
    assert_eq!(state.sessions["scribe-2"]["role"], "scribe");

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({
            "sessionId": "scribe-2",
            "active": false,
            "worktreePath": "/repo/scribe-demoted"
        })),
    );
    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["scribe"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["scribe-2"]["scribe"], false);
    cleanup(project);
}

#[test]
fn watch_route_binds_coder_to_one_overseer() {
    let project = temp_project("watch-bind");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss-1".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "boss-2".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "tool": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bind = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss-1",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(bind.status, 200);
    assert_eq!(bind.body["ok"], true);
    assert_eq!(bind.body["watchedSessionIds"], json!(["worker"]));
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "boss-1");
    assert_eq!(
        registry["sessions"]["boss-1"]["watching"],
        json!(["worker"])
    );

    let conflict = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss-2",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.body["ok"], false);
    assert_eq!(conflict.body["reason"], "already-watched");
    assert_eq!(conflict.body["currentOverseerSessionId"], "boss-1");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "boss-1");
    cleanup(project);
}

#[test]
fn watch_route_unbinds_existing_binding_even_after_roles_drift() {
    let project = temp_project("watch-unbind-after-role-drift");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "tool": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bind = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(bind.status, 200);
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "tool": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "scribe": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();

    let unbind = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": false
        })),
    );

    assert_eq!(unbind.status, 200);
    assert_eq!(unbind.body["ok"], true);
    assert_eq!(unbind.body["active"], false);
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry.pointer("/watchBindings/worker").is_none());
    assert!(registry.pointer("/sessions/boss/watching").is_none());
    cleanup(project);
}

#[test]
fn supervisor_promotion_clears_existing_watched_binding_for_promoted_agent() {
    let project = temp_project("watch-promote-clears-watched-binding");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "tool": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bind = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(bind.status, 200);

    let promote = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "worker", "active": true })),
    );

    assert_eq!(promote.status, 200);
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry.pointer("/watchBindings/worker").is_none());
    assert!(registry.pointer("/sessions/boss/watching").is_none());
    assert_eq!(registry["sessions"]["worker"]["role"], "scribe");
    cleanup(project);
}

#[test]
fn demoting_watching_overseer_requires_explicit_binding_release() {
    let project = temp_project("watch-demote");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "tool": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bind = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(bind.status, 200);

    let refused = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "boss",
            "active": false
        })),
    );
    assert_eq!(refused.status, 409);
    assert_eq!(refused.body["ok"], false);
    assert_eq!(refused.body["reason"], "active-watch-bindings");
    assert_eq!(
        refused.body["details"]["watchedSessionIds"],
        json!(["worker"])
    );
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "boss");

    let released = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "boss",
            "active": false,
            "worktreePath": "/repo/worktrees/boss",
            "releaseBindings": true
        })),
    );
    assert_eq!(released.status, 200);
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry["watchBindings"].as_object().unwrap().is_empty());
    assert_eq!(
        registry["sessions"]["boss"]["lane"],
        json!({ "kind": "worktree", "worktreePath": "/repo/worktrees/boss" })
    );
    cleanup(project);
}

#[test]
fn watch_route_refuses_non_coder_watched_agent() {
    let project = temp_project("watch-refuse-non-coder");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "scribe".into(),
                    json!({ "scribe": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "scribe",
            "active": true
        })),
    );

    assert_eq!(response.status, 400);
    assert_eq!(response.body["ok"], false);
    assert_eq!(response.body["reason"], "watched-agent-must-be-coder");
    assert_eq!(response.body["details"]["role"], "scribe");
    assert!(
        load_agent_role_registry(&state_dir)
            .expect("role registry")
            .pointer("/watchBindings/scribe")
            .is_none()
    );
    cleanup(project);
}

#[test]
fn watch_route_reports_metadata_unavailable_instead_of_session_not_found_when_metadata_is_corrupt()
{
    let project = temp_project("watch-corrupt-metadata");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(metadata_state_path(&state_dir), "{not-json").unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": true
        })),
    );

    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert_eq!(response.body["reason"], "metadata-unavailable");
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("parse metadata state")
    );
    cleanup(project);
}

#[test]
fn watch_route_still_reports_session_not_found_for_genuinely_absent_session() {
    let project = temp_project("watch-missing-session");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "boss".into(),
                json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": true
        })),
    );

    assert_eq!(response.status, 404);
    assert_eq!(response.body["ok"], false);
    assert_eq!(response.body["reason"], "session-not-found");
    assert_eq!(response.body["sessionId"], "worker");
    cleanup(project);
}

fn seed_metadata(state_dir: &PathBuf) {
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss-1".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "scribe-1".into(),
                    json!({ "scribe": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-agent-controls-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
