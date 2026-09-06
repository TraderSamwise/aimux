use super::text::{center, compose_two_pane, strip_ansi, truncate_ansi};

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
        } else {
            visible
        }
    } else {
        visible
    };

    ScreenFrameResult {
        frame: format!(
            "\x1b[2J\x1b[H{}",
            input
                .header
                .iter()
                .chain(body.iter())
                .chain(footer.iter())
                .cloned()
                .collect::<Vec<_>>()
                .join("\r\n")
        ),
        scroll_offset,
    }
}
