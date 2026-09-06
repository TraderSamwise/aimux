use crate::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use crate::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, HotExposeScopeWrite, normalize_hot_snapshot_path,
    read_hot_expose_scope_view, write_hot_expose_scope_views,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeHotSnapshotWorkerProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub service_alive: bool,
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
