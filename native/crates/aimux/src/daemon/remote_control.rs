#[cfg(feature = "remote-control")]
pub use enabled::{
    MaybeDaemonRemoteTextRuntime, hosted_outbox_drain_callback, hosted_prune_callback,
    route_remote_core_command, route_remote_json_request, route_remote_text_request,
};

#[cfg(not(feature = "remote-control"))]
pub use disabled::{
    MaybeDaemonRemoteTextRuntime, route_remote_core_command, route_remote_json_request,
    route_remote_text_request,
};

#[cfg(feature = "remote-control")]
mod enabled {
    use crate::daemon::core_commands::DaemonCoreCommandRuntime;
    use crate::daemon::routing::DaemonRouteResponse;
    use crate::remote::daemon_auth_text::{DaemonAuthTextRuntime, route_auth_text_request};
    use serde_json::json;

    pub trait MaybeDaemonRemoteTextRuntime: DaemonAuthTextRuntime {}

    impl<T> MaybeDaemonRemoteTextRuntime for T where T: DaemonAuthTextRuntime {}

    pub fn route_remote_text_request(
        runtime: &mut impl MaybeDaemonRemoteTextRuntime,
        method: &str,
        path: &str,
    ) -> Option<DaemonRouteResponse> {
        route_auth_text_request(runtime, method, path)
    }

    pub fn route_remote_json_request(
        runtime: &mut impl DaemonCoreCommandRuntime,
        method: &str,
        pathname: &str,
    ) -> Option<DaemonRouteResponse> {
        if method == "GET" && pathname == "/relay/status" {
            return Some(DaemonRouteResponse::json(
                200,
                json!({ "ok": true, "relay": runtime.relay_status() }),
            ));
        }

        if method == "POST" && pathname == "/relay/enable" {
            if !runtime.has_remote_credentials() {
                return Some(DaemonRouteResponse::json(
                    401,
                    json!({ "ok": false, "error": "Not logged in. Run `aimux login` first." }),
                ));
            }
            let relay = runtime.enable_relay_for_user_request();
            if relay.get("status").and_then(serde_json::Value::as_str) == Some("auth_failed") {
                return Some(DaemonRouteResponse::json(
                    401,
                    json!({ "ok": false, "error": runtime.relay_auth_failed_message(&relay), "relay": relay }),
                ));
            }
            return Some(DaemonRouteResponse::json(
                200,
                json!({ "ok": true, "relay": relay }),
            ));
        }

        if method == "POST" && pathname == "/relay/disable" {
            return Some(DaemonRouteResponse::json(
                200,
                json!({ "ok": true, "relay": runtime.disable_relay() }),
            ));
        }

        None
    }

    pub fn route_remote_core_command(
        runtime: &mut impl DaemonCoreCommandRuntime,
        id: &str,
        command: &str,
        issued_at: &str,
    ) -> Option<DaemonRouteResponse> {
        use crate::core_command_contract::CORE_COMMAND_NAMES;
        use crate::daemon::core_commands::{command_error, command_ok};

        let result = match command {
            command if command == CORE_COMMAND_NAMES.relay_status => {
                json!({ "relay": runtime.relay_status() })
            }
            command if command == CORE_COMMAND_NAMES.relay_enable => {
                if !runtime.has_remote_credentials() {
                    return Some(DaemonRouteResponse::json(
                        401,
                        command_error(id, Some(command), "Not logged in. Run `aimux login` first."),
                    ));
                }
                let relay = runtime.enable_relay_for_user_request();
                if relay.get("status").and_then(serde_json::Value::as_str) == Some("auth_failed") {
                    let message = runtime.relay_auth_failed_message(&relay);
                    return Some(DaemonRouteResponse::json(
                        401,
                        command_error(id, Some(command), message),
                    ));
                }
                json!({ "relay": relay })
            }
            command if command == CORE_COMMAND_NAMES.relay_disable => {
                json!({ "relay": runtime.disable_relay() })
            }
            _ => return None,
        };
        Some(DaemonRouteResponse::json(
            200,
            command_ok(id, command, issued_at, result),
        ))
    }

    pub fn hosted_prune_callback(
        state: &std::sync::Arc<crate::remote::hosted_server::HostedServerState>,
    ) -> crate::daemon::scheduler::HostedPruneCallback {
        let state = std::sync::Arc::downgrade(state);
        std::sync::Arc::new(move || match std::sync::Weak::upgrade(&state) {
            Some(state) => state.prune_for_scheduler(),
            None => Ok(()),
        })
    }

    pub fn hosted_outbox_drain_callback(
        state: &std::sync::Arc<crate::remote::hosted_server::HostedServerState>,
    ) -> crate::daemon::scheduler::HostedOutboxDrainCallback {
        let state = std::sync::Arc::downgrade(state);
        std::sync::Arc::new(move || match std::sync::Weak::upgrade(&state) {
            Some(state) => state.drain_outbox_for_scheduler(),
            None => Ok(()),
        })
    }
}

#[cfg(not(feature = "remote-control"))]
mod disabled {
    use crate::daemon::core_commands::DaemonCoreCommandRuntime;
    use crate::daemon::routing::DaemonRouteResponse;

    pub trait MaybeDaemonRemoteTextRuntime {}

    impl<T> MaybeDaemonRemoteTextRuntime for T {}

    pub fn route_remote_text_request(
        runtime: &mut impl MaybeDaemonRemoteTextRuntime,
        method: &str,
        path: &str,
    ) -> Option<DaemonRouteResponse> {
        let _ = (runtime, method, path);
        None
    }

    pub fn route_remote_json_request(
        runtime: &mut impl DaemonCoreCommandRuntime,
        method: &str,
        pathname: &str,
    ) -> Option<DaemonRouteResponse> {
        let _ = (runtime, method, pathname);
        None
    }

    pub fn route_remote_core_command(
        _runtime: &mut impl DaemonCoreCommandRuntime,
        id: &str,
        command: &str,
        _issued_at: &str,
    ) -> Option<DaemonRouteResponse> {
        if remote_core_command_name(command) {
            return Some(DaemonRouteResponse::json(
                400,
                crate::daemon::core_commands::command_error(
                    id,
                    Some(command),
                    "remote control commands are not available in the local build",
                ),
            ));
        }
        None
    }

    fn remote_core_command_name(command: &str) -> bool {
        use crate::core_command_contract::CORE_COMMAND_NAMES;

        command == CORE_COMMAND_NAMES.relay_status
            || command == CORE_COMMAND_NAMES.relay_enable
            || command == CORE_COMMAND_NAMES.relay_disable
    }
}
