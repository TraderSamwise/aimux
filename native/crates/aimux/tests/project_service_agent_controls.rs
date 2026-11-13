use aimux::daemon_state::{
    MetadataState, load_metadata_state, metadata_state_path, save_metadata_state,
};
use aimux::loop_watcher::{load_loop_watcher_state, loop_watcher_state_path};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_roles::load_agent_role_registry;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::runtime_topology_path;
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
fn loop_alert_pause_for_unknown_agent_fails_loud_instead_of_creating_stale_pause() {
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
            .contains("no live session in runtime topology")
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
fn scribe_promotion_clears_the_promoted_agents_incoming_binding() {
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
fn promoting_a_watched_coder_keeps_its_own_manager() {
    // The obvious way to build a tree is to bind a coder to its manager and
    // then promote it so it can manage others. Promotion used to cut the
    // incoming edge, so the middle of the tree lost its link upward and only
    // promote-then-bind worked -- which nothing says.
    let project = temp_project("promote-keeps-manager");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({
                        "role": "coder",
                        "worktreePath": "/repo/worktrees/middle",
                        "updatedAt": "2026-09-05T00:00:00.000Z"
                    }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bound = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "top",
            "watchedSessionId": "middle",
            "active": true
        })),
    );
    assert_eq!(bound.status, 200, "{:?}", bound.body);

    let promoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "middle", "active": true })),
    );
    assert_eq!(promoted.status, 200, "{:?}", promoted.body);

    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["watchBindings"]["middle"], "top",
        "promotion dropped the middle's own manager: {registry:?}"
    );
    assert_eq!(registry["sessions"]["middle"]["role"], "overseer");
    cleanup(project);
}

#[test]
fn demoting_a_mid_tier_overseer_moves_its_reports_up_to_its_own_manager() {
    // Cutting the reports loose instead would leave them pointing at an agent
    // that is no longer an overseer, and `sync_watching_lists` would stamp it
    // back to one on the next pass -- undoing the demotion that was just
    // written.
    let project = temp_project("demote-reparents");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({
                        "overseer": true,
                        "worktreePath": "/repo/worktrees/middle",
                        "updatedAt": "2026-09-05T00:00:00.000Z"
                    }),
                ),
                (
                    "leaf".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for (overseer, watched) in [("top", "middle"), ("middle", "leaf")] {
        let bound = route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": overseer,
                "watchedSessionId": watched,
                "active": true
            })),
        );
        assert_eq!(
            bound.status, 200,
            "{overseer} -> {watched}: {:?}",
            bound.body
        );
    }

    let demoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "middle",
            "active": false,
            "releaseBindings": true,
            "worktreePath": "/repo/worktrees/middle"
        })),
    );
    assert_eq!(demoted.status, 200, "{:?}", demoted.body);

    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["watchBindings"]["leaf"], "top",
        "the leaf was orphaned rather than moved up: {registry:?}"
    );
    assert_eq!(
        registry["watchBindings"]["middle"], "top",
        "the demoted agent lost its own manager: {registry:?}"
    );
    assert_eq!(registry["sessions"]["middle"]["role"], "coder");
    cleanup(project);
}

#[test]
fn a_round_trip_through_demotion_keeps_the_link_upward() {
    // Promotion keeping the manager is only half the symmetry. If demotion
    // still cut it, demote-then-repromote would lose the link upward -- the
    // same bug in the other direction.
    let project = temp_project("demote-repromote");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({
                        "overseer": true,
                        "worktreePath": "/repo/worktrees/middle",
                        "updatedAt": "2026-09-05T00:00:00.000Z"
                    }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bound = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "top",
            "watchedSessionId": "middle",
            "active": true
        })),
    );
    assert_eq!(bound.status, 200, "{:?}", bound.body);

    let demoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "middle",
            "active": false,
            "worktreePath": "/repo/worktrees/middle"
        })),
    );
    assert_eq!(demoted.status, 200, "{:?}", demoted.body);

    let repromoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "middle", "active": true })),
    );
    assert_eq!(repromoted.status, 200, "{:?}", repromoted.body);

    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["watchBindings"]["middle"], "top",
        "the round trip lost the link upward: {registry:?}"
    );
    cleanup(project);
}

#[test]
fn a_report_that_cannot_be_moved_up_refuses_the_demotion_rather_than_orphaning_it() {
    // A cycle cannot be created through the route any more, but one written
    // by a build that had no guard can still be on disk. Reparenting into it
    // is impossible, and silently skipping the move would leave the report
    // with no manager at all and no word of it -- its old binding has just
    // been cleared.
    let project = temp_project("demote-unplaceable");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({
                        "overseer": true,
                        "worktreePath": "/repo/worktrees/middle",
                        "updatedAt": "2026-09-05T00:00:00.000Z"
                    }),
                ),
                (
                    "leaf".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();

    // Written straight to disk: `top` reports to `leaf` and `leaf` reports to
    // `middle`, which the route itself would now refuse to assemble.
    create_dir_all(&state_dir).unwrap();
    write(
        state_dir.join("agent-role-registry.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "sessions": {},
            "roleSlots": {},
            "watchBindings": { "middle": "top", "leaf": "middle", "top": "leaf" }
        }))
        .unwrap(),
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let demoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({
            "sessionId": "middle",
            "active": false,
            "releaseBindings": true,
            "worktreePath": "/repo/worktrees/middle"
        })),
    );

    assert_eq!(demoted.status, 409, "{:?}", demoted.body);
    assert_eq!(demoted.body["reason"], "unplaceable-reports");
    assert_eq!(demoted.body["details"]["watchedSessionIds"][0], "leaf");
    // Refused whole: the tree is exactly as it was.
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["leaf"], "middle");
    // And metadata was never written. A refusal that had already demoted the
    // agent in metadata left the registry saying overseer and metadata saying
    // coder, which no retry could repair: the registry wins on every surface,
    // while the metadata-driven overseer list had already dropped the agent,
    // so its reports pointed at a non-overseer and rebinding was refused.
    let metadata = load_metadata_state(&state_dir);
    assert_eq!(
        metadata
            .sessions
            .get("middle")
            .and_then(|s| s.get("overseer")),
        Some(&json!(true)),
        "the refused demotion still wrote metadata: {:?}",
        metadata.sessions.get("middle")
    );
    cleanup(project);
}

#[test]
fn handing_a_report_to_a_different_manager_says_so_rather_than_claiming_success() {
    // Promotion no longer cuts the incoming edge, so a second `watch` for an
    // already-bound agent is refused -- and releasing it is the documented
    // way out. Releasing with the WRONG manager named used to remove nothing
    // and still answer 200, which made the one route to a transfer report
    // success while leaving the agent exactly where it was.
    let project = temp_project("watch-transfer");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "other".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let watch = |overseer: &str, watched: &str, active: bool| {
        route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": overseer,
                "watchedSessionId": watched,
                "active": active
            })),
        )
    };

    assert_eq!(watch("top", "worker", true).status, 200);

    // Taking it directly is refused, and names who holds it.
    let stolen = watch("other", "worker", true);
    assert_eq!(stolen.status, 409);
    assert_eq!(stolen.body["reason"], "already-watched");

    // Releasing it under the wrong name is refused too, rather than
    // answering 200 having done nothing.
    let wrong_release = watch("other", "worker", false);
    assert_eq!(wrong_release.status, 409, "{:?}", wrong_release.body);
    assert_eq!(wrong_release.body["reason"], "already-watched");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "top");

    // The real release, then the transfer.
    assert_eq!(watch("top", "worker", false).status, 200);
    assert_eq!(watch("other", "worker", true).status, 200);
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "other");
    cleanup(project);
}

#[test]
fn a_release_whose_binding_changed_hands_before_the_lock_is_refused() {
    // Refusing a release under the wrong name sent every real release down
    // the early path, whose ownership test had been read before the lock. A
    // transfer landing in that gap had its fresh binding deleted by a
    // release that no longer owned it, and the caller was still told 200.
    //
    // Deterministic rather than racy: the test holds the registry lock, lets
    // the release block on it, transfers the binding underneath, and then
    // lets go. Whether the release read its snapshot before or after that
    // write, it must refuse -- before, the check under the lock catches it;
    // after, the one above does.
    use aimux::project_service::agent_roles::agent_role_registry_path;
    use aimux::state_update_lock::acquire_state_update_lock;
    use std::sync::Arc;
    use std::sync::Barrier;

    let project = temp_project("release-owner-changed");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "other".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let bound = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "top",
            "watchedSessionId": "worker",
            "active": true
        })),
    );
    assert_eq!(bound.status, 200, "{:?}", bound.body);

    let registry_path = agent_role_registry_path(&state_dir);
    let held = acquire_state_update_lock(&registry_path).expect("registry lock");

    let barrier = Arc::new(Barrier::new(2));
    let releasing = {
        let barrier = Arc::clone(&barrier);
        let project = project.clone();
        let state_dir = state_dir.clone();
        std::thread::spawn(move || {
            let context =
                ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
            barrier.wait();
            route_project_service_request(
                &context,
                "POST",
                routes::agents::WATCH,
                Some(&json!({
                    "overseerSessionId": "top",
                    "watchedSessionId": "worker",
                    "active": false
                })),
            )
        })
    };
    barrier.wait();
    // Give the release time to read its snapshot and reach the lock. The
    // lock leaves no trace a waiter can be polled for, so this is a wait and
    // not a proof of ordering: when it is long enough the guard under the
    // lock answers, and when the runner is slow enough that this thread wins
    // instead, the guard above the lock answers the same way. Either is the
    // contract. What the assertions below pin is that contract -- a refusal
    // naming the real holder -- rather than which guard produced it.
    //
    // Kept well inside the 2s acquire budget so a slow runner cannot turn
    // this into a lock timeout, which the 409 assertion would catch anyway.
    std::thread::sleep(std::time::Duration::from_millis(150));

    // The release is now waiting on the lock this thread holds. Hand the
    // binding to `other` underneath it.
    let mut registry: Value =
        serde_json::from_str(&read_to_string(&registry_path).expect("read registry"))
            .expect("parse registry");
    registry["watchBindings"]["worker"] = json!("other");
    write(
        &registry_path,
        serde_json::to_string_pretty(&registry).expect("serialize registry"),
    )
    .expect("write registry");
    drop(held);

    let response = releasing.join().expect("release thread");
    assert_eq!(response.status, 409, "{:?}", response.body);
    assert_eq!(response.body["reason"], "already-watched");
    // The refusal must name who actually holds it. Naming the caller told a
    // client that `top` owns a binding `other` holds -- and since the
    // documented escape is to re-release under the named manager, it would
    // retry `top` forever.
    assert_eq!(
        response.body["details"]["overseerSessionId"], "other",
        "the refusal named the caller instead of the holder: {:?}",
        response.body
    );

    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["watchBindings"]["worker"], "other",
        "the release deleted a binding it no longer owned: {registry:?}"
    );
    cleanup(project);
}

/// Releasing a binding does not need a readable topology.
///
/// Who is in the graveyard matters only when creating a binding. Reading it on
/// the release path too made a corrupt topology block the one operation that
/// could repair the state it was refusing to describe.
#[test]
fn a_watch_can_be_released_while_the_topology_is_unreadable() {
    let project = temp_project("release-unreadable-topology");
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
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    assert_eq!(
        route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": "boss",
                "watchedSessionId": "worker",
                "active": true
            })),
        )
        .status,
        200
    );

    // The topology goes bad after the binding exists.
    write(runtime_topology_path(&state_dir), "{ not yaml: [").unwrap();

    let released = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "boss",
            "watchedSessionId": "worker",
            "active": false
        })),
    );

    assert_eq!(released.status, 200, "{:?}", released.body);
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(
        registry["watchBindings"].get("worker").is_none(),
        "the binding survived a release: {registry:?}"
    );
    cleanup(project);
}

/// A manager in the graveyard cannot be given new reports.
///
/// Killing a manager moves its reports up to its own manager. Without this the
/// very next bind hands it fresh ones, and the rule holds for exactly as long
/// as nobody tries -- the topology screen draws reports under an agent that is
/// gone, and the loop briefs them to nobody.
#[test]
fn a_watch_cannot_bind_a_report_to_a_graveyarded_manager() {
    let project = temp_project("bind-departed-overseer");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "departed".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    // The graveyard status lives in the runtime topology, which is where the
    // route has to look: metadata keeps a killed agent's record unchanged.
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&json!({
            "version": 1,
            "generatedAt": "2026-09-05T00:00:00.000Z",
            "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo",
                       "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }],
            "nodes": [
                { "id": "node-departed", "rigId": "rig-1", "logicalId": "departed",
                  "toolConfigKey": "claude", "createdAt": "2026-09-05T00:00:00.000Z" },
                { "id": "node-worker", "rigId": "rig-1", "logicalId": "worker",
                  "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" }
            ],
            "edges": [],
            "bindings": [],
            "sessions": [
                { "id": "departed", "nodeId": "node-departed", "status": "graveyard", "command": "claude",
                  "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
                { "id": "worker", "nodeId": "node-worker", "status": "running", "command": "codex",
                  "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
            ],
            "services": [],
            "worktrees": [],
            "worktreeGraveyard": [],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": []
        }))
        .unwrap(),
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "departed",
            "watchedSessionId": "worker",
            "active": true
        })),
    );

    assert_eq!(response.status, 409, "{:?}", response.body);
    assert_eq!(response.body["reason"], "overseer-departed");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(
        registry["watchBindings"].get("worker").is_none(),
        "the refused bind still wrote: {registry:?}"
    );
    cleanup(project);
}

#[test]
fn a_bind_racing_another_bind_cannot_take_an_agent_that_just_changed_hands() {
    // `AlreadyWatched` was checked against a snapshot read before the lock,
    // so two binds of the same agent to different managers both saw no owner
    // and the second insert silently replaced the first. The release path
    // got this recheck already; the bind path is where a report actually
    // changes hands.
    use aimux::project_service::agent_roles::agent_role_registry_path;
    use aimux::state_update_lock::acquire_state_update_lock;
    use std::sync::Arc;
    use std::sync::Barrier;

    let project = temp_project("bind-owner-taken");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "other".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "worker".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    // Seed the registry so the file exists, then take it back to unbound.
    assert_eq!(
        route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": "top",
                "watchedSessionId": "worker",
                "active": true
            })),
        )
        .status,
        200
    );
    assert_eq!(
        route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": "top",
                "watchedSessionId": "worker",
                "active": false
            })),
        )
        .status,
        200
    );

    let registry_path = agent_role_registry_path(&state_dir);
    let held = acquire_state_update_lock(&registry_path).expect("registry lock");

    let barrier = Arc::new(Barrier::new(2));
    let binding = {
        let barrier = Arc::clone(&barrier);
        let project = project.clone();
        let state_dir = state_dir.clone();
        std::thread::spawn(move || {
            let context =
                ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
            barrier.wait();
            route_project_service_request(
                &context,
                "POST",
                routes::agents::WATCH,
                Some(&json!({
                    "overseerSessionId": "top",
                    "watchedSessionId": "worker",
                    "active": true
                })),
            )
        })
    };
    barrier.wait();
    std::thread::sleep(std::time::Duration::from_millis(150));

    // `other` takes the worker while `top`'s bind waits on the lock.
    let mut registry: Value =
        serde_json::from_str(&read_to_string(&registry_path).expect("read registry"))
            .expect("parse registry");
    registry["watchBindings"]["worker"] = json!("other");
    write(
        &registry_path,
        serde_json::to_string_pretty(&registry).expect("serialize registry"),
    )
    .expect("write registry");
    drop(held);

    let response = binding.join().expect("bind thread");
    assert_eq!(response.status, 409, "{:?}", response.body);
    assert_eq!(response.body["reason"], "already-watched");
    assert_eq!(
        response.body["details"]["overseerSessionId"], "other",
        "the refusal named the wrong holder: {:?}",
        response.body
    );
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(
        registry["watchBindings"]["worker"], "other",
        "the bind replaced a manager that already held the agent: {registry:?}"
    );
    cleanup(project);
}

#[test]
fn a_manager_cannot_become_the_scribe_while_it_still_has_reports() {
    // Promotion to scribe cleared only the incoming edge. The outgoing ones
    // survived, and `sync_watching_lists` stamped the session back to
    // `role: overseer` on the strength of them -- metadata saying scribe
    // while the registry still handed it reports.
    let project = temp_project("scribe-with-reports");
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
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    assert_eq!(
        route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": "boss",
                "watchedSessionId": "worker",
                "active": true
            })),
        )
        .status,
        200
    );

    let promoted = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "boss", "active": true })),
    );

    assert_eq!(promoted.status, 409, "{:?}", promoted.body);
    assert_eq!(promoted.body["reason"], "active-watch-bindings");
    assert_eq!(promoted.body["details"]["watchedSessionIds"][0], "worker");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["worker"], "boss");
    let metadata = load_metadata_state(&state_dir);
    assert_ne!(
        metadata.sessions.get("boss").and_then(|s| s.get("scribe")),
        Some(&json!(true)),
        "the refused promotion still wrote metadata"
    );
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
fn an_overseer_can_report_to_another_overseer() {
    // The whole point of the tree: overseer is the manager class at every
    // level above the leaf, so a mid-tier overseer is both somebody's manager
    // and somebody's report. The old rule refused any watched agent that was
    // not a coder, which made two levels the maximum the model could express.
    let project = temp_project("watch-depth-three");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "leaf".into(),
                    json!({ "role": "coder", "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for (overseer, watched) in [("top", "middle"), ("middle", "leaf")] {
        let response = route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": overseer,
                "watchedSessionId": watched,
                "active": true
            })),
        );
        assert_eq!(
            response.status, 200,
            "{overseer} -> {watched}: {:?}",
            response.body
        );
    }

    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert_eq!(registry["watchBindings"]["middle"], "top");
    assert_eq!(registry["watchBindings"]["leaf"], "middle");
    cleanup(project);
}

#[test]
fn a_watch_that_would_close_the_chain_is_refused() {
    // Single-parent forbids a DAG, not a cycle: `top -> middle` and
    // `middle -> top` are each legal on their own and together make a chain
    // with no top. Nothing walked the chain before, so it was storable; the
    // first caller that walks it would hang.
    let project = temp_project("watch-cycle");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "top".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "middle".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let bound = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "top",
            "watchedSessionId": "middle",
            "active": true
        })),
    );
    assert_eq!(bound.status, 200, "{:?}", bound.body);

    let closed = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "middle",
            "watchedSessionId": "top",
            "active": true
        })),
    );

    assert_eq!(closed.status, 409);
    assert_eq!(closed.body["ok"], false);
    assert_eq!(closed.body["reason"], "watch-cycle");
    // Refused before the write, not after it.
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry.pointer("/watchBindings/top").is_none());
    assert_eq!(registry["watchBindings"]["middle"], "top");
    cleanup(project);
}

#[test]
fn a_longer_chain_cannot_be_closed_into_a_loop_either() {
    // The one-hop case exercises the first comparison and never enters the
    // walk's loop body. Three hops is what proves the walk itself.
    let project = temp_project("watch-cycle-three-hop");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "a".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "b".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "c".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for (overseer, watched) in [("a", "b"), ("b", "c")] {
        let response = route_project_service_request(
            &context,
            "POST",
            routes::agents::WATCH,
            Some(&json!({
                "overseerSessionId": overseer,
                "watchedSessionId": watched,
                "active": true
            })),
        );
        assert_eq!(
            response.status, 200,
            "{overseer} -> {watched}: {:?}",
            response.body
        );
    }

    // c reports to b reports to a. Handing a to c closes the loop.
    let closed = route_project_service_request(
        &context,
        "POST",
        routes::agents::WATCH,
        Some(&json!({
            "overseerSessionId": "c",
            "watchedSessionId": "a",
            "active": true
        })),
    );

    assert_eq!(closed.status, 409, "{:?}", closed.body);
    assert_eq!(closed.body["reason"], "watch-cycle");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry.pointer("/watchBindings/a").is_none());
    cleanup(project);
}

#[test]
fn an_overseer_cannot_be_made_its_own_manager() {
    let project = temp_project("watch-self");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "solo".into(),
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
            "overseerSessionId": "solo",
            "watchedSessionId": "solo",
            "active": true
        })),
    );

    assert_eq!(response.status, 409, "{:?}", response.body);
    assert_eq!(response.body["reason"], "watch-cycle");
    let registry = load_agent_role_registry(&state_dir).expect("role registry");
    assert!(registry.pointer("/watchBindings/solo").is_none());
    cleanup(project);
}

#[test]
fn two_binds_racing_in_opposite_directions_cannot_close_a_loop() {
    // The serial guard reads a snapshot taken before the registry lock, so
    // `a -> b` and `b -> a` arriving together each see a map without the
    // other's edge and both pass it. The second guard runs inside the
    // mutator, where the lock has already serialised them.
    //
    // The barrier is what makes this provable rather than hopeful: removing
    // the inner guard fails this on the first attempt with both calls
    // answering 200 and a loop on disk. The attempts loop covers scheduling
    // variance rather than supplying the overlap.
    use std::sync::Arc;
    use std::sync::Barrier;

    for attempt in 0..32 {
        let project = temp_project(&format!("watch-race-{attempt}"));
        let state_dir = project.join("state");
        save_metadata_state(
            &state_dir,
            &MetadataState {
                version: 1,
                sessions: BTreeMap::from([
                    (
                        "a".into(),
                        json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                    ),
                    (
                        "b".into(),
                        json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                    ),
                ]),
            },
        )
        .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for (overseer, watched) in [("a", "b"), ("b", "a")] {
            let barrier = Arc::clone(&barrier);
            let project = project.clone();
            let state_dir = state_dir.clone();
            handles.push(std::thread::spawn(move || {
                let context =
                    ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
                barrier.wait();
                let response = route_project_service_request(
                    &context,
                    "POST",
                    routes::agents::WATCH,
                    Some(&json!({
                        "overseerSessionId": overseer,
                        "watchedSessionId": watched,
                        "active": true
                    })),
                );
                (response.status, response.body)
            }));
        }
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().expect("bind thread"))
            .collect::<Vec<_>>();

        // Assert the shape of the refusal, not only the absence of a cycle.
        // Collecting the statuses and never asserting on them let this pass
        // when either call fell over on a lock-acquire timeout -- no write,
        // no cycle, green -- and left the sentinel-to-`watch-cycle` mapping
        // proved by nothing: a raw sentinel leaking as a 500 looked the same.
        let mut bound = 0;
        for (status, body) in &outcomes {
            match status {
                200 => bound += 1,
                409 => assert_eq!(
                    body["reason"], "watch-cycle",
                    "attempt {attempt} refused for the wrong reason: {body:?}"
                ),
                other => panic!("attempt {attempt} answered {other}: {body:?}"),
            }
        }
        assert_eq!(
            bound, 1,
            "attempt {attempt} did not settle on exactly one binding: {outcomes:?}"
        );

        let registry = load_agent_role_registry(&state_dir).expect("role registry");
        let a_reports_to_b =
            registry.pointer("/watchBindings/a").and_then(Value::as_str) == Some("b");
        let b_reports_to_a =
            registry.pointer("/watchBindings/b").and_then(Value::as_str) == Some("a");
        assert!(
            !(a_reports_to_b && b_reports_to_a),
            "attempt {attempt} stored a cycle; outcomes were {outcomes:?}"
        );
        cleanup(project);
    }
}

#[test]
fn watch_route_refuses_the_scribe_as_a_report() {
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
    assert_eq!(response.body["reason"], "scribe-cannot-be-watched");
    assert_eq!(response.body["details"]["sessionId"], "scribe");
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

    // "add" is in the list because `active: false` with ANY action word takes
    // the branch that removes the loop object: the guard has to read the
    // effect, not the label. Omitting it was how a review deleted a
    // user-managed goal with a 200.
    for action in ["remove", "done", "block", "add"] {
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
        // A deactivation labelled `add` is refused as the removal it is, so
        // the wording names `remove` rather than echoing the label back.
        let named = if action == "add" { "remove" } else { action };
        assert!(
            error.contains("user-managed") && error.contains(named),
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

/// The dashboard's `k` sends only the new kind, so a rewrite that carries no
/// goal must keep the sentence the goal was written as. Without this, handing a
/// week-long migration to the agent erased what the migration was.
#[test]
fn changing_only_the_kind_keeps_the_goal_it_was_written_as() {
    let project = temp_project("user-goal-text-keep");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goal": "move every call site off the old client",
            "goalKind": "user",
            "source": "dashboard"
        })),
    );
    let handed_over = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "goalKind": "agent",
            "source": "dashboard"
        })),
    );
    assert_eq!(handed_over.status, 200, "Sam may hand a running goal over");
    assert_eq!(handed_over.body["loop"]["goalKind"], "agent");
    assert_eq!(
        handed_over.body["loop"]["goal"], "move every call site off the old client",
        "the goal text must survive a kind-only rewrite"
    );
    // And it is the STORED goal that survived, not just the response echoing
    // the request back.
    let stored = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "source": "dashboard"
        })),
    );
    assert_eq!(
        stored.body["loop"]["goal"], "move every call site off the old client",
        "a later rewrite still reads the stored goal"
    );
}

/// `since` is the alert-pause key and part of the spend episode, so rewriting
/// it on every `active: true` meant the dashboard's `k` cancelled a pause Sam
/// had set and re-baselined the token spend. Found by review.
#[test]
fn a_rewrite_of_a_running_loop_keeps_when_it_started() {
    let project = temp_project("user-goal-since");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let post = |body: Value| {
        route_project_service_request(&context, "POST", routes::agents::LOOP, Some(&body))
    };
    let first = post(json!({
        "sessionId": "worker-1",
        "active": true,
        "goal": "the long migration",
        "goalKind": "user",
        "source": "dashboard"
    }));
    let started = first.body["loop"]["since"]
        .as_str()
        .expect("a start time")
        .to_owned();

    let handed_over = post(json!({
        "sessionId": "worker-1",
        "active": true,
        "goalKind": "agent",
        "source": "dashboard"
    }));
    assert_eq!(
        handed_over.body["loop"]["since"], started,
        "a hand-over is not a new loop, and `since` is what a pause is keyed on"
    );

    // A loop that was NOT running starts now. `since` is millisecond
    // resolution, so the clock is given a tick to move rather than asserting
    // two back-to-back writes differ.
    post(json!({ "sessionId": "worker-1", "active": false, "source": "dashboard" }));
    let wait_until = std::time::Instant::now() + std::time::Duration::from_millis(5);
    while std::time::Instant::now() < wait_until {
        std::hint::spin_loop();
    }
    let restarted = post(json!({
        "sessionId": "worker-1",
        "active": true,
        "goal": "again",
        "source": "dashboard"
    }));
    assert_ne!(
        restarted.body["loop"]["since"], started,
        "but a loop started again is genuinely new"
    );
}

/// An omitted goal and a cleared one are different requests. Preserving the
/// stored text on BOTH meant clearing the goal in the app reported success and
/// silently brought the old sentence back.
#[test]
fn an_explicitly_empty_goal_clears_it_while_an_omitted_one_is_kept() {
    let project = temp_project("user-goal-clear");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let add = |body: Value| {
        route_project_service_request(&context, "POST", routes::agents::LOOP, Some(&body))
    };
    add(json!({
        "sessionId": "worker-1",
        "active": true,
        "goal": "move every call site off the old client",
        "source": "dashboard"
    }));

    let kept = add(json!({
        "sessionId": "worker-1",
        "active": true,
        "goalKind": "user",
        "source": "dashboard"
    }));
    assert_eq!(
        kept.body["loop"]["goal"], "move every call site off the old client",
        "a request that never mentions a goal keeps the stored one"
    );

    let cleared = add(json!({
        "sessionId": "worker-1",
        "active": true,
        "goal": "",
        "source": "dashboard"
    }));
    assert_eq!(cleared.status, 200);
    assert!(
        cleared.body["loop"].get("goal").is_none(),
        "an empty goal that was SENT clears it, got {}",
        cleared.body["loop"]
    );
    // And it stayed cleared, rather than the response merely omitting it.
    let reread = add(json!({
        "sessionId": "worker-1",
        "active": true,
        "source": "dashboard"
    }));
    assert!(
        reread.body["loop"].get("goal").is_none(),
        "nothing resurrects it on the next rewrite, got {}",
        reread.body["loop"]
    );
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
