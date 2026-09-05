use aimux::project_service::library::{is_stub_plan, list_library_documents, load_library_entries};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn lists_allowlisted_project_documents() {
    let project = temp_project("docs");
    write(project.join("README.md"), "Read me").expect("readme");
    write(project.join("package.json"), "{}").expect("ignored");

    let documents = list_library_documents(&project);
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0]["id"], "README.md");
    assert_eq!(documents[0]["kind"], "project");
    assert_eq!(documents[0]["title"], "README.md");
    assert_eq!(documents[0]["path"], "README.md");
    assert_eq!(documents[0]["size"], 7);
    assert_eq!(documents[0]["content"], "Read me");
    assert_eq!(documents[0]["truncated"], false);
    cleanup(project);
}

#[test]
fn entries_include_docs_and_non_stub_plans_sorted_by_recency() {
    let project = temp_project("entries");
    write(project.join("AGENTS.md"), "Agent instructions").expect("agents");
    let plans = project.join(".aimux").join("plans");
    create_dir_all(&plans).expect("plans dir");
    write(
        plans.join("codex-stub.md"),
        "# Goal\n\nTBD\n\n# Current Status\n\nTBD\n\n# Steps\n\n- [ ] TBD\n",
    )
    .expect("stub plan");
    write(
        plans.join("codex-1.md"),
        "---\nupdatedAt: 2026-06-20T00:00:00.000Z\n---\n# Plan\n\nShip the API library.",
    )
    .expect("plan");
    let context =
        ProjectServiceRequestContext::new(&project).with_session_label("codex-1", "library agent");

    let entries = load_library_entries(&context, 4000);
    assert!(entries.iter().any(|entry| entry["id"] == "doc:AGENTS.md"));
    let plan = entries
        .iter()
        .find(|entry| entry["id"] == "plan:codex-1")
        .expect("plan entry");
    assert_eq!(plan["title"], "library agent");
    assert_eq!(plan["label"], "library agent");
    assert_eq!(plan["sessionId"], "codex-1");
    assert_eq!(plan["updatedAt"], "2026-06-20T00:00:00.000Z");
    assert_eq!(plan["preview"], "# Plan\n\nShip the API library.");
    assert!(!entries.iter().any(|entry| entry["id"] == "plan:codex-stub"));
    cleanup(project);
}

#[test]
fn detects_generated_stub_plans_after_frontmatter() {
    assert!(is_stub_plan(
        "---\nupdatedAt: 2026-06-20T00:00:00.000Z\n---\n# Goal\n\nTBD\n\n# Current Status\n\nTBD\n\n# Steps\n\n- [ ] TBD"
    ));
    assert!(!is_stub_plan(
        "# Goal\n\nReal work\n\n# Current Status\n\nTBD\n\n# Steps\n\n- [ ] TBD"
    ));
}

#[test]
fn route_returns_documents_and_entries() {
    let project = temp_project("route");
    write(project.join("README.md"), "Read me").expect("readme");
    let plans = project.join(".aimux").join("plans");
    create_dir_all(&plans).expect("plans dir");
    write(plans.join("codex-1.md"), "# Plan\n\nShip").expect("plan");
    let context = ProjectServiceRequestContext::new(&project);

    let response = route_project_service_request(&context, "GET", "/library", None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(
        response.body["documents"],
        json!([{
            "id": "README.md",
            "title": "README.md",
            "path": "README.md",
            "kind": "project",
            "size": 7,
            "updatedAt": response.body["documents"][0]["updatedAt"].clone(),
            "content": "Read me",
            "truncated": false
        }])
    );
    let entries = response.body["entries"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["id"] == "doc:README.md"));
    let plan = entries
        .iter()
        .find(|entry| entry["id"] == "plan:codex-1")
        .expect("plan entry");
    assert_eq!(plan["kind"], "plan");
    assert_eq!(plan["title"], "codex-1");
    assert_eq!(
        plan["path"],
        plans.join("codex-1.md").to_string_lossy().into_owned()
    );
    assert_eq!(plan["sessionId"], "codex-1");
    assert_eq!(plan["preview"], "# Plan\n\nShip");
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-library-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    create_dir_all(&path).expect("project dir");
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
