use aimux::tmux_open_hyperlink::{
    TmuxOpenHyperlinkEnv, TmuxOpenHyperlinkRunner, run_tmux_open_hyperlink,
};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_open_hyperlink_matches_shell_helper_observed_behavior() {
    let cases = [
        Case {
            name: "direct hyperlink is passed through before extraction",
            env: TmuxOpenHyperlinkEnv {
                hyperlink: "https://github.com/org/repo/pull/42)".to_owned(),
                ..Default::default()
            },
            statusline: None,
        },
        Case {
            name: "statusline pr wins when hyperlink is empty",
            env: TmuxOpenHyperlinkEnv {
                current_window_id: "@7".to_owned(),
                ..Default::default()
            },
            statusline: Some(json!({
                "sessions": [
                    { "id": "other", "tmuxWindowId": "@8" },
                    { "id": "agent", "tmuxWindowId": "@7" }
                ],
                "metadata": {
                    "agent": {
                        "context": {
                            "pr": { "url": "https://github.com/org/repo/pull/7" }
                        }
                    }
                }
            })),
        },
        Case {
            name: "mouse word is unwrapped before url extraction",
            env: TmuxOpenHyperlinkEnv {
                mouse_word: "(https://example.com/path).".to_owned(),
                ..Default::default()
            },
            statusline: None,
        },
        Case {
            name: "mouse line extraction keeps punctuation matched by the shell regex",
            env: TmuxOpenHyperlinkEnv {
                mouse_line: "see https://example.com/path, then continue".to_owned(),
                ..Default::default()
            },
            statusline: None,
        },
        Case {
            name: "missing url exits without opening",
            env: TmuxOpenHyperlinkEnv::default(),
            statusline: None,
        },
    ];

    for case in cases {
        let expected = run_shell_helper(&case);
        let mut runner = RecordingRunner::default();
        let actual_code = run_tmux_open_hyperlink(&expected.env, &mut runner);

        assert_eq!(actual_code, expected.code, "{}", case.name);
        assert_eq!(runner.calls, expected.calls, "{}", case.name);
        let _ = fs::remove_dir_all(&expected.root);
    }
}

#[derive(Clone)]
struct Case {
    name: &'static str,
    env: TmuxOpenHyperlinkEnv,
    statusline: Option<Value>,
}

#[derive(Debug, PartialEq, Eq)]
struct ShellResult {
    code: i32,
    env: TmuxOpenHyperlinkEnv,
    root: PathBuf,
    calls: Vec<(String, Vec<String>)>,
}

#[derive(Default)]
struct RecordingRunner {
    calls: Vec<(String, Vec<String>)>,
}

impl TmuxOpenHyperlinkRunner for RecordingRunner {
    fn command_exists(&mut self, program: &str) -> bool {
        program == "open"
    }

    fn run(&mut self, program: &str, args: &[String]) -> i32 {
        self.calls.push((program.to_owned(), args.to_vec()));
        0
    }
}

fn run_shell_helper(case: &Case) -> ShellResult {
    let root = temp_path("tmux-open-hyperlink");
    let state = root.join("state");
    let bin = root.join("bin");
    fs::create_dir_all(&state).expect("state dir");
    fs::create_dir_all(&bin).expect("bin dir");
    if let Some(statusline) = &case.statusline {
        fs::write(
            state.join("statusline.json"),
            serde_json::to_string(statusline).expect("statusline json"),
        )
        .expect("statusline");
    }
    write_fake_open(&bin.join("open"));
    let mut env = case.env.clone();
    env.project_state_dir = state.to_string_lossy().into_owned();
    let record_path = root.join("opened.tsv");
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("scripts")
        .join("tmux-open-hyperlink.sh");
    let mut command = Command::new("sh");
    command
        .arg(script)
        .env("PATH", fake_path(&bin))
        .env("AIMUX_OPEN_RECORD", &record_path)
        .env("AIMUX_PROJECT_STATE_DIR", &state)
        .env("AIMUX_CURRENT_WINDOW_ID", &env.current_window_id)
        .env("AIMUX_HYPERLINK", &env.hyperlink)
        .env("AIMUX_MOUSE_WORD", &env.mouse_word)
        .env("AIMUX_MOUSE_LINE", &env.mouse_line);
    let status = command.status().expect("run shell helper");
    let code = status.code().unwrap_or(1);
    let calls = fs::read_to_string(&record_path)
        .ok()
        .into_iter()
        .flat_map(|text| {
            text.lines()
                .map(|line| {
                    let mut parts = line.splitn(2, '\t');
                    (
                        parts.next().unwrap_or_default().to_owned(),
                        vec![parts.next().unwrap_or_default().to_owned()],
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect();
    ShellResult {
        code,
        env,
        root,
        calls,
    }
}

fn write_fake_open(path: &Path) {
    fs::write(
        path,
        "#!/bin/sh\nprintf 'open\\t%s\\n' \"$1\" >> \"$AIMUX_OPEN_RECORD\"\nexit 0\n",
    )
    .expect("fake open");
    let mut permissions = fs::metadata(path)
        .expect("fake open metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("fake open permissions");
}

fn fake_path(bin: &Path) -> String {
    format!(
        "{}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        bin.to_string_lossy()
    )
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}
