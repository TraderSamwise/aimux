//! Asking the daemon to run a core command, and what came back.
//!
//! The remote half plans the same core commands over the relay, and this one
//! method is all it needs of whoever runs them -- the twenty-three others on
//! the local CLI runtime are the local build's own business. So the narrow
//! trait lives here and the wide one stays where it is implemented.

use crate::core_cli_transport::{CoreCommandCall, CoreCommandOk};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCliExecution {
    pub code: i32,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

impl CoreCliExecution {
    pub fn ok(stdout: Vec<String>) -> Self {
        Self {
            code: 0,
            stdout,
            stderr: Vec::new(),
        }
    }

    pub fn error(message: impl Into<String>, code: i32) -> Self {
        Self {
            code,
            stdout: Vec::new(),
            stderr: vec![message.into()],
        }
    }
}

pub trait CoreCommandRequester {
    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String>;
}
