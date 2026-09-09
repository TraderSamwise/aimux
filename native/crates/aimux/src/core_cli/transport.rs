use crate::core_command_contract::{CORE_API_ROUTES, is_core_command_name};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use super::CORE_DIAGNOSTIC_TIMEOUT_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandRequestOptions {
    pub ensure_daemon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for CoreCommandRequestOptions {
    fn default() -> Self {
        Self {
            ensure_daemon: true,
            timeout_ms: None,
        }
    }
}

impl CoreCommandRequestOptions {
    pub(super) fn existing_daemon() -> Self {
        Self {
            ensure_daemon: false,
            timeout_ms: Some(CORE_DIAGNOSTIC_TIMEOUT_MS),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl CoreCommandEnvelope {
    pub fn new(command: impl Into<String>, payload: Option<Value>) -> Self {
        Self {
            id: None,
            command: command.into(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CoreHttpMethod {
    Post,
}

impl CoreHttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCommandTransportRequest {
    pub route: &'static str,
    pub method: CoreHttpMethod,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreCommandCall {
    pub command: &'static str,
    pub payload: Option<Value>,
    pub options: CoreCommandRequestOptions,
}

impl CoreCommandCall {
    pub fn transport_request(&self) -> Result<CoreCommandTransportRequest, serde_json::Error> {
        build_core_command_transport_request(
            self.command,
            self.payload.clone(),
            self.options.timeout_ms,
        )
    }
}

pub fn build_core_command_transport_request(
    command: &str,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<CoreCommandTransportRequest, serde_json::Error> {
    let body = serde_json::to_string(&CoreCommandEnvelope::new(command, payload))?;
    Ok(CoreCommandTransportRequest {
        route: CORE_API_ROUTES.commands,
        method: CoreHttpMethod::Post,
        headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        body,
        timeout_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandOk {
    pub ok: bool,
    pub id: String,
    pub command: String,
    pub issued_at: String,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandError {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CoreCommandResponse {
    Ok(CoreCommandOk),
    Error(CoreCommandError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreCommandResponseError {
    InvalidResponse(String),
    CommandError(String),
    CommandMismatch { expected: String, actual: String },
}

impl Display for CoreCommandResponseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidResponse(message) | Self::CommandError(message) => {
                formatter.write_str(message)
            }
            Self::CommandMismatch { expected, actual } => write!(
                formatter,
                "core command response mismatch: expected {expected}, got {actual}"
            ),
        }
    }
}

impl Error for CoreCommandResponseError {}

pub fn validate_core_command_response(
    expected_command: &str,
    response: Value,
) -> Result<CoreCommandOk, CoreCommandResponseError> {
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("invalid core command error response");
        return Err(CoreCommandResponseError::CommandError(message.to_owned()));
    }
    let parsed: CoreCommandOk = serde_json::from_value(response).map_err(|error| {
        CoreCommandResponseError::InvalidResponse(format!("invalid core command response: {error}"))
    })?;
    if parsed.command != expected_command {
        return Err(CoreCommandResponseError::CommandMismatch {
            expected: expected_command.to_owned(),
            actual: parsed.command,
        });
    }
    Ok(parsed)
}

pub(super) fn call(
    command: &'static str,
    payload: Option<Value>,
    options: CoreCommandRequestOptions,
) -> CoreCommandCall {
    debug_assert!(is_core_command_name(command));
    CoreCommandCall {
        command,
        payload,
        options,
    }
}
