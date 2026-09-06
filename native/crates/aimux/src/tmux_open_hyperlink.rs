use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxOpenHyperlinkEnv {
    pub project_state_dir: String,
    pub current_window_id: String,
    pub hyperlink: String,
    pub mouse_word: String,
    pub mouse_line: String,
}

impl TmuxOpenHyperlinkEnv {
    pub fn from_process_env() -> Self {
        Self {
            project_state_dir: std::env::var("AIMUX_PROJECT_STATE_DIR").unwrap_or_default(),
            current_window_id: std::env::var("AIMUX_CURRENT_WINDOW_ID").unwrap_or_default(),
            hyperlink: std::env::var("AIMUX_HYPERLINK").unwrap_or_default(),
            mouse_word: std::env::var("AIMUX_MOUSE_WORD").unwrap_or_default(),
            mouse_line: std::env::var("AIMUX_MOUSE_LINE").unwrap_or_default(),
        }
    }
}

pub trait TmuxOpenHyperlinkRunner {
    fn command_exists(&mut self, program: &str) -> bool;
    fn run(&mut self, program: &str, args: &[String]) -> i32;
}

pub struct SystemTmuxOpenHyperlinkRunner;

impl TmuxOpenHyperlinkRunner for SystemTmuxOpenHyperlinkRunner {
    fn command_exists(&mut self, program: &str) -> bool {
        Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {}", shell_word(program)))
            .status()
            .is_ok_and(|status| status.success())
    }

    fn run(&mut self, program: &str, args: &[String]) -> i32 {
        Command::new(program)
            .args(args)
            .status()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1)
    }
}

pub fn run_tmux_open_hyperlink_from_env() -> i32 {
    let env = TmuxOpenHyperlinkEnv::from_process_env();
    let mut runner = SystemTmuxOpenHyperlinkRunner;
    run_tmux_open_hyperlink(&env, &mut runner)
}

pub fn run_tmux_open_hyperlink(
    env: &TmuxOpenHyperlinkEnv,
    runner: &mut impl TmuxOpenHyperlinkRunner,
) -> i32 {
    let Some(url) = resolve_tmux_open_hyperlink_url(env) else {
        return 1;
    };
    let args = vec![url];
    if runner.command_exists("open") {
        return runner.run("open", &args);
    }
    if runner.command_exists("xdg-open") {
        return runner.run("xdg-open", &args);
    }
    1
}

pub fn resolve_tmux_open_hyperlink_url(env: &TmuxOpenHyperlinkEnv) -> Option<String> {
    if !env.hyperlink.is_empty() {
        return Some(env.hyperlink.clone());
    }
    resolve_pr_url(&env.project_state_dir, &env.current_window_id)
        .or_else(|| extract_from_text(env))
}

fn resolve_pr_url(project_state_dir: &str, current_window_id: &str) -> Option<String> {
    if project_state_dir.is_empty() || current_window_id.is_empty() {
        return None;
    }
    let text = fs::read_to_string(Path::new(project_state_dir).join("statusline.json")).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    let sessions = data.get("sessions")?.as_array()?;
    for session in sessions {
        if session.get("tmuxWindowId").and_then(Value::as_str) != Some(current_window_id) {
            continue;
        }
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(url) = data
            .get("metadata")
            .and_then(|metadata| metadata.get(session_id))
            .and_then(|metadata| metadata.get("context"))
            .and_then(|context| context.get("pr"))
            .and_then(|pr| pr.get("url"))
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
        else {
            continue;
        };
        return Some(url.to_owned());
    }
    None
}

fn extract_from_text(env: &TmuxOpenHyperlinkEnv) -> Option<String> {
    [
        ("AIMUX_HYPERLINK", env.hyperlink.as_str()),
        ("AIMUX_MOUSE_WORD", env.mouse_word.as_str()),
        ("AIMUX_MOUSE_LINE", env.mouse_line.as_str()),
    ]
    .into_iter()
    .filter(|(_, value)| !value.is_empty())
    .find_map(|(key, value)| {
        let value = if matches!(key, "AIMUX_HYPERLINK" | "AIMUX_MOUSE_WORD") {
            trim_wrapping_link_punctuation(value)
        } else {
            value
        };
        first_http_url(value)
    })
}

fn trim_wrapping_link_punctuation(value: &str) -> &str {
    value
        .trim_start_matches(['<', '(', '[', '"', '\''])
        .trim_end_matches(['>', ')', ']', ',', '.', ';', ':', '!', '?', '"', '\''])
}

fn first_http_url(value: &str) -> Option<String> {
    let mut start = None;
    for needle in ["http://", "https://"] {
        if let Some(index) = value.find(needle) {
            start = Some(start.map_or(index, |current: usize| current.min(index)));
        }
    }
    let start = start?;
    let rest = &value[start..];
    let end = rest
        .char_indices()
        .find_map(|(index, ch)| {
            if ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\'' | ')' | ']') {
                Some(index)
            } else {
                None
            }
        })
        .unwrap_or(rest.len());
    Some(rest[..end].to_owned())
}

fn shell_word(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.'))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
