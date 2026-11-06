use serde_json::{Map, Value};

use crate::request_actor::{RemoteActor, RemoteActorRole};

pub fn body_shared_chat_actor(body: &Value) -> Option<Value> {
    let raw = body.get("sharedChatActor")?.as_object()?;
    let role = raw.get("role")?.as_str()?;
    if role != "owner" && role != "guest" {
        return None;
    }
    let display_name = trimmed_body_string(raw.get("displayName"));
    let email = trimmed_body_string(raw.get("email"));
    if display_name.is_none() && email.is_none() {
        return None;
    }
    let mut actor = Map::new();
    actor.insert("role".into(), Value::String(role.to_owned()));
    if let Some(display_name) = display_name {
        actor.insert("displayName".into(), Value::String(display_name));
    }
    if let Some(email) = email {
        actor.insert("email".into(), Value::String(email));
    }
    Some(Value::Object(actor))
}

pub fn hosted_attachment_from_body(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let content_url = object.get("contentUrl")?.as_str()?;
    let expires_at = object.get("expiresAt")?.as_str()?;
    let mut hosted = Map::new();
    hosted.insert("contentUrl".into(), Value::String(content_url.to_owned()));
    hosted.insert("expiresAt".into(), Value::String(expires_at.to_owned()));
    if let Some(sha256) = object.get("sha256").and_then(Value::as_str) {
        hosted.insert("sha256".into(), Value::String(sha256.to_owned()));
    }
    if let Some(size_bytes) = object.get("sizeBytes").and_then(Value::as_i64) {
        hosted.insert("sizeBytes".into(), Value::from(size_bytes));
    }
    Some(Value::Object(hosted))
}

pub fn safe_shared_chat_actor_name(actor: &Value) -> String {
    let fallback = if actor.get("role").and_then(Value::as_str) == Some("owner") {
        "chat owner"
    } else {
        "shared guest"
    };
    let raw = trimmed_body_string(actor.get("displayName"))
        .or_else(|| trimmed_body_string(actor.get("email")))
        .unwrap_or_else(|| fallback.to_owned());
    let name = collapse_whitespace(&raw)
        .chars()
        .take(80)
        .collect::<String>();
    if name.is_empty() {
        fallback.to_owned()
    } else {
        name
    }
}

/// Characters that make an input a command rather than prose: a slash
/// command, a shell escape, a shell line.
///
/// Every agent we run reads these at position ZERO, which is exactly what the
/// attribution prefix takes away.
///
/// `#` is deliberately NOT here. It is a markdown heading far more often than
/// it is a command, so including it would strip the sender from ordinary
/// prose for no command preserved.
/// Whether this input is a command the agent parses rather than prose.
///
/// Dropping the prefix drops the only record of who sent the line -- the
/// actor is not persisted anywhere else -- so this is an attribution hole and
/// is kept as small as it can be while still letting a command work.
///
/// SINGLE LINE ONLY. Testing the first character of the whole message let one
/// sigil carry any number of following paragraphs through unattributed, which
/// is a bypass for arbitrary content rather than an exemption for commands.
///
/// Beyond that, the shape of the first token decides, because a command and a
/// path do not look alike:
///
/// - `/clear`, `/model opus` -- a slash command is ONE segment of word
///   characters, so the first token may not contain a second `/` or a `.`.
///   `/home/sam is broken` and `/etc/hosts` are therefore prose and keep
///   their sender, which is the false positive worth removing: real paths
///   have more than one segment.
/// - `!ls -la` -- a bang followed by a word. `!!!` is not.
/// - `$ echo hi` -- a dollar followed by a space or a word. `$500` is not.
///
/// What is left is a single-segment path alone on a line, `/tmp`, which
/// genuinely cannot be told from a command. As prose that is written "look at
/// /tmp", which does not start with the sigil at all.
pub fn looks_like_agent_command(text: &str) -> bool {
    let trimmed = shared_chat_trim(text);
    if trimmed.contains(is_line_break) {
        return false;
    }
    let first_token = trimmed.split(is_shared_whitespace).next().unwrap_or("");
    let mut characters = trimmed.chars();
    match characters.next() {
        Some('/') => is_single_command_segment(&first_token[1..]),
        Some('!') => characters.next().is_some_and(is_command_word_start),
        Some('$') => characters
            .next()
            .is_some_and(|next| next == ' ' || is_command_word_start(next)),
        _ => false,
    }
}

/// The whitespace both sides agree on.
///
/// The two languages disagree at the edges, and each trimming with its own
/// notion made them disagree about the same message. Rust's
/// `char::is_whitespace` is the Unicode White_Space property, which includes
/// U+0085 NEL; JavaScript's `trim` instead includes U+FEFF, which is not
/// White_Space. So `\u{85}/clear` was a command here and prose in the app,
/// and `\u{feff}/clear` was a command there and prose here -- on an answer
/// that decides whether a guest's line keeps its attribution.
fn is_shared_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

/// What counts as starting a new line, which a command may not do.
///
/// `\n` and `\r` were not the whole set. A vertical tab or a form feed
/// renders as a line break, and U+2028 and U+2029 are the line and paragraph
/// separators by definition -- so `!ls\u{b}rm -rf /` passed the single-line
/// test and reached the agent with its sender stripped, which is the bypass
/// the single-line rule exists to close.
fn is_line_break(character: char) -> bool {
    matches!(
        character,
        '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

/// Trim as the app trims, so both sides see the same message.
pub fn shared_chat_trim(text: &str) -> &str {
    text.trim_matches(is_shared_whitespace)
}

/// One segment of a slash command's name: letters, digits, `-` and `_`, and
/// nothing that would make it a path or a filename.
fn is_single_command_segment(name: &str) -> bool {
    let mut characters = name.chars();
    characters.next().is_some_and(is_command_word_start)
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn is_command_word_start(character: char) -> bool {
    character.is_ascii_alphabetic()
}

pub fn format_shared_chat_agent_input(text: &str, actor: &Value) -> String {
    let trimmed = shared_chat_trim(text);
    // A prefixed command is not a command. `[sam@example.com] /clear` is a
    // message beginning with a bracket, so the agent takes it as prose and
    // the thing the sender asked for never happens.
    if looks_like_agent_command(trimmed) {
        return trimmed.to_owned();
    }
    format!("[{}] {}", safe_shared_chat_actor_name(actor), trimmed)
}

pub fn shared_chat_body_actor_prompt(body: &Value, text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    let actor = body_shared_chat_actor(body)?;
    Some(format_shared_chat_agent_input(text, &actor))
}

pub fn shared_chat_remote_actor_prompt(actor: &RemoteActor, text: &str) -> Option<String> {
    let role = match actor.role {
        RemoteActorRole::Owner => "owner",
        RemoteActorRole::Guest => "guest",
        RemoteActorRole::Operator => "operator",
    };
    if role != "owner" && role != "guest" || text.trim().is_empty() {
        return None;
    }
    let mut value = Map::new();
    value.insert("role".into(), Value::String(role.to_owned()));
    if let Some(display_name) = actor.display_name.as_deref() {
        value.insert("displayName".into(), Value::String(display_name.to_owned()));
    }
    if let Some(email) = actor.email.as_deref() {
        value.insert("email".into(), Value::String(email.to_owned()));
    }
    Some(format_shared_chat_agent_input(text, &Value::Object(value)))
}

pub fn format_agent_input_with_attachments(text: &str, attachments: &[Value]) -> String {
    if attachments.is_empty() {
        return text.to_owned();
    }
    let body = if text.trim().is_empty() {
        "Please review the attached file(s).".to_owned()
    } else {
        text.trim().to_owned()
    };
    let attachment_lines = attachments
        .iter()
        .map(|attachment| {
            format!(
                "- {} ({}, {} bytes): {}",
                string_field(attachment, "filename").unwrap_or("attachment"),
                string_field(attachment, "mimeType").unwrap_or("application/octet-stream"),
                attachment
                    .get("sizeBytes")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                string_field(attachment, "contentPath").unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{body}\n\nAttached files:\n{attachment_lines}")
}

fn trimmed_body_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn collapse_whitespace(value: &str) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !output.is_empty() {
                output.push(' ');
            }
            output.push(character);
            pending_space = false;
        }
    }
    output
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn guest() -> Value {
        json!({ "role": "guest", "displayName": "sam@example.com" })
    }

    const COMMAND_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testdata/contracts/v1/agent-command-input.json"
    ));

    /// The app asks this same question, to decide whether to expect the text
    /// back in the parsed transcript -- a command is consumed by the agent
    /// and need not appear as a user turn. When each side owned its own
    /// answer the two could disagree, and a command the app read as prose
    /// produced "Send not confirmed yet" for a message that was delivered.
    #[test]
    fn the_command_rule_matches_the_contract_both_sides_read() {
        let contract: Value = serde_json::from_str(COMMAND_CONTRACT).expect("contract json");
        let commands = contract["commands"].as_array().expect("commands");
        let prose = contract["prose"].as_array().expect("prose");
        assert!(
            commands.len() > 4 && prose.len() > 4,
            "both answers covered"
        );
        for case in commands {
            let text = case.as_str().expect("command string");
            assert!(looks_like_agent_command(text), "{text:?} must be a command");
        }
        for case in prose {
            let text = case.as_str().expect("prose string");
            assert!(!looks_like_agent_command(text), "{text:?} must be prose");
        }
    }

    #[test]
    fn prose_keeps_its_attribution() {
        assert_eq!(
            format_shared_chat_agent_input("Help us make a document.", &guest()),
            "[sam@example.com] Help us make a document."
        );
    }

    #[test]
    fn commands_are_not_prefixed() {
        // The bug: `[sam@example.com] /clear` begins with a bracket, so the
        // agent reads it as prose and the command never runs.
        for command in ["/clear", "/model opus", "!ls -la", "$ echo hi"] {
            assert_eq!(
                format_shared_chat_agent_input(command, &guest()),
                command,
                "{command} must reach the agent unprefixed"
            );
        }
    }

    #[test]
    fn a_sigil_cannot_smuggle_a_whole_unattributed_message() {
        // The hole this closes: testing only the first character of the whole
        // message let one sigil carry any number of following paragraphs
        // through with no sender on them. A command is ONE line.
        let smuggled = "/clear\nand here is a long unattributed paragraph";
        assert_eq!(
            format_shared_chat_agent_input(smuggled, &guest()),
            format!("[sam@example.com] {smuggled}")
        );
        assert!(!looks_like_agent_command("# note\nparagraph"));
        assert!(!looks_like_agent_command("!ls\nrm -rf /"));
    }

    #[test]
    fn a_line_break_that_is_not_a_newline_still_ends_the_command() {
        // `\n` and `\r` were not the whole set, so these reached the agent
        // with the sender stripped: a vertical tab and a form feed render as
        // line breaks, and U+2028/U+2029 are the line and paragraph
        // separators by definition.
        for smuggled in [
            "/clear\u{b}rm -rf /",
            "!ls\u{c}rm -rf /",
            "$ echo hi\u{85}and a paragraph",
            "/clear\u{2028}rm -rf /",
            "!ls\u{2029}rm -rf /",
        ] {
            assert!(
                !looks_like_agent_command(smuggled),
                "{smuggled:?} carries a second line"
            );
            assert_eq!(
                format_shared_chat_agent_input(smuggled, &guest()),
                format!("[sam@example.com] {smuggled}"),
                "{smuggled:?} keeps its sender"
            );
        }
    }

    #[test]
    fn the_two_sides_trim_the_same_characters() {
        // Each language trimming with its own notion of whitespace made them
        // disagree about the same message: U+0085 is Unicode White_Space and
        // so trimmed here but not by JavaScript's `trim`, and U+FEFF is the
        // reverse. Both now trim White_Space plus U+FEFF.
        for wrapped in [
            "\u{feff}/clear",
            "\u{85}/clear",
            "/clear\u{feff}",
            "\u{a0}/clear\u{a0}",
        ] {
            assert!(
                looks_like_agent_command(wrapped),
                "{wrapped:?} is a command with invisible padding"
            );
            assert_eq!(
                format_shared_chat_agent_input(wrapped, &guest()),
                "/clear",
                "{wrapped:?} is sent as the bare command"
            );
        }
        // Padding alone is not a command, and is not an empty prefix either.
        assert!(!looks_like_agent_command("\u{feff}"));
        assert!(!looks_like_agent_command("\u{85}"));
    }

    #[test]
    fn a_heading_is_prose_and_keeps_its_sender() {
        // `#` at position zero is a markdown heading far more often than a
        // command, so it is not a sigil here.
        assert_eq!(
            format_shared_chat_agent_input("# Plan", &guest()),
            "[sam@example.com] # Plan"
        );
    }

    #[test]
    fn leading_whitespace_does_not_hide_a_command() {
        // Trimmed before the test and before sending, so a pasted command
        // with a stray space is still a command.
        assert_eq!(
            format_shared_chat_agent_input("   /clear", &guest()),
            "/clear"
        );
    }

    #[test]
    fn a_path_is_prose_and_keeps_its_sender() {
        // The false positive worth removing. A real path has more than one
        // segment, and a slash command has exactly one.
        for prose in [
            "/home/sam is broken",
            "/etc/hosts",
            "/Users/sam/cs/aimux",
            "/var/log/system.log please look",
        ] {
            assert_eq!(
                format_shared_chat_agent_input(prose, &guest()),
                format!("[sam@example.com] {prose}"),
                "{prose} is a path, not a command"
            );
        }
    }

    #[test]
    fn a_sigil_that_is_not_a_command_shape_is_prose() {
        assert!(!looks_like_agent_command("!!! this is broken"));
        assert!(!looks_like_agent_command("$500 over budget"));
        assert!(!looks_like_agent_command("/2fa.txt"));
        // And the shapes that ARE commands still are.
        assert!(looks_like_agent_command("/clear"));
        assert!(looks_like_agent_command("/model opus"));
        assert!(looks_like_agent_command("!ls -la"));
        assert!(looks_like_agent_command("$ echo hi"));
    }

    #[test]
    fn a_sigil_inside_the_line_is_prose() {
        // Only position zero decides. A sentence mentioning a path or a bang
        // is an ordinary message and keeps its sender.
        assert_eq!(
            format_shared_chat_agent_input("look at /etc/hosts", &guest()),
            "[sam@example.com] look at /etc/hosts"
        );
    }

    #[test]
    fn the_remote_path_agrees_with_the_body_path() {
        // Both callers go through `format_shared_chat_agent_input`, so a
        // command sent over the relay must be treated the same as one sent
        // through the project service body.
        let body = json!({
            "sharedChatActor": { "role": "guest", "displayName": "sam@example.com" }
        });
        assert_eq!(
            shared_chat_body_actor_prompt(&body, "/clear").as_deref(),
            Some("/clear")
        );
        assert_eq!(
            shared_chat_body_actor_prompt(&body, "hello").as_deref(),
            Some("[sam@example.com] hello")
        );
    }

    #[test]
    fn empty_input_is_still_refused() {
        let body = json!({
            "sharedChatActor": { "role": "guest", "displayName": "sam@example.com" }
        });
        assert_eq!(shared_chat_body_actor_prompt(&body, "   "), None);
    }
}
