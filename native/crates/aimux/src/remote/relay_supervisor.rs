//! The relay client's lifetime, and the one place it is started.
//!
//! The bridge that answers the relay is not built here: only the local crate
//! can reach the daemon, so it hands one in. This owns the runner, the
//! reconnect rule and the status that tells "no relay configured" apart from
//! "configured and down".

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::remote::relay_client::RelayStatus;
use crate::remote::relay_runner::{DaemonRelayBridge, RelayHandle, RelayRunner};
use crate::remote::websocket::TokioTungsteniteConnector;
use aimux_core::async_runtime::{spawn_named, task_name};
use aimux_core::machine_identity::MachineIdentity;

/// Owns the relay client for the life of the daemon.
#[derive(Default)]
pub struct RelaySupervisor {
    current: Mutex<Option<(Arc<RelayRunner>, RelayHandle)>>,
}

impl RelaySupervisor {
    /// Node skipped a reconnect unless forced, or unless the existing client
    /// had already given up — otherwise every status poll would restart it.
    pub fn connect(
        &self,
        relay_url: &str,
        token: &str,
        machine: MachineIdentity,
        force: bool,
        build_bridge: impl FnOnce() -> Arc<dyn DaemonRelayBridge>,
    ) {
        if relay_url.is_empty() || token.is_empty() {
            return;
        }
        {
            let current = self.current.lock().ok();
            if let Some(current) = current.as_ref()
                && let Some((_, handle)) = current.as_ref()
            {
                let status = handle.status().status;
                let finished = matches!(
                    status,
                    Some(RelayStatus::AuthFailed) | Some(RelayStatus::Disconnected)
                );
                if !force && !finished {
                    return;
                }
                handle.stop();
            }
        }

        let runner = RelayRunner::new(relay_url, token, machine, build_bridge());
        let handle = runner.handle();
        if let Ok(mut current) = self.current.lock() {
            *current = Some((Arc::clone(&runner), handle.clone()));
        }
        spawn_named(task_name("daemon", "relay"), async move {
            let mut connector = TokioTungsteniteConnector;
            runner.run(&mut connector).await;
        });
    }

    pub fn disconnect(&self) {
        if let Ok(mut current) = self.current.lock()
            && let Some((_, handle)) = current.take()
        {
            handle.stop();
        }
    }

    /// Send a notification over the live relay, or say why it could not go.
    ///
    /// The caller reports this to the project service, so the reason has to
    /// distinguish "no relay configured" from "relay is configured but down" —
    /// otherwise a broken connection looks like an intentional setting.
    pub fn push(&self, notification: &Value) -> Result<(), String> {
        let Ok(current) = self.current.lock() else {
            return Err("relay_unavailable".to_owned());
        };
        let Some((runner, handle)) = current.as_ref() else {
            return Err("relay_off".to_owned());
        };
        if handle.status().status != Some(RelayStatus::Connected) {
            return Err("relay_disconnected".to_owned());
        }
        runner.push_notification(notification)
    }

    /// `off` means there is no client at all, which is a different thing from a
    /// client that exists and is disconnected.
    pub fn status(&self) -> Value {
        match self.current.lock() {
            Ok(current) => match current.as_ref() {
                Some((_, handle)) => handle.status().to_json(),
                None => json!({ "status": "off" }),
            },
            Err(_) => json!({ "status": "off" }),
        }
    }
}
