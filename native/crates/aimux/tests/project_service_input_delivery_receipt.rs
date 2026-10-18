mod support;

use aimux::agent_prompt_delivery::PromptDeliveryVerification::{Unverified, Verified};
use aimux::core_text::{
    render_core_agent_input_lines, render_core_agent_list_lines, render_core_agent_ps_lines,
};
use aimux::daemon_state::{
    MetadataState, metadata_state_path, save_metadata_state, try_load_metadata_state,
};
use aimux::loop_watcher::{build_overseer_briefing, find_loop_candidates_with_overseer};
use aimux::project_service::agents::{
    build_agent_list, topology_desktop_session_list_with_live_window_ids,
};
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::input_delivery_receipt::{
    UNVERIFIED_SUBMISSION_LABEL, UNVERIFIED_SUBMISSION_NOTICE, begin_input_delivery,
    finish_input_delivery, projected_input_delivery,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use aimux::project_service::statusline::{
    build_statusline_snapshot, render_tmux_statusline_contract,
};
use aimux::project_service::tmux_metadata_sync::build_tmux_window_metadata;
use aimux::runtime_topology::coerce_runtime_topology;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;

#[test]
fn receipt_saves_wake_runtime_view_subscribers_for_submitting_and_failed_send() {
    let isolation = support::TestIsolation::new("input-receipt-events");
    let context = ProjectServiceRequestContext::with_project_state_dir(
        isolation.root(),
        isolation.root().join("state"),
    );
    let bus = context.project_events.clone();
    let subscriber = std::thread::spawn(move || {
        bus.wait_for_events_since(0, Some("worker"), Duration::from_secs(1))
    });
    let attempt = begin_input_delivery(&context, "worker", "@1").unwrap();
    assert!(
        subscriber.join().unwrap(),
        "submitting receipt must wake an open client"
    );
    let cursor = context.project_events.latest_sequence();
    let failed = finish_input_delivery(&context, &attempt, Err("capture after Enter failed"));
    assert_eq!(failed["state"], "failed");
    assert!(context.project_events.wait_for_events_since(
        cursor,
        Some("worker"),
        Duration::from_millis(1)
    ));
    for record in context.project_events.events_since(0, Some("worker")) {
        assert_eq!(
            record.event["type"],
            aimux::project_api_contract::event_names::PROJECT_UPDATE
        );
        assert_eq!(record.event["sessionId"], "worker");
        assert_eq!(
            record.event["views"],
            json!(aimux::project_api_contract::invalidations::RUNTIME_SESSION)
        );
    }
    assert!(
        aimux::project_service::watcher_delivery::WatcherDeliveryResult::Unverified
            .consumes_cooldown()
    );
}

#[test]
fn receipt_reservation_and_completion_preserve_three_outcomes_and_newer_attempts() {
    let isolation = support::TestIsolation::new("input-receipt-order");
    let context = ProjectServiceRequestContext::with_project_state_dir(
        isolation.root(),
        isolation.root().join("state"),
    );
    let older = begin_input_delivery(&context, "worker", "@1")
        .expect("missing metadata is legitimate absence");
    let submitting = try_load_metadata_state(context.project_state_dir())
        .unwrap()
        .sessions["worker"]["inputDelivery"]
        .clone();
    assert_eq!(submitting["state"], "submitting");
    assert_eq!(submitting["verified"], false);
    assert_eq!(submitting["notice"], UNVERIFIED_SUBMISSION_NOTICE);
    let newer = begin_input_delivery(&context, "worker", "@1").unwrap();
    let latest = finish_input_delivery(&context, &newer, Ok(Unverified));
    assert_eq!(latest["verified"], false);
    assert_eq!(latest["state"], "delivered");
    assert_eq!(latest["displayLabel"], UNVERIFIED_SUBMISSION_LABEL);
    let late = finish_input_delivery(&context, &older, Ok(Verified));
    assert_eq!(late["superseded"], true);
    assert_eq!(
        try_load_metadata_state(context.project_state_dir())
            .unwrap()
            .sessions["worker"]["inputDelivery"],
        latest
    );
    let verified_attempt = begin_input_delivery(&context, "worker", "@1").unwrap();
    let verified = finish_input_delivery(&context, &verified_attempt, Ok(Verified));
    assert_eq!(verified["verified"], true);
    assert!(verified.get("notice").is_none());
    assert!(verified.get("displayLabel").is_none());
    assert_eq!(
        try_load_metadata_state(context.project_state_dir())
            .unwrap()
            .sessions["worker"]["inputDelivery"],
        verified
    );
    let failed_attempt = begin_input_delivery(&context, "worker", "@1").unwrap();
    let failed = finish_input_delivery(&context, &failed_attempt, Err("original tmux child cause"));
    assert_eq!(failed["state"], "failed");
    assert_eq!(failed["error"], "original tmux child cause");
    assert_eq!(failed["verified"], false);
    assert_eq!(
        try_load_metadata_state(context.project_state_dir())
            .unwrap()
            .sessions["worker"]["inputDelivery"],
        failed
    );
}

#[test]
fn missing_reserved_receipt_is_reported_as_storage_failure_not_a_newer_attempt() {
    let isolation = support::TestIsolation::new("missing-input-receipt");
    let context = ProjectServiceRequestContext::with_project_state_dir(
        isolation.root(),
        isolation.root().join("state"),
    );
    let attempt = begin_input_delivery(&context, "worker", "@1").unwrap();
    fs::remove_file(metadata_state_path(context.project_state_dir())).unwrap();
    let receipt = finish_input_delivery(&context, &attempt, Ok(Verified));
    assert_eq!(receipt["state"], "delivered");
    assert_eq!(receipt["verified"], true);
    assert!(
        receipt["receiptError"].as_str().is_some(),
        "missing reservation is not positive evidence of a newer attempt: {receipt}"
    );
    assert_ne!(receipt["superseded"], true);
    assert!(!metadata_state_path(context.project_state_dir()).exists());
}

#[test]
fn receipt_storage_failure_before_send_errors_but_after_send_stays_visible_without_retry() {
    let isolation = support::TestIsolation::new("input-receipt-storage");
    let directory = isolation.root().join("state");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(isolation.root(), &directory);
    fs::create_dir_all(&directory).unwrap();
    let path = metadata_state_path(&directory);
    fs::write(&path, "broken metadata before send").unwrap();
    let error = begin_input_delivery(&context, "worker", "@1").unwrap_err();
    assert!(error.contains("parse metadata state"), "{error}");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "broken metadata before send"
    );
    save_metadata_state(
        &directory,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .unwrap();
    let attempt =
        begin_input_delivery(&context, "worker", "@1").expect("legacy empty sessions are valid");
    fs::write(&path, "broken metadata after send").unwrap();
    let receipt = finish_input_delivery(&context, &attempt, Ok(Unverified));
    assert_eq!(receipt["state"], "delivered");
    assert_eq!(receipt["verified"], false);
    assert!(
        receipt["receiptError"]
            .as_str()
            .unwrap()
            .contains("parse metadata state")
    );
    assert!(
        receipt["notice"]
            .as_str()
            .unwrap()
            .contains("could not be saved")
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "broken metadata after send"
    );
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let io_error = begin_input_delivery(&context, "worker", "@1").unwrap_err();
    assert!(io_error.contains("read metadata state"), "{io_error}");
}

#[test]
fn receipts_follow_actual_window_identity_and_clear_on_foreign_window_or_absence() {
    let metadata = json!({"inputDelivery":{"windowId":"@1","state":"delivered","verified":false,"notice":UNVERIFIED_SUBMISSION_NOTICE}});
    assert!(
        projected_input_delivery(&json!({"tmuxTarget":{"windowId":"@1"}}), Some(&metadata))
            .is_some()
    );
    assert!(
        projected_input_delivery(&json!({"tmuxWindowId":"@1"}), Some(&metadata)).is_some(),
        "the legacy desktop identity is valid"
    );
    assert!(
        projected_input_delivery(
            &json!({"tmuxTarget":{"windowId":"@2"}, "tmuxWindowId":"@1"}),
            Some(&metadata)
        )
        .is_none(),
        "a stale alias cannot override the actual target"
    );
    for session in [
        json!({"tmuxTarget":{"windowId":"@2"}}),
        json!({"tmuxWindowId":"@2"}),
        json!({"status":"offline"}),
    ] {
        assert!(
            projected_input_delivery(&session, Some(&metadata)).is_none(),
            "{session}"
        );
    }
    assert!(projected_input_delivery(&json!({"tmuxTarget":{"windowId":"@1"}}), None).is_none());
}

#[test]
fn urgent_attention_remains_visible_after_unverified_submission_across_surfaces() {
    let isolation = support::TestIsolation::new("input-receipt-urgent-attention");
    let timestamp = "2026-10-18T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version":1,"generatedAt":timestamp,
        "rigs":[{"id":"rig","name":"aimux-test","projectRoot":isolation.root(),"createdAt":timestamp,"updatedAt":timestamp}],
        "nodes":[{"id":"node","rigId":"rig","logicalId":"worker","toolConfigKey":"codex","label":"polymarket-worker","createdAt":timestamp}],
        "bindings":[{"id":"binding","nodeId":"node","tmuxSession":"aimux-test","tmuxWindowId":"@1","tmuxWindowIndex":1,"updatedAt":timestamp}],
        "sessions":[{"id":"worker","nodeId":"node","status":"running","command":"codex","createdAt":timestamp,"updatedAt":timestamp}]
    })).unwrap();
    let live = support::live_windows("aimux-test", &["@1"]);
    let directory = isolation.root().join("state");
    let exchange = json!({"tasks":[],"threads":[],"messages":[]});
    for (attention, expected_hint, expected_badge) in [
        ("error", "error", "✗"),
        ("blocked", "blocked", "!"),
        ("needs_input", "on you", "?"),
        ("needs_response", "answer", "?"),
    ] {
        let metadata = BTreeMap::from([(
            "worker".to_owned(),
            json!({
                "inputDelivery": {
                    "windowId":"@1","state":"delivered","verified":false,
                    "notice":UNVERIFIED_SUBMISSION_NOTICE,"displayLabel":UNVERIFIED_SUBMISSION_LABEL,
                },
                "derived":{"activity":"idle","attention":attention},
            }),
        )]);
        save_metadata_state(
            &directory,
            &MetadataState {
                version: 1,
                sessions: metadata.clone(),
            },
        )
        .unwrap();
        let desktop = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: isolation.root().to_string_lossy().into_owned(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&live),
        );
        let row = &desktop["sessions"][0];
        assert_eq!(row["semantic"]["user"]["attention"], attention);
        assert_eq!(
            row["semantic"]["presentation"]["compactHint"],
            expected_hint
        );
        assert_eq!(
            row["semantic"]["presentation"]["rowChips"][0]["label"],
            UNVERIFIED_SUBMISSION_LABEL
        );
        assert_eq!(row["inputDelivery"]["notice"], UNVERIFIED_SUBMISSION_NOTICE);
        let context =
            ProjectServiceRequestContext::with_project_state_dir(isolation.root(), &directory)
                .with_desktop_state(desktop);
        let snapshot = build_statusline_snapshot(&context).unwrap();
        let footer = render_tmux_statusline_contract(&json!({
            "data":snapshot,"projectRoot":isolation.root(),"line":"bottom",
            "options":{"currentWindowId":"@1","currentPath":isolation.root()},
        }));
        let text = footer["text"].as_str().unwrap();
        assert!(text.contains(expected_hint), "{attention}: {text}");
        assert!(text.contains(expected_badge), "{attention}: {text}");
        assert!(
            !text.contains(UNVERIFIED_SUBMISSION_LABEL),
            "{attention}: {text}"
        );
    }
}

#[test]
fn actionable_pressure_keeps_its_hint_after_unverified_submission_across_surfaces() {
    let isolation = support::TestIsolation::new("input-receipt-actionable-pressure");
    let timestamp = "2026-10-18T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version":1,"generatedAt":timestamp,
        "rigs":[{"id":"rig","name":"aimux-test","projectRoot":isolation.root(),"createdAt":timestamp,"updatedAt":timestamp}],
        "nodes":[{"id":"node","rigId":"rig","logicalId":"worker","toolConfigKey":"codex","label":"polymarket-worker","createdAt":timestamp}],
        "bindings":[{"id":"binding","nodeId":"node","tmuxSession":"aimux-test","tmuxWindowId":"@1","tmuxWindowIndex":1,"updatedAt":timestamp}],
        "sessions":[{"id":"worker","nodeId":"node","status":"running","command":"codex","createdAt":timestamp,"updatedAt":timestamp}]
    })).unwrap();
    let live = support::live_windows("aimux-test", &["@1"]);
    let directory = isolation.root().join("state");
    let metadata = BTreeMap::from([(
        "worker".to_owned(),
        json!({
            "inputDelivery": {
                "windowId":"@1","state":"delivered","verified":false,
                "notice":UNVERIFIED_SUBMISSION_NOTICE,"displayLabel":UNVERIFIED_SUBMISSION_LABEL,
            },
            "derived":{"activity":"idle","attention":"normal"},
        }),
    )]);
    save_metadata_state(
        &directory,
        &MetadataState {
            version: 1,
            sessions: metadata.clone(),
        },
    )
    .unwrap();
    for (name, exchange, expected_pressure, expected_hint, footer_hint, count_field) in [
        (
            "ordinary idle lane",
            json!({"tasks":[],"threads":[],"messages":[]}),
            "none",
            UNVERIFIED_SUBMISSION_LABEL,
            UNVERIFIED_SUBMISSION_LABEL,
            None,
        ),
        (
            "blocked workflow",
            json!({"tasks":[{"id":"task","status":"blocked"}],"threads":[{"id":"thread","taskId":"task","participants":["worker"]}],"messages":[]}),
            "blocked",
            "blocked task",
            "blocked",
            Some("workflowBlockedCount"),
        ),
        (
            "workflow waiting on this lane",
            json!({"tasks":[{"id":"task","status":"pending"}],"threads":[{"id":"thread","taskId":"task","participants":["worker"],"waitingOn":["worker"]}],"messages":[]}),
            "waiting_on_user",
            "on you",
            "on you",
            Some("workflowOnMeCount"),
        ),
        (
            "thread waiting on this lane",
            json!({"tasks":[],"threads":[{"id":"thread","participants":["worker"],"waitingOn":["worker"]}],"messages":[]}),
            "waiting_on_user",
            "on you",
            "on you",
            Some("threadWaitingOnMeCount"),
        ),
        (
            "thread waiting on someone else",
            json!({"tasks":[],"threads":[{"id":"thread","participants":["worker"],"owner":"worker","waitingOn":["peer"]}],"messages":[]}),
            "waiting_on_them",
            UNVERIFIED_SUBMISSION_LABEL,
            UNVERIFIED_SUBMISSION_LABEL,
            Some("threadWaitingOnThemCount"),
        ),
    ] {
        let desktop = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: isolation.root().to_string_lossy().into_owned(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&live),
        );
        let row = &desktop["sessions"][0];
        assert_eq!(row["semantic"]["user"]["label"], "ready", "{name}");
        assert_eq!(row["semantic"]["user"]["attention"], "none", "{name}");
        assert_eq!(
            row["semantic"]["orchestration"]["pressure"], expected_pressure,
            "{name}"
        );
        assert_eq!(
            row["semantic"]["presentation"]["compactHint"], expected_hint,
            "{name}"
        );
        assert_eq!(
            row["semantic"]["presentation"]["rowChips"][0]["label"], UNVERIFIED_SUBMISSION_LABEL,
            "{name}"
        );
        assert_eq!(
            row["inputDelivery"]["notice"], UNVERIFIED_SUBMISSION_NOTICE,
            "{name}"
        );
        if let Some(field) = count_field {
            assert_eq!(
                row[field], 1,
                "{name}: {field} must drive the real projection"
            );
        }
        let context =
            ProjectServiceRequestContext::with_project_state_dir(isolation.root(), &directory)
                .with_desktop_state(desktop);
        let snapshot = build_statusline_snapshot(&context).unwrap();
        let footer = render_tmux_statusline_contract(&json!({
            "data":snapshot,"projectRoot":isolation.root(),"line":"bottom",
            "options":{"currentWindowId":"@1","currentPath":isolation.root()},
        }));
        let text = footer["text"].as_str().unwrap();
        assert!(text.contains(footer_hint), "{name}: {text}");
        if expected_hint != UNVERIFIED_SUBMISSION_LABEL {
            assert!(
                !text.contains(UNVERIFIED_SUBMISSION_LABEL),
                "{name}: {text}"
            );
        }
    }
}

#[test]
fn receipt_compact_hint_preserves_working_done_and_lifecycle_badges() {
    let isolation = support::TestIsolation::new("input-receipt-status-badges");
    let delivery = json!({
        "windowId":"@1","state":"delivered","verified":false,
        "notice":UNVERIFIED_SUBMISSION_NOTICE,"displayLabel":UNVERIFIED_SUBMISSION_LABEL,
    });
    for (activity, pending_action, expected_badge) in [
        ("running", None, "↻"),
        ("done", None, "✓"),
        ("idle", Some("starting"), "…"),
        ("idle", Some("stopping"), "…"),
        ("idle", Some("graveyarding"), "…"),
    ] {
        let semantic = derive_session_semantics(SessionSemanticsInput {
            status: "running".into(),
            activity: Some(activity.into()),
            attention: Some("normal".into()),
            pending_action: pending_action.map(str::to_owned),
            input_delivery: Some(delivery.clone()),
            ..SessionSemanticsInput::default()
        });
        let desktop = json!({"sessions":[{
            "id":"worker","label":"polymarket-worker","command":"codex","status":"running",
            "tmuxWindowId":"@1","tmuxSession":"aimux-test","semantic":semantic,"inputDelivery":delivery,
        }]});
        let context = ProjectServiceRequestContext::with_project_state_dir(
            isolation.root(),
            isolation.root().join("state"),
        )
        .with_desktop_state(desktop);
        let snapshot = build_statusline_snapshot(&context).unwrap();
        let footer = render_tmux_statusline_contract(&json!({
            "data":snapshot,"projectRoot":isolation.root(),"line":"bottom",
            "options":{"currentWindowId":"@1","currentPath":isolation.root()},
        }));
        let text = footer["text"].as_str().unwrap();
        assert!(
            text.contains(UNVERIFIED_SUBMISSION_LABEL),
            "{activity}/{pending_action:?}: {text}"
        );
        assert!(
            text.contains(expected_badge),
            "{activity}/{pending_action:?}: {text}"
        );
    }
}

#[test]
fn seven_ready_lanes_publish_the_same_submit_receipt_to_ps_desktop_footer_and_overseer() {
    let isolation = support::TestIsolation::new("input-receipt-surfaces");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../testdata/contracts/v1/input-delivery-verification/surfaces.json"
    ))
    .unwrap();
    assert_eq!(
        fixture["prompt"],
        "> [Pasted Content 4577 chars][Pasted Content 3941 chars]"
    );
    let timestamp = "2026-10-18T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version":1,"generatedAt":timestamp,
        "rigs":[{"id":"rig","name":"aimux-test","projectRoot":isolation.root(),"createdAt":timestamp,"updatedAt":timestamp}],
        "nodes":(1..=7).map(|i|json!({"id":format!("node-{i}"),"rigId":"rig","logicalId":format!("worker-{i}"),"toolConfigKey":"codex","label":format!("polymarket-worker-{i}"),"createdAt":timestamp})).collect::<Vec<_>>(),
        "bindings":(1..=7).map(|i|json!({"id":format!("binding-{i}"),"nodeId":format!("node-{i}"),"tmuxSession":"aimux-test","tmuxWindowId":format!("@{i}"),"tmuxWindowIndex":i,"updatedAt":timestamp})).collect::<Vec<_>>(),
        "sessions":(1..=7).map(|i|json!({"id":format!("worker-{i}"),"nodeId":format!("node-{i}"),"status":"running","command":"codex","createdAt":timestamp,"updatedAt":timestamp})).collect::<Vec<_>>()
    })).unwrap();
    let live = support::live_windows("aimux-test", &["@1", "@2", "@3", "@4", "@5", "@6", "@7"]);
    for case in fixture["cases"].as_array().unwrap().iter().filter(|case| {
        matches!(
            case["expectedOutcome"].as_str(),
            Some("unverified" | "delivered" | "failed")
        )
    }) {
        let metadata = (1..=7).map(|i| {
            let mut delivery = case["delivery"].clone();
            delivery["windowId"] = json!(format!("@{i}"));
            (format!("worker-{i}"), json!({"inputDelivery":delivery,"derived":{"activity":"idle","attention":"normal"},"loop":{"active":true,"goal":"continue","since":timestamp}}))
        }).collect::<BTreeMap<_,_>>();
        let directory = isolation.root().join("state");
        save_metadata_state(
            &directory,
            &MetadataState {
                version: 1,
                sessions: metadata.clone(),
            },
        )
        .unwrap();
        let exchange = json!({"tasks":[],"threads":[],"messages":[]});
        let desktop = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: isolation.root().to_string_lossy().into_owned(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&live),
        );
        let tools = json!({"codex":{}}).as_object().unwrap().clone();
        let sessions =
            topology_desktop_session_list_with_live_window_ids(&topology, &metadata, &tools, &live);
        let agents = build_agent_list(&sessions, &metadata, &[], None);
        let ps = render_core_agent_ps_lines(&json!({"agents":agents})).join("\n");
        let list = render_core_agent_list_lines(&json!({"agents":agents})).join("\n");
        let candidates = find_loop_candidates_with_overseer(
            &json!({"sessions":sessions,"metadata":{"sessions":metadata},"pendingInteractions":[]}),
            None,
        );
        assert_eq!(candidates.len(), 7);
        let briefing = build_overseer_briefing(&candidates, None);
        let rows = desktop["sessions"].as_array().unwrap();
        assert_eq!(rows.len(), 7);
        let footer_context =
            ProjectServiceRequestContext::with_project_state_dir(isolation.root(), &directory)
                .with_desktop_state(desktop.clone());
        let footer_snapshot = build_statusline_snapshot(&footer_context).unwrap();
        for row in rows {
            let id = row["id"].as_str().unwrap();
            let agent = agents.iter().find(|agent| agent["id"] == id).unwrap();
            assert_eq!(agent["state"], fixture["state"]);
            assert_eq!(row["semantic"]["user"]["label"], fixture["state"]);
            let ps_line = ps
                .lines()
                .find(|line| line.starts_with(&format!("{id} ")))
                .expect("the real CLI row is present");
            assert_eq!(
                ps_line
                    .split_once("]  ")
                    .expect("CLI status follows tool")
                    .1
                    .split_whitespace()
                    .next(),
                fixture["state"].as_str()
            );
            assert!(!ps_line.contains("answered"));
            let list_line = list
                .lines()
                .find(|line| line.contains(&format!("aimux={id}")))
                .expect("agent list row");
            assert_eq!(
                list_line.split_whitespace().next(),
                fixture["state"].as_str()
            );
            assert_eq!(agent["inputDelivery"], row["inputDelivery"]);
            assert_eq!(row["inputDelivery"]["notice"], case["expectedNotice"]);
            assert_eq!(
                row["inputDelivery"]["displayLabel"],
                case["delivery"]["displayLabel"]
            );
            let footer_record = footer_snapshot["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|session| session["id"] == id)
                .unwrap();
            assert_eq!(footer_record["inputDelivery"], row["inputDelivery"]);
            let tmux = build_tmux_window_metadata(
                &directory,
                sessions.iter().find(|session| session["id"] == id).unwrap(),
                None,
            );
            assert_eq!(tmux["inputDelivery"], row["inputDelivery"]);
            if case["expectedOutcome"] == "unverified" {
                let footer = render_tmux_statusline_contract(
                    &json!({"data":footer_snapshot,"projectRoot":isolation.root(),"line":"bottom","options":{"currentWindowId":row["tmuxWindowId"],"currentPath":isolation.root()}}),
                );
                assert!(
                    footer["text"]
                        .as_str()
                        .unwrap()
                        .contains(UNVERIFIED_SUBMISSION_LABEL),
                    "{footer}"
                );
                let mut higher_priority = footer_snapshot.clone();
                for session in higher_priority["sessions"].as_array_mut().unwrap() {
                    session["semantic"]["presentation"]["compactHint"] = json!("urgent");
                }
                let published_hint = render_tmux_statusline_contract(
                    &json!({"data":higher_priority,"projectRoot":isolation.root(),"line":"bottom","options":{"currentWindowId":row["tmuxWindowId"],"currentPath":isolation.root()}}),
                );
                assert!(
                    published_hint["text"].as_str().unwrap().contains("urgent"),
                    "the renderer must honor the published priority: {published_hint}"
                );
                assert!(
                    !published_hint["text"]
                        .as_str()
                        .unwrap()
                        .contains(UNVERIFIED_SUBMISSION_LABEL)
                );
                assert_eq!(
                    row["semantic"]["presentation"]["compactHint"],
                    UNVERIFIED_SUBMISSION_LABEL
                );
                assert_eq!(
                    row["semantic"]["presentation"]["rowChips"][0]["label"],
                    UNVERIFIED_SUBMISSION_LABEL
                );
                assert!(ps.contains(UNVERIFIED_SUBMISSION_NOTICE));
                assert!(list.contains(UNVERIFIED_SUBMISSION_NOTICE));
                assert!(briefing.contains(UNVERIFIED_SUBMISSION_NOTICE));
                let input = render_core_agent_input_lines(&json!({"sessionId":id,"delivery":row["inputDelivery"],"turnSemantics":{"consumesTurn":true}})).join("\n");
                assert!(input.contains(UNVERIFIED_SUBMISSION_NOTICE));
                assert!(!input.contains("(submitted prompt;"));
            } else if case["expectedOutcome"] == "delivered" {
                assert_ne!(
                    row["semantic"]["presentation"]["compactHint"],
                    UNVERIFIED_SUBMISSION_LABEL
                );
                assert!(!ps.contains(UNVERIFIED_SUBMISSION_NOTICE));
                assert!(!list.contains(UNVERIFIED_SUBMISSION_NOTICE));
                assert!(!briefing.contains(UNVERIFIED_SUBMISSION_NOTICE));
            }
        }
    }
}
