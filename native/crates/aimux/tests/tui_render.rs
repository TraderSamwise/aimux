use aimux::tui_render::box_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use aimux::tui_render::text::{
    compose_two_pane, strip_ansi, truncate_ansi, truncate_plain, wrap_key_value, wrap_text,
};
use aimux::tui_render::theme::{
    ChipTone, Column, StatusKind, Tone, chip, cols, keycap, pad_visible, pill, status_dot, style,
    visible_width,
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
