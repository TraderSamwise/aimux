use crate::hosted_principals::{HostedPrincipal, HostedPrincipalsStore};
use crate::remote_access::{
    RemoteActor, RemoteActorRole, RemoteOperatorGrant, RemoteOperatorPrincipal,
};
use anyhow::Result;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedAuthentication {
    pub ok: bool,
    pub reason: Option<String>,
    pub principal: Option<HostedPrincipal>,
    pub actor: Option<RemoteActor>,
}

impl HostedAuthentication {
    pub fn missing_token() -> Self {
        Self {
            ok: false,
            reason: Some("missing_token".to_owned()),
            principal: None,
            actor: None,
        }
    }

    pub fn unknown_token() -> Self {
        Self {
            ok: false,
            reason: Some("unknown_token".to_owned()),
            principal: None,
            actor: None,
        }
    }

    fn authenticated(principal: HostedPrincipal) -> Self {
        Self {
            ok: true,
            reason: None,
            actor: Some(hosted_operator_actor(&principal)),
            principal: Some(principal),
        }
    }
}

pub fn strip_trusted_headers(headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(key, value)| {
            let normalized_key = key.to_ascii_lowercase();
            (!normalized_key.starts_with("x-aimux-")).then(|| (normalized_key, value.clone()))
        })
        .collect()
}

pub fn strip_trusted_headers_value(headers: &Value) -> Value {
    let mut clean = Map::new();
    if let Some(headers) = headers.as_object() {
        for (key, value) in headers {
            let normalized_key = key.to_ascii_lowercase();
            if normalized_key.starts_with("x-aimux-") || value.is_null() {
                continue;
            }
            if let Some(text) = value.as_str() {
                clean.insert(normalized_key, Value::String(text.to_owned()));
            } else if let Some(values) = value.as_array() {
                clean.insert(
                    normalized_key,
                    Value::String(
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                );
            }
        }
    }
    Value::Object(clean)
}

pub fn bearer_token(headers: &BTreeMap<String, String>) -> Option<String> {
    let raw = headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))?;
    bearer_token_from_header(raw)
}

pub fn bearer_token_value(headers: &Value) -> Option<String> {
    let raw = headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))?;
    if let Some(values) = raw.as_array() {
        return values
            .first()
            .and_then(Value::as_str)
            .and_then(bearer_token_from_header);
    }
    raw.as_str().and_then(bearer_token_from_header)
}

pub fn authenticate_hosted(
    headers: &BTreeMap<String, String>,
    store: &HostedPrincipalsStore,
) -> Result<HostedAuthentication> {
    let Some(token) = bearer_token(headers) else {
        return Ok(HostedAuthentication::missing_token());
    };
    let Some(principal) = store.find_principal_by_token(&token)? else {
        return Ok(HostedAuthentication::unknown_token());
    };
    Ok(HostedAuthentication::authenticated(principal))
}

pub fn authenticate_hosted_value(
    headers: &Value,
    store: &HostedPrincipalsStore,
) -> Result<HostedAuthentication> {
    let Some(token) = bearer_token_value(headers) else {
        return Ok(HostedAuthentication::missing_token());
    };
    let Some(principal) = store.find_principal_by_token(&token)? else {
        return Ok(HostedAuthentication::unknown_token());
    };
    Ok(HostedAuthentication::authenticated(principal))
}

fn bearer_token_from_header(header: &str) -> Option<String> {
    let trimmed = header.trim_start();
    let mut chars = trimmed.char_indices();
    let mut split_at = None;
    for (index, character) in chars.by_ref() {
        if character.is_whitespace() {
            split_at = Some(index);
            break;
        }
    }
    let split_at = split_at?;
    let scheme = &trimmed[..split_at];
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = trimmed[split_at..].trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn hosted_operator_actor(principal: &HostedPrincipal) -> RemoteActor {
    RemoteActor {
        role: RemoteActorRole::Operator,
        user_id: None,
        display_name: Some(principal.label.clone()),
        email: None,
        share_id: None,
        share_session_id: None,
        principal: Some(RemoteOperatorPrincipal {
            id: principal.id.clone(),
            label: principal.label.clone(),
            role: principal.role.clone(),
            grants: principal
                .grants
                .iter()
                .map(|grant| RemoteOperatorGrant {
                    project_root: grant.project_root.clone(),
                    session_id: grant.session_id.clone(),
                })
                .collect(),
            revoked_at: principal.revoked_at.clone(),
        }),
    }
}
