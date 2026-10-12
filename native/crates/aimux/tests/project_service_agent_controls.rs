use aimux::daemon_state::{
    MetadataState, load_metadata_state, metadata_state_path, save_metadata_state,
};
use aimux::loop_watcher::{load_loop_watcher_state, loop_watcher_state_path};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_roles::load_agent_role_registry;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::{Value, json};
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
    assert_eq!(worker["loopLastAction"]["goal"], "ship");
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
            "source": "dashboard",
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
            "source": "dashboard",
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
        second_read.body["loopAlertState"]["ok"],
        first_read.body["loopAlertState"]["ok"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["globalPause"]["pausedAtMs"],
        first_read.body["loopAlertState"]["globalPause"]["pausedAtMs"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["globalPause"]["expiresAtMs"],
        first_read.body["loopAlertState"]["globalPause"]["expiresAtMs"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["globalPause"]["pausedBy"],
        first_read.body["loopAlertState"]["globalPause"]["pausedBy"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["globalPause"]["reason"],
        first_read.body["loopAlertState"]["globalPause"]["reason"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["pausedCount"],
        first_read.body["loopAlertState"]["pausedCount"]
    );
    assert_eq!(
        second_read.body["loopAlertState"]["bufferedCount"],
        first_read.body["loopAlertState"]["bufferedCount"]
    );
    let first_remaining = first_read.body["loopAlertState"]["globalPause"]["remainingMs"]
        .as_u64()
        .expect("first remaining millis");
    let second_remaining = second_read.body["loopAlertState"]["globalPause"]["remainingMs"]
        .as_u64()
        .expect("second remaining millis");
    assert!(
        second_remaining <= first_remaining,
        "remainingMs should not increase across consecutive reads"
    );
    assert!(
        first_remaining.saturating_sub(second_remaining) < 1_000,
        "consecutive reads should only differ by elapsed wall-clock time"
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

/// A plane is where an agent is SHOWN. A worktree path nobody has a worktree at
/// is a group that renders nowhere, so the agent would vanish and the call
/// would still answer 200.
#[test]
fn plane_route_refuses_a_worktree_nobody_has() {
    let project = temp_project("plane-unknown-worktree");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::PLANE,
        Some(&json!({
            "sessionId": "boss-1",
            "lane": { "kind": "worktree", "worktreePath": "/repo/typo" }
        })),
    );

    assert_eq!(response.status, 400);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("/repo/typo"),
        "the refusal has to name the path: {}",
        response.body
    );
    let state = load_metadata_state(&state_dir);
    assert!(
        state.sessions["boss-1"].get("lane").is_none(),
        "a refused move must not write a plane"
    );
    cleanup(project);
}

/// An unreadable topology is not an empty one. Answering "no worktree at that
/// path" would be a claim about the project we have no grounds for, and would
/// refuse every worktree plane for as long as the file stayed broken.
#[test]
fn plane_route_reports_an_unreadable_topology_instead_of_denying_the_worktree() {
    let project = temp_project("plane-unreadable-topology");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    std::fs::write(
        state_dir.join("runtime-topology.yaml"),
        ": not : valid : yaml :",
    )
    .expect("write broken topology");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::PLANE,
        Some(&json!({
            "sessionId": "boss-1",
            "lane": { "kind": "worktree", "worktreePath": "/repo/feature" }
        })),
    );

    assert_eq!(response.status, 500, "{}", response.body);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("worktrees"),
        "the failure has to say it could not read them: {}",
        response.body
    );
    cleanup(project);
}

/// The main checkout is a plane agents legitimately sit in, and the one they
/// return to, so it has to pass the same check.
#[test]
fn plane_route_accepts_the_main_checkout_and_the_supervisor_plane() {
    let project = temp_project("plane-known-targets");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let project_root = project.to_string_lossy().into_owned();

    let supervisor = route_project_service_request(
        &context,
        "POST",
        routes::agents::PLANE,
        Some(&json!({ "sessionId": "boss-1", "lane": { "kind": "supervisor" } })),
    );
    assert_eq!(supervisor.status, 200);
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["boss-1"]["lane"],
        json!({ "kind": "supervisor" })
    );

    let main_checkout = route_project_service_request(
        &context,
        "POST",
        routes::agents::PLANE,
        Some(&json!({
            "sessionId": "boss-1",
            "lane": { "kind": "worktree", "worktreePath": project_root }
        })),
    );
    assert_eq!(main_checkout.status, 200, "{}", main_checkout.body);

    // Clearing drops the stored plane so the derived one takes over again.
    let cleared = route_project_service_request(
        &context,
        "POST",
        routes::agents::PLANE,
        Some(&json!({ "sessionId": "boss-1", "lane": Value::Null })),
    );
    assert_eq!(cleared.status, 200);
    let state = load_metadata_state(&state_dir);
    assert!(state.sessions["boss-1"].get("lane").is_none());
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

/// Sam's words: "user managed can only be by the user ... nothign ends it
/// besides me for user managed goal. thats the whole point."
///
/// Asserted through the route rather than the helper, because the helper
/// passing proves nothing about whether the route ever consults it.
#[test]
fn an_agent_cannot_close_a_user_managed_goal_through_the_loop_route() {
    let project = temp_project("user-goal-close");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let add = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "migrate the whole thing",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );
    assert_eq!(add.status, 200, "{:?}", add.body);
    assert_eq!(add.body["loop"]["goalKind"], "user");

    for action in ["remove", "done", "block"] {
        let close = route_project_service_request(
            &context,
            "POST",
            routes::agents::LOOP,
            Some(&json!({
                "sessionId": "worker-1",
                "active": false,
                "action": action,
                "source": "agent"
            })),
        );
        assert_eq!(
            close.status, 409,
            "`{action}` must be refused: {:?}",
            close.body
        );
        let error = close.body["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("user-managed") && error.contains(action),
            "the refusal must name the kind and the operation, got {error:?}"
        );
    }

    // And the goal is still there afterwards, which is the point.
    let metadata = load_metadata_state(&state_dir);
    let loop_meta = metadata.sessions["worker-1"]["loop"].clone();
    assert_eq!(loop_meta["active"], true);
    assert_eq!(loop_meta["goalKind"], "user");
}

/// The overseer is an agent too, and so is every automation.
#[test]
fn no_automation_closes_a_user_managed_goal_through_the_route() {
    let project = temp_project("user-goal-automation");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );

    for source in ["overseer", "task", "system", "unknown"] {
        let close = route_project_service_request(
            &context,
            "POST",
            routes::agents::LOOP,
            Some(&json!({
                "sessionId": "worker-1",
                "active": false,
                "action": "done",
                "source": source
            })),
        );
        assert_eq!(close.status, 409, "source {source} must be refused");
    }
}

#[test]
fn sam_closes_a_user_managed_goal_through_the_route() {
    let project = temp_project("user-goal-sam");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );
    let close = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": false,
            "action": "done",
            "source": "dashboard"
        })),
    );
    assert_eq!(close.status, 200, "{:?}", close.body);
}

/// `active: true` rewrites the whole loop object, so without a guard an agent
/// re-adds a user-managed goal as agent-managed and then closes the one it
/// just created. Changing the kind is a close in disguise.
#[test]
fn an_agent_cannot_launder_a_user_managed_goal_by_re_adding_it() {
    let project = temp_project("user-goal-launder");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );

    let relabel = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "agent",
            "source": "agent"
        })),
    );
    assert_eq!(relabel.status, 409, "{:?}", relabel.body);

    let metadata = load_metadata_state(&state_dir);
    assert_eq!(metadata.sessions["worker-1"]["loop"]["goalKind"], "user");
}

/// Re-adding without naming a kind must keep the stored one, or every goal
/// reverts to the permissive default the next time anything touches it.
#[test]
fn a_re_add_without_a_kind_keeps_the_stored_one() {
    let project = temp_project("user-goal-keep");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );
    let edit = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul, revised",
            "source": "agent"
        })),
    );
    assert_eq!(edit.status, 200, "editing the goal text is still allowed");
    assert_eq!(edit.body["loop"]["goalKind"], "user");
    assert_eq!(edit.body["loop"]["goal"], "long haul, revised");
}

/// The hole a review found: pausing silences the same reminders a close would,
/// and this route used to ask nobody whose goal it was.
#[test]
fn an_agent_cannot_pause_the_alerts_on_a_user_managed_goal() {
    let project = temp_project("user-goal-pause");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "long haul",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );

    let pause = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({
            "sessionId": "worker-1",
            "paused": true,
            "source": "agent"
        })),
    );
    assert_eq!(pause.status, 409, "{:?}", pause.body);

    let sam = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({
            "sessionId": "worker-1",
            "paused": true,
            "source": "dashboard"
        })),
    );
    assert_eq!(sam.status, 200, "Sam can still quiet it: {:?}", sam.body);
}

/// An agent-managed goal is the default and stays the agent's to close, so
/// this cannot have broken the behaviour the loop already had.
#[test]
fn an_agent_still_closes_its_own_agent_managed_goal_through_the_route() {
    let project = temp_project("agent-goal-close");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "fix the test",
            "source": "agent"
        })),
    );
    let close = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": false,
            "action": "done",
            "source": "agent"
        })),
    );
    assert_eq!(close.status, 200, "{:?}", close.body);
}

/// Reading stored metadata falls back closed, but a REQUEST has somewhere to
/// put an error -- so a caller asking for a token goal with no budget is told,
/// rather than quietly handed a user-managed goal it never asked for.
#[test]
fn a_token_goal_request_without_a_budget_is_refused_not_converted() {
    let project = temp_project("token-goal-budget");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for body in [
        json!({ "sessionId": "worker-1", "active": true, "goalKind": "tokens", "source": "dashboard" }),
        json!({ "sessionId": "worker-1", "active": true, "goalKind": "tokens", "tokenBudget": 0, "source": "dashboard" }),
    ] {
        let response =
            route_project_service_request(&context, "POST", routes::agents::LOOP, Some(&body));
        assert_eq!(response.status, 400, "{:?}", response.body);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("tokenBudget"),
            "the refusal must name the missing field, got {:?}",
            response.body["error"]
        );
    }

    let good = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "spend no more than this",
            "goalKind": "tokens",
            "tokenBudget": 50_000,
            "source": "dashboard"
        })),
    );
    assert_eq!(good.status, 200, "{:?}", good.body);
    assert_eq!(good.body["loop"]["goalKind"], "tokens");
    assert_eq!(good.body["loop"]["tokenBudget"], 50_000);
}

/// A kind this build does not know is a typo, not a new feature.
#[test]
fn an_unknown_goal_kind_request_is_refused() {
    let project = temp_project("goal-kind-unknown");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goalKind": "whenever",
            "source": "dashboard"
        })),
    );
    assert_eq!(response.status, 400, "{:?}", response.body);
}

/// A budget sent alongside a non-token kind is not stored, so it cannot come
/// back out of `stored_goal_kind` as a token goal nobody asked for.
#[test]
fn a_budget_on_a_non_token_goal_is_not_persisted() {
    let project = temp_project("goal-kind-stray-budget");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goalKind": "user",
            "tokenBudget": 50_000,
            "source": "dashboard"
        })),
    );
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["loop"]["goalKind"], "user");
    assert!(
        response.body["loop"].get("tokenBudget").is_none(),
        "a user-managed goal has no budget to store, got {:?}",
        response.body["loop"]
    );
}

/// A global pause silences every session's reminders at once, user-managed
/// goals included -- so it is the one the per-session gate would have been
/// trivially walked around with.
#[test]
fn an_agent_cannot_pause_the_whole_fleets_alerts() {
    let project = temp_project("global-pause-agent");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for source in ["agent", "overseer", "task", "system", "unknown"] {
        let pause = route_project_service_request(
            &context,
            "POST",
            routes::agents::LOOP_ALERTS,
            Some(&json!({ "global": true, "paused": true, "source": source })),
        );
        assert_eq!(
            pause.status, 409,
            "source {source} must not quiet the fleet"
        );
    }

    let unattributed = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "global": true, "paused": true })),
    );
    assert_eq!(
        unattributed.status, 409,
        "and a request that names nobody is not Sam"
    );

    let sam = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(&json!({ "global": true, "paused": true, "source": "dashboard" })),
    );
    assert_eq!(sam.status, 200, "{:?}", sam.body);
}

/// An agent may still CREATE a user-managed goal -- putting itself under one
/// is not ending one. Without this, deleting the `stored_loop.is_some()` guard
/// passed every other test while making this impossible.
#[test]
fn an_agent_can_put_itself_under_a_user_managed_goal() {
    let project = temp_project("agent-sets-user-goal");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let add = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "the long migration",
            "goalKind": "user",
            "source": "agent"
        })),
    );
    assert_eq!(add.status, 200, "{:?}", add.body);
    assert_eq!(add.body["loop"]["goalKind"], "user");

    // And having done so, it cannot take itself back out.
    let close = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": false,
            "action": "done",
            "source": "agent"
        })),
    );
    assert_eq!(close.status, 409, "{:?}", close.body);
}

/// Shrinking a token budget to one already spent would close the goal by
/// construction, and the kind NAME does not change when it happens.
#[test]
fn an_agent_cannot_shrink_a_token_budget() {
    let project = temp_project("token-budget-shrink");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "spend a million",
            "goalKind": "tokens",
            "tokenBudget": 1_000_000,
            "source": "dashboard"
        })),
    );

    let shrink = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "spend a million",
            "goalKind": "tokens",
            "tokenBudget": 1,
            "source": "agent"
        })),
    );
    assert_eq!(shrink.status, 409, "{:?}", shrink.body);

    let metadata = load_metadata_state(&state_dir);
    assert_eq!(
        metadata.sessions["worker-1"]["loop"]["tokenBudget"], 1_000_000,
        "the budget Sam set must survive"
    );
}

/// A budget with no kind is a request nobody can honour.
#[test]
fn a_token_budget_without_a_kind_is_refused() {
    let project = temp_project("budget-no-kind");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "tokenBudget": 50_000,
            "source": "dashboard"
        })),
    );
    assert_eq!(response.status, 400, "{:?}", response.body);
}
