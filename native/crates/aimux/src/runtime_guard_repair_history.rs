use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

type History = BTreeMap<String, Vec<i64>>;

pub fn history_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref()
        .join("state")
        .join("runtime-guard-repair-attempts.json")
}

pub fn load_attempts(
    home: impl AsRef<Path>,
    project_root: &str,
    window_ms: i64,
    now: i64,
) -> Vec<i64> {
    let history = read_history(home);
    history
        .get(&key_for(project_root))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|at| now - at < window_ms)
        .collect()
}

pub fn record_attempt(
    home: impl AsRef<Path>,
    project_root: &str,
    window_ms: i64,
    now: i64,
) -> Vec<i64> {
    let home = home.as_ref();
    let mut history = read_history(home);
    let key = key_for(project_root);
    let mut kept = history
        .get(&key)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|at| now - at < window_ms)
        .collect::<Vec<_>>();
    kept.push(now);
    history.insert(key.clone(), kept.clone());
    let keys = history.keys().cloned().collect::<Vec<_>>();
    for other_key in keys {
        if other_key == key {
            continue;
        }
        let alive = history
            .get(&other_key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|at| now - at < window_ms)
            .collect::<Vec<_>>();
        if alive.is_empty() {
            history.remove(&other_key);
        } else {
            history.insert(other_key, alive);
        }
    }
    write_history(home, &history);
    kept
}

pub fn clear_attempts(home: impl AsRef<Path>, project_root: &str) {
    let home = home.as_ref();
    let mut history = read_history(home);
    history.remove(&key_for(project_root));
    write_history(home, &history);
}

fn read_history(home: impl AsRef<Path>) -> History {
    let Ok(text) = fs::read_to_string(history_path(home)) else {
        return History::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return History::new();
    };
    let Some(object) = value.as_object() else {
        return History::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            let attempts = value
                .as_array()?
                .iter()
                .filter_map(Value::as_i64)
                .collect::<Vec<_>>();
            Some((key.clone(), attempts))
        })
        .collect()
}

fn write_history(home: impl AsRef<Path>, history: &History) {
    let path = history_path(home);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(history) {
        let _ = fs::write(path, format!("{text}\n"));
    }
}

fn key_for(project_root: &str) -> String {
    normalize_path(project_root).to_string_lossy().into_owned()
}

fn normalize_path(path: &str) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}
