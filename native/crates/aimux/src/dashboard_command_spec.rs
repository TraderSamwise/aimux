use crate::cli_launcher::{
    AimuxCliLaunchOptions, AimuxCliLaunchSource, get_aimux_dashboard_launch_command,
};
use crate::launcher_env::{DEFAULT_DAEMON_PORT, DEFAULT_ENV, DEFAULT_WEB_APP_URL};
use crate::tmux::TmuxCommandSpec;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const DASHBOARD_ENV_KEYS: &[&str] = &[
    "AIMUX_HOME",
    "AIMUX_DAEMON_HOST",
    "AIMUX_DAEMON_PORT",
    "AIMUX_ENV",
    "AIMUX_WEB_APP_URL",
    "AIMUX_CLI_BIN",
    "AIMUX_INSTALL_ROOT",
    "AIMUX_DASHBOARD_IMPLEMENTATION",
];
const STABLE_SHIM_ENV_KEYS: &[&str] = &["AIMUX_CLI_BIN", "AIMUX_INSTALL_ROOT"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardCommandSpec {
    pub script_path: String,
    pub dashboard_build_stamp: String,
    pub dashboard_command: TmuxCommandSpec,
}

#[derive(Debug, Clone)]
pub struct DashboardCommandSpecOptions {
    pub env: BTreeMap<String, String>,
    pub script_path: PathBuf,
    pub implementation_path: PathBuf,
    pub home_dir: PathBuf,
    pub platform: String,
    pub arch: String,
}

impl Default for DashboardCommandSpecOptions {
    fn default() -> Self {
        let script_path = env::current_exe().unwrap_or_else(|_| PathBuf::from("aimux"));
        Self {
            env: env::vars().collect(),
            implementation_path: script_path.clone(),
            script_path,
            home_dir: env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
            platform: node_platform(env::consts::OS).to_owned(),
            arch: node_arch(env::consts::ARCH).to_owned(),
        }
    }
}

pub fn get_dashboard_command_spec(project_root: &str) -> io::Result<DashboardCommandSpec> {
    get_dashboard_command_spec_with_options(project_root, DashboardCommandSpecOptions::default())
}

pub fn get_dashboard_command_spec_with_options(
    project_root: &str,
    options: DashboardCommandSpecOptions,
) -> io::Result<DashboardCommandSpec> {
    let script_path = path_text(&options.script_path);
    let launch = get_aimux_dashboard_launch_command(AimuxCliLaunchOptions {
        env: options.env.clone(),
        current_argv_entry: Some(script_path.clone()),
        current_entry_path: Some(script_path.clone()),
        home_dir: Some(options.home_dir.clone()),
    });
    let artifact_paths = if launch.source == AimuxCliLaunchSource::StableShim {
        resolve_stable_shim_artifact_paths(
            Path::new(&launch.stable_shim_path),
            &options.platform,
            &options.arch,
        )
        .unwrap_or_else(|| {
            vec![
                options.script_path.clone(),
                options.implementation_path.clone(),
            ]
        })
    } else {
        vec![
            options.script_path.clone(),
            options.implementation_path.clone(),
        ]
    };
    let aimux_command = std::iter::once(launch.command.as_str())
        .chain(launch.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let unset_keys = if launch.source == AimuxCliLaunchSource::CurrentEntry {
        STABLE_SHIM_ENV_KEYS
    } else {
        &[]
    };
    let dashboard_entrypoint = format!(
        "{}{}",
        build_dashboard_env_command_prefix(&options.env, false, unset_keys, &options.home_dir),
        aimux_command
    );
    let dashboard_stamp_entrypoint = format!(
        "{}{}",
        build_dashboard_env_command_prefix(&options.env, true, unset_keys, &options.home_dir),
        aimux_command
    );
    let wrapped_dashboard_command = build_wrapped_dashboard_command(&dashboard_entrypoint);
    let stamp_command =
        wrapped_dashboard_command.replacen(&dashboard_entrypoint, &dashboard_stamp_entrypoint, 1);

    Ok(DashboardCommandSpec {
        script_path,
        dashboard_build_stamp: build_dashboard_stamp(&artifact_paths, &stamp_command)?,
        dashboard_command: TmuxCommandSpec {
            cwd: project_root.to_owned(),
            command: "bash".to_owned(),
            args: vec!["-lc".to_owned(), wrapped_dashboard_command],
        },
    })
}

fn resolve_stable_shim_artifact_paths(
    stable_shim_path: &Path,
    platform: &str,
    arch: &str,
) -> Option<Vec<PathBuf>> {
    let real_shim_path = stable_shim_path.canonicalize().ok()?;
    if real_shim_path.file_name()?.to_str()? != "aimux"
        || real_shim_path.parent()?.file_name()?.to_str()? != "bin"
    {
        return None;
    }
    let install_root = real_shim_path.parent()?.parent()?;
    let mut artifact_paths = vec![
        install_root.join("dist/launcher-bin.js"),
        install_root.join("dist/main.js"),
    ];
    if !artifact_paths.iter().all(|path| path.exists()) {
        return None;
    }
    let native_artifact_path = install_root
        .join("native")
        .join(format!("{platform}-{arch}"))
        .join("aimux");
    if native_artifact_path.exists() {
        artifact_paths.push(native_artifact_path);
    }
    Some(artifact_paths)
}

fn build_dashboard_env_command_prefix(
    env: &BTreeMap<String, String>,
    for_stamp: bool,
    unset_keys: &[&str],
    home_dir: &Path,
) -> String {
    let mut args = unset_keys
        .iter()
        .map(|key| format!("-u {}", shell_quote(key)))
        .collect::<Vec<_>>();
    for key in DASHBOARD_ENV_KEYS {
        if unset_keys.contains(key) {
            continue;
        }
        let Some(value) = env.get(*key).map(|value| value.trim()) else {
            continue;
        };
        if value.is_empty() || (for_stamp && is_dashboard_env_stamp_default(key, value, home_dir)) {
            continue;
        }
        args.push(format!("{key}={}", shell_quote(value)));
    }
    if args.is_empty() {
        String::new()
    } else {
        format!("env {} ", args.join(" "))
    }
}

fn is_dashboard_env_stamp_default(key: &str, value: &str, home_dir: &Path) -> bool {
    match key {
        "AIMUX_HOME" => value == path_text(&home_dir.join(".aimux")),
        "AIMUX_DAEMON_PORT" => value == DEFAULT_DAEMON_PORT,
        "AIMUX_ENV" => value == DEFAULT_ENV,
        "AIMUX_WEB_APP_URL" => value == DEFAULT_WEB_APP_URL,
        _ => false,
    }
}

fn build_dashboard_stamp(artifact_paths: &[PathBuf], command: &str) -> io::Result<String> {
    let mut artifact_hash = Sha256::new();
    let mut seen = BTreeSet::new();
    for path in artifact_paths {
        let path_text = path_text(path);
        if !seen.insert(path_text.clone()) {
            continue;
        }
        let metadata = fs::metadata(path)?;
        let modified_ms = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        artifact_hash.update(format!("{path_text}:{modified_ms}:").as_bytes());
        artifact_hash.update(fs::read(path)?);
    }
    let command_hash = Sha256::digest(command.as_bytes());
    Ok(format!(
        "{}-{}",
        hex_prefix(artifact_hash.finalize().as_slice(), 16),
        hex_prefix(command_hash.as_slice(), 16)
    ))
}

fn build_wrapped_dashboard_command(dashboard_entrypoint: &str) -> String {
    let startup_prelude = [
        "printf".to_owned(),
        shell_quote("\n%s\n%s\n"),
        shell_quote("Starting Aimux dashboard..."),
        shell_quote("Loading local control plane."),
    ]
    .join(" ");
    [
        "output_file=$(mktemp /tmp/aimux-dashboard-output.XXXXXX)".to_owned(),
        ";".to_owned(),
        "trap 'rm -f \"$output_file\"' EXIT".to_owned(),
        ";".to_owned(),
        "trap 'rm -f \"$output_file\"; exit 130' INT TERM HUP".to_owned(),
        ";".to_owned(),
        "set -o pipefail".to_owned(),
        ";".to_owned(),
        startup_prelude,
        ";".to_owned(),
        dashboard_entrypoint.to_owned(),
        "2>&1".to_owned(),
        "|".to_owned(),
        "tee".to_owned(),
        "\"$output_file\"".to_owned(),
        ";".to_owned(),
        "code=$?".to_owned(),
        ";".to_owned(),
        "if".to_owned(),
        "[".to_owned(),
        "$code".to_owned(),
        "-ne".to_owned(),
        "0".to_owned(),
        "]".to_owned(),
        ";".to_owned(),
        "then".to_owned(),
        "printf".to_owned(),
        "'\\033[?1049l\\033[H\\033[2J'".to_owned(),
        ";".to_owned(),
        "if".to_owned(),
        "[".to_owned(),
        "-s".to_owned(),
        "\"$output_file\"".to_owned(),
        "]".to_owned(),
        ";".to_owned(),
        "then".to_owned(),
        "cat".to_owned(),
        "\"$output_file\"".to_owned(),
        ";".to_owned(),
        "else".to_owned(),
        "printf".to_owned(),
        shell_quote("%s\\n"),
        shell_quote("No dashboard stderr/stdout was captured."),
        ";".to_owned(),
        "fi".to_owned(),
        ";".to_owned(),
        "printf".to_owned(),
        shell_quote("%s\\n"),
        shell_quote(""),
        ";".to_owned(),
        "printf".to_owned(),
        shell_quote("%s\\n%s\\n%s\\n%s\\n%s\\n"),
        shell_quote("aimux dashboard failed to start."),
        shell_quote("The error above was captured from the dashboard process."),
        shell_quote(
            "If that output is empty, rerun aimux with --debug to record the next attempt.",
        ),
        shell_quote("Press q, Enter, or Ctrl+C to close this pane."),
        shell_quote(""),
        ";".to_owned(),
        "printf".to_owned(),
        shell_quote("%s\\n"),
        "\"exit code: $code\"".to_owned(),
        ";".to_owned(),
        "while".to_owned(),
        "IFS= read -rsn1 key".to_owned(),
        ";".to_owned(),
        "do".to_owned(),
        "if".to_owned(),
        "[".to_owned(),
        "-z".to_owned(),
        "\"$key\"".to_owned(),
        "]".to_owned(),
        "||".to_owned(),
        "[".to_owned(),
        "\"$key\"".to_owned(),
        "=".to_owned(),
        shell_quote("q"),
        "]".to_owned(),
        ";".to_owned(),
        "then".to_owned(),
        "exit 0".to_owned(),
        ";".to_owned(),
        "fi".to_owned(),
        ";".to_owned(),
        "done".to_owned(),
        ";".to_owned(),
        "fi".to_owned(),
    ]
    .join(" ")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut value, "{byte:02x}").expect("writing to a string cannot fail");
    }
    value.truncate(length);
    value
}

fn node_platform(platform: &str) -> &str {
    match platform {
        "macos" => "darwin",
        value => value,
    }
}

fn node_arch(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    }
}
