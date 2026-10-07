use aimux::tui_render::box_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use aimux::tui_render::screen_frame::{
    ScreenFrameInput, compose_screen_frame, screen_content_width, screen_left_width,
};
use aimux::tui_render::text::{
    compose_two_pane, strip_ansi, strip_terminal_control, truncate, truncate_ansi, truncate_plain,
    wrap_key_value, wrap_text,
};
use aimux::tui_render::theme::{
    ChipTone, Column, PROGRESS_MARK, StatusKind, Tone, chip, cols, keycap, note_line, pad_visible,
    pill, progress_label, progress_line, status_dot, style, visible_width,
};

#[test]
fn visible_width_ignores_ansi_sgr_sequences() {
    let styled = style("hello", Tone::Work);
    assert_eq!(strip_ansi(&styled), "hello");
    assert_eq!(visible_width(&styled), 5);
    assert_eq!(visible_width("\x1b[1;38;5;75mready\x1b[0m"), 5);
}

#[test]
fn truncates_pads_and_wraps_like_the_typescript_helpers() {
    assert_eq!(truncate_plain("abcdef", 4), "abc…");
    assert_eq!(truncate_plain("abcdef", 1), "a");
    assert_eq!(visible_width("a😀b"), 4);
    assert_eq!(truncate_plain("😀x", 2), "\u{fffd}…");
    assert_eq!(truncate("😀x", 2), "😀…");

    let truncated = truncate_ansi(&style("abcdef", Tone::Work), 4);
    assert_eq!(strip_ansi(&truncated), "abc…");
    assert!(truncated.contains("\x1b[36m"));
    assert!(truncated.ends_with("\x1b[0m"));

    assert_eq!(strip_ansi(&pad_visible("ab", 5)), "ab   ");
    assert_eq!(visible_width(&pad_visible(&style("ab", Tone::Work), 6)), 6);
    assert_eq!(
        wrap_text(" alpha   bravo charlie ", 12),
        ["alpha bravo", "charlie"]
    );
    assert_eq!(wrap_text("abcdefghijkl", 8), ["abcdefg…"]);
    assert_eq!(
        wrap_key_value("Name", "alpha bravo charlie", 16),
        ["Name: alpha", "      bravo", "      charlie"]
    );
}

#[test]
fn styled_primitives_keep_their_exact_visible_widths() {
    assert_eq!(style("hi", Tone::Danger), "\x1b[31mhi\x1b[0m");

    let done = pill("OK", Tone::Done);
    assert_eq!(strip_ansi(&done), " OK ");
    assert!(done.contains(";7m"));
    assert_eq!(visible_width(&done), 4);
    assert_eq!(visible_width(&chip("22 unseen", ChipTone::Info)), 11);
    assert_eq!(visible_width(&keycap("q", None)), 3);

    for kind in [
        StatusKind::Working,
        StatusKind::Ready,
        StatusKind::Idle,
        StatusKind::Offline,
        StatusKind::Needs,
        StatusKind::Error,
        StatusKind::Done,
        StatusKind::Blocked,
        StatusKind::Service,
        StatusKind::ServiceOff,
    ] {
        assert_eq!(visible_width(&status_dot(kind)), 1);
    }
    assert_eq!(strip_ansi(&status_dot(StatusKind::Offline)), "○");
    assert_eq!(strip_ansi(&status_dot(StatusKind::Needs)), "◉");
    assert!(status_dot(StatusKind::Error).contains("\x1b[31m"));
}

#[test]
fn columns_and_two_pane_composition_obey_width_budgets() {
    let dot = status_dot(StatusKind::Working);
    let name = style("codex", Tone::Strong);
    let state = pill("WORKING", Tone::Work);
    let line = cols(&[
        Column {
            content: &dot,
            width: 2,
        },
        Column {
            content: &name,
            width: 10,
        },
        Column {
            content: &state,
            width: 14,
        },
    ]);
    assert_eq!(visible_width(&line), 26);

    let composed = compose_two_pane(&["left".into()], &["right".into()], 80, Some("  ||  "));
    assert_eq!(composed.len(), 1);
    assert!(strip_ansi(&composed[0]).contains("left"));
    assert!(strip_ansi(&composed[0]).contains("right"));
    assert!(strip_ansi(&composed[0]).contains("||"));
    assert!(visible_width(&composed[0]) <= 80);
}

#[test]
fn overlay_box_rows_share_one_frame_width_and_fit_the_viewport() {
    let body = vec!["  body line".to_owned(), style("bold", Tone::Strong)];
    let output = render_overlay_box(&OverlayBoxSpec {
        title: "Title",
        body: &body,
        cols: 80,
        rows: 24,
        variant: OverlayVariant::Blue,
        icon: None,
    });
    let rows = positioned_rows(&output);
    assert_eq!(rows.len(), 6);
    let widths = rows
        .iter()
        .map(|row| visible_width(row))
        .collect::<Vec<_>>();
    assert!(widths.iter().all(|width| *width == widths[0]));
    assert!(widths[0] <= 80);

    let plain = rows.iter().map(|row| strip_ansi(row)).collect::<String>();
    assert!(plain.contains("╭"));
    assert!(plain.contains("╮"));
    assert!(plain.contains("├"));
    assert!(plain.contains("┤"));
    assert!(plain.contains("TITLE"));
    assert!(plain.contains("body line"));
    assert!(output.contains("\x1b[34m"));
}

#[test]
fn danger_overlay_has_warning_glyph_and_uniform_truncated_rows() {
    let body = vec!["x".repeat(300)];
    let output = render_overlay_box(&OverlayBoxSpec {
        title: "Danger",
        body: &body,
        cols: 80,
        rows: 24,
        variant: OverlayVariant::Red,
        icon: None,
    });
    let rows = positioned_rows(&output);
    let widths = rows
        .iter()
        .map(|row| visible_width(row))
        .collect::<Vec<_>>();
    assert!(widths.iter().all(|width| *width == widths[0]));
    assert!(widths[0] <= 80);
    assert!(output.contains("\x1b[31m"));
    assert!(rows.iter().any(|row| strip_ansi(row).contains('⚠')));
}

#[test]
fn screen_frame_scrolls_to_focused_card_and_renders_footer() {
    let header = vec![
        String::new(),
        "aimux".to_owned(),
        "─".repeat(80),
        String::new(),
    ];
    let content = (0..12)
        .map(|index| format!("row-{index}"))
        .collect::<Vec<_>>();
    let footer = vec!["q quit".to_owned()];

    let result = compose_screen_frame(&ScreenFrameInput {
        cols: 80,
        rows: 10,
        header: &header,
        content: &content,
        footer_lines: &footer,
        focus_line: 10,
        scroll_offset: 0,
        two_pane: false,
        right_panel: None,
    });
    let plain = strip_ansi(&result.frame);

    assert!(result.scroll_offset > 0);
    // A repaint never blanks the screen. `\x1b[2J` used to open every frame and
    // clears the WHOLE screen before any of the new one is drawn, so a terminal
    // that does not honour the synchronized update -- or gives up on it part
    // way through a slow write -- shows an empty screen on every keystroke.
    // Each row clears only itself now, immediately before its own content, so
    // at most one row is ever blank and only for the bytes until it is drawn.
    assert!(
        !result.frame.contains("\x1b[2J"),
        "a frame must not clear the whole screen: {:?}",
        &result.frame[..result.frame.len().min(40)]
    );
    assert!(
        result.frame.starts_with("\x1b[?2026h\x1b[H"),
        "frame must open a synchronized update and home the cursor"
    );
    // Every row, and the erase BEFORE the content: after it, a row as wide as
    // the terminal sits at the pending-wrap column where `\x1b[K` erases the
    // cell the cursor is on and takes the character just drawn. The header and
    // footer rules are `"─".repeat(cols)`, exactly that wide.
    let rows = result
        .frame
        .strip_prefix("\x1b[?2026h\x1b[H")
        .and_then(|rest| rest.strip_suffix("\x1b[?2026l"))
        .expect("a synchronized frame")
        .split("\r\n")
        .collect::<Vec<_>>();
    assert!(
        rows.iter().all(|row| row.starts_with("\x1b[m\x1b[K")),
        "every row has to clear itself before drawing, or the last frame's \
         longer rows leave their tails behind"
    );
    assert!(
        plain.ends_with("\x1b[?2026l"),
        "frame must close the synchronized update"
    );
    assert!(plain.contains("row-10"));
    assert!(plain.contains("▼ more ▼") || plain.contains("▲ more ▲"));
    assert!(plain.contains("──"));
    assert!(plain.contains("  q quit"));
}

#[test]
fn screen_frame_matches_dashboard_geometry_helpers_and_two_pane_body() {
    assert_eq!(screen_content_width(40), 72);
    assert_eq!(screen_content_width(120), 120);
    assert_eq!(screen_left_width(40), 41);
    assert_eq!(screen_left_width(120), 69);

    let header: Vec<String> = Vec::new();
    let footer: Vec<String> = Vec::new();
    let left = vec!["left".to_owned()];
    let right = vec!["right".to_owned()];
    let result = compose_screen_frame(&ScreenFrameInput {
        cols: 80,
        rows: 4,
        header: &header,
        content: &left,
        footer_lines: &footer,
        focus_line: -1,
        scroll_offset: 0,
        two_pane: true,
        right_panel: Some(&right),
    });

    assert!(strip_ansi(&result.frame).contains("left"));
    assert!(strip_ansi(&result.frame).contains("right"));
    // Measured on the content: the row carries its own `\x1b[m\x1b[K`, and
    // `strip_ansi` is SGR-only, so it would count those five bytes as width.
    let body_line = strip_terminal_control(result.frame.split("\r\n").nth(1).unwrap_or(""));
    assert!(visible_width(&body_line) <= 80);
}

/// Every row fits the terminal, including one narrower than the content floor.
///
/// `screen_content_width` is `72.max(cols)` -- a MINIMUM content width -- so a
/// two-pane body at 40 columns is composed 72 wide and every row of it wraps.
/// The suite only ever composed at 80 and above, and the full-screen clear hid
/// the consequence: the layout was scrambled but nothing was left behind. Each
/// row erases only itself now, so a wrapped row leaves the tail of the last
/// frame on the line below it.
#[test]
fn a_narrow_terminal_gets_rows_that_fit_it() {
    let header = vec!["head".to_owned()];
    let footer = vec!["q quit".to_owned()];
    let left = (0..6).map(|n| format!("left row {n}")).collect::<Vec<_>>();
    let right = (0..6).map(|n| format!("right row {n}")).collect::<Vec<_>>();
    let result = compose_screen_frame(&ScreenFrameInput {
        cols: 40,
        rows: 12,
        header: &header,
        content: &left,
        footer_lines: &footer,
        focus_line: -1,
        scroll_offset: 0,
        two_pane: true,
        right_panel: Some(&right),
    });

    for (index, row) in strip_terminal_control(&result.frame)
        .split("\r\n")
        .enumerate()
    {
        assert!(
            visible_width(row) <= 40,
            "row {} is {} wide in a 40 column terminal and will wrap: {:?}",
            index + 1,
            visible_width(row),
            strip_ansi(row)
        );
    }
}

fn positioned_rows(output: &str) -> Vec<&str> {
    let bytes = output.as_bytes();
    let mut markers = Vec::new();
    let mut index = 0;
    while index + 2 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }
        let mut end = index + 2;
        let row_start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if end == row_start || bytes.get(end) != Some(&b';') {
            index += 1;
            continue;
        }
        end += 1;
        let column_start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if end != column_start && bytes.get(end) == Some(&b'H') {
            markers.push((index, end + 1));
            index = end + 1;
        } else {
            index += 1;
        }
    }

    markers
        .iter()
        .enumerate()
        .map(|(marker_index, (_, content_start))| {
            let content_end = markers
                .get(marker_index + 1)
                .map_or(output.len().saturating_sub(2), |(start, _)| *start);
            &output[*content_start..content_end]
        })
        .collect()
}

/// The danger red (`31m`) and the danger keycap foreground (`203`) are the two
/// spellings of "this failed". Progress and notes must carry neither, which is
/// the whole of what Sam reported: `! Restored 9 agents`.
mod a_transient_line_is_not_painted_as_a_failure {
    use super::*;

    const DANGER_SGR: &str = "\u{1b}[31m";
    const DANGER_KEYCAP_FOREGROUND: &str = "38;5;203";

    #[test]
    fn progress_carries_the_working_tone_and_no_danger_spelling() {
        let line = progress_line("Restoring 36 agents");
        assert!(line.contains(PROGRESS_MARK), "{line:?}");
        assert!(
            line.contains(&style("", Tone::Work).replace("\u{1b}[0m", "")),
            "progress must use the working tone: {line:?}"
        );
        assert!(!line.contains(DANGER_SGR), "{line:?}");
        assert!(!line.contains(DANGER_KEYCAP_FOREGROUND), "{line:?}");
        assert!(!line.contains('!'), "{line:?}");
    }

    #[test]
    fn a_note_carries_no_danger_spelling_either() {
        let line = note_line("Restored 9 agents");
        assert!(!line.contains(DANGER_SGR), "{line:?}");
        assert!(!line.contains(DANGER_KEYCAP_FOREGROUND), "{line:?}");
        assert!(!line.contains('!'), "{line:?}");
        assert!(strip_ansi(&line).ends_with("Restored 9 agents"), "{line:?}");
    }

    #[test]
    fn progress_and_a_note_do_not_look_the_same() {
        assert_ne!(
            strip_ansi(&progress_line("Working")),
            strip_ansi(&note_line("Working")),
            "a mark that does not distinguish them is not a distinction"
        );
    }

    /// Inline and footer progress say the same thing with the same mark, so a
    /// row and the footer cannot disagree about what "in progress" looks like.
    #[test]
    fn inline_progress_uses_the_same_mark_as_the_footer() {
        assert!(progress_label("creating").starts_with(&style(PROGRESS_MARK, Tone::Work)));
        assert!(progress_line("creating").starts_with(&style(PROGRESS_MARK, Tone::Work)));
    }
}

/// An overlay never covers the footer, so a refusal stays readable while a
/// picker is open over it.
///
/// This is load-bearing rather than cosmetic: the overseer menu reports why it
/// is offering a replacement and then opens the tool picker in the same
/// keypress. If the box reached the footer rows, that sentence would be
/// written and never seen — the silent-create this change exists to stop,
/// wearing a different hat.
#[test]
fn an_overlay_box_never_reaches_the_footer_rows() {
    for rows in [10_usize, 20, 24, 40, 60] {
        // More body than can fit, so the box is as tall as it can ever be.
        let body = (0..rows + 10)
            .map(|row| format!("line {row}"))
            .collect::<Vec<_>>();
        let rendered = aimux::tui_render::render_overlay_box(&aimux::tui_render::OverlayBoxSpec {
            title: "Overseer",
            body: &body,
            cols: 120,
            rows,
            variant: aimux::tui_render::OverlayVariant::Blue,
            icon: None,
        });

        let lowest = rendered
            .split('\u{1b}')
            .filter_map(|chunk| chunk.strip_prefix('['))
            .filter_map(|chunk| chunk.split_once(';'))
            .filter_map(|(row, _)| row.parse::<usize>().ok())
            .max()
            .expect("the box positions its rows");
        assert!(
            lowest <= rows.saturating_sub(2),
            "a {rows}-row viewport put the box at row {lowest}, which is where the footer lives"
        );
    }
}
