use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

pub const PROMPT_CONTEXT_MAX_BYTES: usize = 4096;
const PROMPT_CONTEXT_TTL_MS: i64 = 30 * 60 * 1000;
const CONTEXT_OPEN: &str = "[aimux context]";
const CONTEXT_CLOSE: &str = "[/aimux context]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptContextEntry {
    pub text: String,
    pub updated_at: i64,
    pub expires_at: i64,
}

static PROMPT_CONTEXTS: OnceLock<Mutex<HashMap<String, PromptContextEntry>>> = OnceLock::new();

/// The prompt-context store, recovering from a poisoned lock.
///
/// `expect` here was permanent: a single panic while any thread held this
/// guard poisons the mutex for the life of the process, so every later call --
/// the route, the delivery path that composes a prompt, the clear on teardown
/// -- panics too. Prompt context would be dead until the project service
/// restarted, and each call would take its caller's route down with it.
///
/// RECOVERY IS SAFE HERE, and that is a claim about this data rather than a
/// habit. The map holds independent per-session entries, and the mutations are
/// single `insert`/`remove` calls. The only state a panic can leave behind is
/// an expired entry that `prune_expired_locked` did not reach, and every read
/// re-checks `expires_at` before returning, so a stale entry cannot be served.
/// Nothing in here spans two keys, so there is no half-applied change to see.
fn lock_prompt_context_store() -> std::sync::MutexGuard<'static, HashMap<String, PromptContextEntry>>
{
    prompt_context_store()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

pub fn route_prompt_context_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST")
        || project_service_pathname(path) != routes::agents::PROMPT_CONTEXT
    {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "sessionId is required" }),
        ));
    };
    let raw = body.get("text").and_then(Value::as_str).unwrap_or("");
    let normalized = normalize_prompt_context(raw);
    let bytes = prompt_context_byte_length(&normalized);
    if bytes > PROMPT_CONTEXT_MAX_BYTES {
        return Some(json_response(
            413,
            json!({
                "ok": false,
                "error": format!(
                    "prompt context too large: {bytes} bytes exceeds {PROMPT_CONTEXT_MAX_BYTES}"
                ),
            }),
        ));
    }
    let entry = set_prompt_context(context.project_state_dir(), &session_id, &normalized);
    Some(json_response(
        200,
        json!({
            "ok": true,
            "sessionId": session_id,
            "context": entry.as_ref().map(|entry| entry.text.clone()),
            "bytes": entry.as_ref().map(|_| bytes).unwrap_or_default(),
            "expiresAt": entry.as_ref().map(|entry| entry.expires_at),
        }),
    ))
}

pub fn set_prompt_context(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    text: &str,
) -> Option<PromptContextEntry> {
    let session_id = session_id.trim();
    let key = store_key(project_state_dir, session_id);
    let normalized = normalize_prompt_context(text);
    let mut store = lock_prompt_context_store();
    prune_expired_locked(&mut store);
    if normalized.is_empty() {
        store.remove(&key);
        return None;
    }
    let updated_at = now_ms();
    let entry = PromptContextEntry {
        text: normalized,
        updated_at,
        expires_at: updated_at + PROMPT_CONTEXT_TTL_MS,
    };
    store.insert(key, entry.clone());
    Some(entry)
}

pub fn get_prompt_context_text(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> Option<String> {
    let key = store_key(project_state_dir, session_id.trim());
    let mut store = lock_prompt_context_store();
    let entry = store.get(&key).cloned()?;
    if now_ms() >= entry.expires_at {
        store.remove(&key);
        return None;
    }
    Some(entry.text)
}

pub fn clear_prompt_context(project_state_dir: impl AsRef<Path>, session_id: &str) {
    let key = store_key(project_state_dir, session_id.trim());
    let mut store = lock_prompt_context_store();
    store.remove(&key);
}

pub fn compose_with_prompt_context(text: &str, context: Option<&str>) -> String {
    let Some(context) = context.filter(|value| !value.is_empty()) else {
        return text.to_owned();
    };
    format!("{CONTEXT_OPEN} {context} {CONTEXT_CLOSE} {text}")
}

pub fn normalize_prompt_context(text: &str) -> String {
    let mut stripped = text
        .chars()
        .filter(|character| !is_zero_width(*character))
        .collect::<String>();
    loop {
        let next = remove_context_delimiters_once(&stripped);
        if next == stripped {
            break;
        }
        stripped = next;
    }
    collapse_whitespace(&stripped)
}

pub fn prompt_context_byte_length(text: &str) -> usize {
    text.len()
}

fn prompt_context_store() -> &'static Mutex<HashMap<String, PromptContextEntry>> {
    PROMPT_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_expired_locked(store: &mut HashMap<String, PromptContextEntry>) {
    let now = now_ms();
    store.retain(|_, entry| now < entry.expires_at);
}

fn store_key(project_state_dir: impl AsRef<Path>, session_id: &str) -> String {
    format!("{}::{session_id}", project_state_dir.as_ref().display())
}

fn remove_context_delimiters_once(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut tail = 0;
    while cursor < input.len() {
        let Some((character, next_cursor)) = next_char(input, cursor) else {
            break;
        };
        if character == '['
            && let Some(end) = context_delimiter_end(input, cursor)
        {
            output.push_str(&input[tail..cursor]);
            output.push(' ');
            cursor = end;
            tail = end;
            continue;
        }
        cursor = next_cursor;
    }
    output.push_str(&input[tail..]);
    output
}

fn context_delimiter_end(input: &str, start: usize) -> Option<usize> {
    let (_, mut cursor) = next_char(input, start).filter(|(character, _)| *character == '[')?;
    cursor = skip_whitespace(input, cursor);
    if let Some(('/', next)) = next_char(input, cursor) {
        cursor = next;
    }
    cursor = skip_whitespace(input, cursor);
    cursor = consume_ascii_case_insensitive(input, cursor, "aimux")?;
    let after_aimux = skip_whitespace(input, cursor);
    if after_aimux == cursor {
        return None;
    }
    cursor = consume_ascii_case_insensitive(input, after_aimux, "context")?;
    cursor = skip_whitespace(input, cursor);
    let (_, cursor) = next_char(input, cursor).filter(|(character, _)| *character == ']')?;
    Some(cursor)
}

fn consume_ascii_case_insensitive(input: &str, mut cursor: usize, expected: &str) -> Option<usize> {
    for expected in expected.chars() {
        let (actual, next) = next_char(input, cursor)?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return None;
        }
        cursor = next;
    }
    Some(cursor)
}

fn skip_whitespace(input: &str, mut cursor: usize) -> usize {
    while let Some((character, next)) = next_char(input, cursor) {
        if !character.is_whitespace() {
            break;
        }
        cursor = next;
    }
    cursor
}

fn next_char(input: &str, cursor: usize) -> Option<(char, usize)> {
    input[cursor..]
        .chars()
        .next()
        .map(|character| (character, cursor + character.len_utf8()))
}

fn collapse_whitespace(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut pending_space = false;
    for character in input.chars() {
        if character.is_whitespace() {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
                pending_space = false;
            }
            output.push(character);
        }
    }
    output
}

fn is_zero_width(character: char) -> bool {
    matches!(character, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}')
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn now_ms() -> i64 {
    let now = time::OffsetDateTime::now_utc();
    now.unix_timestamp() * 1000 + i64::from(now.millisecond())
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Poisons the store the only way it can really happen: a panic while a
    /// guard is held.
    ///
    /// The store is process-wide, so this poisons it for every later test in
    /// this binary. That is the point rather than a problem -- after the fix
    /// the later calls recover, and before it they would panic, which is
    /// exactly the permanence being fixed.
    fn poison_the_store() {
        let panicked = std::thread::spawn(|| {
            let _guard = prompt_context_store()
                .lock()
                .expect("a clean lock to poison");
            panic!("poisoning the prompt context store on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            prompt_context_store().is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );
    }

    /// All three entry points, because all three took the lock and all three
    /// would have panicked.
    #[test]
    fn a_poisoned_prompt_context_store_still_sets_reads_and_clears() {
        let state_dir = std::path::Path::new("/tmp/aimux-prompt-context-poison");
        let session = "session-poisoned";

        poison_the_store();

        let entry = set_prompt_context(state_dir, session, "still answering");
        assert_eq!(
            entry.map(|entry| entry.text),
            Some("still answering".to_owned()),
            "set must survive a poisoned store"
        );
        assert_eq!(
            get_prompt_context_text(state_dir, session),
            Some("still answering".to_owned()),
            "get must survive a poisoned store"
        );

        clear_prompt_context(state_dir, session);
        assert_eq!(
            get_prompt_context_text(state_dir, session),
            None,
            "clear must survive a poisoned store, and must actually clear"
        );
    }
}
