pub fn sanitize_expose_preview_line(line: &str) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < line.len() {
        let Some((ch, next)) = next_char(line, index) else {
            break;
        };
        if ch == '\x1b' {
            if line[index..].starts_with("\x1b[") {
                if let Some((end, keep)) = consume_csi(line, index) {
                    if keep {
                        output.push_str(&line[index..end]);
                    }
                    index = end;
                    continue;
                }
                if is_incomplete_csi_at_end(&line[index..]) {
                    break;
                }
            } else if line[index..].starts_with("\x1b]") {
                if let Some(end) = consume_osc(line, index) {
                    index = end;
                    continue;
                }
                index = next;
                continue;
            } else {
                index = next;
                if index < line.len() {
                    let Some((_, after_next)) = next_char(line, index) else {
                        break;
                    };
                    index = after_next;
                }
                continue;
            }
        }
        output.push(if is_sanitized_control(ch) { ' ' } else { ch });
        index = next;
    }
    output
}

pub fn sanitize_expose_preview_output(raw: &str) -> Vec<String> {
    let normalized = raw.replace('\r', "");
    let mut lines = normalized
        .split('\n')
        .map(sanitize_expose_preview_line)
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines
}

fn consume_csi(line: &str, start: usize) -> Option<(usize, bool)> {
    let mut index = start + 2;
    while index < line.len() {
        let (ch, next) = next_char(line, index)?;
        if ('@'..='~').contains(&ch) {
            let body = &line[start + 2..index];
            let keep = ch == 'm'
                && body
                    .chars()
                    .all(|character| character.is_ascii_digit() || matches!(character, ';' | ':'));
            return Some((next, keep));
        }
        index = next;
    }
    None
}

fn is_incomplete_csi_at_end(value: &str) -> bool {
    value
        .strip_prefix("\x1b[")
        .is_some_and(|body| body.chars().all(is_incomplete_csi_char))
}

fn is_incomplete_csi_char(ch: char) -> bool {
    ch.is_ascii_digit() || matches!(ch, ';' | ':' | '?' | ' '..='/')
}

fn consume_osc(line: &str, start: usize) -> Option<usize> {
    let mut index = start + 2;
    while index < line.len() {
        let (ch, next) = next_char(line, index)?;
        if ch == '\x07' {
            return Some(next);
        }
        if ch == '\x1b' && line[next..].starts_with('\\') {
            return Some(next + 1);
        }
        index = next;
    }
    None
}

fn is_sanitized_control(ch: char) -> bool {
    matches!(
        ch as u32,
        0x00..=0x09 | 0x0b..=0x1a | 0x1c..=0x1f | 0x7f..=0x9f
    )
}

fn next_char(value: &str, index: usize) -> Option<(char, usize)> {
    let ch = value[index..].chars().next()?;
    Some((ch, index + ch.len_utf8()))
}
