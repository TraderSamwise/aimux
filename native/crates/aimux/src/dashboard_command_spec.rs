use crate::cli_launcher::{
    AimuxCliLaunchOptions, AimuxCliLaunchSource, get_aimux_dashboard_launch_command,
};
use crate::launcher_env::{DEFAULT_DAEMON_PORT, DEFAULT_ENV, DEFAULT_WEB_APP_URL};
use crate::tmux::TmuxCommandSpec;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

const DASHBOARD_ENV_KEYS: &[&str] = &[
    "AIMUX_HOME",
    "AIMUX_DAEMON_HOST",
    "AIMUX_DAEMON_PORT",
    "AIMUX_ENV",
    "AIMUX_WEB_APP_URL",
    "AIMUX_CLI_BIN",
    "AIMUX_INSTALL_ROOT",
];
const DASHBOARD_INHERITED_ENV_UNSET_KEYS: &[&str] = &["AIMUX_ROOT"];
const STABLE_SHIM_ENV_KEYS: &[&str] = &["AIMUX_CLI_BIN", "AIMUX_INSTALL_ROOT"];
const CONTRACT_NODE_EXEC_PATH: &str = "/opt/homebrew/Cellar/node/25.8.1_1/bin/node";
const CONTRACT_HOME_DIR: &str = "/Users/sam";

static CONTRACT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    pub process_exec_path: String,
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
            process_exec_path: script_path.to_string_lossy().into_owned(),
            script_path,
            home_dir: env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
            platform: native_platform(env::consts::OS).to_owned(),
            arch: native_arch(env::consts::ARCH).to_owned(),
        }
    }
}

pub fn get_dashboard_command_spec(project_root: &str) -> io::Result<DashboardCommandSpec> {
    let mut options = DashboardCommandSpecOptions::default();
    options
        .env
        .entry("AIMUX_DASHBOARD_IMPLEMENTATION".to_owned())
        .or_insert_with(|| "native".to_owned());
    get_dashboard_command_spec_with_options(project_root, options)
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
        process_exec_path: Some(options.process_exec_path.clone()),
        home_dir: Some(options.home_dir.clone()),
    });
    let artifact_paths = match launch.source {
        AimuxCliLaunchSource::NativeBinary => vec![PathBuf::from(&launch.command)],
        AimuxCliLaunchSource::StableShim => resolve_stable_shim_artifact_paths(
            Path::new(&launch.stable_shim_path),
            &options.platform,
            &options.arch,
        )
        .unwrap_or_else(|| {
            vec![
                options.script_path.clone(),
                options.implementation_path.clone(),
            ]
        }),
        AimuxCliLaunchSource::CurrentEntry => vec![
            options.script_path.clone(),
            options.implementation_path.clone(),
        ],
    };
    let aimux_command = std::iter::once(launch.command.as_str())
        .chain(launch.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let unset_keys = dashboard_unset_env_keys(launch.source == AimuxCliLaunchSource::CurrentEntry);
    let dashboard_entrypoint = format!(
        "{}{}",
        build_dashboard_env_command_prefix(&options.env, false, &unset_keys, &options.home_dir),
        aimux_command
    );
    let dashboard_stamp_entrypoint = format!(
        "{}{}",
        build_dashboard_env_command_prefix(&options.env, true, &unset_keys, &options.home_dir),
        aimux_command
    );
    let native_dashboard = launch
        .args
        .iter()
        .any(|arg| arg == "__dashboard-internal-native");
    let wrapped_dashboard_command = if native_dashboard {
        dashboard_entrypoint.clone()
    } else {
        build_wrapped_dashboard_command(&dashboard_entrypoint)
    };
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

pub fn run_dashboard_command_spec_contract_case(name: &str, input: &Value) -> Value {
    let mut envs = if let Some(values) = input.get("envs").and_then(Value::as_array) {
        values.to_vec()
    } else if input.get("envPreparedBy").and_then(Value::as_str) == Some("prepareStableCliEnv") {
        vec![
            json!({}),
            json!({
                "AIMUX_HOME": "/Users/sam/.aimux",
                "AIMUX_DAEMON_PORT": DEFAULT_DAEMON_PORT,
                "AIMUX_ENV": DEFAULT_ENV,
                "AIMUX_WEB_APP_URL": DEFAULT_WEB_APP_URL,
            }),
        ]
    } else {
        vec![input.get("env").cloned().unwrap_or_else(|| json!({}))]
    };
    if matches!(
        name,
        "stable shim launch stamp follows install root"
            | "stable shim launch stamp follows native binary bytes"
    ) && envs.len() == 1
    {
        envs.push(envs[0].clone());
    }
    let temp = ContractTempDir::new();
    let repo_root = temp.0.join("repo");
    let script_path = repo_root.join("dist/launcher-bin.js");
    let implementation_path = repo_root.join("dist/main.js");
    fs::create_dir_all(script_path.parent().expect("contract dist parent"))
        .expect("create contract dist");
    fs::write(&script_path, "launcher-one").expect("write contract launcher");
    fs::write(&implementation_path, "main-one").expect("write contract implementation");

    if name == "stable shim launch stamp follows install root"
        || name == "stable shim launch stamp follows native binary bytes"
    {
        seed_contract_stable_shim(&temp.0);
    }

    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("/tmp/repo");
    let mut outputs = envs
        .iter()
        .map(|env| {
            let spec = get_dashboard_command_spec_with_options(
                project_root,
                DashboardCommandSpecOptions {
                    env: contract_env(env, &repo_root, &temp.0),
                    script_path: script_path.clone(),
                    implementation_path: implementation_path.clone(),
                    process_exec_path: CONTRACT_NODE_EXEC_PATH.to_owned(),
                    home_dir: PathBuf::from(CONTRACT_HOME_DIR),
                    platform: native_platform(env::consts::OS).to_owned(),
                    arch: native_arch(env::consts::ARCH).to_owned(),
                },
            )
            .expect("build dashboard command spec contract output");
            summarize_dashboard_spec(&spec, &repo_root, &temp.0)
        })
        .collect::<Vec<_>>();

    match name {
        "environment change alters build stamp" => paired_output("first", "second", outputs),
        "explicit production defaults do not alter build stamp" => {
            paired_output("implicit", "explicit", outputs)
        }
        "prepared stable CLI defaults do not alter build stamp" => {
            paired_output("implicit", "prepared", outputs)
        }
        "non-default web app env changes build stamp" => {
            paired_output("production", "development", outputs)
        }
        "stable shim launch stamp follows install root"
        | "stable shim launch stamp follows native binary bytes" => {
            paired_output("first", "second", outputs)
        }
        _ => outputs.remove(0),
    }
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
    let artifact_paths = [
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
    let mut paths = artifact_paths.to_vec();
    if native_artifact_path.exists() {
        paths.push(native_artifact_path);
    }
    Some(paths)
}

fn paired_output(first_key: &str, second_key: &str, mut outputs: Vec<Value>) -> Value {
    let first = outputs.remove(0);
    let second = outputs.remove(0);
    let same_stamp = first.get("dashboardBuildStamp") == second.get("dashboardBuildStamp");
    json!({
        first_key: first,
        second_key: second,
        "sameStamp": same_stamp,
    })
}

fn summarize_dashboard_spec(
    spec: &DashboardCommandSpec,
    repo_root: &Path,
    temp_root: &Path,
) -> Value {
    let command = spec
        .dashboard_command
        .args
        .get(1)
        .map(String::as_str)
        .unwrap_or_default();
    json!({
        "scriptPath": normalize_contract_path(&spec.script_path, repo_root, temp_root),
        "dashboardBuildStamp": spec.dashboard_build_stamp,
        "dashboardCommand": {
            "cwd": spec.dashboard_command.cwd,
            "command": spec.dashboard_command.command,
            "args": spec.dashboard_command.args.iter().map(|arg| normalize_contract_path(arg, repo_root, temp_root)).collect::<Vec<_>>(),
        },
        "derived": {
            "shellSyntaxOk": bash_syntax_ok(command),
            "usesBashWrapper": spec.dashboard_command.command == "bash"
                && spec.dashboard_command.args.first().map(String::as_str) == Some("-lc"),
            "includesLegacyNodeDashboardEntrypoint": command.contains("--tmux-dashboard-internal"),
            "includesNativeDashboardEntrypoint": command.contains("__dashboard-internal-native"),
            "quotesPrintfNewline": command.contains("printf '%s\\n'"),
            "hasExitCleanupTrap": command.contains("trap 'rm -f \"$output_file\"' EXIT"),
            "hasSignalCleanupTrap": command.contains("trap 'rm -f \"$output_file\"; exit 130' INT TERM HUP"),
            "appendsSharedDebugLog": command.contains("/tmp/aimux-debug.log") || command.contains("tee -a"),
            "printsStartupFrameBeforeEntrypoint": command.find("Starting Aimux dashboard...")
                .zip(command.find("--tmux-dashboard-internal"))
                .is_some_and(|(startup, entrypoint)| entrypoint > startup),
            "entersAlternateScreenBeforeStartup": command.contains("\u{1b}[?1049h"),
        },
    })
}

fn bash_syntax_ok(command: &str) -> bool {
    Command::new("bash")
        .args(["-n", "-c", command])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn contract_env(env: &Value, repo_root: &Path, temp_root: &Path) -> BTreeMap<String, String> {
    env.as_object()
        .unwrap_or(&Map::new())
        .iter()
        .filter_map(|(key, value)| {
            value.as_str().map(|value| {
                (
                    key.clone(),
                    denormalize_contract_path(value, repo_root, temp_root),
                )
            })
        })
        .collect()
}

fn denormalize_contract_path(value: &str, repo_root: &Path, temp_root: &Path) -> String {
    value
        .replace("<REPO>", &path_text(repo_root))
        .replace("<TMP>", &path_text(temp_root))
}

fn normalize_contract_path(value: &str, repo_root: &Path, temp_root: &Path) -> String {
    value
        .replace(&path_text(repo_root), "<REPO>")
        .replace(&path_text(temp_root), "<TMP>")
}

fn seed_contract_stable_shim(temp_root: &Path) {
    let shim = temp_root.join("bin/aimux");
    fs::create_dir_all(shim.parent().expect("contract shim parent")).expect("create shim parent");
    fs::write(&shim, "#!/usr/bin/env sh\n").expect("write shim");
}

struct ContractTempDir(PathBuf);

impl ContractTempDir {
    fn new() -> Self {
        let sequence = CONTRACT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!(
            "aimux-dashboard-command-contract-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create dashboard command contract temp");
        Self(path)
    }
}

impl Drop for ContractTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
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

fn dashboard_unset_env_keys(source_checkout: bool) -> Vec<&'static str> {
    let mut keys = DASHBOARD_INHERITED_ENV_UNSET_KEYS.to_vec();
    if source_checkout {
        keys.extend(STABLE_SHIM_ENV_KEYS);
    }
    keys
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

fn native_platform(platform: &str) -> &str {
    match platform {
        "macos" => "darwin",
        value => value,
    }
}

fn native_arch(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    }
}
