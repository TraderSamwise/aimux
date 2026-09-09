use crate::core_cli::{CoreCommandOk, CoreCommandRequestOptions};
use crate::core_command_transport::{CoreCommandTransportError, send_core_command};
use crate::daemon_state::EnsureDaemonRunningOptions;
use crate::daemon_supervisor::{DaemonSupervisorError, ensure_daemon_running};
use serde_json::Value;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug)]
pub enum CoreCommandClientError {
    Supervisor(DaemonSupervisorError),
    Transport(CoreCommandTransportError),
}

impl Display for CoreCommandClientError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Supervisor(error) => Display::fmt(error, formatter),
            Self::Transport(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for CoreCommandClientError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Supervisor(error) => Some(error),
            Self::Transport(error) => Some(error),
        }
    }
}

pub fn request_core_command(
    command: &str,
    payload: Option<Value>,
    options: CoreCommandRequestOptions,
) -> Result<CoreCommandOk, CoreCommandClientError> {
    if options.ensure_daemon {
        ensure_daemon_running(EnsureDaemonRunningOptions::default())
            .map_err(CoreCommandClientError::Supervisor)?;
    }
    send_core_command(command, payload, options.timeout_ms)
        .map_err(CoreCommandClientError::Transport)
}
