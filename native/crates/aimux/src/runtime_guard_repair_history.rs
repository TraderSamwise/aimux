use std::collections::BTreeMap;
use std::fs;
use std::io;
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
) -> Result<Vec<i64>, String> {
    let history = read_history(home)?;
    Ok(history
        .get(&key_for(project_root))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|at| now - at < window_ms)
        .collect())
}

pub fn record_attempt(
    home: impl AsRef<Path>,
    project_root: &str,
    window_ms: i64,
    now: i64,
) -> Result<Vec<i64>, String> {
    let home = home.as_ref();
    let mut history = read_history(home)?;
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
    write_history(home, &history)?;
    Ok(kept)
}

pub fn clear_attempts(home: impl AsRef<Path>, project_root: &str) -> Result<(), String> {
    let home = home.as_ref();
    let mut history = read_history(home)?;
    history.remove(&key_for(project_root));
    write_history(home, &history)
}

fn read_history(home: impl AsRef<Path>) -> Result<History, String> {
    let path = history_path(home);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(History::new());
        }
        Err(error) => {
            return Err(format!(
                "could not read runtime guard repair history {}: {error}",
                path.display()
            ));
        }
    };
    let value = serde_json::from_str::<Value>(&text).map_err(|error| {
        format!(
            "could not parse runtime guard repair history {}: {error}",
            path.display()
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!(
            "runtime guard repair history {} must be a JSON object",
            path.display()
        )
    })?;
    let mut history = History::new();
    for (key, value) in object {
        let attempts = value.as_array().ok_or_else(|| {
            format!(
                "runtime guard repair history {} has non-array attempts for {key}",
                path.display()
            )
        })?;
        let mut parsed_attempts = Vec::with_capacity(attempts.len());
        for attempt in attempts {
            let Some(attempt) = attempt.as_i64() else {
                return Err(format!(
                    "runtime guard repair history {} has non-integer attempt for {key}",
                    path.display()
                ));
            };
            parsed_attempts.push(attempt);
        }
        history.insert(key.clone(), parsed_attempts);
    }
    Ok(history)
}

fn write_history(home: impl AsRef<Path>, history: &History) -> Result<(), String> {
    let path = history_path(home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "could not create runtime guard repair history directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let text = serde_json::to_string(history)
        .map_err(|error| format!("could not encode runtime guard repair history: {error}"))?;
    fs::write(&path, format!("{text}\n")).map_err(|error| {
        format!(
            "could not write runtime guard repair history {}: {error}",
            path.display()
        )
    })
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
