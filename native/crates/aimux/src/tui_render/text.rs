const ESC: u8 = 0x1b;

pub(crate) fn sgr_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&ESC) || bytes.get(start + 1) != Some(&b'[') {
        return None;
    }

    let mut end = start + 2;
    while matches!(bytes.get(end), Some(b'0'..=b'9' | b';' | b':')) {
        end += 1;
    }
    (bytes.get(end) == Some(&b'm')).then_some(end + 1)
}

pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;

    while index < bytes.len() {
        if let Some(end) = sgr_end(bytes, index) {
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

    output
}

pub fn center(text: &str, width: usize) -> String {
    let padding = width.saturating_sub(strip_ansi(text).chars().count()) / 2;
    format!("{}{text}", " ".repeat(padding))
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    format!("{}…", text.chars().take(max).collect::<String>())
}

pub fn truncate_plain(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    if max <= 1 {
        return text.chars().take(max).collect();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>())
}

pub fn truncate_ansi(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }

    let plain_length = strip_ansi(text).chars().count();
    let needs_ellipsis = plain_length > max;
    let limit = if needs_ellipsis && max > 1 {
        max - 1
    } else {
        max
    };
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let mut visible = 0;

    while index < bytes.len() {
        if let Some(end) = sgr_end(bytes, index) {
            output.push_str(&text[index..end]);
            index = end;
            continue;
        }
        if visible >= limit {
            break;
        }
        let character = text[index..]
            .chars()
            .next()
            .expect("index must be at a UTF-8 character boundary");
        output.push(character);
        index += character.len_utf8();
        visible += 1;
    }

    if needs_ellipsis {
        output.push('…');
    }
    if output.contains("\x1b[") {
        output.push_str("\x1b[0m");
    }
    output
}

pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let plain = text.trim();
    if plain.is_empty() {
        return vec![String::new()];
    }
    if width <= 8 {
        return vec![truncate_plain(plain, width)];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in plain.split_whitespace() {
        let next = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if next.chars().count() <= width {
            current = next;
            continue;
        }
        if !current.is_empty() {
            lines.push(current);
        }
        current = if word.chars().count() > width {
            truncate_plain(word, width)
        } else {
            word.to_owned()
        };
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

pub fn wrap_key_value(key: &str, value: &str, width: usize) -> Vec<String> {
    let prefix = format!("{key}: ");
    let wrapped = wrap_text(value, 8.max(width.saturating_sub(prefix.chars().count())));
    wrapped
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                format!("{prefix}{line}")
            } else {
                format!("{}{line}", " ".repeat(prefix.chars().count()))
            }
        })
        .collect()
}

pub fn two_pane_left_width(cols: usize) -> usize {
    32.max(((cols as f64) * 0.58).floor() as usize)
}

pub fn compose_two_pane(
    left: &[String],
    right: &[String],
    cols: usize,
    separator: Option<&str>,
) -> Vec<String> {
    let separator = separator.unwrap_or(" │ ");
    let left_width = two_pane_left_width(cols);
    let separator_width = strip_ansi(separator).chars().count();
    let right_width = 20.max(
        cols.saturating_sub(left_width)
            .saturating_sub(separator_width)
            .saturating_sub(1),
    );
    let height = left.len().max(right.len());
    let total_width = left_width + separator_width + right_width;
    let outer_padding = cols.saturating_sub(total_width) / 2;

    (0..height)
        .map(|index| {
            let left_line = truncate_ansi(
                left.get(index).map(String::as_str).unwrap_or(""),
                left_width,
            );
            let right_line = truncate_ansi(
                right.get(index).map(String::as_str).unwrap_or(""),
                right_width,
            );
            let left_padding = left_width.saturating_sub(strip_ansi(&left_line).chars().count());
            let right_padding = right_width.saturating_sub(strip_ansi(&right_line).chars().count());
            format!(
                "{}{}{}{separator}{}{}",
                " ".repeat(outer_padding),
                left_line,
                " ".repeat(left_padding),
                right_line,
                " ".repeat(right_padding)
            )
        })
        .collect()
}
