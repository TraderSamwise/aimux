use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use crate::atomic_write::write_text_atomic;

pub const RUNTIME_EXCHANGE_VERSION: u8 = 1;
const UPDATE_LOCK_TIMEOUT_MS: u64 = 5_000;
const UPDATE_LOCK_RETRY_MS: u64 = 25;
const UPDATE_LOCK_STALE_MS: u64 = UPDATE_LOCK_TIMEOUT_MS - 1_000;

pub fn runtime_exchange_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("runtime-exchange.yaml")
}

pub fn empty_runtime_exchange() -> Value {
    json!({
        "version": RUNTIME_EXCHANGE_VERSION,
        "generatedAt": now_iso(),
        "threads": [],
        "messages": [],
        "tasks": [],
        "handoffs": [],
        "reviews": [],
        "waits": [],
        "inbox": [],
        "planRefs": [],
        "continuityRefs": [],
        "attachmentRefs": [],
    })
}

pub fn read_runtime_exchange(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let Ok(contents) = fs::read_to_string(path) else {
        return empty_runtime_exchange();
    };
    let Ok(value) = serde_yaml::from_str::<Value>(&contents) else {
        return empty_runtime_exchange();
    };
    normalize_runtime_exchange(value).unwrap_or_else(|_| empty_runtime_exchange())
}

pub fn write_runtime_exchange(path: impl AsRef<Path>, exchange: &Value) -> std::io::Result<()> {
    let text = serialize_runtime_exchange(exchange);
    write_text_atomic(path, text)
}

pub fn update_runtime_exchange(
    path: impl AsRef<Path>,
    mutator: impl FnOnce(Value) -> Value,
) -> Result<Value, String> {
    let path = path.as_ref();
    let _lock = RuntimeExchangeLock::acquire(path)?;
    let current = read_runtime_exchange(path);
    let next = normalize_runtime_exchange(mutator(current))?;
    write_runtime_exchange(path, &next).map_err(|error| error.to_string())?;
    Ok(next)
}

pub fn normalize_runtime_exchange(value: Value) -> Result<Value, String> {
    let Some(record) = value.as_object() else {
        return Err("invalid runtime exchange: root must be an object".into());
    };
    if record.get("version").and_then(Value::as_u64) != Some(RUNTIME_EXCHANGE_VERSION as u64) {
        return Err(format!(
            "unsupported runtime exchange version: {}",
            record
                .get("version")
                .map(Value::to_string)
                .unwrap_or_else(|| "null".into())
        ));
    }
    let mut normalized = Map::new();
    normalized.insert("version".into(), Value::from(RUNTIME_EXCHANGE_VERSION));
    normalized.insert(
        "generatedAt".into(),
        required_string(record.get("generatedAt"), "generatedAt")?,
    );
    for key in [
        "threads",
        "messages",
        "tasks",
        "handoffs",
        "reviews",
        "waits",
        "inbox",
        "planRefs",
        "continuityRefs",
        "attachmentRefs",
    ] {
        normalized.insert(key.into(), array_value(record.get(key)));
    }
    Ok(Value::Object(normalized))
}

fn serialize_runtime_exchange(exchange: &Value) -> String {
    serde_yaml::to_string(exchange).unwrap_or_else(|_| "--- {}\n".into())
}

fn required_string(value: Option<&Value>, context: &str) -> Result<Value, String> {
    match value.and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(Value::String(value.to_owned())),
        _ => Err(format!(
            "invalid runtime exchange: {context} must be a non-empty string"
        )),
    }
}

fn array_value(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_array)
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

struct RuntimeExchangeLock {
    lock_path: PathBuf,
}

impl RuntimeExchangeLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let lock_path = PathBuf::from(format!("{}.lock", path.to_string_lossy()));
        let started = SystemTime::now();
        loop {
            match fs::create_dir(&lock_path) {
                Ok(()) => {
                    let owner = lock_path.join("owner");
                    if let Err(error) = fs::write(&owner, format!("{}\n", std::process::id())) {
                        let _ = fs::remove_dir_all(&lock_path);
                        return Err(error.to_string());
                    }
                    return Ok(Self { lock_path });
                }
                Err(error) => {
                    if recover_stale_update_lock(&lock_path) {
                        continue;
                    }
                    if started.elapsed().unwrap_or_default()
                        >= Duration::from_millis(UPDATE_LOCK_TIMEOUT_MS)
                    {
                        return Err(format!(
                            "Timed out acquiring runtime exchange update lock at {}: {error}",
                            lock_path.display()
                        ));
                    }
                    thread::sleep(Duration::from_millis(UPDATE_LOCK_RETRY_MS));
                }
            }
        }
    }
}

impl Drop for RuntimeExchangeLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.lock_path);
    }
}

fn recover_stale_update_lock(lock_path: &Path) -> bool {
    let owner_path = lock_path.join("owner");
    if let Ok(owner) = fs::read_to_string(&owner_path) {
        if let Ok(pid) = owner.trim().parse::<i32>()
            && pid > 0
        {
            if is_process_alive(pid) {
                return false;
            }
            let _ = fs::remove_dir_all(lock_path);
            return true;
        }
    } else if owner_path.exists() {
        return false;
    }

    if let Ok(metadata) = fs::metadata(lock_path)
        && let Ok(modified) = metadata.modified()
        && SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default()
            > Duration::from_millis(UPDATE_LOCK_STALE_MS)
    {
        let _ = fs::remove_dir_all(lock_path);
        return true;
    }
    false
}

fn is_process_alive(pid: i32) -> bool {
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
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
