//! What an event stream says, as data.
//!
//! These cross between the daemon that opens a stream and the hosted server
//! that pipes it, so they live where both can name them. Opening a stream is
//! not here: that needs a connection, which this crate does not do.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAgentStreamError {
    InvalidUrl(String),
    InvalidResponse(String),
    Io(String),
    Upstream(String),
    Transform(String),
}

impl Display for HostAgentStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(message) | Self::InvalidResponse(message) => {
                formatter.write_str(message)
            }
            Self::Io(message) | Self::Upstream(message) | Self::Transform(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl Error for HostAgentStreamError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostAgentStreamRequestOptions {
    pub timeout_ms: Option<u64>,
}

impl Default for HostAgentStreamRequestOptions {
    fn default() -> Self {
        Self {
            timeout_ms: Some(10_000),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectEventStreamChunk {
    Data(Vec<u8>),
    Timeout,
    Eof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectEventStreamTarget {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOperatorStreamTarget {
    pub url: String,
    pub project_root: String,
}
