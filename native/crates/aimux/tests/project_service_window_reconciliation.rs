//! Repairing tmux bindings after the server that issued the ids is gone.
//!
//! Every case here is the same topology seen after a tmux server restart, and
//! differs only in what the project actually owns afterwards — which is the
//! only evidence that separates "this agent moved" from "this agent is gone".

use aimux::project_service::window_reconciliation::{
    BindingRepair, OwnedWindow, apply_binding_repairs, plan_binding_repairs,
};
use serde_json::{Value, json};

const PROJECT_SESSION: &str = "aimux-repo";

fn topology_with_binding(window_id: &str, tmux_session: &str) -> Value {
    json!({
        "nodes": [{ "id": "node-codex", "toolConfigKey": "codex", "cwd": "/repo" }],
        "sessions": [{ "id": "codex-abc123", "nodeId": "node-codex", "status": "running" }],
        "bindings": [{
            "id": "binding-codex",
            "nodeId": "node-codex",
            "tmuxSession": tmux_session,
            "tmuxWindowId": window_id,
            "tmuxWindowIndex": 4,
            "tmuxWindowName": "codex"
        }],
    })
}

fn owned(session_id: Option<&str>, window_id: &str, window_index: i64) -> OwnedWindow {
    OwnedWindow {
        session_id: session_id.map(str::to_owned),
        tmux_session: PROJECT_SESSION.to_owned(),
        window_id: window_id.to_owned(),
        window_index,
        window_name: "codex".to_owned(),
    }
}

#[test]
fn binding_whose_window_matches_its_own_session_needs_no_repair() {
    let topology = topology_with_binding("@1018", PROJECT_SESSION);

    let repairs = plan_binding_repairs(&topology, &[owned(Some("codex-abc123"), "@1018", 4)]);

    assert!(
        repairs.is_empty(),
        "a correct binding must not be rewritten"
    );
}

/// The agent survived the restart under a new id. tmux window ids are not the
/// identity; the `@aimux-meta` session id is, and it still names this session.
#[test]
fn live_session_under_a_new_window_id_is_rebound_to_it() {
    let topology = topology_with_binding("@1018", PROJECT_SESSION);

    let repairs = plan_binding_repairs(&topology, &[owned(Some("codex-abc123"), "@7", 2)]);

    assert_eq!(
        repairs,
        vec![BindingRepair::Rebind {
            node_id: "node-codex".to_owned(),
            session_id: "codex-abc123".to_owned(),
            from_window_id: "@1018".to_owned(),
            to: owned(Some("codex-abc123"), "@7", 2),
        }]
    );

    let repaired = apply_binding_repairs(topology, &repairs);
    let binding = &repaired["bindings"][0];
    assert_eq!(binding["tmuxWindowId"], json!("@7"));
    assert_eq!(binding["tmuxWindowIndex"], json!(2));
    assert_eq!(binding["tmuxSession"], json!(PROJECT_SESSION));
}

/// Nothing this project owns claims the session, so the binding is a phantom.
/// Dropping it is what makes the session read offline and restorable instead of
/// advertising a focus that can only fail.
#[test]
fn binding_no_owned_window_claims_is_invalidated() {
    let topology = topology_with_binding("@1018", PROJECT_SESSION);

    let repairs = plan_binding_repairs(&topology, &[owned(Some("claude-scribe"), "@6", 1)]);

    assert_eq!(
        repairs,
        vec![BindingRepair::Invalidate {
            node_id: "node-codex".to_owned(),
            session_id: "codex-abc123".to_owned(),
            stale_window_id: "@1018".to_owned(),
            stale_tmux_session: PROJECT_SESSION.to_owned(),
        }]
    );

    let repaired = apply_binding_repairs(topology, &repairs);
    assert_eq!(
        repaired["bindings"].as_array().map(Vec::len),
        Some(0),
        "an unclaimable binding must not survive the repair"
    );
}

/// The reboot case Sam hit: `@3` still exists, but it is another project's
/// dashboard. Matching by id would leave the binding in place and keep
/// punting him into that project.
#[test]
fn binding_pointing_at_another_projects_window_is_invalidated() {
    let topology = topology_with_binding("@3", PROJECT_SESSION);

    let repairs = plan_binding_repairs(&topology, &[owned(Some("claude-scribe"), "@6", 1)]);

    assert!(
        matches!(repairs.as_slice(), [BindingRepair::Invalidate { stale_window_id, .. }] if stale_window_id == "@3"),
        "a window id this project does not own is stale no matter who else holds it: {repairs:?}"
    );
}

/// A window aimux did not create carries no session id, so it is evidence of
/// nothing. If the binding names that window, leave it alone rather than
/// deleting a binding on the strength of missing metadata.
#[test]
fn window_without_aimux_metadata_does_not_invalidate_a_binding_to_it() {
    let topology = topology_with_binding("@9", PROJECT_SESSION);

    let repairs = plan_binding_repairs(&topology, &[owned(None, "@9", 3)]);

    assert!(
        repairs.is_empty(),
        "a window we own but cannot identify must not be treated as proof the session is gone"
    );
}

/// Repairs are keyed by node, so one stale binding does not disturb a healthy
/// sibling in the same topology.
#[test]
fn repairing_one_binding_leaves_the_others_untouched() {
    let mut topology = topology_with_binding("@1018", PROJECT_SESSION);
    topology["nodes"].as_array_mut().unwrap().push(json!({
        "id": "node-scribe", "toolConfigKey": "claude", "cwd": "/repo"
    }));
    topology["sessions"].as_array_mut().unwrap().push(json!({
        "id": "claude-scribe", "nodeId": "node-scribe", "status": "running"
    }));
    topology["bindings"].as_array_mut().unwrap().push(json!({
        "id": "binding-scribe",
        "nodeId": "node-scribe",
        "tmuxSession": PROJECT_SESSION,
        "tmuxWindowId": "@6",
        "tmuxWindowIndex": 1,
        "tmuxWindowName": "claude"
    }));

    let repairs = plan_binding_repairs(&topology, &[owned(Some("claude-scribe"), "@6", 1)]);
    let repaired = apply_binding_repairs(topology, &repairs);

    let bindings = repaired["bindings"].as_array().expect("bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0]["nodeId"], json!("node-scribe"));
    assert_eq!(bindings[0]["tmuxWindowId"], json!("@6"));
}

/// The task half: a tmux inventory that could not be taken is an error, never
/// an empty list. An empty list would invalidate every binding in the project
/// on a transient tmux hiccup.
mod task {
    use aimux::async_runtime::block_on_named;
    use aimux::project_service::router::ProjectServiceRequestContext;
    use aimux::project_service::scheduler::PeriodicTask;
    use aimux::project_service::window_reconciliation::{
        OwnedWindow, OwnedWindowSource, WindowReconciliationTask,
    };
    use aimux::runtime_topology::{read_runtime_topology, runtime_topology_path};
    use serde_json::{Value, json};
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;

    struct FakeWindows(Result<Vec<OwnedWindow>, String>);

    impl OwnedWindowSource for FakeWindows {
        fn owned_windows<'a>(
            &'a mut self,
            _project_root: &'a Path,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<OwnedWindow>, String>> + Send + 'a>> {
            Box::pin(std::future::ready(self.0.clone()))
        }
    }

    fn temp_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aimux-window-reconciliation-{name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(root.join("state")).expect("state dir");
        root
    }

    fn write_topology(state_dir: &Path, window_id: &str) {
        let stamp = "2026-09-22T00:00:00.000Z";
        let topology = json!({
            "version": 1,
            "generatedAt": stamp,
            "rigs": [{
                "id": "rig-1", "name": "repo", "projectRoot": "/repo",
                "createdAt": stamp, "updatedAt": stamp
            }],
            "nodes": [{
                "id": "node-codex", "rigId": "rig-1", "logicalId": "codex-abc123",
                "toolConfigKey": "codex", "cwd": "/repo",
                "createdAt": stamp, "updatedAt": stamp
            }],
            "sessions": [{
                "id": "codex-abc123", "nodeId": "node-codex", "status": "running",
                "tool": "codex", "toolConfigKey": "codex", "command": "codex",
                "createdAt": stamp, "updatedAt": stamp
            }],
            "bindings": [{
                "id": "binding-codex",
                "nodeId": "node-codex",
                "tmuxSession": "aimux-repo",
                "tmuxWindowId": window_id,
                "tmuxWindowIndex": 4,
                "tmuxWindowName": "codex",
                "updatedAt": stamp
            }],
        });
        aimux::runtime_topology::write_runtime_topology(
            runtime_topology_path(state_dir),
            &aimux::runtime_topology::coerce_runtime_topology(&topology).expect("coerce"),
        )
        .expect("write topology");
    }

    fn bindings(state_dir: &Path) -> Vec<Value> {
        read_runtime_topology(runtime_topology_path(state_dir))
            .expect("read topology")
            .get("bindings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn tmux_inventory_failure_fails_the_task_and_changes_nothing() {
        let root = temp_project("inventory-error");
        let state_dir = root.join("state");
        write_topology(&state_dir, "@1018");
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir);
        let mut task = WindowReconciliationTask::with_window_source(Box::new(FakeWindows(Err(
            "tmux server not running".to_owned(),
        ))));

        // aimux-async-seam: test - sync test drives async handler
        let result = block_on_named("window-reconciliation-test", task.run(&context));

        assert!(
            result
                .as_ref()
                .is_err_and(|error| error.contains("tmux server not running")),
            "a failed inventory must surface as a task error: {result:?}"
        );
        assert_eq!(
            bindings(&state_dir).len(),
            1,
            "nothing may be invalidated on the strength of a query that failed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_binding_is_removed_from_the_persisted_topology() {
        let root = temp_project("invalidate");
        let state_dir = root.join("state");
        write_topology(&state_dir, "@1018");
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir);
        let mut task =
            WindowReconciliationTask::with_window_source(Box::new(FakeWindows(Ok(vec![
                OwnedWindow {
                    session_id: Some("claude-scribe".to_owned()),
                    tmux_session: "aimux-repo".to_owned(),
                    window_id: "@6".to_owned(),
                    window_index: 1,
                    window_name: "claude".to_owned(),
                },
            ]))));

        // aimux-async-seam: test - sync test drives async handler
        block_on_named("window-reconciliation-test", task.run(&context)).expect("task run");

        assert!(
            bindings(&state_dir).is_empty(),
            "the phantom binding must be gone from disk, not just from the read"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn moved_session_is_rebound_on_disk() {
        let root = temp_project("rebind");
        let state_dir = root.join("state");
        write_topology(&state_dir, "@1018");
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir);
        let mut task =
            WindowReconciliationTask::with_window_source(Box::new(FakeWindows(Ok(vec![
                OwnedWindow {
                    session_id: Some("codex-abc123".to_owned()),
                    tmux_session: "aimux-repo".to_owned(),
                    window_id: "@7".to_owned(),
                    window_index: 2,
                    window_name: "codex".to_owned(),
                },
            ]))));

        // aimux-async-seam: test - sync test drives async handler
        block_on_named("window-reconciliation-test", task.run(&context)).expect("task run");

        let bindings = bindings(&state_dir);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0]["tmuxWindowId"], json!("@7"));
        assert_eq!(bindings[0]["tmuxWindowIndex"], json!(2));
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The real tmux inventory is a blocking multi-command walk. Running it inline
/// inside the tick task panics the whole task, which is exactly what shipped
/// the first time: the fake source never exercised the blocking path.
#[test]
fn real_tmux_inventory_does_not_panic_inside_the_tick_task() {
    use aimux::async_runtime::{block_on_named, init_process_runtime, spawn_named};
    use aimux::project_service::window_reconciliation::{OwnedWindowSource, TmuxOwnedWindowSource};
    use std::path::PathBuf;

    init_process_runtime().expect("process runtime");
    let project_root = PathBuf::from("/nonexistent-aimux-window-reconciliation");

    // aimux-async-seam: test - sync test drives async handler
    let outcome = block_on_named("window-reconciliation-blocking-seam", async move {
        spawn_named("window-reconciliation-blocking-seam-inner", async move {
            let mut source = TmuxOwnedWindowSource;
            source.owned_windows(&project_root).await
        })
        .await
    });

    assert!(
        outcome.is_ok(),
        "the tmux inventory must not panic when driven from an async task: {outcome:?}"
    );
}
