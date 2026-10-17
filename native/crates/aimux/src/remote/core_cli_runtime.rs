//! How the CLI runtime answers the remote half's questions.
//!
//! The impl lives here rather than beside `RealCoreCliRuntime`, where it was a
//! foreign-trait-for-local-type impl under a `#[cfg]` -- one more place a
//! reviewer of the local build had to check. Rust allows it on this side
//! because the crate is the same one; when the far side becomes its own crate
//! it comes with it, and `RealCoreCliRuntime` is a unit struct so nothing has
//! to be opened up for it.

use serde_json::{Value, json};

use crate::core_cli_executor::RealCoreCliRuntime;
use crate::paths::PathResolver;

impl crate::remote::cli::RemoteCliRuntime for RealCoreCliRuntime {
    fn credentials_for_status(&self) -> Option<Value> {
        let resolver = PathResolver::from_env();
        crate::remote::remote_credentials::load_credentials(&resolver).map(|credentials| {
            json!({
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        })
    }

    fn whoami_payload(&self) -> Value {
        let resolver = PathResolver::from_env();
        let credentials =
            crate::remote::remote_credentials::load_credentials(&resolver).map(|credentials| {
                json!({
                    "userId": credentials.user_id,
                    "relayUrl": credentials.relay_url,
                    "remoteEnabled": credentials.remote_enabled,
                })
            });
        json!({ "credentials": credentials })
    }

    fn set_remote_enabled(&self, enabled: bool) -> Result<(), String> {
        let resolver = PathResolver::from_env();
        crate::remote::remote_credentials::set_remote_enabled(&resolver, enabled)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn clear_credentials(&self) -> String {
        let resolver = PathResolver::from_env();
        crate::remote::remote_credentials::clear_credentials(&resolver)
            .as_str()
            .into()
    }

    fn run_login_flow(
        &self,
        security_unlock: bool,
    ) -> Result<crate::remote::daemon_auth_text::AuthFlowResult, String> {
        let resolver = PathResolver::from_env();
        let result = crate::remote::remote_login::run_login_flow(
            &resolver,
            if security_unlock {
                crate::remote::remote_login::LoginAction::SecurityUnlock
            } else {
                crate::remote::remote_login::LoginAction::Login
            },
        )?;
        Ok(crate::remote::daemon_auth_text::AuthFlowResult {
            user_id: result.user_id,
            relay: Value::Null,
            messages: result.messages,
        })
    }

    fn list_remote_security_devices(&self, pending: bool) -> Result<Vec<Value>, String> {
        crate::remote::remote_security_devices::list_remote_security_devices(pending)
    }

    fn update_remote_security_device(
        &self,
        device_id: &str,
        action: &str,
        approval_code: Option<&str>,
    ) -> Result<Value, String> {
        crate::remote::remote_security_devices::update_remote_security_device(
            device_id,
            action,
            approval_code,
        )
    }
}
