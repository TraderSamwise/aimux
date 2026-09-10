use serde_json::{Map, Value};

use crate::remote_access::{RemoteActor, RemoteActorRole};

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

pub fn format_shared_chat_agent_input(text: &str, actor: &Value) -> String {
    format!("[{}] {}", safe_shared_chat_actor_name(actor), text.trim())
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
