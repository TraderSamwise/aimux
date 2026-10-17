//! The daemon's recorded state, as a shape.
//!
//! Reading and writing the file stays in the local crate: that is path
//! resolution, locking and atomic replacement. This is only what the record
//! looks like, because the CLI runtime trait names it and both halves
//! implement that trait.

use serde::Serialize;
use serde_json::{Map, Value};

const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
    pub projects: Map<String, Value>,
}

impl DaemonState {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: Some(Value::String(EPOCH_ISO.into())),
            projects: Map::new(),
        }
    }
}
