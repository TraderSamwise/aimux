use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const TMUX_CONTROL_SCRIPT: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/control-script.json");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_tmux_control_script_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_CONTROL_SCRIPT).expect("valid tmux-control fixture");
    let cases = contract["cases"].as_array().expect("tmux-control cases");
    assert_eq!(cases.len(), 55, "unexpected tmux-control case count");

    let mut failures = Vec::new();
    for case in cases {
        let expected = &case["output"];
        let actual = run_case(case);
        if &actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-control-script parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let repo = repo_root();
    let mut roots = BTreeMap::<String, TempRoot>::new();
    let exec_calls = case["input"]["execCalls"].as_array().expect("exec calls");

    for root in case["output"]["roots"].as_array().into_iter().flatten() {
        let placeholder = root["root"].as_str().expect("output root placeholder");
        roots
            .entry(placeholder.to_owned())
            .or_insert_with(|| TempRoot::new(placeholder));
    }
    for call in exec_calls {
        if let Some(before_root) = call.get("beforeRoot").filter(|value| !value.is_null()) {
            let placeholder = before_root["root"]
                .as_str()
                .expect("before root placeholder");
            roots
                .entry(placeholder.to_owned())
                .or_insert_with(|| TempRoot::new(placeholder));
        }
    }
    for call in exec_calls {
        if let Some(before_root) = call.get("beforeRoot").filter(|value| !value.is_null()) {
            let placeholder = before_root["root"]
                .as_str()
                .expect("before root placeholder");
            roots
                .get(placeholder)
                .expect("root for fixture")
                .reset_from_fixture(before_root, &repo, &roots);
        }
    }

    let mut thrown = Value::Null;
    for call in exec_calls {
        if let Err(error) = run_exec_call(call, &repo, &roots) {
            thrown = error;
            break;
        }
    }
    wait_for_expected_logs(&roots, &case["output"], &repo);

    let replacements = placeholder_map(&roots);
    let snapshots = roots
        .values()
        .map(|root| normalize_value(snapshot_root(root.path()), &repo, &replacements))
        .collect::<Vec<_>>();

    json!({
        "thrown": thrown,
        "roots": snapshots,
    })
}

fn run_exec_call(
    call: &Value,
    repo: &Path,
    roots: &BTreeMap<String, TempRoot>,
) -> Result<(), Value> {
    let root_placeholder = call["beforeRoot"]["root"]
        .as_str()
        .expect("exec call before root");
    let root = roots
        .get(root_placeholder)
        .expect("root for exec call")
        .path();
    let replacements = placeholder_map(roots);
    let command = denormalize_string(
        call["command"].as_str().expect("command"),
        repo,
        &replacements,
    );
    let args = call["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|arg| denormalize_string(arg.as_str().expect("arg"), repo, &replacements))
        .collect::<Vec<_>>();
    let bin_dir = root.join("bin");
    let path = format!(
        "{}:{}",
        bin_dir.to_string_lossy(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut process = Command::new(command);
    process
        .args(args)
        .current_dir(repo)
        .env("PATH", path)
        .env("TMPDIR", root.to_string_lossy().into_owned());
    process
        .env("TMUX_FAKE_STATE", root.join("tmux-state.json"))
        .env("TMUX_FAKE_LOG", root.join("tmux-log.jsonl"))
        .env("TMUX_FAKE_CURL_LOG", root.join("curl-log.jsonl"))
        .env("TMUX_FAKE_AIMUX_LOG", root.join("aimux-log.txt"))
        .env("AIMUX_BIN", bin_dir.join("aimux"));
    if let Some(env) = call["env"].as_object() {
        for (key, value) in env {
            if key == "PATH" || value.is_null() {
                continue;
            }
            process.env(
                key,
                denormalize_string(value.as_str().unwrap_or_default(), repo, &replacements),
            );
        }
    }
    let output = process.output().expect("run tmux-control command");
    if output.status.success() {
        Ok(())
    } else {
        Err(json!({
            "name": "Error",
            "message": format!("Command failed with status {}", output.status.code().unwrap_or(-1)),
            "status": output.status.code(),
        }))
    }
}

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-tmux-control-fixture-{}-{}-{}",
            sanitize_label(label),
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp root");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn reset_from_fixture(
        &self,
        before_root: &Value,
        repo: &Path,
        roots: &BTreeMap<String, TempRoot>,
    ) {
        let _ = fs::remove_dir_all(&self.path);
        fs::create_dir_all(self.path.join("bin")).expect("create bin dir");
        fs::create_dir_all(self.path.join("project")).expect("create project dir");
        write_fake_binaries(&self.path);
        fs::write(
            self.path.join("tmux-state.json"),
            serde_json::to_string_pretty(&denormalize_value(
                before_root["state"].clone(),
                repo,
                &placeholder_map(roots),
            ))
            .expect("serialize state"),
        )
        .expect("write state");
        fs::write(self.path.join("tmux-log.jsonl"), "").expect("write tmux log");
        fs::write(self.path.join("curl-log.jsonl"), "").expect("write curl log");
        fs::write(self.path.join("aimux-log.txt"), "").expect("write aimux log");
        for (name, contents) in before_root["rootFiles"].as_object().into_iter().flatten() {
            fs::write(
                self.path.join(name),
                denormalize_string(
                    contents.as_str().unwrap_or_default(),
                    repo,
                    &placeholder_map(roots),
                ),
            )
            .expect("write root file");
        }
        for (name, contents) in before_root["projectFiles"]
            .as_object()
            .into_iter()
            .flatten()
        {
            let path = self.path.join("project").join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create project file parent");
            }
            fs::write(
                path,
                denormalize_string(
                    contents.as_str().unwrap_or_default(),
                    repo,
                    &placeholder_map(roots),
                ),
            )
            .expect("write project file");
        }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn snapshot_root(root: &Path) -> Value {
    json!({
        "root": root.to_string_lossy(),
        "tmuxLog": read_json_lines(&root.join("tmux-log.jsonl")),
        "curlLog": read_text_lines(&root.join("curl-log.jsonl")),
        "aimuxLog": read_text_lines(&root.join("aimux-log.txt")),
        "state": read_json_file(&root.join("tmux-state.json")),
        "rootFiles": list_root_files(root),
        "projectFiles": list_files(&root.join("project")),
    })
}

fn wait_for_expected_logs(roots: &BTreeMap<String, TempRoot>, expected: &Value, repo: &Path) {
    let expected_roots = expected["roots"].as_array().cloned().unwrap_or_default();
    let replacements = placeholder_map(roots);
    for _ in 0..100 {
        let ready = expected_roots.iter().all(|expected_root| {
            let Some(placeholder) = expected_root["root"].as_str() else {
                return true;
            };
            let Some(root) = roots.get(placeholder) else {
                return true;
            };
            let expected_curl = expected_root["curlLog"].as_array().map_or(0, Vec::len);
            let expected_aimux = expected_root["aimuxLog"].as_array().map_or(0, Vec::len);
            let expected_tmux = expected_root["tmuxLog"].as_array().map_or(0, Vec::len);
            let expected_root_files = expected_root.get("rootFiles").unwrap_or(&Value::Null);
            text_line_count(&root.path().join("curl-log.jsonl")) >= expected_curl
                && text_line_count(&root.path().join("aimux-log.txt")) >= expected_aimux
                && text_line_count(&root.path().join("tmux-log.jsonl")) >= expected_tmux
                && normalize_value(list_root_files(root.path()), repo, &replacements)
                    == *expected_root_files
        });
        if ready {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn text_line_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .lines()
        .filter(|line| !line.is_empty())
        .count()
}

fn read_json_lines(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_default();
    Value::Array(
        text.trim()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                serde_json::from_str(line).unwrap_or_else(|_| Value::String(line.to_owned()))
            })
            .collect(),
    )
}

fn read_text_lines(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_default();
    Value::Array(
        text.trim()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| Value::String(line.to_owned()))
            .collect(),
    )
}

fn read_json_file(path: &Path) -> Value {
    let Ok(text) = fs::read_to_string(path) else {
        return Value::Null;
    };
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

fn list_files(root: &Path) -> Value {
    let mut files = BTreeMap::new();
    collect_files(root, root, &mut files);
    Value::Object(
        files
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect::<Map<_, _>>(),
    )
}

fn list_root_files(root: &Path) -> Value {
    let ignored = [
        "bin",
        "project",
        "tmux-state.json",
        "tmux-log.jsonl",
        "curl-log.jsonl",
        "aimux-log.txt",
    ];
    let mut files = BTreeMap::new();
    let Ok(entries) = fs::read_dir(root) else {
        return json!({});
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if ignored.contains(&name) || !path.is_file() {
            continue;
        }
        files.insert(
            name.to_owned(),
            fs::read_to_string(&path).unwrap_or_default(),
        );
    }
    Value::Object(
        files
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect::<Map<_, _>>(),
    )
}

fn collect_files(root: &Path, base: &Path, files: &mut BTreeMap<String, String>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_files(&path, base, files);
        } else if path.is_file() {
            let key = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            files.insert(key, fs::read_to_string(&path).unwrap_or_default());
        }
    }
}

fn placeholder_map(roots: &BTreeMap<String, TempRoot>) -> BTreeMap<String, String> {
    roots
        .iter()
        .map(|(placeholder, root)| {
            (
                placeholder.clone(),
                root.path().to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn normalize_value(value: Value, repo: &Path, replacements: &BTreeMap<String, String>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|value| normalize_value(value, repo, replacements))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_value(value, repo, replacements)))
                .collect(),
        ),
        Value::String(value) => Value::String(normalize_string(&value, repo, replacements)),
        other => other,
    }
}

fn denormalize_value(value: Value, repo: &Path, replacements: &BTreeMap<String, String>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|value| denormalize_value(value, repo, replacements))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, denormalize_value(value, repo, replacements)))
                .collect(),
        ),
        Value::String(value) => Value::String(denormalize_string(&value, repo, replacements)),
        other => other,
    }
}

fn normalize_string(value: &str, repo: &Path, replacements: &BTreeMap<String, String>) -> String {
    let mut output = value.replace(&repo.to_string_lossy().to_string(), "<repo>");
    for (placeholder, real) in replacements {
        output = output.replace(
            &percent_encode_component(real),
            &percent_encode_component(placeholder),
        );
        output = output.replace(real, placeholder);
    }
    normalize_tempfile_paths(&output)
}

fn denormalize_string(value: &str, repo: &Path, replacements: &BTreeMap<String, String>) -> String {
    let mut output = value.replace("<repo>", &repo.to_string_lossy());
    for (placeholder, real) in replacements {
        output = output.replace(
            &percent_encode_component(placeholder),
            &percent_encode_component(real),
        );
        output = output.replace(placeholder, real);
    }
    output
}

fn write_fake_binaries(root: &Path) {
    let bin = root.join("bin");
    write_executable(&bin.join("tmux"), FAKE_TMUX);
    write_executable(&bin.join("curl"), FAKE_CURL);
    write_executable(&bin.join("nc"), FAKE_NC);
    write_executable(&bin.join("aimux"), FAKE_AIMUX);
}

fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).expect("write fake executable");
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).expect("fake metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod fake executable");
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn sanitize_label(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn normalize_tempfile_paths(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("/var/folders/") {
        output.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(tmp_index) = tail.find("/T/tmp.") else {
            output.push_str("/var/folders/");
            rest = &tail["/var/folders/".len()..];
            continue;
        };
        let after_tmp = start + tmp_index + "/T/tmp.".len();
        let absolute_after_tmp = rest[after_tmp..]
            .find(|character: char| !character.is_ascii_alphanumeric())
            .map(|offset| after_tmp + offset)
            .unwrap_or(rest.len());
        output.push_str("<tempfile>");
        rest = &rest[absolute_after_tmp..];
    }
    output.push_str(rest);
    output
}

fn percent_encode_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

const FAKE_TMUX: &str = r####"#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const statePath = process.env.TMUX_FAKE_STATE;
const logPath = process.env.TMUX_FAKE_LOG;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(args) + "\n");
function fail() { process.exit(1); }
function out(value) { process.stdout.write(String(value)); }
function listClients() {
  const format = args[2] || "";
  const rows = (state.clients || []).map((client) =>
    format
      .replace("#{client_tty}", client.tty)
      .replace("#{session_name}", client.sessionName)
      .replace("#{window_id}", client.windowId)
      .replace("#{client_width}", String(client.width ?? 200))
      .replace("#{client_height}", String(client.height ?? 60)),
  );
  out(rows.join("\n"));
}
function listWindows() {
  const all = args.includes("-a");
  const formatIndex = args.indexOf("-F");
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "";
  const targetIndex = args.indexOf("-t");
  const sessionName = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const sessions = all ? Object.entries(state.windows || {}) : [[sessionName, state.windows?.[sessionName] || []]];
  const rows = [];
  for (const [session, windows] of sessions) {
    for (const window of windows || []) {
      rows.push(
        format
          .replace("#{session_name}", session)
          .replace("#{window_index}", String(window.index))
          .replace("#{window_name}", window.name)
          .replace("#{window_id}", window.id)
          .replace("#{pane_dead}", state.deadWindows?.includes(window.id) ? "1" : "0"),
      );
    }
  }
  out(rows.join("\n"));
}
function displayMessage() {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const format = args.at(-1) || "";
  if (format === "#{pane_dead}") {
    const exists = Object.values(state.windows || {}).some((windows) =>
      (windows || []).some((window) => window.id === target),
    );
    if (!exists) fail();
    out(state.deadWindows?.includes(target) ? "1" : "0");
    return;
  }
  const pane = (state.panes || {})[target];
  if (!pane) fail();
  out(
    format
      .replace("#{pane_in_mode}", pane.inMode ? "1" : "0")
      .replace("#{pane_current_command}", pane.currentCommand || "")
      .replace("#{session_name}", pane.sessionName || "")
      .replace("#{window_id}", pane.windowId || "")
      .replace("#{window_name}", pane.windowName || "")
      .replace("#{client_tty}", pane.clientTty || "")
      .replace("#{pane_current_path}", pane.currentPath || ""),
  );
}
function capturePane() {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const content = (state.capturedPanes || {})[target];
  out(content == null ? "" : content);
}
function showOptions() {
  const targetIndex = args.indexOf("-t");
  const session = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const key = args.at(-1);
  const value = state.sessionOptions?.[session]?.[key];
  if (value == null) fail();
  out(value);
}
function showWindowOptions() {
  const targetIndex = args.indexOf("-t");
  const windowId = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const key = args.at(-1);
  const value =
    key === "@aimux-meta" ? state.windowMetadata?.[windowId] && JSON.stringify(state.windowMetadata[windowId]) : state.windowOptions?.[windowId]?.[key];
  if (value == null) fail();
  out(value);
}
function linkWindow() {
  const source = args[args.indexOf("-s") + 1];
  const targetSession = args[args.indexOf("-t") + 1];
  let sourceWindow = null;
  for (const windows of Object.values(state.windows || {})) {
    const match = (windows || []).find((window) => window.id === source);
    if (match) {
      sourceWindow = { ...match };
      break;
    }
  }
  if (!sourceWindow) fail();
  state.windows[targetSession] ||= [];
  const windows = state.windows[targetSession];
  if (!windows.find((window) => window.id === sourceWindow.id)) {
    const nextIndex = windows.length ? Math.max(...windows.map((window) => window.index)) + 1 : 0;
    windows.push({ ...sourceWindow, index: nextIndex });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}
function switchClient() {
  const ttyIndex = args.indexOf("-c");
  const tty = ttyIndex >= 0 ? args[ttyIndex + 1] : "";
  const target = args[args.indexOf("-t") + 1];
  const parts = target.split(":");
  const sessionName = parts[0];
  const indexText = parts[1];
  const window = (state.windows?.[sessionName] || []).find((entry) => String(entry.index) === indexText);
  if (!window) fail();
  const client = (state.clients || []).find((entry) => entry.tty === tty);
  if (!client) fail();
  client.sessionName = sessionName;
  client.windowId = window.id;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
switch (args[0]) {
  case "list-clients": listClients(); break;
  case "list-windows": listWindows(); break;
  case "display-message": displayMessage(); break;
  case "capture-pane": capturePane(); break;
  case "display-menu":
    if (process.env.TMUX_FAKE_DISPLAY_MENU_EXIT === "1") fail();
    break;
  case "display-popup":
    if (process.env.TMUX_FAKE_DISPLAY_POPUP_EXIT) process.exit(Number(process.env.TMUX_FAKE_DISPLAY_POPUP_EXIT));
    if (process.env.TMUX_FAKE_DISPLAY_POPUP_RUN_COMMAND === "1") {
      const command = args.at(-1) || "";
      const result = spawnSync("sh", ["-c", command], { env: process.env, stdio: "inherit" });
      process.exit(result.status ?? 1);
    }
    break;
  case "new-window": break;
  case "show-options": showOptions(); break;
  case "show-window-options": showWindowOptions(); break;
  case "link-window": linkWindow(); break;
  case "switch-client": switchClient(); break;
  case "refresh-client": break;
  case "send-keys": break;
  default: fail();
}
"####;

const FAKE_CURL: &str = r####"#!/bin/sh
printf '%s\n' "$*" >> "$TMUX_FAKE_CURL_LOG"
for arg in "$@"; do
  case "$arg" in
    *"/control/switchable-agents"*)
      if [ -n "$TMUX_FAKE_SWITCHABLE_RESPONSE" ]; then
        printf '%s' "$TMUX_FAKE_SWITCHABLE_RESPONSE"
      else
        printf '{"ok":true,"items":[]}'
      fi
      exit "${TMUX_FAKE_CURL_EXIT:-0}"
      ;;
    *"/control/open-dashboard"*)
      if [ -n "$TMUX_FAKE_OPEN_DASHBOARD_RESPONSE" ]; then
        printf '%s' "$TMUX_FAKE_OPEN_DASHBOARD_RESPONSE"
      else
        printf '{"ok":true,"target":{"sessionName":"aimux-proj-client-1234abcd","windowIndex":0,"windowId":"@dash","windowName":"dashboard-live"},"focused":true}'
      fi
      exit "${TMUX_FAKE_CURL_EXIT:-0}"
      ;;
  esac
done
exit "${TMUX_FAKE_CURL_EXIT:-0}"
"####;

const FAKE_NC: &str = r####"#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
let done = false;
function maybeFinish() {
  if (done) return;
  const header = Buffer.concat(chunks).toString("utf8").split("\n");
  if (header.length < 16) return;
  done = true;
  const statusPath = header[10] || "";
  const selectionPath = header[14] || "";
  const sequencePath = process.env.TMUX_FAKE_NC_STATUS_SEQUENCE_FILE || "";
  let status = process.env.TMUX_FAKE_NC_STATUS || "0";
  if (sequencePath) {
    const values = fs.readFileSync(sequencePath, "utf8").trim().split(/\s*,\s*/).filter(Boolean);
    status = values.shift() || status;
    fs.writeFileSync(sequencePath, values.join(","));
  }
  if (statusPath) fs.writeFileSync(statusPath, status + "\n");
  if (selectionPath && process.env.TMUX_FAKE_NC_SELECTION) {
    fs.writeFileSync(selectionPath, process.env.TMUX_FAKE_NC_SELECTION + "\n");
  }
  process.exit(Number(process.env.TMUX_FAKE_NC_EXIT || "0"));
}
process.stdin.on("data", (chunk) => {
  chunks.push(chunk);
  maybeFinish();
});
process.stdin.on("end", maybeFinish);
process.stdin.resume();
"####;

const FAKE_AIMUX: &str = r####"#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$TMUX_FAKE_AIMUX_LOG"
exit 0
"####;
