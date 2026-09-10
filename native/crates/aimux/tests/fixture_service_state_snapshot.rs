use aimux::runtime_topology::{
    empty_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::runtime_topology_services::list_topology_service_states;
use aimux::service_state_snapshot::{
    ServiceStateSnapshotRuntime, merge_runtime_snapshots, merge_service_snapshots,
    persist_project_runtime_snapshots_before_tmux_stop_at, snapshot_project_service_windows,
};
use aimux::tmux::{TmuxManagedWindow, TmuxTarget};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const SERVICE_STATE_SNAPSHOT: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/service-state-snapshot.json");

#[test]
fn fixture_service_state_snapshot_matches_typescript() {
    let contract: Value = serde_json::from_str(SERVICE_STATE_SNAPSHOT)
        .expect("valid runtime-state/service-state-snapshot fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("service snapshot cases");
    assert_eq!(
        cases.len(),
        5,
        "unexpected runtime-state/service-state-snapshot case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = service_state_snapshot_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} runtime-state/service-state-snapshot parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn service_state_snapshot_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "mergeServiceSnapshots" => {
            let snapshots = case["input"]
                .get("snapshots")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            merge_service_snapshots(
                case["input"].get("existing"),
                &snapshots,
                case["input"]["cwd"].as_str().unwrap_or("<repo>"),
                case["input"]["savedAt"].as_str().unwrap_or("<ts:1>"),
            )
        }
        "mergeRuntimeSnapshots" => json!({
            "merged": merge_runtime_snapshots(
                case["input"].get("existing"),
                case["input"].get("snapshots").and_then(|snapshots| snapshots.get("services")),
                "<repo>",
                case["input"]["savedAt"].as_str().unwrap_or("<ts:1>"),
            ),
            "topologySessions": [],
        }),
        "persistProjectRuntimeSnapshotsBeforeTmuxStop" => {
            let root = temp_root("service-state-snapshot-persist");
            let repo_root = root.join("repo");
            let state_dir = root.join("state");
            fs::create_dir_all(&repo_root).expect("repo root");
            fs::create_dir_all(&state_dir).expect("state dir");
            write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
                .expect("seed topology");
            let mut tmux =
                FakeSnapshotRuntime::new(vec![service_window_from_case(case, &repo_root)]);
            persist_project_runtime_snapshots_before_tmux_stop_at(
                &repo_root,
                &state_dir,
                &mut tmux,
                case["input"]["metadataCreatedAt"]
                    .as_str()
                    .unwrap_or("<ts:1>"),
            )
            .expect("persist snapshots");
            let topology =
                read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
            json!({ "stopped": normalize_paths(
                list_topology_service_states(&topology, Some(&["stopped"])),
                &repo_root
            ) })
        }
        "persistNoWindows" => {
            let root = temp_root("service-state-snapshot-none");
            let repo_root = root.join("repo");
            let state_dir = root.join("state");
            fs::create_dir_all(&repo_root).expect("repo root");
            fs::create_dir_all(&state_dir).expect("state dir");
            write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
                .expect("seed topology");
            fs::write(
                state_dir.join("state.json"),
                serde_json::to_vec_pretty(&case["input"]["state"]).expect("state json"),
            )
            .expect("write existing state");
            let mut tmux = FakeSnapshotRuntime::new(Vec::new());
            let result = persist_project_runtime_snapshots_before_tmux_stop_at(
                &repo_root, &state_dir, &mut tmux, "<ts:1>",
            )
            .expect("persist no windows");
            let state: Value = serde_json::from_slice(
                &fs::read(state_dir.join("state.json")).expect("read state"),
            )
            .expect("parse state");
            json!({ "result": result, "state": normalize_value_paths(state, &repo_root) })
        }
        "snapshotProjectServiceWindows" => {
            let root = temp_root("service-state-snapshot-windows");
            let state_dir = root.join("state");
            fs::create_dir_all(&state_dir).expect("state dir");
            write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
                .expect("seed topology");
            let windows = case["input"]["windows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(window_from_value)
                .collect::<Vec<_>>();
            let mut tmux = FakeSnapshotRuntime::new(windows);
            Value::Array(
                snapshot_project_service_windows(PathBuf::from("<repo>"), &state_dir, &mut tmux)
                    .expect("snapshot service windows"),
            )
        }
        _ => Value::Null,
    }
}

fn service_window_from_case(case: &Value, repo_root: &Path) -> TmuxManagedWindow {
    let service = &case["input"]["service"];
    let mut metadata = service.clone();
    metadata["kind"] = Value::String("service".into());
    metadata["sessionId"] = service["id"].clone();
    metadata["createdAt"] = case["input"]["metadataCreatedAt"].clone();
    metadata["worktreePath"] = Value::String(repo_root.to_string_lossy().into_owned());
    metadata["args"] = Value::Array(Vec::new());
    let target = target_from_value(&service["tmuxTarget"]);
    TmuxManagedWindow { target, metadata }
}

fn window_from_value(window: &Value) -> TmuxManagedWindow {
    TmuxManagedWindow {
        target: target_from_value(&window["target"]),
        metadata: window["metadata"].clone(),
    }
}

fn target_from_value(value: &Value) -> TmuxTarget {
    TmuxTarget {
        session_name: value["sessionName"]
            .as_str()
            .unwrap_or("aimux-repo")
            .to_owned(),
        window_id: value["windowId"].as_str().unwrap_or("@1").to_owned(),
        window_index: value["windowIndex"].as_i64().unwrap_or(1),
        window_name: value["windowName"].as_str().unwrap_or("window").to_owned(),
        pane_dead: None,
    }
}

struct FakeSnapshotRuntime {
    windows: Vec<TmuxManagedWindow>,
    dead_windows: BTreeSet<String>,
}

impl FakeSnapshotRuntime {
    fn new(windows: Vec<TmuxManagedWindow>) -> Self {
        Self {
            windows,
            dead_windows: BTreeSet::new(),
        }
    }
}

impl ServiceStateSnapshotRuntime for FakeSnapshotRuntime {
    fn list_project_managed_windows(
        &mut self,
        _project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        Ok(self.windows.clone())
    }

    fn display_message(&mut self, _format: &str, target: &str) -> Option<String> {
        if target == "@2" {
            Some("<repo>".into())
        } else {
            None
        }
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        Ok(!self.dead_windows.contains(&target.window_id))
    }

    fn path_exists(&mut self, path: &str) -> bool {
        !path.contains("/missing")
    }
}

fn normalize_paths(values: Vec<Value>, repo_root: &Path) -> Vec<Value> {
    values
        .into_iter()
        .map(|value| normalize_value_paths(value, repo_root))
        .collect()
}

fn normalize_value_paths(value: Value, repo_root: &Path) -> Value {
    match value {
        Value::String(value) => {
            Value::String(value.replace(repo_root.to_string_lossy().as_ref(), "<repo>"))
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|value| normalize_value_paths(value, repo_root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value_paths(value, repo_root)))
                .collect(),
        ),
        value => value,
    }
}

fn temp_root(prefix: &str) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    path
}
