use super::theme::{BandTone, Tone, modal_band, pad_visible, style, visible_width};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OverlayVariant {
    #[default]
    Blue,
    Red,
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
    let (tone, band_tone, default_icon) = match spec.variant {
        OverlayVariant::Blue => (Tone::Info, BandTone::Info, None),
        OverlayVariant::Red => (Tone::Danger, BandTone::Danger, Some("⚠")),
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
        .map(|line| visible_width(line))
        .chain([visible_width(&band_label) + 1, 0])
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
        modal_band(&band_label, band_tone, band_width),
        border("│")
    ));
    push_row(border(&format!("├{}┤", "─".repeat(box_width - 2))));
    for line in visible_body {
        push_row(format!(
            "{} {} {}",
            border("│"),
            pad_visible(line, inner_width),
            border("│")
        ));
    }
    push_row(border(&format!("╰{}╯", "─".repeat(box_width - 2))));
    output.push_str("\x1b8");
    output
}
