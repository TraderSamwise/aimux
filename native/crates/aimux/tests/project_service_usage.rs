use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::usage::{
    MarkLastUsedOptions, last_used_path, load_last_used_state, mark_last_used,
};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn keeps_recent_ordering_monotonic_when_older_usage_marks_arrive_late() {
    let project = temp_project("monotonic");
    let state_dir = project.join("state");
    mark_last_used(
        &state_dir,
        mark("agent-a", Some("client-1"), "2026-06-28T04:00:01.000Z"),
    );
    mark_last_used(
        &state_dir,
        mark("agent-b", Some("client-1"), "2026-06-28T04:00:02.000Z"),
    );
    mark_last_used(
        &state_dir,
        mark("agent-a", Some("client-1"), "2026-06-28T04:00:01.000Z"),
    );

    let state = load_last_used_state(&state_dir);
    assert_eq!(state["projectRecentIds"], json!(["agent-b", "agent-a"]));
    assert_eq!(
        state["clients"]["client-1"]["recentIds"],
        json!(["agent-b", "agent-a"])
    );
    assert_eq!(state["updatedAt"], "2026-06-28T04:00:02.000Z");
    assert_eq!(
        state["clients"]["client-1"]["updatedAt"],
        "2026-06-28T04:00:02.000Z"
    );
    cleanup(project);
}

#[test]
fn older_mark_does_not_overwrite_newer_item_timestamp() {
    let project = temp_project("older");
    let state_dir = project.join("state");
    mark_last_used(
        &state_dir,
        mark("agent-a", None, "2026-06-28T04:00:03.000Z"),
    );
    mark_last_used(
        &state_dir,
        mark("agent-a", None, "2026-06-28T04:00:01.000Z"),
    );
    assert_eq!(
        load_last_used_state(&state_dir)["items"]["agent-a"]["lastUsedAt"],
        "2026-06-28T04:00:03.000Z"
    );
    cleanup(project);
}

#[test]
fn keeps_each_clients_recency_independent() {
    let project = temp_project("clients");
    let state_dir = project.join("state");
    mark_last_used(
        &state_dir,
        mark("agent-a", Some("client-1"), "2026-06-28T04:00:01.000Z"),
    );
    mark_last_used(
        &state_dir,
        mark("agent-a", Some("client-2"), "2026-06-28T04:00:03.000Z"),
    );
    mark_last_used(
        &state_dir,
        mark("agent-b", Some("client-1"), "2026-06-28T04:00:02.000Z"),
    );

    let state = load_last_used_state(&state_dir);
    assert_eq!(state["projectRecentIds"], json!(["agent-a", "agent-b"]));
    assert_eq!(
        state["clients"]["client-1"]["recentIds"],
        json!(["agent-b", "agent-a"])
    );
    assert_eq!(
        state["clients"]["client-2"]["recentIds"],
        json!(["agent-a"])
    );
    cleanup(project);
}

#[test]
fn prunes_per_client_item_timestamps_to_recent_id_limit() {
    let project = temp_project("prune");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    let mut entries = serde_json::Map::new();
    let mut recent_ids = Vec::new();
    for index in 0..69 {
        let item_id = format!("agent-{index}");
        entries.insert(
            item_id.clone(),
            json!({ "lastUsedAt": format!("2026-06-28T04:{:02}:{:02}.000Z", index / 60, index % 60) }),
        );
        recent_ids.insert(0, item_id);
    }
    write(
        last_used_path(&state_dir),
        json!({
            "version": 1,
            "items": entries,
            "clients": {
                "client-1": {
                    "recentIds": recent_ids,
                    "items": entries,
                    "updatedAt": "2026-06-28T04:01:08.000Z"
                }
            },
            "projectRecentIds": recent_ids
        })
        .to_string(),
    )
    .expect("seed last-used");

    mark_last_used(
        &state_dir,
        mark("agent-69", Some("client-1"), "2026-06-28T04:01:09.000Z"),
    );
    let state = load_last_used_state(&state_dir);
    assert_eq!(
        state["clients"]["client-1"]["recentIds"]
            .as_array()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        state["clients"]["client-1"]["items"]
            .as_object()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        state["clients"]["client-1"]["items"]["agent-69"]["lastUsedAt"],
        "2026-06-28T04:01:09.000Z"
    );
    assert!(state["clients"]["client-1"]["items"]["agent-0"].is_null());
    cleanup(project);
}

#[test]
fn seeds_legacy_client_recency_timestamps_from_saved_order() {
    let project = temp_project("legacy");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(
        last_used_path(&state_dir),
        json!({
            "version": 1,
            "items": {
                "agent-a": { "lastUsedAt": "2026-06-28T04:00:01.000Z" },
                "agent-b": { "lastUsedAt": "2026-06-28T04:00:02.000Z" }
            },
            "clients": {
                "client-1": {
                    "recentIds": ["agent-a", "agent-b"],
                    "updatedAt": "2026-06-28T04:00:03.000Z"
                }
            },
            "projectRecentIds": ["agent-b", "agent-a"]
        })
        .to_string(),
    )
    .expect("seed legacy state");

    mark_last_used(
        &state_dir,
        mark("agent-b", Some("client-1"), "2026-06-28T04:00:02.000Z"),
    );
    assert_eq!(
        load_last_used_state(&state_dir)["clients"]["client-1"]["recentIds"],
        json!(["agent-a", "agent-b"])
    );
    cleanup(project);
}

#[test]
fn route_marks_usage_and_returns_last_used_at() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::USAGE_MARK,
        Some(&json!({
            "itemId": " service-1 ",
            "clientSession": " aimux-client-1 ",
            "usedAt": "2026-06-28T04:00:00.000Z"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        json!({
            "ok": true,
            "itemId": "service-1",
            "lastUsedAt": "2026-06-28T04:00:00.000Z"
        })
    );
    assert_eq!(
        load_last_used_state(&state_dir)["clients"]["aimux-client-1"]["recentIds"][0],
        "service-1"
    );

    let missing = route_project_service_request(
        &context,
        "POST",
        routes::runtime::USAGE_MARK,
        Some(&json!({})),
    );
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["error"], "itemId is required");
    cleanup(project);
}

fn mark(item_id: &str, client_session: Option<&str>, used_at: &str) -> MarkLastUsedOptions {
    MarkLastUsedOptions {
        item_id: item_id.into(),
        client_session: client_session.map(str::to_owned),
        used_at: Some(used_at.into()),
    }
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-usage-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
