use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AimuxCliLaunchSource {
    StableShim,
    CurrentEntry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AimuxCliLaunchCommand {
    pub command: String,
    pub args: Vec<String>,
    pub source: AimuxCliLaunchSource,
    pub current_entry_path: String,
    pub stable_shim_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct AimuxCliLaunchOptions {
    pub env: BTreeMap<String, String>,
    pub current_argv_entry: Option<String>,
    pub current_entry_path: Option<String>,
    pub home_dir: Option<PathBuf>,
}

pub fn get_aimux_stable_shim_path() -> String {
    get_aimux_stable_shim_path_from(&std_env(), home_dir())
}

pub fn get_aimux_stable_shim_path_from(
    env: &BTreeMap<String, String>,
    home_dir: PathBuf,
) -> String {
    env.get("AIMUX_CLI_BIN")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            home_dir
                .join(".local/bin/aimux")
                .to_string_lossy()
                .into_owned()
        })
}

pub fn get_aimux_daemon_launch_command(options: AimuxCliLaunchOptions) -> AimuxCliLaunchCommand {
    resolve_aimux_cli_launch_command(vec!["daemon".into(), "run".into()], options)
}

pub fn get_aimux_dashboard_launch_command(options: AimuxCliLaunchOptions) -> AimuxCliLaunchCommand {
    let args = dashboard_launch_args(&options.env);
    resolve_aimux_cli_launch_command(args, options)
}

pub fn get_aimux_project_service_launch_command(
    project_id: &str,
    project_root: &str,
    options: AimuxCliLaunchOptions,
) -> AimuxCliLaunchCommand {
    resolve_current_entry_launch_command(
        project_service_launch_args(project_id, project_root),
        options,
    )
}

pub fn get_aimux_current_cli_identity(options: AimuxCliLaunchOptions) -> AimuxCliLaunchCommand {
    resolve_aimux_cli_launch_command(Vec::new(), options)
}

pub fn resolve_aimux_cli_launch_command(
    args: Vec<String>,
    options: AimuxCliLaunchOptions,
) -> AimuxCliLaunchCommand {
    let env = options.env;
    let home_dir = options.home_dir.unwrap_or_else(home_dir);
    let stable_shim_path = get_aimux_stable_shim_path_from(&env, home_dir.clone());
    let current_entry_path = options
        .current_entry_path
        .unwrap_or_else(current_entry_path);
    if should_use_stable_shim(&ShouldUseStableShimInput {
        current_argv_entry: options.current_argv_entry.as_deref(),
        stable_shim_path: &stable_shim_path,
        env: &env,
        home_dir: &home_dir,
    }) {
        return AimuxCliLaunchCommand {
            command: stable_shim_path.clone(),
            args,
            source: AimuxCliLaunchSource::StableShim,
            current_entry_path,
            stable_shim_path,
        };
    }
    AimuxCliLaunchCommand {
        command: current_entry_path.clone(),
        args,
        source: AimuxCliLaunchSource::CurrentEntry,
        current_entry_path,
        stable_shim_path,
    }
}

fn resolve_current_entry_launch_command(
    args: Vec<String>,
    options: AimuxCliLaunchOptions,
) -> AimuxCliLaunchCommand {
    let env = options.env;
    let home_dir = options.home_dir.unwrap_or_else(home_dir);
    let stable_shim_path = get_aimux_stable_shim_path_from(&env, home_dir);
    let current_entry_path = options
        .current_entry_path
        .unwrap_or_else(current_entry_path);
    AimuxCliLaunchCommand {
        command: current_entry_path.clone(),
        args,
        source: AimuxCliLaunchSource::CurrentEntry,
        current_entry_path,
        stable_shim_path,
    }
}

fn project_service_launch_args(project_id: &str, project_root: &str) -> Vec<String> {
    vec![
        "__project-service-internal".into(),
        "--project-id".into(),
        project_id.into(),
        "--project-root".into(),
        project_root.into(),
    ]
}

fn dashboard_launch_args(env: &BTreeMap<String, String>) -> Vec<String> {
    if env
        .get("AIMUX_DASHBOARD_IMPLEMENTATION")
        .map(|value| value.trim())
        == Some("node")
    {
        vec!["--tmux-dashboard-internal".into()]
    } else {
        vec!["__dashboard-internal-native".into()]
    }
}

struct ShouldUseStableShimInput<'a> {
    current_argv_entry: Option<&'a str>,
    stable_shim_path: &'a str,
    env: &'a BTreeMap<String, String>,
    home_dir: &'a Path,
}

fn should_use_stable_shim(input: &ShouldUseStableShimInput<'_>) -> bool {
    if !file_exists(input.stable_shim_path) {
        return false;
    }
    let Some(current) = input
        .current_argv_entry
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if canonical_path(current) == canonical_path(input.stable_shim_path) {
        return true;
    }
    let native_root = input
        .env
        .get("AIMUX_INSTALL_ROOT")
        .map(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| input.home_dir.join(".aimux/native"));
    canonical_path(current).starts_with(&normalize_dir(native_root))
}

fn file_exists(path: impl AsRef<Path>) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn current_entry_path() -> String {
    std::env::current_exe()
        .or_else(|_| std::env::current_dir().map(|cwd| cwd.join("aimux")))
        .unwrap_or_else(|_| PathBuf::from("aimux"))
        .to_string_lossy()
        .into_owned()
}

fn normalize_dir(path: impl AsRef<Path>) -> String {
    let mut normalized = canonical_path(path);
    let separator = std::path::MAIN_SEPARATOR;
    if !normalized.ends_with(separator) {
        normalized.push(separator);
    }
    normalized
}

fn canonical_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    std::fs::canonicalize(path)
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

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn std_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}
