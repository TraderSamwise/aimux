//! What answering a remote auth request takes, and what it answers with.
//!
//! The trait is here so the only thing that can satisfy it -- the local
//! daemon, which holds the credentials and the relay state -- does not have to
//! live on the far side to implement it. Rendering the replies is the remote
//! half's own business and stays there.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthAction {
    Login,
    SecurityUnlock,
}

impl AuthAction {
    pub fn failure_prefix(self) -> &'static str {
        match self {
            Self::Login => "Login failed",
            Self::SecurityUnlock => "Security unlock failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthFlowResult {
    pub user_id: String,
    pub relay: Value,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFlowStart {
    pub id: String,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthTextError {
    pub status: u16,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFlowError {
    pub error: String,
    pub messages: Vec<String>,
}

pub trait DaemonAuthTextRuntime {
    fn remote_status_text_payload(&self) -> Value;
    fn whoami_text_payload(&self) -> Value;
    fn require_remote_credentials(&self) -> Result<(), AuthTextError>;
    fn enable_relay_for_user_request(&mut self) -> Value;
    fn relay_auth_failed_message(&self, relay: &Value) -> String;
    fn disable_relay(&mut self);
    fn clear_credentials(&mut self) -> String;
    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError>;
    fn start_auth_flow(&mut self, action: AuthAction) -> AuthFlowStart;
    fn wait_auth_flow(
        &mut self,
        id: &str,
        action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError>;
}
