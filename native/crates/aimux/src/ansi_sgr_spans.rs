use serde_json::{Map, Value, json};

const BASE_16: [&str; 16] = [
    "#5c6370", "#e06c75", "#98c379", "#d19a66", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#7f848e", "#ff7b86", "#b5e08a", "#e5c07b", "#7cc5ff", "#dd93ec", "#66d9e2", "#ffffff",
];

pub fn parse_ansi_lines(text: &str) -> Value {
    let mut attributes = Attributes::default();
    let mut plain_lines = Vec::new();
    let lines = text
        .split('\n')
        .map(|line| {
            let spans = parse_ansi_line(line, &mut attributes);
            plain_lines.push(line_text(&spans));
            Value::Array(spans)
        })
        .collect::<Vec<_>>();
    json!({
        "lines": lines,
        "text": plain_lines.join("\n"),
    })
}

pub(crate) fn parse_ansi_rich_text_spans(text: &str) -> Vec<Value> {
    let mut attributes = Attributes::default();
    let mut spans = Vec::new();
    for (line_index, line) in text.split('\n').enumerate() {
        if line_index > 0 {
            spans.push(json!({ "text": "\n" }));
        }
        spans.extend(parse_ansi_rich_text_line(line, &mut attributes));
    }
    spans
}

fn parse_ansi_rich_text_line(line: &str, attributes: &mut Attributes) -> Vec<Value> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = line[cursor..].find("\u{1b}[") {
        let start = cursor + relative;
        let params_start = start + 2;
        let Some((end, params)) = sgr_params(line, params_start) else {
            break;
        };
        if start > cursor {
            spans.push(rich_text_span_json(&line[cursor..start], attributes));
        }
        apply_params(attributes, params);
        cursor = end + 1;
    }
    if cursor < line.len() {
        spans.push(rich_text_span_json(&line[cursor..], attributes));
    }
    spans
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Attributes {
    fg: Option<String>,
    bg: Option<String>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    inverse: bool,
}

fn parse_ansi_line(line: &str, attributes: &mut Attributes) -> Vec<Value> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = line[cursor..].find("\u{1b}[") {
        let start = cursor + relative;
        let params_start = start + 2;
        let Some((end, params)) = sgr_params(line, params_start) else {
            break;
        };
        if start > cursor {
            spans.push(span_json(&line[cursor..start], attributes));
        }
        apply_params(attributes, params);
        cursor = end + 1;
    }
    if cursor < line.len() {
        spans.push(span_json(&line[cursor..], attributes));
    }
    spans
}

fn sgr_params(line: &str, start: usize) -> Option<(usize, &str)> {
    for (offset, ch) in line[start..].char_indices() {
        if ch == 'm' {
            let end = start + offset;
            return Some((end, &line[start..end]));
        }
        if !ch.is_ascii_digit() && !matches!(ch, ';' | ':') {
            return None;
        }
    }
    None
}

fn apply_params(attributes: &mut Attributes, params: &str) {
    let codes = params.replace(':', ";");
    let codes = codes.split(';').collect::<Vec<_>>();
    let mut index = 0;
    while index < codes.len() {
        let code = if codes[index].is_empty() {
            Some(0)
        } else {
            codes[index].parse::<u16>().ok()
        };
        match code {
            Some(0) => *attributes = Attributes::default(),
            Some(1) => attributes.bold = true,
            Some(2) => attributes.dim = true,
            Some(3) => attributes.italic = true,
            Some(4) => attributes.underline = true,
            Some(7) => attributes.inverse = true,
            Some(9) => attributes.strike = true,
            Some(22) => {
                attributes.bold = false;
                attributes.dim = false;
            }
            Some(23) => attributes.italic = false,
            Some(24) => attributes.underline = false,
            Some(27) => attributes.inverse = false,
            Some(29) => attributes.strike = false,
            Some(30..=37) => attributes.fg = Some(BASE_16[code.unwrap() as usize - 30].to_owned()),
            Some(40..=47) => attributes.bg = Some(BASE_16[code.unwrap() as usize - 40].to_owned()),
            Some(90..=97) => {
                attributes.fg = Some(BASE_16[code.unwrap() as usize - 90 + 8].to_owned())
            }
            Some(100..=107) => {
                attributes.bg = Some(BASE_16[code.unwrap() as usize - 100 + 8].to_owned());
            }
            Some(39) => attributes.fg = None,
            Some(49) => attributes.bg = None,
            Some(38 | 48) => {
                let target_fg = code == Some(38);
                match codes
                    .get(index + 1)
                    .and_then(|value| value.parse::<u16>().ok())
                {
                    Some(5) => {
                        if let Some(color) = codes
                            .get(index + 2)
                            .and_then(|value| value.parse::<u16>().ok())
                            .and_then(xterm256)
                        {
                            set_color(attributes, target_fg, color);
                        }
                        index += 2;
                    }
                    Some(2) => {
                        if let (Some(r), Some(g), Some(b)) = (
                            codes
                                .get(index + 2)
                                .and_then(|value| value.parse::<i32>().ok()),
                            codes
                                .get(index + 3)
                                .and_then(|value| value.parse::<i32>().ok()),
                            codes
                                .get(index + 4)
                                .and_then(|value| value.parse::<i32>().ok()),
                        ) {
                            set_color(attributes, target_fg, hex(r, g, b));
                        }
                        index += 4;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        index += 1;
    }
}

fn set_color(attributes: &mut Attributes, foreground: bool, color: String) {
    if foreground {
        attributes.fg = Some(color);
    } else {
        attributes.bg = Some(color);
    }
}

fn xterm256(index: u16) -> Option<String> {
    if index > 255 {
        return None;
    }
    if index < 16 {
        return Some(BASE_16[index as usize].to_owned());
    }
    if index < 232 {
        let offset = index - 16;
        let level = |value: u16| if value == 0 { 0 } else { value * 40 + 55 };
        return Some(hex(
            level(offset / 36) as i32,
            level((offset / 6) % 6) as i32,
            level(offset % 6) as i32,
        ));
    }
    let gray = (index - 232) * 10 + 8;
    Some(hex(gray as i32, gray as i32, gray as i32))
}

fn hex(r: i32, g: i32, b: i32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        r.clamp(0, 255),
        g.clamp(0, 255),
        b.clamp(0, 255)
    )
}

fn span_json(text: &str, attributes: &Attributes) -> Value {
    json!({
        "text": text,
        "style": style_json(attributes),
    })
}

fn rich_text_span_json(text: &str, attributes: &Attributes) -> Value {
    let fg = if attributes.inverse {
        attributes.bg.as_deref()
    } else {
        attributes.fg.as_deref()
    };
    let bg = if attributes.inverse {
        attributes.fg.as_deref()
    } else {
        attributes.bg.as_deref()
    };
    let mut span = Map::new();
    span.insert("text".to_owned(), Value::String(text.to_owned()));

    let marks = [
        (attributes.bold, "bold"),
        (attributes.dim, "dim"),
        (attributes.italic, "italic"),
        (attributes.underline, "underline"),
        (attributes.strike, "strike"),
    ]
    .into_iter()
    .filter(|(enabled, _)| *enabled)
    .map(|(_, mark)| Value::String(mark.to_owned()))
    .collect::<Vec<_>>();
    if !marks.is_empty() {
        span.insert("marks".to_owned(), Value::Array(marks));
    }
    if let Some(fg) = fg {
        span.insert(
            "foreground".to_owned(),
            json!({ "model": "rgb", "value": fg }),
        );
    }
    if let Some(bg) = bg {
        span.insert(
            "background".to_owned(),
            json!({ "model": "rgb", "value": bg }),
        );
    }
    Value::Object(span)
}

fn style_json(attributes: &Attributes) -> Value {
    let fg = if attributes.inverse {
        attributes.bg.as_deref()
    } else {
        attributes.fg.as_deref()
    };
    let bg = if attributes.inverse {
        attributes.fg.as_deref()
    } else {
        attributes.bg.as_deref()
    };
    let mut style = Map::new();
    if let Some(fg) = fg {
        style.insert("color".to_owned(), Value::String(fg.to_owned()));
    }
    if let Some(bg) = bg {
        style.insert("backgroundColor".to_owned(), Value::String(bg.to_owned()));
    }
    if attributes.bold {
        style.insert("fontWeight".to_owned(), Value::String("bold".to_owned()));
    }
    if attributes.italic {
        style.insert("fontStyle".to_owned(), Value::String("italic".to_owned()));
    }
    if attributes.dim {
        style.insert("opacity".to_owned(), json!(0.6));
    }
    if let Some(decoration) = decoration(attributes.underline, attributes.strike) {
        style.insert(
            "textDecorationLine".to_owned(),
            Value::String(decoration.to_owned()),
        );
    }
    Value::Object(style)
}

fn decoration(underline: bool, strike: bool) -> Option<&'static str> {
    match (underline, strike) {
        (true, true) => Some("underline line-through"),
        (true, false) => Some("underline"),
        (false, true) => Some("line-through"),
        (false, false) => None,
    }
}

fn line_text(spans: &[Value]) -> String {
    spans
        .iter()
        .filter_map(|span| span.get("text").and_then(Value::as_str))
        .collect()
}
