use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aimux::cli_launcher::{
    get_aimux_current_cli_identity, get_aimux_daemon_launch_command,
    get_aimux_dashboard_launch_command, get_aimux_project_service_launch_command,
    AimuxCliLaunchCommand, AimuxCliLaunchOptions, AimuxCliLaunchSource,
};
use serde::Deserialize;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/runtime/cli-launcher.json");
const NODE: &str = "<node>";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn cli_launcher_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli launcher fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_cli_launcher_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "cli launcher parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_cli_launcher_contract_case(input: &Value) -> Value {
    with_fixture_paths(input, |paths| {
        let options = launch_options(input, paths);
        let command = match string_field(input, "api") {
            "getAimuxDaemonLaunchCommand" => get_aimux_daemon_launch_command(options),
            "getAimuxDashboardLaunchCommand" => get_aimux_dashboard_launch_command(options),
            "getAimuxProjectServiceLaunchCommand" => get_aimux_project_service_launch_command(
                string_field(input, "projectId"),
                string_field(input, "projectRoot"),
                options,
            ),
            "getAimuxCurrentCliIdentity" => get_aimux_current_cli_identity(options),
            api => panic!("unknown cli-launcher api: {api}"),
        };
        normalize_command(command, paths)
    })
}

struct FixturePaths {
    tmp: PathBuf,
    repo: PathBuf,
    node: PathBuf,
}

fn with_fixture_paths(input: &Value, run: impl FnOnce(&FixturePaths) -> Value) -> Value {
    let tmp = temp_dir("cli-launcher");
    let repo = tmp.join("repo");
    let node = tmp.join("node");

    fs::create_dir_all(repo.join("dist")).expect("mkdir fixture repo dist");
    write_file(&node);
    write_file(&repo.join("dist/launcher-bin.js"));

    fs::create_dir_all(tmp.join("bin")).expect("mkdir fixture bin");
    write_file(&tmp.join("bin/aimux"));
    write_file(&tmp.join("native/old-build/dist/launcher-bin.js"));
    write_file(&tmp.join("checkout/dist/launcher-bin.js"));
    write_file(
        &tmp.join("native")
            .join("old-build")
            .join("native")
            .join(platform_arch())
            .join("aimux"),
    );

    if input.get("setup").and_then(Value::as_str) == Some("alias-root") {
        write_file(
            &tmp.join("real")
                .join("native")
                .join("old-build")
                .join("native")
                .join(platform_arch())
                .join("aimux"),
        );
        fs::create_dir_all(tmp.join("alias")).expect("mkdir fixture alias dir");
        symlink_dir(tmp.join("real/native"), tmp.join("alias/native"));
    }

    run(&FixturePaths { tmp, repo, node })
}

#[cfg(unix)]
fn symlink_dir(original: impl AsRef<Path>, link: impl AsRef<Path>) {
    std::os::unix::fs::symlink(original, link).expect("symlink fixture alias");
}

#[cfg(not(unix))]
fn symlink_dir(original: impl AsRef<Path>, link: impl AsRef<Path>) {
    let _ = (original, link);
    panic!("cli launcher alias fixture requires symlink support");
}

fn launch_options(input: &Value, paths: &FixturePaths) -> AimuxCliLaunchOptions {
    let raw_options = value_field(input, "options");
    AimuxCliLaunchOptions {
        env: env_map(value_field(raw_options, "env"), paths),
        current_argv_entry: string_field_opt(raw_options, "currentArgvEntry")
            .map(|value| denormalize_path(&value, paths)),
        current_entry_path: Some(
            paths
                .repo
                .join("dist/launcher-bin.js")
                .to_string_lossy()
                .into_owned(),
        ),
        process_exec_path: Some(paths.node.to_string_lossy().into_owned()),
        home_dir: Some(paths.tmp.clone()),
    }
}

fn env_map(input: &Value, paths: &FixturePaths) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let Some(object) = input.as_object() else {
        return env;
    };
    for (key, value) in object {
        let Some(value) = value.as_str() else {
            continue;
        };
        env.insert(key.clone(), denormalize_path(value, paths));
    }
    env
}

fn normalize_command(command: AimuxCliLaunchCommand, paths: &FixturePaths) -> Value {
    let source = match command.source {
        AimuxCliLaunchSource::StableShim => "stable-shim",
        AimuxCliLaunchSource::CurrentEntry => "current-entry",
        AimuxCliLaunchSource::NativeBinary => "native-binary",
    };
    json!({
        "command": normalize_path(&command.command, paths),
        "args": command
            .args
            .iter()
            .map(|arg| normalize_path(arg, paths))
            .collect::<Vec<_>>(),
        "source": source,
        "currentEntryPath": normalize_path(&command.current_entry_path, paths),
        "stableShimPath": normalize_path(&command.stable_shim_path, paths),
    })
}

fn denormalize_path(value: &str, paths: &FixturePaths) -> String {
    value
        .replace("<repo>", &paths.repo.to_string_lossy())
        .replace("<tmp>", &paths.tmp.to_string_lossy())
        .replace("<node>", &paths.node.to_string_lossy())
        .replace("<platform-arch>", &platform_arch())
}

fn normalize_path(value: &str, paths: &FixturePaths) -> String {
    if value == paths.node.to_string_lossy() {
        return NODE.to_owned();
    }
    value
        .replace(&paths.repo.to_string_lossy().to_string(), "<repo>")
        .replace(&paths.tmp.to_string_lossy().to_string(), "<tmp>")
        .replace(&platform_arch(), "<platform-arch>")
}

fn platform_arch() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    };
    format!("{os}-{arch}")
}

fn temp_dir(label: &str) -> PathBuf {
    let id = TEMP_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!("aimux-{label}-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir fixture temp dir");
    fs::canonicalize(&path).expect("canonicalize fixture temp dir")
}

fn write_file(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir fixture parent");
    }
    fs::write(path, "#!/bin/sh\n").expect("write fixture file");
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}"))
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {field}"))
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
