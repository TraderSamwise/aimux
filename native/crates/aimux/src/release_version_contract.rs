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

pub fn read_aimux_runtime_version() -> String {
    read_aimux_runtime_version_from(
        std::env::var_os("AIMUX_ROOT").map(PathBuf::from),
        std::env::current_exe().ok(),
    )
}

pub fn read_aimux_runtime_version_from(
    aimux_root: Option<PathBuf>,
    executable_path: Option<PathBuf>,
) -> String {
    if let Some(executable_path) = executable_path
        && let Some(parent) = executable_path.parent()
    {
        for candidate in parent.ancestors() {
            if let Some(version) = read_non_default_version(candidate) {
                return version;
            }
        }
    }
    if let Some(root) = aimux_root
        && let Some(version) = read_non_default_version(root)
    {
        return version;
    }
    read_aimux_version_from_package_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn read_non_default_version(root: impl AsRef<Path>) -> Option<String> {
    let version = read_aimux_version_from_package_root(root);
    (version != DEFAULT_VERSION).then_some(version)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_version_finds_install_root_above_direct_native_binary() {
        let temp = ContractTempDir::new();
        fs::write(temp.path().join("VERSION"), "local-direct\n").expect("write version");
        let exe = temp.path().join("native/darwin-arm64/aimux");
        fs::create_dir_all(exe.parent().expect("exe parent")).expect("create native dir");
        fs::write(&exe, "").expect("write fake exe");

        assert_eq!(
            read_aimux_runtime_version_from(None, Some(exe)),
            "local-direct"
        );
    }

    #[test]
    fn runtime_version_prefers_running_executable_over_explicit_aimux_root() {
        let env_root = ContractTempDir::new();
        let exe_root = ContractTempDir::new();
        fs::write(env_root.path().join("VERSION"), "local-env\n").expect("write env version");
        fs::write(exe_root.path().join("VERSION"), "local-exe\n").expect("write exe version");
        let exe = exe_root.path().join("native/darwin-arm64/aimux");

        assert_eq!(
            read_aimux_runtime_version_from(Some(env_root.path().to_path_buf()), Some(exe)),
            "local-exe"
        );
    }
}
