//! How the daemon answers the remote half's auth-text questions.
//!
//! The impl lives here rather than beside `RealDaemonRuntime`, where it was a
//! foreign-trait-for-local-type impl under a `#[cfg]` -- and where it dragged
//! three `use crate::remote::..` lines into a file the local build compiles.
//! Rust allows it on this side because the crate is still one crate; the
//! runtime's remote state is `pub(crate)` so this can reach the login flows it
//! drives.
//!
//! When the far side becomes its own crate, this impl is the one thing that
//! cannot simply travel with it -- a foreign trait for a foreign type -- and
//! the shape it wants then is the runtime holding a `dyn` the far side
//! installs. Written down because it is the next phase's main problem.

use serde_json::{Value, json};

use std::sync::atomic::Ordering;

use crate::daemon::core_commands::DaemonCoreCommandRuntime;
use crate::daemon::runtime::RealDaemonRuntime;
use crate::daemon::status::DaemonStatusRuntime;
use crate::remote::daemon_auth_text::{
    AuthAction, AuthFlowError, AuthFlowResult, AuthFlowStart, AuthTextError, DaemonAuthTextRuntime,
};
use crate::remote::remote_credentials;
use crate::remote::remote_login::{self, LoginAction, LoginFlowWaiter};

impl DaemonAuthTextRuntime for RealDaemonRuntime {
    fn remote_status_text_payload(&self) -> Value {
        let credentials = remote_credentials::load_credentials(&self.resolver).map(|credentials| {
            json!({
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        });
        json!({ "credentials": credentials, "relay": self.relay_status() })
    }

    fn whoami_text_payload(&self) -> Value {
        let credentials = remote_credentials::load_credentials(&self.resolver).map(|credentials| {
            json!({
                "userId": credentials.user_id,
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        });
        json!({ "credentials": credentials })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        if remote_credentials::load_credentials(&self.resolver).is_some() {
            Ok(())
        } else {
            Err(AuthTextError {
                status: 401,
                error: "Not logged in. Run `aimux login` first.".into(),
            })
        }
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self)
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        <Self as DaemonCoreCommandRuntime>::relay_auth_failed_message(self, relay)
    }

    fn disable_relay(&mut self) {
        <Self as DaemonCoreCommandRuntime>::disable_relay(self);
    }

    fn clear_credentials(&mut self) -> String {
        remote_credentials::clear_credentials(&self.resolver)
            .as_str()
            .into()
    }

    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        match remote_login::run_login_flow(
            &self.resolver,
            match action {
                AuthAction::Login => LoginAction::Login,
                AuthAction::SecurityUnlock => LoginAction::SecurityUnlock,
            },
        ) {
            Ok(result) => Ok(AuthFlowResult {
                user_id: result.user_id,
                relay: <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self),
                messages: result.messages,
            }),
            Err(error) => Err(AuthFlowError {
                error,
                messages: Vec::new(),
            }),
        }
    }

    fn start_auth_flow(&mut self, action: AuthAction) -> AuthFlowStart {
        let id = format!(
            "native-auth-{}",
            self.next_command.fetch_add(1, Ordering::Relaxed) + 1
        );
        match remote_login::start_login_flow(
            &self.resolver,
            match action {
                AuthAction::Login => LoginAction::Login,
                AuthAction::SecurityUnlock => LoginAction::SecurityUnlock,
            },
        ) {
            Ok((messages, waiter)) => {
                self.remote
                    .auth_flows()
                    .lock()
                    .expect("auth flow mutex")
                    .insert(id.clone(), waiter);
                AuthFlowStart { id, messages }
            }
            Err(error) => {
                self.remote
                    .auth_flows()
                    .lock()
                    .expect("auth flow mutex")
                    .insert(id.clone(), LoginFlowWaiter::ready_error(error));
                AuthFlowStart {
                    id,
                    messages: Vec::new(),
                }
            }
        }
    }

    fn wait_auth_flow(
        &mut self,
        id: &str,
        _action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        let waiter = self
            .remote
            .auth_flows()
            .lock()
            .expect("auth flow mutex")
            .remove(id)
            .ok_or_else(|| AuthTextError {
                status: 404,
                error: "auth session not found".into(),
            })?;
        match waiter.wait() {
            Ok(result) => Ok(AuthFlowResult {
                user_id: result.user_id,
                relay: <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self),
                messages: result.messages,
            }),
            Err(error) => Err(AuthTextError { status: 500, error }),
        }
    }
}
