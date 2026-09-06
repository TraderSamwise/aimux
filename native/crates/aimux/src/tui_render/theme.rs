use super::text::{sgr_end, strip_ansi, truncate_ansi};

const RESET: &str = "\x1b[0m";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tone {
    Text,
    Muted,
    Strong,
    Accent,
    Work,
    Attention,
    Done,
    Danger,
    Blocked,
    Info,
    Ready,
    Idle,
    Sleep,
}

fn tone_sgr(tone: Tone) -> &'static str {
    match tone {
        Tone::Text => "",
        Tone::Muted => "\x1b[2m",
        Tone::Strong => "\x1b[1m",
        Tone::Accent | Tone::Attention => "\x1b[1;33m",
        Tone::Work => "\x1b[36m",
        Tone::Done => "\x1b[32m",
        Tone::Danger => "\x1b[31m",
        Tone::Blocked => "\x1b[35m",
        Tone::Info => "\x1b[34m",
        Tone::Ready => "\x1b[38;5;75m",
        Tone::Idle => "\x1b[2;32m",
        Tone::Sleep => "\x1b[38;5;103m",
    }
}

pub fn style(text: &str, tone: Tone) -> String {
    let sgr = tone_sgr(tone);
    if sgr.is_empty() {
        text.to_owned()
    } else {
        format!("{sgr}{text}{RESET}")
    }
}

pub fn recede(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    const FAINT: &str = "\x1b[2;38;5;240m";
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len() + FAINT.len() + RESET.len());
    output.push_str(FAINT);
    let mut index = 0;

    while index < bytes.len() {
        if let Some(end) = sgr_end(bytes, index) {
            let params = &text[index + 2..end - 1];
            let reset_rest = if params.is_empty() || params == "0" {
                Some("")
            } else {
                params.strip_prefix("0;").filter(|rest| {
                    rest.bytes()
                        .all(|byte| byte.is_ascii_digit() || byte == b';')
                })
            };
            if let Some(rest) = reset_rest {
                output.push_str(RESET);
                output.push_str(FAINT);
                if !rest.is_empty() {
                    output.push_str("\x1b[");
                    output.push_str(rest);
                    output.push('m');
                }
            } else {
                output.push_str(&text[index..end]);
            }
            index = end;
            continue;
        }

        let character = text[index..]
            .chars()
            .next()
            .expect("index must be at a UTF-8 character boundary");
        output.push(character);
        index += character.len_utf8();
    }

    output.push_str(RESET);
    output
}

pub fn visible_width(text: &str) -> usize {
    strip_ansi(text).chars().count()
}

pub fn pad_visible(text: &str, width: usize) -> String {
    let current = visible_width(text);
    if current == width {
        text.to_owned()
    } else if current > width {
        truncate_ansi(text, width)
    } else {
        format!("{text}{}", " ".repeat(width - current))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Column<'a> {
    pub content: &'a str,
    pub width: usize,
}

pub fn cols(columns: &[Column<'_>]) -> String {
    columns
        .iter()
        .map(|column| pad_visible(column.content, column.width))
        .collect()
}

pub fn pill(label: &str, tone: Tone) -> String {
    let base = tone_sgr(tone);
    let sgr = if base.is_empty() {
        "\x1b[7m".to_owned()
    } else {
        format!("{};7m", base.trim_end_matches('m'))
    };
    format!("{sgr} {label} {RESET}")
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ChipTone {
    #[default]
    Info,
    Work,
    Attention,
    Muted,
    Danger,
}

pub fn chip(label: &str, tone: ChipTone) -> String {
    let foreground = match tone {
        ChipTone::Info => 117,
        ChipTone::Work => 80,
        ChipTone::Attention => 179,
        ChipTone::Muted => 245,
        ChipTone::Danger => 174,
    };
    format!("\x1b[48;5;236;38;5;{foreground}m {label} {RESET}")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyTone {
    Danger,
}

pub fn keycap(key: &str, tone: Option<KeyTone>) -> String {
    let foreground = if tone == Some(KeyTone::Danger) {
        203
    } else {
        255
    };
    format!("\x1b[48;5;240;38;5;{foreground}m {key} {RESET}")
}

pub fn keycap_hint(key: &str, label: &str, tone: Option<KeyTone>) -> String {
    if label.is_empty() {
        keycap(key, tone)
    } else {
        format!("{} {}", keycap(key, tone), style(label, Tone::Muted))
    }
}

pub fn footer_key(key: &str, tone: Option<KeyTone>) -> String {
    let foreground = if tone == Some(KeyTone::Danger) {
        203
    } else {
        255
    };
    format!("\x1b[1;38;5;{foreground}m{key}{RESET}")
}

fn parse_hint_group(group: &str) -> (&str, &str) {
    if let Some(without_open) = group.strip_prefix('[')
        && let Some(close) = without_open.find(']')
    {
        return (
            &without_open[..close],
            without_open[close + 1..].trim_start(),
        );
    }
    group
        .split_once(' ')
        .map_or((group, ""), |(key, label)| (key, label))
}

fn hint_groups(line: &str) -> Vec<&str> {
    let line = line.trim();
    let mut groups = Vec::new();
    let mut group_start = 0;
    let mut characters = line.char_indices().peekable();

    while let Some((index, character)) = characters.next() {
        if !character.is_whitespace() {
            continue;
        }
        let run_start = index;
        let mut run_end = index + character.len_utf8();
        let mut run_length = 1;
        while let Some(&(next_index, next_character)) = characters.peek() {
            if !next_character.is_whitespace() {
                break;
            }
            characters.next();
            run_end = next_index + next_character.len_utf8();
            run_length += 1;
        }
        if run_length >= 2 {
            if group_start < run_start {
                groups.push(&line[group_start..run_start]);
            }
            group_start = run_end;
        }
    }
    if group_start < line.len() {
        groups.push(&line[group_start..]);
    }
    groups
}

fn style_hint_group(group: &str) -> String {
    let (key, label) = parse_hint_group(group);
    keycap_hint(key, label, None)
}

pub fn keycap_hints(line: &str) -> String {
    hint_groups(line)
        .into_iter()
        .map(style_hint_group)
        .collect::<Vec<_>>()
        .join("  ")
}

pub fn footer_hints(line: &str) -> String {
    hint_groups(line)
        .into_iter()
        .map(|group| {
            let (key, label) = parse_hint_group(group);
            if label.is_empty() {
                footer_key(key, None)
            } else {
                format!("{} {}", footer_key(key, None), style(label, Tone::Muted))
            }
        })
        .collect::<Vec<_>>()
        .join("  ")
}

pub fn keycap_hint_lines(line: &str, width: usize) -> Vec<String> {
    let groups = hint_groups(line)
        .into_iter()
        .map(style_hint_group)
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    let mut current = String::new();

    for group in groups {
        let next = if current.is_empty() {
            group.clone()
        } else {
            format!("{current}  {group}")
        };
        if visible_width(&next) <= width {
            current = next;
        } else {
            if !current.is_empty() {
                lines.push(current);
            }
            current = group;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

#[derive(Clone, Copy, Debug)]
pub struct FooterHint<'a> {
    pub key: &'a str,
    pub label: &'a str,
    pub tone: Option<KeyTone>,
}

pub fn render_footer_hints(hints: &[FooterHint<'_>], width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();

    for hint in hints {
        let token = format!(
            "{} {}",
            footer_key(hint.key, hint.tone),
            style(hint.label, Tone::Muted)
        );
        let candidate = if line.is_empty() {
            token.clone()
        } else {
            format!("{line}  {token}")
        };
        if line.is_empty() || visible_width(&candidate) <= width {
            line = candidate;
        } else {
            lines.push(line);
            line = token;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BandTone {
    Info,
    Danger,
}

pub fn modal_band(label: &str, tone: BandTone, width: usize) -> String {
    let sgr = match tone {
        BandTone::Info => "\x1b[1;48;5;24;38;5;195m",
        BandTone::Danger => "\x1b[1;48;5;52;38;5;224m",
    };
    format!("{sgr}{}{RESET}", pad_visible(&format!(" {label}"), width))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusKind {
    Working,
    Ready,
    Idle,
    Offline,
    Needs,
    Error,
    Done,
    Blocked,
    Service,
    ServiceOff,
}

pub fn status_tone(kind: StatusKind) -> Tone {
    match kind {
        StatusKind::Working => Tone::Work,
        StatusKind::Ready => Tone::Ready,
        StatusKind::Idle => Tone::Idle,
        StatusKind::Offline | StatusKind::ServiceOff => Tone::Muted,
        StatusKind::Needs => Tone::Attention,
        StatusKind::Error => Tone::Danger,
        StatusKind::Done | StatusKind::Service => Tone::Done,
        StatusKind::Blocked => Tone::Blocked,
    }
}

pub fn status_dot(kind: StatusKind) -> String {
    let glyph = match kind {
        StatusKind::Working
        | StatusKind::Ready
        | StatusKind::Idle
        | StatusKind::Error
        | StatusKind::Done
        | StatusKind::Blocked => "●",
        StatusKind::Offline => "○",
        StatusKind::Needs => "◉",
        StatusKind::Service => "◆",
        StatusKind::ServiceOff => "◇",
    };
    style(glyph, status_tone(kind))
}

fn tmux_color(tone: Tone) -> Option<&'static str> {
    match tone {
        Tone::Muted => Some("colour244"),
        Tone::Accent | Tone::Attention => Some("yellow"),
        Tone::Work | Tone::Info => Some("cyan"),
        Tone::Done | Tone::Idle => Some("green"),
        Tone::Danger => Some("red"),
        Tone::Blocked => Some("magenta"),
        Tone::Ready => Some("colour75"),
        Tone::Text | Tone::Strong | Tone::Sleep => None,
    }
}

pub fn tmux_style(text: &str, tone: Tone) -> String {
    tmux_color(tone).map_or_else(
        || text.to_owned(),
        |color| format!("#[fg={color}]{text}#[default]"),
    )
}

pub fn tmux_invert(text: &str, tone: Tone) -> String {
    let color = tmux_color(tone).unwrap_or("white");
    format!("#[fg=black,bg={color}]{text}#[default]")
}

pub fn divider(width: usize, tone: Tone) -> String {
    style(&"─".repeat(width), tone)
}

#[derive(Clone, Copy, Debug)]
pub struct CardSpec<'a> {
    pub tone: Tone,
    pub title: &'a str,
    pub summary: Option<&'a str>,
    pub rows: &'a [String],
    pub width: usize,
}

pub fn card(spec: &CardSpec<'_>) -> Vec<String> {
    let width = spec.width.max(8);
    let inner = width - 4;
    let border = |segment: &str| style(segment, spec.tone);
    let mut lines = Vec::new();

    let frame = 6;
    let mut summary = spec.summary.unwrap_or("");
    let mut summary_cost = if summary.is_empty() {
        0
    } else {
        visible_width(summary) + 2
    };
    let mut title_max = width.saturating_sub(frame + summary_cost);
    if title_max < 1 && !summary.is_empty() {
        summary = "";
        summary_cost = 0;
        title_max = width.saturating_sub(frame);
    }
    let fitted_title = if visible_width(spec.title) > title_max {
        truncate_ansi(spec.title, title_max)
    } else {
        spec.title.to_owned()
    };
    let title_separator = if visible_width(&fitted_title) > 0 {
        " "
    } else {
        ""
    };
    let used = 2 + visible_width(&fitted_title) + title_separator.len() + summary_cost + 1;
    let dashes = 2.max(width.saturating_sub(used));
    let mut top = format!(
        "{}{}{}{}",
        border("╭ "),
        fitted_title,
        title_separator,
        border(&"─".repeat(dashes))
    );
    if !summary.is_empty() {
        top.push_str(&format!(" {summary} "));
    }
    top.push_str(&border("╮"));
    lines.push(pad_visible(&top, width));

    for row in spec.rows {
        lines.push(format!(
            "{}{}{}",
            border("│ "),
            pad_visible(row, inner),
            border(" │")
        ));
    }

    lines.push(format!(
        "{}{}{}",
        border("╰"),
        border(&"─".repeat(width - 2)),
        border("╯")
    ));
    lines
}
