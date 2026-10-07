use super::text::{center, compose_two_pane, strip_ansi, truncate_ansi};
use super::theme::visible_width;

#[derive(Debug, Clone)]
pub struct ScreenFrameInput<'a> {
    pub cols: usize,
    pub rows: usize,
    pub header: &'a [String],
    pub content: &'a [String],
    pub footer_lines: &'a [String],
    pub focus_line: isize,
    pub scroll_offset: usize,
    pub two_pane: bool,
    pub right_panel: Option<&'a [String]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenFrameResult {
    pub frame: String,
    pub scroll_offset: usize,
}

pub fn screen_content_width(cols: usize) -> usize {
    72.max(cols)
}

pub fn screen_left_width(cols: usize) -> usize {
    32.max(((screen_content_width(cols) as f64) * 0.58).floor() as usize)
}

pub fn compose_screen_frame(input: &ScreenFrameInput<'_>) -> ScreenFrameResult {
    let cols = input.cols;
    let content_width = screen_content_width(cols);
    let center_in_block = |line: &str| truncate_ansi(&center(line, content_width), cols);
    let footer_indent = "  ";
    let mut footer = vec!["─".repeat(cols)];
    footer.extend(
        input
            .footer_lines
            .iter()
            .map(|line| truncate_ansi(&format!("{footer_indent}{line}"), cols)),
    );

    let viewport_height = 1.max(input.rows.saturating_sub(input.header.len() + footer.len()));
    let mut scroll_offset = input.scroll_offset;
    let focus_line = input.focus_line;
    let mut focus_end = focus_line;
    while focus_end >= 0 {
        let next = (focus_end + 1) as usize;
        if next >= input.content.len() || strip_ansi(&input.content[next]).trim().is_empty() {
            break;
        }
        focus_end += 1;
    }
    let max_scroll = input.content.len().saturating_sub(viewport_height);
    if focus_line >= 0 {
        let focus = focus_line as usize;
        let end = focus_end.max(focus_line) as usize;
        if focus < scroll_offset + 1 {
            scroll_offset = focus.saturating_sub(1);
        } else if end >= scroll_offset + viewport_height.saturating_sub(1) {
            scroll_offset = max_scroll.min(end.saturating_sub(viewport_height).saturating_add(2));
            if focus < scroll_offset + 1 {
                scroll_offset = focus.saturating_sub(1);
            }
        }
    }
    scroll_offset = scroll_offset.min(max_scroll);

    let mut visible = input
        .content
        .iter()
        .skip(scroll_offset)
        .take(viewport_height)
        .cloned()
        .collect::<Vec<_>>();
    let can_scroll_up = scroll_offset > 0;
    let can_scroll_down = scroll_offset < max_scroll;
    if can_scroll_up && !visible.is_empty() {
        visible[0] = center_in_block("\x1b[2m▲ more ▲\x1b[0m");
    }
    if can_scroll_down && !visible.is_empty() {
        let last = visible.len() - 1;
        visible[last] = center_in_block("\x1b[2m▼ more ▼\x1b[0m");
    }
    while visible.len() < viewport_height {
        visible.push(String::new());
    }

    let body = if input.two_pane {
        if let Some(right_panel) = input.right_panel {
            compose_two_pane(&visible, right_panel, content_width, Some("   "))
                .into_iter()
                .take(viewport_height)
                // Truncated to the terminal, the way the footer rows already
                // are. `content_width` is `72.max(cols)`, a MINIMUM content
                // width, so under 72 columns the two-pane body is composed
                // wider than the screen and every row of it wraps. The
                // full-screen clear hid the consequence: the layout was already
                // scrambled, but nothing was left behind. Each row erases only
                // itself now, so a wrapped row would leave the tail of the last
                // frame below it.
                // Only when it really is too wide: `truncate_ansi` appends a
                // reset whether or not it cut anything, and these rows are
                // compared byte for byte against the frames Node drew.
                .map(|line| {
                    if visible_width(&line) > cols {
                        truncate_ansi(&line, cols)
                    } else {
                        line
                    }
                })
                .collect()
        } else {
            visible
        }
    } else {
        visible
    };

    ScreenFrameResult {
        // Still wrapped in a synchronized update (DECSET 2026), and no longer
        // relying on it. The frame used to open with `\x1b[2J`, which blanks the
        // WHOLE screen before a single character of the new one is drawn -- so
        // any terminal that does not honour 2026, or that gives up on it part
        // way through a slow write, shows an empty screen on every keystroke.
        // That is the flicker.
        //
        // Each row now erases its own tail after it is drawn, so no part of the
        // screen is ever blank: a row goes straight from the old content to the
        // new. There is nothing to erase below, because the body is padded to
        // the viewport and header + body + footer is exactly `rows`.
        frame: compose_rows(input.header.iter().chain(body.iter()).chain(footer.iter())),
        scroll_offset,
    }
}

/// The bytes that put a frame on the screen, one row at a time.
///
/// `\x1b[2J` used to open every frame. It blanks the WHOLE screen before a
/// single character of the new one is drawn, so any terminal that does not
/// honour the synchronized update, or that gives up on it part way through a
/// slow write, shows an empty screen on every keystroke. That is the flicker.
///
/// Each row now clears only itself, immediately before its own content, so the
/// most that is ever blank is one row and only for the few bytes until that
/// row is drawn. The synchronized wrapper stays -- it is four bytes and it
/// still helps where it is honoured -- but nothing depends on it any more.
///
/// `\x1b[m` before each erase, because `\x1b[K` fills with the CURRENT
/// background: a row reached with a colour still open would paint it out to the
/// margin. `style` and `truncate_ansi` close every span they open, and all
/// thirteen golden frames end their rows reset, but that is a convention of the
/// theme and `header` and `content` arrive here raw.
///
/// The erase goes BEFORE the content, not after it. After is tempting -- it
/// never blanks anything -- but a row already as wide as the terminal leaves
/// the cursor on the last column with its wrap pending, and `\x1b[K` there
/// erases from the cursor inclusive and takes the character just drawn. The
/// header and footer rules are `"─".repeat(cols)`, exactly that wide, so the
/// trailing form loses the last `─` of both on every frame.
///
/// Nothing erases below the last row: `viewport_height` is whatever is left
/// after the header and the footer, and the body is padded to it, so the rows
/// here are exactly `rows`. A trailing `\x1b[J` would have the same
/// pending-wrap problem for a frame whose last row is a rule.
pub const SYNCHRONIZED_BEGIN: &str = "\x1b[?2026h";
pub const SYNCHRONIZED_END: &str = "\x1b[?2026l";

/// A composed frame split into its rows and whatever closes it.
///
/// So an overlay can be added INSIDE the synchronized update rather than after
/// it. Returns the whole frame as the rows and an empty trailer if the markers
/// are not where they are expected, which keeps a caller from silently losing
/// the frame if this ever stops being how frames are built.
pub fn split_synchronized_frame(frame: &str) -> (&str, &str) {
    match frame
        .strip_prefix(SYNCHRONIZED_BEGIN)
        .and_then(|rest| rest.strip_suffix(SYNCHRONIZED_END))
    {
        Some(rows) => (rows, SYNCHRONIZED_END),
        None => (frame, ""),
    }
}

fn compose_rows<'a>(rows: impl Iterator<Item = &'a String>) -> String {
    let mut frame = String::from("\x1b[?2026h\x1b[H");
    for (index, row) in rows.enumerate() {
        if index > 0 {
            frame.push_str("\r\n");
        }
        frame.push_str("\x1b[m\x1b[K");
        frame.push_str(row);
    }
    frame.push_str("\x1b[?2026l");
    frame
}
