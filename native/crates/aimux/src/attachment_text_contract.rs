use serde_json::{Value, json};
use std::collections::BTreeSet;

const ATTACHMENT_DIR: &str = ".aimux/attachments/";
const METADATA_WINDOW: usize = 1024;

pub fn recover_wrapped_attachments_contract(tail: &str) -> Value {
    let mut squashed = String::new();
    let mut source_index = Vec::new();
    for (index, ch) in tail.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        squashed.push(ch);
        source_index.push(index);
    }

    let chars = squashed.chars().collect::<Vec<_>>();
    let adjacent = |index: usize| index > 0 && source_index[index] == source_index[index - 1] + 1;
    let bullet_at = |index: usize| {
        index < chars.len()
            && matches!(chars[index], '-' | '•')
            && !adjacent(index)
            && (index + 1 >= chars.len() || !adjacent(index + 1))
    };
    let has_bullet_in = |from: usize, to: usize| (from..to).any(&bullet_at);

    let mut attachments = Vec::new();
    let mut drop = BTreeSet::new();
    let mut search_from = 0;
    while let Some(relative) = squashed[search_from..].find(ATTACHMENT_DIR) {
        let path_start = search_from + relative;
        let id_start = path_start + ATTACHMENT_DIR.len();
        let id_end = attachment_id_end(&squashed, id_start);
        if id_end == id_start {
            search_from = id_start;
            continue;
        }
        let attachment_id = squashed[id_start..id_end].to_owned();
        let mut end = id_end;
        while end < chars.len() && adjacent(end) && trailing_path_char(chars[end]) {
            end += chars[end].len_utf8();
        }

        let metadata = last_metadata_before(&squashed, path_start);
        let own_metadata = metadata.filter(|metadata| {
            !has_bullet_in(metadata.end, path_start)
                && !squashed[metadata.end..path_start].contains(ATTACHMENT_DIR)
        });
        let mut attachment = serde_json::Map::new();
        attachment.insert("attachmentId".to_owned(), Value::String(attachment_id));
        let start = if let Some(metadata) = own_metadata {
            attachment.insert("mimeType".to_owned(), Value::String(metadata.mime_type));
            let mut bullet = metadata.start;
            while bullet > 0 && !bullet_at(byte_to_char_index(&squashed, bullet).saturating_sub(1))
            {
                bullet = previous_char_boundary(&squashed, bullet);
            }
            let filename = squashed[bullet..metadata.start].to_owned();
            if bullet > 0 && !filename.is_empty() {
                attachment.insert("filename".to_owned(), Value::String(filename));
            }
            if bullet > 0 {
                previous_char_boundary(&squashed, bullet)
            } else {
                metadata.start
            }
        } else {
            let mut start = path_start;
            while start > 0 {
                let previous = previous_char_boundary(&squashed, start);
                let previous_char_index = byte_to_char_index(&squashed, previous);
                let Some(ch) = squashed[previous..start].chars().next() else {
                    break;
                };
                if !path_char(ch) || bullet_at(previous_char_index) {
                    break;
                }
                start = previous;
            }
            start
        };
        attachments.push(Value::Object(attachment));
        for char_index in byte_to_char_index(&squashed, start)..byte_to_char_index(&squashed, end) {
            if let Some(source) = source_index.get(char_index) {
                drop.insert(*source);
            }
        }
        search_from = end;
    }

    if attachments.is_empty() {
        return Value::Null;
    }

    let mut prose = String::new();
    for (index, ch) in tail.char_indices() {
        if !drop.contains(&index) {
            prose.push(ch);
        }
    }
    let prose = prose
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('-')
        .trim_matches('•')
        .trim()
        .to_owned();
    json!({ "attachments": attachments, "prose": prose })
}

#[derive(Debug, Clone)]
struct MetadataMatch {
    mime_type: String,
    start: usize,
    end: usize,
}

fn last_metadata_before(text: &str, path_start: usize) -> Option<MetadataMatch> {
    let window_start =
        previous_boundary_at_or_before(text, path_start.saturating_sub(METADATA_WINDOW));
    let window = &text[window_start..path_start];
    let mut result = None;
    let mut search = 0;
    while let Some(open_relative) = window[search..].find('(') {
        let open = search + open_relative;
        let Some(close_relative) = window[open..].find("bytes):") else {
            break;
        };
        let end = open + close_relative + "bytes):".len();
        let inner = &window[open + 1..open + close_relative];
        if let Some((mime, bytes)) = inner.split_once(",")
            && valid_mime(mime)
            && bytes
                .trim_end_matches("bytes")
                .chars()
                .all(|ch| ch.is_ascii_digit())
        {
            result = Some(MetadataMatch {
                mime_type: mime.to_owned(),
                start: window_start + open,
                end: window_start + end,
            });
        }
        search = end;
    }
    result
}

fn valid_mime(value: &str) -> bool {
    let Some((left, right)) = value.split_once('/') else {
        return false;
    };
    !left.is_empty()
        && !right.is_empty()
        && left.chars().all(mime_char)
        && right.chars().all(mime_char)
}

fn mime_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-')
}

fn attachment_id_end(text: &str, start: usize) -> usize {
    let mut end = start;
    for (offset, ch) in text[start..].char_indices() {
        if offset == 0 {
            continue;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            end = start + offset + ch.len_utf8();
        } else {
            break;
        }
    }
    end
}

fn path_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '~')
}

fn trailing_path_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '.'
}

fn previous_char_boundary(text: &str, index: usize) -> usize {
    text[..index]
        .char_indices()
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn previous_boundary_at_or_before(text: &str, index: usize) -> usize {
    if text.is_char_boundary(index) {
        return index;
    }
    previous_char_boundary(text, index)
}

fn byte_to_char_index(text: &str, byte: usize) -> usize {
    text[..byte].chars().count()
}
