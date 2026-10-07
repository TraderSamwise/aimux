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
                .collect()
        } else {
            visible
        }
    } else {
        visible
    };

    ScreenFrameResult {
        frame: compose_rows(
            input.header.iter().chain(body.iter()).chain(footer.iter()),
            cols,
        ),
        scroll_offset,
    }
}

pub const SYNCHRONIZED_BEGIN: &str = "\x1b[?2026h";
pub const SYNCHRONIZED_END: &str = "\x1b[?2026l";

/// A composed frame's rows, with its synchronized wrapper taken off.
///
/// So an overlay can be added INSIDE the update rather than after it. A frame
/// that does not carry the markers is returned whole, and the caller wraps it
/// either way -- an earlier version returned an empty trailer for that case,
/// which had the caller open a synchronized update it never closed. A terminal
/// left inside one stops painting.
pub fn unwrap_synchronized_frame(frame: &str) -> &str {
    frame
        .strip_prefix(SYNCHRONIZED_BEGIN)
        .and_then(|rest| rest.strip_suffix(SYNCHRONIZED_END))
        .unwrap_or(frame)
}

/// The bytes that put a frame on the screen, one row at a time.
///
/// `\x1b[2J` used to open every frame, blanking the WHOLE screen before a single
/// character of the new one was drawn. Each row now clears only itself,
/// immediately before its own content, so the most that is ever blank is one
/// row and only for the few bytes until that row is drawn. The synchronized
/// wrapper stays -- four bytes, and it still helps where it is honoured -- but
/// nothing depends on it any more.
///
/// NOT, as an earlier version of this comment said, "the flicker". A review of
/// PR 407 established that tmux honours the synchronized update itself and
/// emits its own cell diff, so inside tmux -- which is where this dashboard
/// runs -- the clear never reached the terminal as a separate paint and taking
/// it out changes nothing visible. It is removed because a repaint should not
/// depend on a terminal feature to avoid blanking the screen, and that is the
/// whole claim.
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
///
/// The row widths are only as honest as `visible_width`, which counts UTF-16
/// units rather than terminal cells. Forty CJW characters measure forty and
/// occupy eighty, so a row of them is not truncated, wraps, and -- with the
/// clear gone -- orphans the previous frame's tail below it. That metric is
/// what the whole layout is built on and every parity frame is captured
/// against, so it is said here rather than changed.
fn compose_rows<'a>(rows: impl Iterator<Item = &'a String>, cols: usize) -> String {
    let mut frame = String::from("\x1b[?2026h\x1b[H");
    for (index, row) in rows.enumerate() {
        if index > 0 {
            frame.push_str("\r\n");
        }
        frame.push_str("\x1b[m\x1b[K");
        // Every row, not only the two-pane body. `center` pads to
        // `72.max(cols)` and only ever pads, so under 72 columns the header
        // title, the plain content rows and the footer hints all arrive wider
        // than the screen. Each one wraps, shifts every row after it, and --
        // now that a row erases only itself -- orphans the tail of the last
        // frame below it. Only when it really is too wide: `truncate_ansi`
        // appends a reset whether or not it cut anything, and these rows are
        // compared byte for byte against the frames Node drew.
        if visible_width(row) > cols {
            frame.push_str(&truncate_ansi(row, cols));
        } else {
            frame.push_str(row);
        }
    }
    frame.push_str("\x1b[?2026l");
    frame
}
