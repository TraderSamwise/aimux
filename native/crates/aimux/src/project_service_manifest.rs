use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

pub const PROJECT_SERVICE_API_VERSION: u32 = 5;
static PROJECT_SERVICE_BUILD_STAMP: OnceLock<Result<String, String>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceManifest {
    pub api_version: u32,
    pub capabilities: BTreeMap<String, bool>,
    pub build_stamp: String,
}

pub fn project_service_capabilities() -> BTreeMap<String, bool> {
    BTreeMap::from([
        ("parsedAgentOutput".into(), true),
        ("attachmentRead".into(), true),
        ("chatEventStream".into(), true),
        ("agentTranscriptMessages".into(), true),
        ("agentActivityState".into(), true),
    ])
}

pub fn resolve_artifact(
    compiled_path: impl AsRef<Path>,
    source_path: impl AsRef<Path>,
) -> io::Result<PathBuf> {
    let compiled_path = compiled_path.as_ref();
    if compiled_path.exists() {
        return Ok(compiled_path.to_path_buf());
    }
    let source_path = source_path.as_ref();
    if source_path.exists() {
        return Ok(source_path.to_path_buf());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "unable to locate project service build artifact: {}",
            compiled_path.display()
        ),
    ))
}

pub fn compute_build_stamp(artifact_paths: &[PathBuf]) -> io::Result<String> {
    let mut hash = Sha1::new();
    let mut mtimes = Vec::with_capacity(artifact_paths.len());
    for path in artifact_paths {
        let metadata = fs::metadata(path)?;
        hash.update(fs::read(path)?);
        let modified = metadata.modified()?;
        let millis = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        mtimes.push((millis / 1000) * 1000);
    }
    let digest = format!("{:x}", hash.finalize());
    Ok(format!(
        "{}-{}",
        mtimes
            .iter()
            .map(u128::to_string)
            .collect::<Vec<_>>()
            .join("."),
        &digest[..12]
    ))
}

pub fn project_service_artifact_paths(module_dir: impl AsRef<Path>) -> io::Result<Vec<PathBuf>> {
    let candidates = runtime_native_artifact_candidates();
    match project_service_source_artifact_paths(module_dir) {
        Ok(paths) => Ok(paths),
        Err(source_error) => candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
            .map(|candidate| vec![candidate])
            .ok_or(source_error),
    }
}

pub fn project_service_artifact_paths_with_native_candidates(
    module_dir: impl AsRef<Path>,
    native_candidates: &[PathBuf],
) -> io::Result<Vec<PathBuf>> {
    for candidate in native_candidates {
        if candidate.is_file() {
            return Ok(vec![candidate.clone()]);
        }
    }
    project_service_source_artifact_paths(module_dir)
}

pub fn project_service_build_stamp_with_release_root(
    module_dir: impl AsRef<Path>,
    release_root: Option<&Path>,
    native_candidates: &[PathBuf],
) -> io::Result<String> {
    if let Some(stamp) = release_root.and_then(read_release_build_stamp) {
        return Ok(stamp);
    }
    compute_build_stamp(&project_service_artifact_paths_with_native_candidates(
        module_dir,
        native_candidates,
    )?)
}

fn read_release_build_stamp(release_root: &Path) -> Option<String> {
    let stamp = fs::read_to_string(release_root.join("BUILD_STAMP")).ok()?;
    let stamp = stamp.trim();
    (!stamp.is_empty()).then(|| stamp.to_owned())
}

fn project_service_source_artifact_paths(module_dir: impl AsRef<Path>) -> io::Result<Vec<PathBuf>> {
    let module_dir = module_dir.as_ref();
    Ok(vec![
        resolve_artifact(
            module_dir.join("launcher-bin.js"),
            module_dir.join("launcher-bin.ts"),
        )?,
        resolve_artifact(module_dir.join("main.js"), module_dir.join("main.ts"))?,
    ])
}

fn runtime_native_artifact_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("AIMUX_NATIVE_BIN")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        candidates.push(path);
    }
    if let Ok(path) = std::env::current_exe()
        && path.file_name().and_then(|value| value.to_str()) == Some("aimux")
    {
        candidates.push(path);
    }
    if let Ok(path) = std::env::current_exe()
        && let Some(profile_dir) = path.parent().and_then(|deps_dir| deps_dir.parent())
        && path.parent().and_then(|deps_dir| deps_dir.file_name())
            == Some(std::ffi::OsStr::new("deps"))
    {
        candidates.push(profile_dir.join("aimux"));
    }
    if let Some(root) = std::env::var_os("AIMUX_ROOT")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        candidates.push(
            root.join("native")
                .join(platform_native_dirname())
                .join("aimux"),
        );
    }
    candidates
}

fn runtime_release_root() -> Option<PathBuf> {
    std::env::var_os("AIMUX_ROOT")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn platform_native_dirname() -> String {
    format!(
        "{}-{}",
        match std::env::consts::OS {
            "macos" => "darwin",
            value => value,
        },
        match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            value => value,
        }
    )
}

pub fn compute_project_service_build_stamp(module_dir: impl AsRef<Path>) -> io::Result<String> {
    compute_build_stamp(&project_service_artifact_paths(module_dir)?)
}

pub fn source_project_service_module_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../src")
}

pub fn get_project_service_manifest() -> io::Result<ProjectServiceManifest> {
    Ok(ProjectServiceManifest {
        api_version: PROJECT_SERVICE_API_VERSION,
        capabilities: project_service_capabilities(),
        build_stamp: project_service_build_stamp()?,
    })
}

pub fn compute_current_project_service_manifest() -> io::Result<ProjectServiceManifest> {
    let release_root = runtime_release_root();
    Ok(ProjectServiceManifest {
        api_version: PROJECT_SERVICE_API_VERSION,
        capabilities: project_service_capabilities(),
        build_stamp: project_service_build_stamp_with_release_root(
            source_project_service_module_dir(),
            release_root.as_deref(),
            &runtime_native_artifact_candidates(),
        )?,
    })
}

pub fn project_service_build_stamp() -> io::Result<String> {
    PROJECT_SERVICE_BUILD_STAMP
        .get_or_init(|| {
            let release_root = runtime_release_root();
            project_service_build_stamp_with_release_root(
                source_project_service_module_dir(),
                release_root.as_deref(),
                &runtime_native_artifact_candidates(),
            )
            .map_err(|error| error.to_string())
        })
        .clone()
        .map_err(|message| io::Error::other(message.clone()))
}

pub fn has_project_service_build_drift() -> bool {
    match (
        project_service_build_stamp(),
        compute_current_project_service_manifest(),
    ) {
        (Ok(initial), Ok(current)) => current.build_stamp != initial,
        _ => false,
    }
}

pub fn manifests_match(expected: &ProjectServiceManifest, actual: Option<&Value>) -> bool {
    let Some(actual) = actual.and_then(Value::as_object) else {
        return false;
    };
    let api_version = actual.get("apiVersion").and_then(js_number).unwrap_or(0.0);
    if api_version != f64::from(expected.api_version) {
        return false;
    }
    let actual_build_stamp = actual
        .get("buildStamp")
        .filter(js_truthy)
        .map(js_string)
        .unwrap_or_default();
    if actual_build_stamp != expected.build_stamp {
        return false;
    }
    let capabilities = actual.get("capabilities").and_then(Value::as_object);
    expected.capabilities.iter().all(|(key, value)| {
        capabilities
            .and_then(|capabilities| capabilities.get(key))
            .and_then(Value::as_bool)
            == Some(*value)
    })
}

pub fn build_stamp_generation(stamp: Option<&Value>) -> Option<u64> {
    let stamp = js_string_for_nullish(stamp);
    let lead = stamp.split('.').next()?;
    let value = lead.parse::<f64>().ok()?;
    (value.is_finite() && value > 0.0).then_some(value as u64)
}

pub fn is_stale_against_daemon(daemon_stamp: Option<&Value>, own_stamp: Option<&Value>) -> bool {
    match (
        build_stamp_generation(daemon_stamp),
        build_stamp_generation(own_stamp),
    ) {
        (Some(daemon), Some(own)) => daemon > own,
        _ => false,
    }
}

pub fn should_keep_unresponsive_daemon(
    adopt_existing: Option<bool>,
    daemon_pid_alive: bool,
) -> bool {
    adopt_existing != Some(false) && daemon_pid_alive
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.trim().parse().ok(),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) | Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn js_truthy(value: &&Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_string_for_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}
