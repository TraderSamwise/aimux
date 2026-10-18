use crate::dashboard_controller::DashboardKey;
use crate::dashboard_tool_picker::DashboardToolEntry;
use crate::tui_render::text::truncate_ansi;
use crate::tui_render::theme::{Tone, keycap_hint, style};
use crate::tui_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardLaunchOptionsState {
    pub tool_key: String,
    pub args: LineState,
    pub env: LineState,
    pub active_field: LaunchOptionsField,
    pub error: Option<String>,
    pub restart_session_id: Option<String>,
    pub restart_tool: Option<DashboardToolEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOptionsField {
    Args,
    Env,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineState {
    pub text: String,
    pub cursor: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchOverride {
    pub command: String,
    pub args: Vec<String>,
    pub env: Map<String, Value>,
}

impl DashboardLaunchOptionsState {
    pub fn new(tool: &DashboardToolEntry) -> Self {
        let args = tool
            .default_args
            .iter()
            .map(|arg| quote_shell_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        Self {
            tool_key: tool.key.clone(),
            args: LineState::new(args),
            env: LineState::new(format_env_defaults(&tool.default_env)),
            active_field: LaunchOptionsField::Args,
            error: None,
            restart_session_id: None,
            restart_tool: None,
        }
    }

    pub fn for_restart(session_id: String, tool: DashboardToolEntry) -> Self {
        let mut state = Self::new(&tool);
        state.restart_session_id = Some(session_id);
        state.restart_tool = Some(tool);
        state
    }

    pub fn toggle_field(&mut self) {
        if self.restart_session_id.is_some() {
            return;
        }
        self.active_field = match self.active_field {
            LaunchOptionsField::Args => LaunchOptionsField::Env,
            LaunchOptionsField::Env => LaunchOptionsField::Args,
        };
    }

    pub fn apply_edit_key(&mut self, key: DashboardKey) -> bool {
        let consumed = match self.active_field {
            LaunchOptionsField::Args => self.args.apply_key(key),
            LaunchOptionsField::Env => self.env.apply_key(key),
        };
        if consumed {
            self.error = None;
        }
        consumed
    }

    pub fn launch_override(&mut self, tool: &DashboardToolEntry) -> Result<LaunchOverride, String> {
        let extra_args = parse_shell_args(&self.args.text)?;
        let env = parse_env_assignments(&self.env.text)?;
        Ok(LaunchOverride {
            command: tool.command.clone(),
            args: tool.args.iter().cloned().chain(extra_args).collect(),
            env,
        })
    }
}

impl LineState {
    pub fn new(initial: String) -> Self {
        let cursor = initial.len();
        Self {
            text: initial,
            cursor,
        }
    }

    pub fn apply_key(&mut self, key: DashboardKey) -> bool {
        self.clamp_cursor();
        match key {
            DashboardKey::Ctrl('a') => {
                self.cursor = 0;
                true
            }
            DashboardKey::Ctrl('e') => {
                self.cursor = self.text.len();
                true
            }
            DashboardKey::Ctrl('u') => {
                self.delete_range(0, self.cursor);
                true
            }
            DashboardKey::Ctrl('k') => {
                self.text.truncate(self.cursor);
                true
            }
            DashboardKey::Ctrl('w') => {
                self.delete_range(word_start(&self.text, self.cursor), self.cursor);
                true
            }
            DashboardKey::Left => {
                self.cursor = self.previous_boundary();
                true
            }
            DashboardKey::Right => {
                self.cursor = self.next_boundary();
                true
            }
            DashboardKey::Home => {
                self.cursor = 0;
                true
            }
            DashboardKey::End => {
                self.cursor = self.text.len();
                true
            }
            DashboardKey::Backspace => {
                if self.cursor > 0 {
                    self.delete_range(self.previous_boundary(), self.cursor);
                }
                true
            }
            DashboardKey::Delete => {
                if self.cursor < self.text.len() {
                    self.delete_range(self.cursor, self.next_boundary());
                }
                true
            }
            DashboardKey::Printable(character) => {
                let insert = if character == '\r' || character == '\n' {
                    ' '
                } else {
                    character
                };
                self.text.insert(self.cursor, insert);
                self.cursor += insert.len_utf8();
                true
            }
            DashboardKey::Paste(text) => {
                let text = text.replace(['\r', '\n'], " ");
                self.text.insert_str(self.cursor, &text);
                self.cursor += text.len();
                true
            }
            _ => false,
        }
    }

    fn clamp_cursor(&mut self) {
        self.cursor = self.cursor.min(self.text.len());
        while !self.text.is_char_boundary(self.cursor) {
            self.cursor = self.cursor.saturating_sub(1);
        }
    }

    fn previous_boundary(&self) -> usize {
        self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(index, _)| index)
    }

    fn next_boundary(&self) -> usize {
        self.text[self.cursor..]
            .chars()
            .next()
            .map_or(self.cursor, |ch| self.cursor + ch.len_utf8())
    }

    fn delete_range(&mut self, start: usize, end: usize) {
        self.text.replace_range(start..end, "");
        self.cursor = start;
    }
}

pub fn render_launch_options_overlay(
    state: &DashboardLaunchOptionsState,
    tool: Option<&DashboardToolEntry>,
    cols: usize,
    rows: usize,
) -> String {
    let Some(tool) = tool else {
        let body = vec![
            format!("  {}", style("No enabled tools", Tone::Muted)),
            String::new(),
            overlay_hints(&[("Esc", "back")]),
        ];
        return render_overlay_box(&OverlayBoxSpec {
            title: "Launch options",
            body: &body,
            cols,
            rows,
            variant: OverlayVariant::Red,
            icon: None,
        });
    };
    let width = cols.saturating_sub(28).max(12);
    let args = if state.active_field == LaunchOptionsField::Args {
        render_line_window(&state.args, width)
    } else {
        truncate_ansi(&state.args.text, width)
    };
    let env = if state.active_field == LaunchOptionsField::Env {
        render_line_window(&state.env, width)
    } else {
        truncate_ansi(&state.env.text, width)
    };
    let mut extra_args = Vec::new();
    let mut env_map = Map::new();
    let mut parse_error = state.error.clone();
    match parse_shell_args(&state.args.text) {
        Ok(args) => extra_args = args,
        Err(error) => {
            if parse_error.is_none() {
                parse_error = Some(error);
            }
        }
    }
    if parse_error.is_none() {
        match parse_env_assignments(&state.env.text) {
            Ok(env) => env_map = env,
            Err(error) => parse_error = Some(error),
        }
    }
    let restarting = state.restart_session_id.is_some();
    let mut body = vec![
        format!(
            "  {} {}",
            style("Defaults:", Tone::Muted),
            command_preview(tool)
        ),
        String::new(),
        format!(
            "{} {} {}",
            field_marker(state.active_field == LaunchOptionsField::Args),
            style(&format!("{:<11}", "Extra args:"), Tone::Muted),
            args
        ),
    ];
    if !restarting {
        body.push(format!(
            "{} {} {}",
            field_marker(state.active_field == LaunchOptionsField::Env),
            style(&format!("{:<11}", "Env vars:"), Tone::Muted),
            env
        ));
    } else {
        body.push(format!(
            "  {}",
            style(
                "Args are saved for future restarts. Tool stays the same.",
                Tone::Muted
            )
        ));
    }
    body.extend([
        String::new(),
        format!(
            "  {} {}{}",
            style("Launch:", Tone::Muted),
            if parse_error.is_some() {
                String::new()
            } else {
                env_prefix(&env_map)
            },
            command_preview_with_args(tool, &extra_args)
        ),
    ]);
    if let Some(error) = parse_error.as_ref() {
        body.push(String::new());
        body.push(format!(
            "  {} {}",
            style("Error:", Tone::Danger),
            style(error, Tone::Danger)
        ));
    }
    body.push(String::new());
    body.push(if restarting {
        overlay_hints(&[("Enter", "restart"), ("Esc", "cancel")])
    } else {
        overlay_hints(&[("Tab", "switch field"), ("Enter", "start"), ("Esc", "back")])
    });
    render_overlay_box(&OverlayBoxSpec {
        title: &format!(
            "{}: {}",
            state.tool_key,
            if restarting {
                "restart with args"
            } else {
                "launch options"
            }
        ),
        body: &body,
        cols,
        rows,
        variant: if parse_error.is_some() {
            OverlayVariant::Red
        } else {
            OverlayVariant::Blue
        },
        icon: None,
    })
}

fn overlay_hints(pairs: &[(&str, &str)]) -> String {
    format!(
        "  {}",
        pairs
            .iter()
            .map(|(key, label)| keycap_hint(key, label, None))
            .collect::<Vec<_>>()
            .join("  ")
    )
}

pub fn render_line_window(state: &LineState, max_width: usize) -> String {
    let width = max_width.max(1);
    let mut byte_cursor = state.cursor.min(state.text.len());
    while !state.text.is_char_boundary(byte_cursor) {
        byte_cursor = byte_cursor.saturating_sub(1);
    }
    let cursor = state.text[..byte_cursor].chars().count();
    let base = if byte_cursor >= state.text.len() {
        format!("{} ", state.text)
    } else {
        state.text.clone()
    };
    let chars = base.chars().collect::<Vec<_>>();
    // UTF-8 byte lengths conservatively bound terminal cells, including wide glyphs.
    let mut start = cursor;
    let mut used = chars[cursor].len_utf8().min(width);
    while start > 0 && used + chars[start - 1].len_utf8() <= width {
        start -= 1;
        used += chars[start].len_utf8();
    }
    let mut end = cursor + 1;
    while end < chars.len() && used + chars[end].len_utf8() <= width {
        used += chars[end].len_utf8();
        end += 1;
    }
    let mut output = String::new();
    for (index, character) in chars.iter().enumerate().take(end).skip(start) {
        if index == cursor {
            output.push_str("\x1b[7m");
            output.push(if character.len_utf8() > width {
                ' '
            } else {
                *character
            });
            output.push_str("\x1b[27m");
        } else {
            output.push(*character);
        }
    }
    output
}

pub fn parse_shell_args(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaping = false;
    let mut token_started = false;

    for character in input.chars() {
        if escaping {
            current.push(character);
            escaping = false;
            token_started = true;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaping = true;
            token_started = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
                token_started = true;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            token_started = true;
            continue;
        }
        if character.is_whitespace() {
            if token_started {
                args.push(std::mem::take(&mut current));
                token_started = false;
            }
            continue;
        }
        current.push(character);
        token_started = true;
    }

    if escaping {
        current.push('\\');
    }
    if let Some(quote) = quote {
        return Err(format!(
            "unterminated {} quote",
            if quote == '\'' { "single" } else { "double" }
        ));
    }
    if token_started {
        args.push(current);
    }
    Ok(args)
}

pub fn parse_env_assignments(input: &str) -> Result<Map<String, Value>, String> {
    let mut env = Map::new();
    for token in parse_shell_args(input)? {
        let Some((name, value)) = token.split_once('=') else {
            return Err(format!("invalid env var \"{token}\" (expected NAME=VALUE)"));
        };
        if !valid_env_name(name) {
            return Err(format!("invalid env var \"{token}\" (expected NAME=VALUE)"));
        }
        env.insert(name.to_owned(), Value::String(value.to_owned()));
    }
    Ok(env)
}

pub fn format_env_defaults(env: &Map<String, Value>) -> String {
    env.iter()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(|value| format!("{key}={}", quote_shell_arg(value)))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn quote_shell_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "''".into();
    }
    if arg
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"_./:=@%+,-".contains(&byte))
    {
        return arg.to_owned();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn command_preview(tool: &DashboardToolEntry) -> String {
    command_preview_with_args(tool, &[])
}

fn command_preview_with_args(tool: &DashboardToolEntry, extra_args: &[String]) -> String {
    std::iter::once(tool.command.as_str())
        .chain(tool.args.iter().map(String::as_str))
        .chain(extra_args.iter().map(String::as_str))
        .map(quote_shell_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn env_prefix(env: &Map<String, Value>) -> String {
    if env.is_empty() {
        return String::new();
    }
    format!(
        "env {} ",
        env.iter()
            .filter_map(|(key, value)| value
                .as_str()
                .map(|value| format!("{key}={}", quote_shell_arg(value))))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn field_marker(active: bool) -> String {
    if active {
        style("▸", Tone::Accent)
    } else {
        " ".into()
    }
}

fn word_start(text: &str, from: usize) -> usize {
    let bytes = text.as_bytes();
    let mut index = from.min(bytes.len());
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    while index > 0 && !bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    index
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
