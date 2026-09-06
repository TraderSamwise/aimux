use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{HotExposeScopeKey, write_hot_expose_scope_view};
use aimux::tmux_expose_hot_snapshot_worker::{
    ExposeHotSnapshotWorkerProject, build_global_expose_hot_snapshot_view,
    refresh_global_expose_hot_snapshots,
};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const EXPOSE_HOT_SNAPSHOT_WORKER: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/expose-hot-snapshot-worker.json");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_expose_hot_snapshot_worker_matches_typescript_contract() {
    let contract: Value = serde_json::from_str(EXPOSE_HOT_SNAPSHOT_WORKER)
        .expect("valid expose hot snapshot worker fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("expose hot snapshot worker cases");
    assert_eq!(
        cases.len(),
        3,
        "unexpected expose hot snapshot worker case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} expose-hot-snapshot-worker parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let home = temp_root();
    let projects = case["input"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .map(|project| {
            serde_json::from_value::<ExposeHotSnapshotWorkerProject>(project.clone())
                .expect("project")
        })
        .collect::<Vec<_>>();
    setup_case(&home, case["name"].as_str().expect("case name"), &projects);
    let output = match case["name"].as_str().expect("case name") {
        "builds global view from project hot snapshots" => {
            json!({
                "view": view_to_value(build_global_expose_hot_snapshot_view(&projects, |id| state_dir(&home, id)))
            })
        }
        "mirrors active project snapshots into every active project global cache" => {
            refresh_global_expose_hot_snapshots(&projects, |id| state_dir(&home, id));
            json!({
                "projA": snapshot(&home, "proj-a", "/repo/a"),
                "projB": snapshot(&home, "proj-b", "/repo/b"),
                "projC": snapshot(&home, "proj-c", "/repo/c"),
            })
        }
        "clears active global caches when no project snapshots remain" => {
            let path = state_dir(&home, "proj-a").join("expose-hot-snapshots.json");
            let before_exists = path.exists();
            refresh_global_expose_hot_snapshots(&projects, |id| state_dir(&home, id));
            json!({
                "beforeExists": before_exists,
                "afterExists": path.exists(),
                "global": snapshot(&home, "proj-a", "/repo/a"),
            })
        }
        unexpected => panic!("unexpected case {unexpected}"),
    };
    let _ = fs::remove_dir_all(&home);
    normalize(output)
}

fn setup_case(home: &Path, name: &str, projects: &[ExposeHotSnapshotWorkerProject]) {
    match name {
        "builds global view from project hot snapshots" => {
            write_project_snapshot(home, &projects[0], vec![item("agent-a", "@1")]);
        }
        "mirrors active project snapshots into every active project global cache" => {
            write_project_snapshot(home, &projects[0], vec![item("agent-a", "@1")]);
            write_project_snapshot(home, &projects[1], vec![item("agent-b", "@2")]);
        }
        "clears active global caches when no project snapshots remain" => {
            write_hot_expose_scope_view(
                state_dir(home, "proj-a"),
                HotExposeScopeKey {
                    project_root: "/repo/a".into(),
                    scope: ExposeScope::Global,
                    worktree_key: None,
                    launch_window_id: None,
                },
                ExposeScopeView {
                    scope: ExposeScope::Global,
                    scope_label: "all projects".into(),
                    sublabel: ExposeSublabel::ProjectWorktree,
                    items: vec![item("stale-agent", "@9")],
                },
                None,
            );
        }
        unexpected => panic!("unexpected setup {unexpected}"),
    }
}

fn write_project_snapshot(
    home: &Path,
    project: &ExposeHotSnapshotWorkerProject,
    items: Vec<Value>,
) {
    write_hot_expose_scope_view(
        state_dir(home, &project.id),
        HotExposeScopeKey {
            project_root: project.path.clone(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items,
        },
        None,
    );
}

fn snapshot(home: &Path, id: &str, project_root: &str) -> Value {
    aimux::tmux_expose_hot_snapshot::read_hot_expose_scope_view(
        state_dir(home, id),
        &HotExposeScopeKey {
            project_root: project_root.into(),
            scope: ExposeScope::Global,
            worktree_key: None,
            launch_window_id: None,
        },
    )
    .map(view_to_value)
    .map(normalize)
    .unwrap_or(Value::Null)
}

fn view_to_value(view: ExposeScopeView) -> Value {
    json!({
        "scope": view.scope,
        "items": view.items,
        "scopeLabel": view.scope_label,
        "sublabel": view.sublabel,
    })
}

fn item(id: &str, window_id: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "urgency": 0,
        "activity": 0,
        "recentRank": 0,
        "target": { "sessionName": "aimux-test", "windowId": window_id, "windowIndex": 1, "windowName": id },
        "metadata": { "kind": "agent", "sessionId": id, "command": "codex", "worktreePath": "/repo" },
        "previewSnapshot": {
            "output": format!("{id} preview\n"),
            "capturedAt": "2026-07-20T13:00:00.000Z",
            "source": "tap",
            "windowId": window_id,
            "startLine": -40,
            "lineCount": 40,
        },
    })
}

fn normalize(value: Value) -> Value {
    match value {
        Value::String(value) if is_iso_timestamp(&value) => Value::String("<iso>".into()),
        Value::Array(values) => Value::Array(values.into_iter().map(normalize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        value => value,
    }
}

fn is_iso_timestamp(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes().get(16) == Some(&b':')
        && value.as_bytes().get(19) == Some(&b'.')
        && value.as_bytes().get(23) == Some(&b'Z')
}

fn state_dir(home: &Path, id: &str) -> PathBuf {
    home.join("projects").join(id)
}

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-expose-hot-snapshot-worker-fixture-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp root");
    path
}
