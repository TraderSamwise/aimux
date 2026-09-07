use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const DEFAULT_VERSION: &str = "0.0.0";
const DEFAULT_BUILD_PROFILE: &str = "full";
static VERSION_CONTRACT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn read_aimux_version_from_package_root(package_root: impl AsRef<Path>) -> String {
    let package_root = package_root.as_ref();
    if let Ok(version) = fs::read_to_string(package_root.join("VERSION")) {
        let version = version.trim();
        if !version.is_empty() {
            return version.to_owned();
        }
    }
    fs::read_to_string(package_root.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|package| {
            package
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| DEFAULT_VERSION.to_owned())
}

pub fn read_aimux_build_profile_from_package_root(package_root: impl AsRef<Path>) -> String {
    read_aimux_build_profile_from_package_root_with_env(
        package_root,
        std::env::var("AIMUX_BUILD_PROFILE").ok().as_deref(),
    )
}

pub fn read_aimux_build_profile_from_package_root_with_env(
    package_root: impl AsRef<Path>,
    env_build_profile: Option<&str>,
) -> String {
    if let Ok(profile) = fs::read_to_string(package_root.as_ref().join("BUILD_PROFILE"))
        && let Some(profile) = parse_aimux_build_profile(Some(&profile))
    {
        return profile.to_owned();
    }
    parse_aimux_build_profile(env_build_profile)
        .unwrap_or(DEFAULT_BUILD_PROFILE)
        .to_owned()
}

pub fn parse_aimux_build_profile(value: Option<&str>) -> Option<&'static str> {
    match value.map(str::trim) {
        Some("full") => Some("full"),
        Some("local") => Some("local"),
        _ => None,
    }
}

pub fn run_release_version_contract_case(input: &Value) -> Value {
    let temp = ContractTempDir::new();
    seed_files(temp.path(), input.get("files").unwrap_or(&Value::Null));
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "readAimuxVersionFromPackageRoot" => {
            Value::String(read_aimux_version_from_package_root(temp.path()))
        }
        "readAimuxBuildProfileFromPackageRoot" => {
            let env_profile = input.get("envBuildProfile").and_then(Value::as_str);
            Value::String(read_aimux_build_profile_from_package_root_with_env(
                temp.path(),
                env_profile,
            ))
        }
        api => Value::String(format!("unknown release version contract api: {api}")),
    }
}

fn seed_files(root: &Path, files: &Value) {
    let Some(files) = files.as_object() else {
        return;
    };
    for (name, contents) in files {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create version contract parent");
        }
        fs::write(path, contents.as_str().unwrap_or_default())
            .expect("write version contract file");
    }
}

struct ContractTempDir {
    path: PathBuf,
}

impl ContractTempDir {
    fn new() -> Self {
        let sequence = VERSION_CONTRACT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "aimux-version-rust-contract-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create version contract temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ContractTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
