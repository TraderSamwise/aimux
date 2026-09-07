use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn run_installed_shim_contract_case(repo_root: &Path, input: &Value) -> Value {
    let temp = TempContractDir::new("aimux-installed-shim-contract");
    let mut envs = vec![("PATH".to_owned(), "/bin:/usr/bin".to_owned())];
    match input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "explicit-native" => {
            let native_bin = write_native_bin(temp.path(), "native-explicit");
            envs.push((
                "AIMUX_NATIVE_BIN".to_owned(),
                native_bin.to_string_lossy().into_owned(),
            ));
        }
        "root-native" => {
            let native_dir = temp.path().join("native").join(platform_arch());
            write_native_bin(&native_dir, "native-root");
            envs.push((
                "AIMUX_ROOT".to_owned(),
                temp.path().to_string_lossy().into_owned(),
            ));
        }
        "missing-native" => {
            envs.push((
                "AIMUX_ROOT".to_owned(),
                temp.path().to_string_lossy().into_owned(),
            ));
        }
        mode => panic!("unknown installed shim fixture mode: {mode}"),
    }

    let mut command = Command::new("/bin/sh");
    command
        .arg(repo_root.join("scripts/installed-aimux-shim.sh"))
        .env_clear();
    for (key, value) in envs {
        command.env(key, value);
    }
    for arg in string_array(input, "args") {
        command.arg(arg);
    }

    let output = command.output().expect("run installed aimux shim");
    json!({
        "status": output.status.code().unwrap_or(128),
        "stdout": String::from_utf8_lossy(&output.stdout).into_owned(),
        "stderr": String::from_utf8_lossy(&output.stderr)
            .replace(&temp.path().to_string_lossy().to_string(), "<tmp>"),
    })
}

pub fn run_package_manifest_contract_case(repo_root: &Path, input: &Value) -> Value {
    let source_path = input
        .get("sourcePath")
        .and_then(Value::as_str)
        .expect("package manifest sourcePath");
    let package: Value = serde_json::from_str(
        &fs::read_to_string(repo_root.join(source_path)).expect("read package manifest"),
    )
    .expect("parse package manifest");
    let files = package
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    json!({
        "files": files,
        "required": presence_entries(input, "requiredFiles", &package["files"]),
        "forbidden": presence_entries(input, "forbiddenFiles", &package["files"]),
    })
}

pub fn run_release_asset_contract_case(repo_root: &Path, input: &Value) -> Value {
    let source_path = input
        .get("sourcePath")
        .and_then(Value::as_str)
        .expect("release asset sourcePath");
    let body = fs::read_to_string(repo_root.join(source_path)).expect("read release asset script");
    json!({
        "contains": string_array(input, "contains").into_iter().map(|needle| {
            json!({ "needle": needle, "present": body.contains(&needle) })
        }).collect::<Vec<_>>(),
        "notContains": string_array(input, "notContains").into_iter().map(|needle| {
            json!({ "needle": needle, "present": body.contains(&needle) })
        }).collect::<Vec<_>>(),
    })
}

fn presence_entries(input: &Value, key: &str, files: &Value) -> Vec<Value> {
    let shipped = files.as_array().cloned().unwrap_or_default();
    string_array(input, key)
        .into_iter()
        .map(|entry| {
            let present = shipped.iter().any(|file| file.as_str() == Some(&entry));
            json!({ "entry": entry, "present": present })
        })
        .collect()
}

fn string_array(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn write_native_bin(root: &Path, label: &str) -> PathBuf {
    fs::create_dir_all(root).expect("create native bin dir");
    let native_bin = root.join("aimux");
    fs::write(
        &native_bin,
        format!("#!/bin/sh\nprintf '{label} %s\\n' \"$*\"\n"),
    )
    .expect("write fake native bin");
    let mut permissions = fs::metadata(&native_bin)
        .expect("stat fake native bin")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&native_bin, permissions).expect("chmod fake native bin");
    native_bin
}

fn platform_arch() -> String {
    format!("{}-{}", platform(), arch())
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

struct TempContractDir {
    path: PathBuf,
}

impl TempContractDir {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("create contract temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempContractDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
