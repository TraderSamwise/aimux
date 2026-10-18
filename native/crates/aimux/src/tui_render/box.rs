use super::theme::{
    BandTone, PROGRESS_MARK, PROGRESS_TONE, Tone, modal_band_with_padding, pad_visible, style,
    visible_width,
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OverlayVariant {
    #[default]
    Blue,
    Red,
    /// Work under way that finishes on its own. Nothing is wrong and the user
    /// is not being asked for anything.
    Progress,
}

#[derive(Clone, Copy, Debug)]
pub struct OverlayBoxSpec<'a> {
    pub title: &'a str,
    pub body: &'a [String],
    pub cols: usize,
    pub rows: usize,
    pub variant: OverlayVariant,
    pub icon: Option<&'a str>,
}

pub fn render_overlay_box(spec: &OverlayBoxSpec<'_>) -> String {
    render_overlay_box_measured(spec, visible_width, pad_visible)
}

pub fn render_overlay_box_cells(spec: &OverlayBoxSpec<'_>) -> String {
    render_overlay_box_measured(spec, display_cell_width, pad_display_cells)
}

pub(crate) fn display_cell_width(text: &str) -> usize {
    UnicodeWidthStr::width(super::text::strip_ansi(text).as_str())
}

fn pad_display_cells(text: &str, width: usize) -> String {
    let current = display_cell_width(text);
    if current <= width {
        return format!("{text}{}", " ".repeat(width - current));
    }
    let mut output = String::new();
    let mut cells = 0;
    let mut index = 0;
    while index < text.len() {
        if let Some(end) = super::text::sgr_end(text.as_bytes(), index) {
            output.push_str(&text[index..end]);
            index = end;
            continue;
        }
        let character = text[index..].chars().next().expect("character boundary");
        let next = character.width().unwrap_or(0);
        if cells + next > width {
            break;
        }
        output.push(character);
        cells += next;
        index += character.len_utf8();
    }
    output.push_str("\x1b[0m");
    output.push_str(&" ".repeat(width - cells));
    output
}

fn render_overlay_box_measured(
    spec: &OverlayBoxSpec<'_>,
    measure: fn(&str) -> usize,
    pad: fn(&str, usize) -> String,
) -> String {
    let (tone, band_tone, default_icon) = match spec.variant {
        OverlayVariant::Blue => (Tone::Info, BandTone::Info, None),
        OverlayVariant::Red => (Tone::Danger, BandTone::Danger, Some("⚠")),
        OverlayVariant::Progress => (PROGRESS_TONE, BandTone::Progress, Some(PROGRESS_MARK)),
    };
    let band_icon = spec.icon.or(default_icon);
    let border = |segment: &str| style(segment, tone);
    let band_label = format!(
        "{}{}",
        band_icon.map_or_else(String::new, |icon| format!("{icon}  ")),
        spec.title.to_uppercase()
    );

    let max_content_width = 10.max(spec.cols.saturating_sub(8));
    let measured_content_width = spec
        .body
        .iter()
        .map(|line| measure(line))
        .chain([measure(&band_label) + 1, 0])
        .max()
        .unwrap_or_default();
    let content_width = 20.max(max_content_width.min(measured_content_width));
    let box_width = 24.max(spec.cols.saturating_sub(2).min(content_width + 4));
    let inner_width = box_width - 4;
    let band_width = box_width - 2;

    let max_body_rows = spec.rows.saturating_sub(6);
    let visible_body = &spec.body[..spec.body.len().min(max_body_rows)];
    let box_height = 4 + visible_body.len();
    let start_row = 1.max(spec.rows.saturating_sub(box_height) / 2);
    let start_col = 1.max(spec.cols.saturating_sub(box_width) / 2);

    let mut output = String::from("\x1b7");
    let mut row = 0;
    let mut push_row = |content: String| {
        output.push_str(&format!("\x1b[{};{start_col}H{content}", start_row + row));
        row += 1;
    };

    push_row(border(&format!("╭{}╮", "─".repeat(box_width - 2))));
    push_row(format!(
        "{}{}{}",
        border("│"),
        modal_band_with_padding(&band_label, band_tone, band_width, pad),
        border("│")
    ));
    push_row(border(&format!("├{}┤", "─".repeat(box_width - 2))));
    for line in visible_body {
        push_row(format!(
            "{} {} {}",
            border("│"),
            pad(line, inner_width),
            border("│")
        ));
    }
    push_row(border(&format!("╰{}╯", "─".repeat(box_width - 2))));
    output.push_str("\x1b8");
    output
}
