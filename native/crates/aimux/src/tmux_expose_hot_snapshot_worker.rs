use crate::daemon_state::load_metadata_state;
use crate::project_service::switchable_agents::{
    AgentListScope, ManagedWindowEntry, SwitchableContext, SwitchableListOptions,
    list_switchable_agent_items, serialize_fast_control_item,
};
use crate::project_service::usage::load_last_used_state;
use crate::tmux::{CapturePaneOptions, TmuxManagedWindow, TmuxRuntimeManager, TmuxTarget};
use crate::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use crate::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, HotExposeScopePrune, HotExposeScopeWrite, normalize_hot_snapshot_path,
    read_hot_expose_scope_view, write_hot_expose_scope_views,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const EXPOSE_HOT_SNAPSHOT_MAX_LAUNCH_CONTEXTS: usize = 6;
const EXPOSE_PREVIEW_CAPTURE_LINES: i64 = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeHotSnapshotWorkerProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub service_alive: bool,
}

pub trait ProjectExposeHotSnapshotRuntime {
    fn list_project_managed_windows(
        &mut self,
        project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String>;
    fn capture_target(
        &mut self,
        target: &TmuxTarget,
        options: CapturePaneOptions,
    ) -> Result<String, String>;
}

impl ProjectExposeHotSnapshotRuntime for TmuxRuntimeManager {
    fn list_project_managed_windows(
        &mut self,
        project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        self.list_project_managed_windows(project_root)
    }

    fn capture_target(
        &mut self,
        target: &TmuxTarget,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.capture_target(target, options)
    }
}

pub fn refresh_project_expose_hot_snapshots(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    runtime: &mut impl ProjectExposeHotSnapshotRuntime,
) {
    let project_root = normalize_hot_snapshot_path(&project_root.as_ref().to_string_lossy());
    let project_state_dir = project_state_dir.as_ref();
    let captured_at = now_iso();
    let mut capture_cache = HashMap::<String, Option<Value>>::new();
    let live_launch_contexts = match runtime.list_project_managed_windows(Path::new(&project_root))
    {
        Ok(windows) => windows
            .into_iter()
            .filter(|entry| {
                entry.target.pane_dead != Some(true)
                    && !crate::tmux::is_dashboard_window_name(&entry.target.window_name)
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            crate::debug_logging::log_at(
                crate::debug_logging::LogLevel::Debug,
                "skipped project expose hot snapshot: tmux inventory failed",
                "expose",
                Some(json!({
                    "projectRoot": project_root,
                    "error": error,
                })),
            );
            return;
        }
    };
    let project_items = list_project_switchable_items(
        ProjectSwitchableItemsInput {
            project_root: &project_root,
            current_path: Some(&project_root),
            current_window: None,
            current_window_id: None,
            scope: AgentListScope::All,
            live_launch_contexts: &live_launch_contexts,
            project_state_dir,
        },
        runtime,
        &captured_at,
        &mut capture_cache,
    );
    let mut snapshot_writes = vec![HotExposeScopeWrite {
        key: HotExposeScopeKey {
            project_root: project_root.clone(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        view: ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: project_items,
        },
    }];
    let keep_launch_window_ids = live_launch_contexts
        .iter()
        .map(|entry| entry.target.window_id.clone())
        .collect::<HashSet<_>>();
    for entry in live_launch_contexts
        .iter()
        .take(EXPOSE_HOT_SNAPSHOT_MAX_LAUNCH_CONTEXTS)
    {
        let worktree_path = entry
            .metadata
            .get("worktreePath")
            .and_then(Value::as_str)
            .map(normalize_hot_snapshot_path)
            .unwrap_or_else(|| project_root.clone());
        let worktree_items = list_project_switchable_items(
            ProjectSwitchableItemsInput {
                project_root: &project_root,
                current_path: Some(&worktree_path),
                current_window: Some(&entry.target.window_name),
                current_window_id: Some(&entry.target.window_id),
                scope: AgentListScope::Worktree,
                live_launch_contexts: &live_launch_contexts,
                project_state_dir,
            },
            runtime,
            &captured_at,
            &mut capture_cache,
        );
        snapshot_writes.push(HotExposeScopeWrite {
            key: HotExposeScopeKey {
                project_root: project_root.clone(),
                scope: ExposeScope::Worktree,
                worktree_key: Some(worktree_path),
                launch_window_id: Some(entry.target.window_id.clone()),
            },
            view: ExposeScopeView {
                scope: ExposeScope::Worktree,
                scope_label: "this worktree".into(),
                sublabel: ExposeSublabel::None,
                items: worktree_items,
            },
        });
    }
    write_hot_expose_scope_views(
        project_state_dir,
        &snapshot_writes,
        Some(&HotExposeScopePrune {
            project_root,
            scopes: Some(vec![ExposeScope::Worktree]),
            keep_launch_window_ids: Some(keep_launch_window_ids),
        }),
    );
}

pub fn build_global_expose_hot_snapshot_view(
    projects: &[ExposeHotSnapshotWorkerProject],
    mut project_state_dir_by_id: impl FnMut(&str) -> PathBuf,
) -> ExposeScopeView {
    let mut items = Vec::new();
    for project in projects {
        let project_root = normalize_hot_snapshot_path(&project.path);
        let project_view = read_hot_expose_scope_view(
            project_state_dir_by_id(&project.id),
            &HotExposeScopeKey {
                project_root: project_root.clone(),
                scope: ExposeScope::Project,
                worktree_key: None,
                launch_window_id: None,
            },
        );
        let Some(project_view) = project_view else {
            continue;
        };
        for item in project_view.items {
            items.push(global_item(item, project, &project_root));
        }
    }
    ExposeScopeView {
        scope: ExposeScope::Global,
        scope_label: "all projects".into(),
        sublabel: ExposeSublabel::ProjectWorktree,
        items,
    }
}

pub fn refresh_global_expose_hot_snapshots(
    projects: &[ExposeHotSnapshotWorkerProject],
    mut project_state_dir_by_id: impl FnMut(&str) -> PathBuf,
) {
    let active_projects = projects
        .iter()
        .filter(|project| project.service_alive)
        .cloned()
        .collect::<Vec<_>>();
    let view =
        build_global_expose_hot_snapshot_view(&active_projects, |id| project_state_dir_by_id(id));
    for project in active_projects {
        let project_root = normalize_hot_snapshot_path(&project.path);
        write_hot_expose_scope_views(
            project_state_dir_by_id(&project.id),
            &[HotExposeScopeWrite {
                key: HotExposeScopeKey {
                    project_root,
                    scope: ExposeScope::Global,
                    worktree_key: None,
                    launch_window_id: None,
                },
                view: view.clone(),
            }],
            None,
        );
    }
}

fn global_item(
    mut item: Value,
    project: &ExposeHotSnapshotWorkerProject,
    project_root: &str,
) -> Value {
    let Some(object) = item.as_object_mut() else {
        return item;
    };
    object.insert("projectId".into(), Value::String(project.id.clone()));
    object.insert("projectRoot".into(), Value::String(project_root.to_owned()));
    object.insert("projectName".into(), Value::String(project.name.clone()));
    item
}

struct ProjectSwitchableItemsInput<'a> {
    project_root: &'a str,
    current_path: Option<&'a str>,
    current_window: Option<&'a str>,
    current_window_id: Option<&'a str>,
    scope: AgentListScope,
    live_launch_contexts: &'a [TmuxManagedWindow],
    project_state_dir: &'a Path,
}

fn list_project_switchable_items(
    input: ProjectSwitchableItemsInput<'_>,
    runtime: &mut impl ProjectExposeHotSnapshotRuntime,
    captured_at: &str,
    capture_cache: &mut HashMap<String, Option<Value>>,
) -> Vec<Value> {
    let metadata = load_metadata_state(input.project_state_dir);
    let last_used = load_last_used_state(input.project_state_dir);
    let entries = input
        .live_launch_contexts
        .iter()
        .map(managed_window_entry)
        .collect::<Vec<_>>();
    let context = SwitchableContext {
        project_root: input.project_root.into(),
        current_path: input.current_path.map(str::to_owned),
        current_window: input.current_window.map(str::to_owned),
        current_window_id: input.current_window_id.map(str::to_owned),
        current_client_session: None,
    };
    let options = SwitchableListOptions {
        scope: input.scope,
        raw_labels: true,
        ..SwitchableListOptions::default()
    };
    list_switchable_agent_items(&entries, &metadata.sessions, &context, &options, &last_used)
        .into_iter()
        .map(|item| {
            let mut serialized = serialize_fast_control_item(&item);
            if let Some(object) = serialized.as_object_mut() {
                object.insert("alive".into(), Value::Bool(item.alive));
            }
            attach_captured_preview(&mut serialized, runtime, captured_at, capture_cache);
            serialized
        })
        .collect()
}

fn managed_window_entry(window: &TmuxManagedWindow) -> ManagedWindowEntry {
    ManagedWindowEntry {
        target: target_to_value(&window.target),
        metadata: window.metadata.clone(),
        alive: window.target.pane_dead != Some(true),
        activity: window.target.window_index,
    }
}

fn attach_captured_preview(
    item: &mut Value,
    runtime: &mut impl ProjectExposeHotSnapshotRuntime,
    captured_at: &str,
    capture_cache: &mut HashMap<String, Option<Value>>,
) {
    let Some(target) = item.get("target").and_then(tmux_target_from_value) else {
        return;
    };
    if !capture_cache.contains_key(&target.window_id) {
        let snapshot = runtime
            .capture_target(
                &target,
                CapturePaneOptions {
                    start_line: Some(-EXPOSE_PREVIEW_CAPTURE_LINES),
                    end_line: None,
                    include_escapes: true,
                },
            )
            .ok()
            .map(|output| {
                json!({
                    "output": output,
                    "capturedAt": captured_at,
                    "source": "capture",
                    "windowId": target.window_id,
                    "startLine": -EXPOSE_PREVIEW_CAPTURE_LINES,
                    "lineCount": EXPOSE_PREVIEW_CAPTURE_LINES,
                })
            });
        capture_cache.insert(target.window_id.clone(), snapshot);
    }
    let Some(snapshot) = capture_cache.get(&target.window_id).cloned().flatten() else {
        return;
    };
    let Some(object) = item.as_object_mut() else {
        return;
    };
    object.insert("previewSnapshot".into(), snapshot);
}

fn target_to_value(target: &TmuxTarget) -> Value {
    let mut object = Map::new();
    object.insert(
        "sessionName".into(),
        Value::String(target.session_name.clone()),
    );
    object.insert("windowId".into(), Value::String(target.window_id.clone()));
    object.insert("windowIndex".into(), Value::from(target.window_index));
    object.insert(
        "windowName".into(),
        Value::String(target.window_name.clone()),
    );
    if let Some(pane_dead) = target.pane_dead {
        object.insert("paneDead".into(), Value::Bool(pane_dead));
    }
    Value::Object(object)
}

fn tmux_target_from_value(value: &Value) -> Option<TmuxTarget> {
    Some(TmuxTarget {
        session_name: value.get("sessionName")?.as_str()?.to_owned(),
        window_id: value.get("windowId")?.as_str()?.to_owned(),
        window_index: value.get("windowIndex")?.as_i64()?,
        window_name: value.get("windowName")?.as_str()?.to_owned(),
        pane_dead: value.get("paneDead").and_then(Value::as_bool),
    })
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
