use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyEvent {
    pub char: String,
    pub name: String,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub raw: String,
}

pub fn command_key(event: &KeyEvent) -> String {
    let key = if event.name.is_empty() {
        event.char.as_str()
    } else {
        event.name.as_str()
    };
    if key.chars().count() == 1 {
        key.to_ascii_lowercase()
    } else {
        key.to_owned()
    }
}

pub fn is_shifted_letter_command(event: &KeyEvent, lower_key: &str, letter: &str) -> bool {
    let raw_key = if event.name.is_empty() {
        event.char.as_str()
    } else {
        event.name.as_str()
    };
    lower_key == letter && (event.shift || raw_key == letter.to_ascii_uppercase())
}

pub fn printable_input_text(event: &KeyEvent) -> String {
    if event.ctrl || event.alt {
        return String::new();
    }
    if !event.name.is_empty() && event.name != "paste" {
        return String::new();
    }
    event
        .char
        .chars()
        .filter(|ch| !matches!(*ch as u32, 0x00..=0x1f | 0x7f))
        .collect()
}

pub fn parse_keys(data: &[u8]) -> Vec<KeyEvent> {
    let text = String::from_utf8_lossy(data);
    let mut events = Vec::new();
    let mut index = 0;
    while index < text.len() {
        if text.as_bytes()[index] == 0x1b {
            if text[index..].starts_with("\x1b[200~") {
                let paste_start = index + "\x1b[200~".len();
                let paste_end = text[paste_start..]
                    .find("\x1b[201~")
                    .map(|offset| paste_start + offset);
                let content = paste_end
                    .map(|end| &text[paste_start..end])
                    .unwrap_or(&text[paste_start..]);
                if !content.is_empty() {
                    events.push(event(content, "paste", false, false, false, content));
                }
                index = paste_end
                    .map(|end| end + "\x1b[201~".len())
                    .unwrap_or(text.len());
                continue;
            }

            if text[index..].starts_with("\x1b[")
                && let Some((mut parsed, consumed)) = parse_csi(&text, index + 2)
            {
                parsed.raw = text[index..index + 2 + consumed].to_owned();
                events.push(parsed);
                index += 2 + consumed;
                continue;
            }

            if text[index..].starts_with("\x1bO") && index + 2 < text.len() {
                let raw_end = next_char_index(&text, index + 2);
                let ch = text[index + 2..raw_end].chars().next().unwrap_or_default();
                if let Some(name) = csi_final_name(ch) {
                    events.push(event("", name, false, false, false, &text[index..raw_end]));
                    index = raw_end;
                    continue;
                }
                if ('P'..='S').contains(&ch) {
                    let f_num = ch as u32 - 'P' as u32 + 1;
                    events.push(event(
                        "",
                        &format!("f{f_num}"),
                        false,
                        false,
                        false,
                        &text[index..raw_end],
                    ));
                    index = raw_end;
                    continue;
                }
            }

            if index + 1 < text.len() && text.as_bytes()[index + 1] != 0x1b {
                let raw_end = next_char_index(&text, index + 1);
                let ch = text[index + 1..raw_end].chars().next().unwrap_or_default();
                let code = ch as u32;
                let ctrl_name = control_name_for_alt(code);
                let name = ctrl_name.clone().unwrap_or_else(|| ch.to_string());
                let char_text = ctrl_name.map_or_else(|| ch.to_string(), |_| String::new());
                events.push(KeyEvent {
                    char: char_text,
                    name,
                    shift: false,
                    ctrl: code < 32 && !matches!(code, 8 | 9 | 10 | 13),
                    alt: true,
                    raw: text[index..raw_end].to_owned(),
                });
                index = raw_end;
                continue;
            }

            events.push(event("", "escape", false, false, false, "\x1b"));
            index += 1;
            continue;
        }

        let ch = text[index..].chars().next().unwrap_or_default();
        let code = ch as u32;
        if code < 32 || code == 127 {
            let raw_end = next_char_index(&text, index);
            if code == 13 || code == 10 {
                events.push(event(
                    "",
                    "enter",
                    false,
                    false,
                    false,
                    &text[index..raw_end],
                ));
            } else if code == 9 {
                events.push(event("", "tab", false, false, false, &text[index..raw_end]));
            } else if code == 127 || code == 8 {
                events.push(event(
                    "",
                    "backspace",
                    false,
                    false,
                    false,
                    &text[index..raw_end],
                ));
            } else {
                let name = char::from_u32(code + 96).unwrap_or_default().to_string();
                events.push(event("", &name, false, true, false, &text[index..raw_end]));
            }
            index = raw_end;
            continue;
        }

        let start = index;
        index = next_char_index(&text, index);
        while index < text.len() && text.as_bytes()[index] != 0x1b {
            let ch = text[index..].chars().next().unwrap_or_default();
            if (ch as u32) < 32 {
                break;
            }
            index = next_char_index(&text, index);
        }
        let chars = &text[start..index];
        events.push(event(chars, "", false, false, false, chars));
    }
    events
}

pub fn match_key(event: &KeyEvent, descriptor: &str) -> bool {
    let descriptor = descriptor.to_ascii_lowercase();
    let mut parts = descriptor.split('+').collect::<Vec<_>>();
    let Some(key) = parts.pop() else {
        return false;
    };
    event.ctrl == parts.contains(&"ctrl")
        && event.shift == parts.contains(&"shift")
        && event.alt == parts.contains(&"alt")
        && (event.name == key || event.char == key)
}

fn parse_csi(text: &str, start: usize) -> Option<(KeyEvent, usize)> {
    let mut index = start;
    let mut params = String::new();
    while index < text.len() {
        let byte = text.as_bytes()[index];
        if !(0x30..=0x3f).contains(&byte) {
            break;
        }
        params.push(byte as char);
        index += 1;
    }
    if index >= text.len() {
        return None;
    }
    let final_byte = text.as_bytes()[index];
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    let final_char = final_byte as char;
    let consumed = index - start + 1;
    let parts = params
        .split(';')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect::<Vec<_>>();

    if final_char == 'u' {
        let keycode = parts.first().copied().unwrap_or(0);
        let (shift, ctrl, alt) = parse_modifier(parts.get(1).copied().unwrap_or(1));
        let name = keycode_name(keycode);
        let char_text = if name.is_empty() {
            char::from_u32(keycode).unwrap_or_default().to_string()
        } else {
            String::new()
        };
        let event_name = if name.is_empty() {
            char_text.clone()
        } else {
            name.to_owned()
        };
        return Some((
            KeyEvent {
                char: char_text,
                name: event_name,
                shift,
                ctrl,
                alt,
                raw: String::new(),
            },
            consumed,
        ));
    }

    if final_char == '~' && parts.first() == Some(&27) && parts.len() >= 3 {
        let (shift, ctrl, alt) = parse_modifier(parts.get(1).copied().unwrap_or(1));
        let keycode = parts.get(2).copied().unwrap_or(0);
        let name = keycode_name(keycode);
        let char_text = if name.is_empty() {
            char::from_u32(keycode).unwrap_or_default().to_string()
        } else {
            String::new()
        };
        let event_name = if name.is_empty() {
            char_text.clone()
        } else {
            name.to_owned()
        };
        return Some((
            KeyEvent {
                char: char_text,
                name: event_name,
                shift,
                ctrl,
                alt,
                raw: String::new(),
            },
            consumed,
        ));
    }

    if final_char == '~' {
        let key_num = parts.first().copied().unwrap_or(0);
        let (shift, ctrl, alt) = parse_modifier(parts.get(1).copied().unwrap_or(1));
        let name = csi_tilde_name(key_num);
        if !name.is_empty() {
            return Some((event("", name, shift, ctrl, alt, ""), consumed));
        }
        return None;
    }

    if final_char == 'M' || final_char == 'm' {
        return Some((event("", "mouse", false, false, false, ""), consumed));
    }
    if final_char == 'I' {
        return Some((event("", "focusin", false, false, false, ""), consumed));
    }
    if final_char == 'O' {
        return Some((event("", "focusout", false, false, false, ""), consumed));
    }
    if let Some(name) = csi_final_name(final_char) {
        let modifier = if parts.len() >= 2 {
            parts.get(1).copied().unwrap_or(1)
        } else {
            1
        };
        let (shift, ctrl, alt) = parse_modifier(modifier);
        return Some((event("", name, shift, ctrl, alt, ""), consumed));
    }
    None
}

fn event(char_text: &str, name: &str, shift: bool, ctrl: bool, alt: bool, raw: &str) -> KeyEvent {
    KeyEvent {
        char: char_text.to_owned(),
        name: name.to_owned(),
        shift,
        ctrl,
        alt,
        raw: raw.to_owned(),
    }
}

fn parse_modifier(modifier: u32) -> (bool, bool, bool) {
    let mask = modifier.saturating_sub(1);
    ((mask & 1) != 0, (mask & 4) != 0, (mask & 2) != 0)
}

fn keycode_name(code: u32) -> &'static str {
    match code {
        9 => "tab",
        13 => "enter",
        27 => "escape",
        127 => "backspace",
        _ => "",
    }
}

fn csi_final_name(ch: char) -> Option<&'static str> {
    match ch {
        'A' => Some("up"),
        'B' => Some("down"),
        'C' => Some("right"),
        'D' => Some("left"),
        'H' => Some("home"),
        'F' => Some("end"),
        _ => None,
    }
}

fn csi_tilde_name(code: u32) -> &'static str {
    match code {
        1 => "home",
        2 => "insert",
        3 => "delete",
        4 => "end",
        5 => "pageup",
        6 => "pagedown",
        11 => "f1",
        12 => "f2",
        13 => "f3",
        14 => "f4",
        15 => "f5",
        17 => "f6",
        18 => "f7",
        19 => "f8",
        20 => "f9",
        21 => "f10",
        23 => "f11",
        24 => "f12",
        _ => "",
    }
}

fn control_name_for_alt(code: u32) -> Option<String> {
    if code == 127 || code == 8 {
        Some("backspace".to_owned())
    } else if code == 13 || code == 10 {
        Some("enter".to_owned())
    } else if code == 9 {
        Some("tab".to_owned())
    } else if code < 32 {
        Some(char::from_u32(code + 96).unwrap_or_default().to_string())
    } else {
        None
    }
}

fn next_char_index(text: &str, index: usize) -> usize {
    index
        + text[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1)
}
