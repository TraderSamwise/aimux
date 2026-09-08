use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn compact_entrypoint_matches_node_cli_contract_without_node_fallback() {
    let fixture = CliFixture::new("compact", 46420);
    let repo = fixture.root.join("repo");
    fs::create_dir_all(repo.join(".git")).expect("create repo marker");
    let history_dir = repo.join(".aimux/history");
    fs::create_dir_all(&history_dir).expect("create history dir");
    write_history(
        &history_dir,
        "codex-1",
        &[
            json!({ "ts": "2026-09-09T01:00:00.000Z", "type": "prompt", "content": "check gui contract" }),
            json!({ "ts": "2026-09-09T01:00:05.000Z", "type": "response", "content": "gui contract is pinned", "files": ["app/lib/api.ts"] }),
        ],
    );
    write_history(
        &history_dir,
        "claude-2",
        &[
            json!({ "ts": "2026-09-09T01:01:00.000Z", "type": "prompt", "content": "review compactor" }),
        ],
    );
    let compact_log = fixture.root.join("compact-input.txt");
    let compact_command = fake_compact_command(&fixture.root, &compact_log);
    fs::write(
        repo.join(".aimux/config.json"),
        serde_json::to_string(&json!({
            "tools": {
                "claude": {
                    "compactCommand": compact_command.to_string_lossy()
                }
            }
        }))
        .expect("config json"),
    )
    .expect("write config");

    let output = fixture
        .command()
        .current_dir(&repo)
        .arg("compact")
        .output()
        .expect("run aimux compact");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Compacting history for 2 session(s)..."));
    let canonical_repo = repo.canonicalize().expect("canonical repo");
    assert!(stdout.contains(&format!(
        "Done. Summary written to {}/summary.md",
        canonical_repo.join(".aimux/context").display()
    )));
    assert!(
        !fixture.node_log.exists(),
        "compact should not invoke node fallback"
    );
    let compact_input = fs::read_to_string(compact_log).expect("compact input");
    assert!(compact_input.contains("=== Session: codex-1 (2 turns) ==="));
    assert!(compact_input.contains("=== Session: claude-2 (1 turns) ==="));
    let codex_summary =
        fs::read_to_string(repo.join(".aimux/context/codex-1/summary.md")).expect("codex summary");
    assert!(codex_summary.contains("Source: llm"));
    assert!(codex_summary.contains("## CLI summary"));
    let claude_summary = fs::read_to_string(repo.join(".aimux/context/claude-2/summary.md"))
        .expect("claude summary");
    assert!(claude_summary.contains("Source: llm"));
    assert!(claude_summary.contains("## CLI summary"));
}

fn write_history(history_dir: &Path, session_id: &str, turns: &[serde_json::Value]) {
    let body = turns
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(
        history_dir.join(format!("{session_id}.jsonl")),
        format!("{body}\n"),
    )
    .expect("write history");
}

fn fake_compact_command(root: &Path, log: &Path) -> PathBuf {
    let path = root.join("fake-compact");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' '--- compact call ---' >> '{}'\ncat >> '{}'\nprintf '%s\\n' '## CLI summary' 'from fake compact'\n",
            shell_single_quote(log),
            shell_single_quote(log)
        ),
    )
    .expect("write fake compact");
    make_executable(&path);
    path
}

fn fake_node(root: &Path, log: &Path, code: i32) -> PathBuf {
    let path = root.join("fake-node");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n: > '{}'\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '{}'; done\nexit {code}\n",
            shell_single_quote(log),
            shell_single_quote(log)
        ),
    )
    .expect("write fake node");
    make_executable(&path);
    path
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).expect("script metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod script");
    }
}

fn shell_single_quote(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

struct CliFixture {
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    node_log: PathBuf,
    node: PathBuf,
    port: u16,
}

impl CliFixture {
    fn new(label: &str, base_port: u16) -> Self {
        let root = temp_root(label);
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        let node_log = root.join("node.log");
        let node = fake_node(&root, &node_log, 9);
        let offset = u16::try_from(TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) % 500)
            .expect("port offset");
        Self {
            root,
            home,
            aimux_home,
            node_log,
            node,
            port: base_port + offset,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
        command
            .env("AIMUX_ROOT", &self.root)
            .env("AIMUX_NODE_BIN", &self.node)
            .env("HOME", &self.home)
            .env("AIMUX_HOME", &self.aimux_home)
            .env("AIMUX_DAEMON_PORT", self.port.to_string());
        command
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = self.command().args(["daemon", "stop"]).output();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-context-history-cli-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp root");
    path
}
