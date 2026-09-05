use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::load_config_for_project;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::router::ProjectServiceRequestContext;

const DEFAULT_CACHE_DIR_NAMES: &[&str] = &["node_modules", ".next"];
const ALLOWED_CACHE_DIR_NAMES: &[&str] = &["node_modules", ".next", ".turbo"];

pub fn run_worktree_cache_cleanup(
    context: &ProjectServiceRequestContext,
    body: &Value,
    main_repo: &str,
) -> Result<Value, String> {
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    let config = load_config_for_project(context.project_root());
    let project_root = canonical_string(context.project_root());
    let dry_run = body.get("dryRun").and_then(Value::as_bool) != Some(false);
    let include_active = body.get("includeActive").and_then(Value::as_bool) == Some(true);
    let cache_dir_names = normalize_cache_dir_names(
        config
            .get("worktrees")
            .and_then(|worktrees| worktrees.get("cacheCleanupDirs")),
    );
    let aimux_worktree_root = canonical_string(worktree_base_dir(&config, main_repo));
    let active = active_runtime_by_worktree(&topology);
    let mut targets = Vec::new();
    let mut skipped = Vec::new();

    for worktree in array_field(&topology, "worktrees") {
        let Some(path) = string_field(&worktree, "path") else {
            continue;
        };
        let worktree_path = canonical_string(path);
        if worktree_path == project_root {
            skipped.push(json!({ "worktreePath": worktree_path, "reason": "main-worktree" }));
            continue;
        }
        if !is_inside(&aimux_worktree_root, &worktree_path) {
            skipped.push(
                json!({ "worktreePath": worktree_path, "reason": "outside-aimux-worktrees" }),
            );
            continue;
        }
        if let Some(active_entry) = active.get(&worktree_path)
            && !include_active
        {
            skipped.push(json!({
                "worktreePath": worktree_path,
                "reason": "active-runtime",
                "sessions": active_entry.sessions.iter().cloned().collect::<Vec<_>>(),
                "services": active_entry.services.iter().cloned().collect::<Vec<_>>(),
            }));
            continue;
        }
        for (path, relative_path) in list_cache_targets(&worktree_path, &cache_dir_names) {
            if !Path::new(&path).exists() {
                continue;
            }
            let size_bytes = directory_size(&path);
            targets.push(json!({
                "worktreePath": worktree_path,
                "relativePath": relative_path,
                "path": path,
                "sizeBytes": size_bytes,
            }));
        }
    }

    let reclaimable_bytes = targets
        .iter()
        .filter_map(|target| target.get("sizeBytes").and_then(Value::as_u64))
        .sum::<u64>();
    let plan = json!({
        "projectRoot": project_root,
        "dryRun": dry_run,
        "includeActive": include_active,
        "cacheDirNames": cache_dir_names,
        "targets": targets,
        "skipped": skipped,
        "reclaimableBytes": reclaimable_bytes,
    });
    let mut results = Vec::new();
    let mut reclaimed_bytes = 0u64;
    for target in plan
        .get("targets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let path = string_field(&target, "path").unwrap_or_default().to_owned();
        let size_bytes = target.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0);
        if dry_run {
            results.push(json!({ "path": path, "status": "dry-run", "sizeBytes": size_bytes }));
            continue;
        }
        if !is_removable_cache_target(&target, &cache_dir_names) {
            results.push(json!({
                "path": path,
                "status": "failed",
                "sizeBytes": size_bytes,
                "error": "planned cache target failed final safety validation",
            }));
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                reclaimed_bytes += size_bytes;
                results.push(json!({ "path": path, "status": "removed", "sizeBytes": size_bytes }));
            }
            Err(error) => {
                results.push(json!({
                    "path": path,
                    "status": "failed",
                    "sizeBytes": size_bytes,
                    "error": error.to_string(),
                }));
            }
        }
    }

    Ok(json!({
        "dryRun": dry_run,
        "plan": plan,
        "results": results,
        "reclaimedBytes": reclaimed_bytes,
    }))
}

#[derive(Default)]
struct ActiveRuntime {
    sessions: BTreeSet<String>,
    services: BTreeSet<String>,
}

fn active_runtime_by_worktree(topology: &Value) -> BTreeMap<String, ActiveRuntime> {
    let mut active = BTreeMap::new();
    for session in array_field(topology, "sessions") {
        if matches!(
            string_field(&session, "status"),
            Some("starting" | "running" | "idle")
        ) {
            add_active(
                &mut active,
                string_field(&session, "worktreePath"),
                "sessions",
                string_field(&session, "id"),
            );
        }
    }
    for service in array_field(topology, "services") {
        if matches!(
            string_field(&service, "status"),
            Some("starting" | "running")
        ) {
            add_active(
                &mut active,
                string_field(&service, "worktreePath"),
                "services",
                string_field(&service, "id"),
            );
        }
    }
    active
}

fn add_active(
    active: &mut BTreeMap<String, ActiveRuntime>,
    worktree_path: Option<&str>,
    kind: &str,
    id: Option<&str>,
) {
    let (Some(worktree_path), Some(id)) = (worktree_path, id) else {
        return;
    };
    let entry = active.entry(canonical_string(worktree_path)).or_default();
    if kind == "sessions" {
        entry.sessions.insert(id.to_owned());
    } else {
        entry.services.insert(id.to_owned());
    }
}

fn normalize_cache_dir_names(value: Option<&Value>) -> Vec<String> {
    let source = value
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            DEFAULT_CACHE_DIR_NAMES
                .iter()
                .map(|name| json!(name))
                .collect()
        });
    let mut names = Vec::new();
    for item in source {
        let Some(name) = item.as_str().map(str::trim) else {
            continue;
        };
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
            || !ALLOWED_CACHE_DIR_NAMES.contains(&name)
            || names.iter().any(|existing| existing == name)
        {
            continue;
        }
        names.push(name.to_owned());
    }
    names
}

fn worktree_base_dir(config: &Value, main_repo: &str) -> PathBuf {
    let base_dir = config
        .get("worktrees")
        .and_then(|worktrees| worktrees.get("baseDir"))
        .and_then(Value::as_str)
        .unwrap_or(".aimux/worktrees");
    let path = PathBuf::from(base_dir);
    if path.is_absolute() {
        path
    } else {
        Path::new(main_repo).join(path)
    }
}

fn list_cache_targets(worktree_path: &str, cache_dir_names: &[String]) -> Vec<(String, String)> {
    let names = cache_dir_names
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut targets = Vec::new();
    let mut stack = vec![PathBuf::from(worktree_path)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let child = entry.path();
            let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_real_directory(&child) {
                continue;
            }
            if names.contains(name) {
                let relative_path = child
                    .strip_prefix(worktree_path)
                    .ok()
                    .and_then(|path| path.to_str())
                    .filter(|path| !path.is_empty())
                    .unwrap_or(name)
                    .to_owned();
                targets.push((child.to_string_lossy().into_owned(), relative_path));
                continue;
            }
            if name != ".git" {
                stack.push(child);
            }
        }
    }
    targets
}

fn directory_size(path: &str) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![PathBuf::from(path)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&child) else {
                continue;
            };
            total = total.saturating_add(metadata.len());
            if metadata.is_dir() {
                stack.push(child);
            }
        }
    }
    total
}

fn is_removable_cache_target(target: &Value, cache_dir_names: &[String]) -> bool {
    let Some(path) = string_field(target, "path") else {
        return false;
    };
    let Some(worktree_path) = string_field(target, "worktreePath") else {
        return false;
    };
    let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    cache_dir_names.iter().any(|allowed| allowed == name)
        && is_inside(&canonical_string(worktree_path), &canonical_string(path))
        && is_real_directory(path)
}

fn is_real_directory(path: impl AsRef<Path>) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_inside(parent: &str, child: &str) -> bool {
    Path::new(child).starts_with(parent)
}

fn canonical_string(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    path.canonicalize()
        .unwrap_or_else(|_| {
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        })
        .to_string_lossy()
        .into_owned()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
