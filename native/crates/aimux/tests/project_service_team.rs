use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::team::{load_team_config, project_team_path, save_team_config};
use serde_json::json;
use std::fs::{read_to_string, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn routes_read_init_add_update_default_and_remove_project_team_config() {
    let project = temp_project("routes");
    let context = ProjectServiceRequestContext::new(&project);

    let initialized =
        route_project_service_request(&context, "POST", routes::team::INIT, Some(&json!({})));
    assert_eq!(initialized.status, 200);
    assert_eq!(initialized.body["config"]["defaultRole"], "coder");
    assert!(initialized.body["config"]["roles"]["coder"].is_object());
    assert!(initialized.body["config"]["roles"]["reviewer"].is_object());

    let initial_read = route_project_service_request(&context, "GET", routes::team::CONFIG, None);
    assert_eq!(initial_read.status, 200);
    assert_eq!(initial_read.body["config"]["defaultRole"], "coder");

    let added = route_project_service_request(
        &context,
        "POST",
        routes::team::ADD_ROLE,
        Some(&json!({
            "role": "planner",
            "description": "Plans work",
            "reviewedBy": "reviewer",
            "canEdit": true
        })),
    );
    assert_eq!(added.status, 200);
    assert_eq!(added.body["role"], "planner");
    assert_eq!(
        added.body["config"]["roles"]["planner"]["description"],
        "Plans work"
    );
    assert_eq!(
        added.body["config"]["roles"]["planner"]["reviewedBy"],
        "reviewer"
    );
    assert_eq!(added.body["config"]["roles"]["planner"]["canEdit"], true);

    let stored = serde_json::from_str::<serde_json::Value>(
        &read_to_string(project_team_path(&project)).expect("team file"),
    )
    .expect("stored json");
    assert_eq!(
        stored["roles"]["planner"],
        added.body["config"]["roles"]["planner"]
    );

    let updated = route_project_service_request(
        &context,
        "POST",
        routes::team::ADD_ROLE,
        Some(&json!({ "role": "planner", "description": "Plans revised" })),
    );
    assert_eq!(updated.status, 200);
    assert_eq!(
        updated.body["config"]["roles"]["planner"],
        json!({
            "description": "Plans revised",
            "reviewedBy": "reviewer",
            "canEdit": true
        })
    );

    let defaulted = route_project_service_request(
        &context,
        "POST",
        routes::team::DEFAULT_ROLE,
        Some(&json!({ "role": "planner" })),
    );
    assert_eq!(defaulted.status, 200);
    assert_eq!(defaulted.body["config"]["defaultRole"], "planner");

    let missing_default = route_project_service_request(
        &context,
        "POST",
        routes::team::DEFAULT_ROLE,
        Some(&json!({ "role": "missing" })),
    );
    assert_eq!(missing_default.status, 404);
    assert_eq!(
        missing_default.body["error"],
        "Role \"missing\" not found. Add it first with: aimux team add missing"
    );

    let removed = route_project_service_request(
        &context,
        "POST",
        routes::team::REMOVE_ROLE,
        Some(&json!({ "role": "planner" })),
    );
    assert_eq!(removed.status, 200);
    assert!(removed.body["config"]["roles"]["planner"].is_null());
    assert_eq!(removed.body["config"]["defaultRole"], "coder");

    let reviewer_removed = route_project_service_request(
        &context,
        "POST",
        routes::team::REMOVE_ROLE,
        Some(&json!({ "role": "reviewer" })),
    );
    assert_eq!(reviewer_removed.status, 200);
    assert_eq!(reviewer_removed.body["config"]["defaultRole"], "coder");

    let last_role_removed = route_project_service_request(
        &context,
        "POST",
        routes::team::REMOVE_ROLE,
        Some(&json!({ "role": "coder" })),
    );
    assert_eq!(last_role_removed.status, 400);
    assert_eq!(
        last_role_removed.body["error"],
        "cannot remove the last team role"
    );
    cleanup(project);
}

#[test]
fn add_role_defaults_from_existing_or_role_name() {
    let project = temp_project("defaults");
    let context = ProjectServiceRequestContext::new(&project);
    save_team_config(
        &project,
        &json!({
            "roles": {
                "builder": { "description": "Build", "reviewedBy": "reviewer", "canEdit": true },
                "reviewer": { "description": "Review" }
            },
            "defaultRole": "builder"
        }),
    )
    .expect("seed team config");

    let updated_existing = route_project_service_request(
        &context,
        "POST",
        routes::team::ADD_ROLE,
        Some(&json!({ "role": "builder" })),
    );
    assert_eq!(
        updated_existing.body["config"]["roles"]["builder"],
        json!({ "description": "Build", "reviewedBy": "reviewer", "canEdit": true })
    );

    let added_new = route_project_service_request(
        &context,
        "POST",
        routes::team::ADD_ROLE,
        Some(&json!({ "role": "observer" })),
    );
    assert_eq!(
        added_new.body["config"]["roles"]["observer"],
        json!({ "description": "observer agent" })
    );
    cleanup(project);
}

#[test]
fn validation_errors_match_typescript_routes() {
    let project = temp_project("validation");
    let context = ProjectServiceRequestContext::new(&project);

    let missing_add =
        route_project_service_request(&context, "POST", routes::team::ADD_ROLE, Some(&json!({})));
    assert_eq!(missing_add.status, 400);
    assert_eq!(missing_add.body["error"], "role is required");

    route_project_service_request(&context, "POST", routes::team::INIT, Some(&json!({})));
    let missing_remove = route_project_service_request(
        &context,
        "POST",
        routes::team::REMOVE_ROLE,
        Some(&json!({ "role": "missing" })),
    );
    assert_eq!(missing_remove.status, 404);
    assert_eq!(missing_remove.body["error"], "Role \"missing\" not found.");
    cleanup(project);
}

#[test]
fn load_returns_project_json_verbatim_when_present() {
    let project = temp_project("load");
    save_team_config(
        &project,
        &json!({
            "roles": { "alpha": { "description": "Alpha" } },
            "defaultRole": "alpha",
            "extra": true
        }),
    )
    .expect("seed team config");
    assert_eq!(load_team_config(&project)["extra"], true);
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-team-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
