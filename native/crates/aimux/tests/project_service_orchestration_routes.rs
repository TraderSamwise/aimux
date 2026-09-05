use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn serves_selected_orchestration_route_option_without_self_tool_route() {
    let project = temp_project("selected");
    let context = ProjectServiceRequestContext::new(&project).with_desktop_state(json!({
        "sessions": [
            {
                "id": "codex-1",
                "command": "codex",
                "tool": "codex",
                "label": "Reviewer",
                "worktreePath": "/repo/wt",
                "semantic": {
                    "user": { "label": "idle" },
                    "runtime": { "canReceiveInput": true, "isAlive": true }
                }
            }
        ],
        "teammates": [],
        "services": []
    }));

    let response = route_project_service_request(
        &context,
        "GET",
        "/orchestration/routes?selectedSessionId=codex-1",
        None,
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    let options = response.body["options"].as_array().unwrap();
    assert_eq!(
        options[0],
        json!({ "label": "Reviewer (codex-1)", "sessionId": "codex-1" })
    );
    assert!(!options.iter().any(|option| option["tool"] == "codex"));
    cleanup(project);
}

#[test]
fn preserves_selected_source_agent_for_routed_tool_options() {
    let project = temp_project("source");
    let context = ProjectServiceRequestContext::new(&project).with_desktop_state(json!({
        "sessions": [
            {
                "id": "claude-1",
                "command": "claude",
                "label": "Claude",
                "worktreePath": "/repo/wt",
                "semantic": {
                    "user": { "label": "idle" },
                    "runtime": { "canReceiveInput": true, "isAlive": true }
                }
            },
            {
                "id": "codex-1",
                "command": "codex",
                "tool": "codex",
                "worktreePath": "/repo/wt",
                "semantic": {
                    "user": { "label": "idle" },
                    "runtime": { "canReceiveInput": true, "isAlive": true }
                }
            }
        ],
        "teammates": [],
        "services": []
    }));

    let response = route_project_service_request(
        &context,
        "GET",
        "/orchestration/routes?selectedSessionId=claude-1&worktreePath=/repo/wt",
        None,
    );

    assert_eq!(response.status, 200);
    let options = response.body["options"].as_array().unwrap();
    assert!(options.contains(&json!({
        "label": "Tool: codex [1: codex-1]",
        "sourceSessionId": "claude-1",
        "tool": "codex",
        "worktreePath": "/repo/wt",
        "recipientIds": ["codex-1"],
    })));
    assert!(
        options
            .iter()
            .find(|option| option["sessionId"] == "claude-1")
            .is_some_and(|option| option["sourceSessionId"].is_null())
    );
    cleanup(project);
}

#[test]
fn routes_by_role_and_sorts_by_score_then_id() {
    let project = temp_project("roles");
    let context = ProjectServiceRequestContext::new(&project).with_desktop_state(json!({
        "sessions": [
            {
                "id": "codex-ui",
                "tool": "codex",
                "role": "reviewer",
                "worktreePath": "/repo/ui",
                "workflowOnMeCount": 1,
                "semantic": {
                    "user": { "label": "running" },
                    "runtime": { "canReceiveInput": true, "isAlive": true }
                }
            },
            {
                "id": "claude-ui",
                "tool": "claude",
                "role": "reviewer",
                "worktreePath": "/repo/ui",
                "semantic": {
                    "user": { "label": "idle" },
                    "runtime": { "canReceiveInput": true, "isAlive": true }
                }
            },
            {
                "id": "offline-ui",
                "tool": "claude",
                "role": "reviewer",
                "worktreePath": "/repo/ui",
                "semantic": {
                    "user": { "label": "offline" },
                    "runtime": { "canReceiveInput": false, "isAlive": false }
                }
            }
        ],
        "teammates": [],
        "services": []
    }));

    let response =
        route_project_service_request(&context, "GET", routes::orchestration::ROUTES, None);

    assert_eq!(response.status, 200);
    let reviewer = response.body["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["assignee"] == "reviewer")
        .unwrap();
    assert_eq!(reviewer["recipientIds"], json!(["claude-ui", "codex-ui"]));
    assert_eq!(
        reviewer["label"],
        "Role: reviewer - Reviews code changes, approves or requests changes [2: claude-ui, codex-ui]"
    );
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-orchestration-routes-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
