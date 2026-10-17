//! A project as the projects route reports it.
//!
//! The daemon builds these from its catalog and the hosted server reads them
//! to resolve a caller's project, so the shape lives where both can name it.
//! Building one needs the catalog and stays in the local crate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsRouteProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub dashboard_session_name: String,
    pub service: Option<Value>,
    pub service_alive: bool,
    /// Whether this project has a live tmux dashboard. `None` means tmux could
    /// not be asked, which is not the same answer as "no dashboard" -- a client
    /// that renders unknown as offline would call a whole fleet dead on one
    /// failed query. Always serialized so a client can tell the three apart.
    pub dashboard_alive: Option<bool>,
    pub service_endpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online_agent_count: Option<usize>,
}
