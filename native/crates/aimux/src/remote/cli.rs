use crate::core_cli::{
    CoreCliAction, CoreCliContext, CoreCliFallback, CoreCliOperation, CoreCliOutputMode,
    CoreCliPlanError, CoreCommandCall, CoreCommandRequestOptions,
};
use crate::core_cli_executor::{CoreCliExecution, CoreCliRuntime};
use crate::core_command_contract::CORE_COMMAND_NAMES;
use crate::core_text::{
    core_whoami_json, render_core_login_lines, render_core_logout_lines,
    render_core_remote_disable_lines, render_core_remote_enable_lines,
    render_core_remote_security_device_mutation_line, render_core_remote_security_devices_lines,
    render_core_remote_status_lines, render_core_security_unlock_lines, render_core_whoami_lines,
};
use crate::remote::daemon_auth_text::AuthFlowResult;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteCliOperation {
    RemoteStatus,
    RemoteEnable,
    RemoteDisable,
    Whoami,
    Logout,
    Login,
    SecurityUnlock,
    SecurityDevices,
    SecurityDeviceApprove,
    SecurityDeviceBlock,
    SecurityDeviceUnblock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteCliFallback {
    RelayOff,
    NotLoggedIn,
    DisableRemoteLocally,
    IgnoreRelayDisableFailure,
    RelayDisconnected,
    RelayDeferredUntilDaemonStart,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteCliAction {
    RemoteStatus {
        relay_request: Option<CoreCommandCall>,
    },
    RemoteEnable {
        relay_request: Option<CoreCommandCall>,
    },
    RemoteDisable {
        relay_request: Option<CoreCommandCall>,
    },
    Whoami,
    Logout {
        relay_disable: Option<CoreCommandCall>,
    },
    Login {
        security_unlock: bool,
        relay_enable: Option<CoreCommandCall>,
    },
    SecurityDevices {
        json: bool,
    },
    SecurityDeviceApproveLive {
        device_id: Option<String>,
        json: bool,
    },
    SecurityDeviceUpdate {
        device_id: String,
        action: &'static str,
        approval_code: Option<String>,
        json: bool,
    },
}

pub trait RemoteCliRuntime: CoreCliRuntime {
    fn credentials_for_status(&self) -> Option<Value>;
    fn whoami_payload(&self) -> Value;
    fn set_remote_enabled(&self, enabled: bool) -> Result<(), String>;
    fn clear_credentials(&self) -> String;
    fn run_login_flow(&self, security_unlock: bool) -> Result<AuthFlowResult, String>;
    fn list_remote_security_devices(&self, pending: bool) -> Result<Vec<Value>, String>;
    fn update_remote_security_device(
        &self,
        device_id: &str,
        action: &str,
        approval_code: Option<&str>,
    ) -> Result<Value, String>;
}

pub fn is_remote_core_cli_command(command: &str, subcommand: &str) -> bool {
    matches!(command, "remote" | "whoami" | "logout" | "login")
        || matches!(
            (command, subcommand),
            (
                "security",
                "unlock" | "devices" | "device" | "approve" | "block" | "revoke" | "unblock"
            )
        )
}

pub fn plan_remote_core_cli(
    args: &[String],
    context: &CoreCliContext,
) -> Result<(CoreCliOperation, CoreCliAction, CoreCliFallback), CoreCliPlanError> {
    let command = args.first().map(String::as_str).unwrap_or("");
    let subcommand = args.get(1).map(String::as_str).unwrap_or("");
    match (command, subcommand) {
        ("remote", "status") => {
            let relay_request = (context.has_credentials && context.daemon_running)
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_status));
            Ok(remote_plan(
                RemoteCliOperation::RemoteStatus,
                RemoteCliAction::RemoteStatus { relay_request },
                Some(RemoteCliFallback::RelayOff),
            ))
        }
        ("remote", "enable") => {
            let relay_request = context
                .has_credentials
                .then(|| default_call(CORE_COMMAND_NAMES.relay_enable, None));
            Ok(remote_plan(
                RemoteCliOperation::RemoteEnable,
                RemoteCliAction::RemoteEnable { relay_request },
                if context.has_credentials {
                    None
                } else {
                    Some(RemoteCliFallback::NotLoggedIn)
                },
            ))
        }
        ("remote", "disable") => {
            let relay_request = context
                .daemon_running
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_disable));
            Ok(remote_plan(
                RemoteCliOperation::RemoteDisable,
                RemoteCliAction::RemoteDisable { relay_request },
                if context.daemon_running {
                    None
                } else {
                    Some(RemoteCliFallback::DisableRemoteLocally)
                },
            ))
        }
        ("whoami", _) => Ok(remote_plan(
            RemoteCliOperation::Whoami,
            RemoteCliAction::Whoami,
            None,
        )),
        ("logout", _) => Ok(remote_plan(
            RemoteCliOperation::Logout,
            RemoteCliAction::Logout {
                relay_disable: context
                    .daemon_running
                    .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_disable)),
            },
            if context.daemon_running {
                Some(RemoteCliFallback::IgnoreRelayDisableFailure)
            } else {
                None
            },
        )),
        ("login", _) | ("security", "unlock") => {
            let security_unlock = command == "security";
            let relay_enable = context
                .daemon_running
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_enable));
            Ok(remote_plan(
                if security_unlock {
                    RemoteCliOperation::SecurityUnlock
                } else {
                    RemoteCliOperation::Login
                },
                RemoteCliAction::Login {
                    security_unlock,
                    relay_enable,
                },
                if context.daemon_running {
                    Some(RemoteCliFallback::RelayDisconnected)
                } else {
                    Some(RemoteCliFallback::RelayDeferredUntilDaemonStart)
                },
            ))
        }
        ("security", "devices") if args[2..].iter().all(|arg| arg == "--json") => Ok(remote_plan(
            RemoteCliOperation::SecurityDevices,
            RemoteCliAction::SecurityDevices {
                json: args[2..].iter().any(|arg| arg == "--json"),
            },
            None,
        )),
        ("security", "device") if args.get(2).map(String::as_str) == Some("approve") => {
            let parsed = parse_security_device_approve_live_args(args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.to_vec(),
                    message: "error: invalid security device approve arguments".into(),
                }
            })?;
            Ok(remote_plan(
                RemoteCliOperation::SecurityDeviceApprove,
                RemoteCliAction::SecurityDeviceApproveLive {
                    device_id: parsed.device_id,
                    json: parsed.json,
                },
                None,
            ))
        }
        ("security", "approve" | "block" | "revoke" | "unblock") => {
            let parsed = parse_security_device_update_args(args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.to_vec(),
                    message: "error: invalid security device arguments".into(),
                }
            })?;
            Ok(remote_plan(
                match parsed.action {
                    "approve" => RemoteCliOperation::SecurityDeviceApprove,
                    "block" | "revoke" => RemoteCliOperation::SecurityDeviceBlock,
                    "unblock" => RemoteCliOperation::SecurityDeviceUnblock,
                    _ => unreachable!("validated security action"),
                },
                RemoteCliAction::SecurityDeviceUpdate {
                    device_id: parsed.device_id,
                    action: if parsed.action == "revoke" {
                        "block"
                    } else {
                        parsed.action
                    },
                    approval_code: parsed.approval_code,
                    json: parsed.json,
                },
                None,
            ))
        }
        _ => Err(CoreCliPlanError::Unsupported {
            args: args.to_vec(),
        }),
    }
}

pub fn run_remote_cli_action(
    action: RemoteCliAction,
    output_mode: CoreCliOutputMode,
    runtime: &mut impl RemoteCliRuntime,
) -> Result<CoreCliExecution, String> {
    match action {
        RemoteCliAction::RemoteStatus { relay_request } => {
            let credentials = runtime.credentials_for_status();
            let relay = match relay_request {
                Some(request) => runtime
                    .request_core_command(&request)
                    .map(|response| response.result["relay"].clone())
                    .unwrap_or_else(|_| json!({ "status": "off" })),
                None => json!({ "status": "off" }),
            };
            let payload = json!({ "credentials": credentials, "relay": relay.clone() });
            render_json_or_lines(
                output_mode,
                json!({ "loggedIn": payload.get("credentials").is_some_and(|value| !value.is_null()), "relay": relay }),
                render_core_remote_status_lines(&payload),
            )
        }
        RemoteCliAction::RemoteEnable { relay_request } => {
            let Some(request) = relay_request else {
                return Ok(CoreCliExecution::error(
                    "Not logged in. Run `aimux login` first.",
                    1,
                ));
            };
            let response = runtime.request_core_command(&request)?;
            render_json_or_lines(
                output_mode,
                json!({ "relay": response.result["relay"].clone() }),
                render_core_remote_enable_lines(&response.result["relay"]),
            )
        }
        RemoteCliAction::RemoteDisable { relay_request } => {
            let daemon_disconnected = relay_request.is_some();
            if let Some(request) = relay_request {
                runtime.request_core_command(&request)?;
            } else {
                runtime.set_remote_enabled(false)?;
            }
            render_json_or_lines(
                output_mode,
                json!({ "remoteEnabled": false, "daemonDisconnected": daemon_disconnected }),
                render_core_remote_disable_lines(daemon_disconnected),
            )
        }
        RemoteCliAction::Whoami => {
            let payload = runtime.whoami_payload();
            render_json_or_lines(
                output_mode,
                core_whoami_json(&payload),
                render_core_whoami_lines(&payload),
            )
        }
        RemoteCliAction::Logout { relay_disable } => {
            if let Some(request) = relay_disable {
                let _ = runtime.request_core_command(&request);
            }
            let result = runtime.clear_credentials();
            render_json_or_lines(
                output_mode,
                json!({ "result": result }),
                render_core_logout_lines(&result),
            )
        }
        RemoteCliAction::Login {
            security_unlock,
            relay_enable,
        } => {
            let result = runtime.run_login_flow(security_unlock)?;
            let relay = match relay_enable {
                Some(request) => runtime
                    .request_core_command(&request)
                    .map(|response| response.result["relay"].clone())
                    .unwrap_or_else(|error| {
                        json!({
                            "status": "disconnected",
                            "relayUrl": "",
                            "lastConnectedAt": Value::Null,
                            "lastError": error,
                        })
                    }),
                None => json!({ "status": "off" }),
            };
            let payload = json!({ "userId": result.user_id, "relay": relay });
            let mut lines = result.messages;
            if security_unlock {
                lines.extend(render_core_security_unlock_lines(&payload));
            } else {
                lines.extend(render_core_login_lines(&payload));
            }
            Ok(CoreCliExecution::ok(lines))
        }
        RemoteCliAction::SecurityDevices { json } => {
            run_security_devices(json, false, output_mode, runtime)
        }
        RemoteCliAction::SecurityDeviceApproveLive { device_id, json } => {
            run_security_device_approve_live(device_id.as_deref(), json, output_mode, runtime)
        }
        RemoteCliAction::SecurityDeviceUpdate {
            device_id,
            action,
            approval_code,
            json,
        } => run_security_device_update(
            &device_id,
            action,
            approval_code.as_deref(),
            json,
            output_mode,
            runtime,
        ),
    }
}

fn remote_plan(
    operation: RemoteCliOperation,
    action: RemoteCliAction,
    fallback: Option<RemoteCliFallback>,
) -> (CoreCliOperation, CoreCliAction, CoreCliFallback) {
    (
        CoreCliOperation::Remote(operation),
        CoreCliAction::Remote(action),
        fallback
            .map(CoreCliFallback::Remote)
            .unwrap_or(CoreCliFallback::None),
    )
}

fn default_call(command: &'static str, payload: Option<Value>) -> CoreCommandCall {
    CoreCommandCall {
        command,
        payload,
        options: CoreCommandRequestOptions::default(),
    }
}

fn existing_daemon_call(command: &'static str) -> CoreCommandCall {
    CoreCommandCall {
        command,
        payload: None,
        options: CoreCommandRequestOptions::existing_daemon(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecurityDeviceApproveLiveArgs {
    device_id: Option<String>,
    json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecurityDeviceUpdateArgs {
    device_id: String,
    action: &'static str,
    approval_code: Option<String>,
    json: bool,
}

fn parse_security_device_approve_live_args(
    args: &[String],
) -> Option<SecurityDeviceApproveLiveArgs> {
    let mut device_id = None;
    let mut json = false;
    let mut index = 3;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            json = true;
            index += 1;
        } else if device_id.is_none() && !arg.starts_with('-') {
            device_id = Some(arg.to_owned());
            index += 1;
        } else {
            return None;
        }
    }
    Some(SecurityDeviceApproveLiveArgs { device_id, json })
}

fn parse_security_device_update_args(args: &[String]) -> Option<SecurityDeviceUpdateArgs> {
    let action = match args.get(1)?.as_str() {
        "approve" => "approve",
        "block" => "block",
        "revoke" => "revoke",
        "unblock" => "unblock",
        _ => return None,
    };
    let mut device_id = None;
    let mut approval_code = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            json = true;
            index += 1;
        } else if action == "approve" && arg == "--code" {
            let value = args.get(index + 1)?;
            if value.starts_with('-') {
                return None;
            }
            approval_code = Some(value.clone());
            index += 2;
        } else if action == "approve"
            && let Some(value) = arg.strip_prefix("--code=")
        {
            if value.is_empty() {
                return None;
            }
            approval_code = Some(value.to_owned());
            index += 1;
        } else if device_id.is_none() && !arg.starts_with('-') {
            device_id = Some(arg.to_owned());
            index += 1;
        } else {
            return None;
        }
    }
    Some(SecurityDeviceUpdateArgs {
        device_id: device_id?,
        action,
        approval_code,
        json,
    })
}

fn run_security_devices(
    json_flag: bool,
    pending: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl RemoteCliRuntime,
) -> Result<CoreCliExecution, String> {
    let devices = runtime.list_remote_security_devices(pending)?;
    if json_flag || output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json!({ "devices": devices }))
                .map_err(|error| error.to_string())?,
        ]));
    }
    Ok(CoreCliExecution::ok(
        render_core_remote_security_devices_lines(&devices),
    ))
}

fn run_security_device_approve_live(
    device_id: Option<&str>,
    json_flag: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl RemoteCliRuntime,
) -> Result<CoreCliExecution, String> {
    let devices = runtime.list_remote_security_devices(true)?;
    let candidates = if let Some(device_id) = device_id {
        devices
            .into_iter()
            .filter(|device| {
                [device.get("id"), device.get("deviceId")]
                    .into_iter()
                    .flatten()
                    .any(|value| value.as_str() == Some(device_id))
            })
            .collect::<Vec<_>>()
    } else {
        devices
    };
    if candidates.is_empty() {
        if json_flag || output_mode == CoreCliOutputMode::Json {
            return Ok(CoreCliExecution::ok(vec![
                serde_json::to_string_pretty(
                    &json!({ "ok": false, "devices": [], "error": "No live remote clients are waiting for approval" }),
                )
                .map_err(|error| error.to_string())?,
            ]));
        }
        let message = device_id
            .map(|device_id| {
                format!("No live remote client is waiting for approval as {device_id}.")
            })
            .unwrap_or_else(|| "No live remote clients are waiting for approval.".into());
        return Ok(CoreCliExecution::ok(vec![message]));
    }
    Err("Interactive approval requires a TTY. Run `aimux security device approve` in a terminal and type the code shown on the waiting device.".into())
}

fn run_security_device_update(
    device_id: &str,
    action: &str,
    approval_code: Option<&str>,
    json_flag: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl RemoteCliRuntime,
) -> Result<CoreCliExecution, String> {
    let device = runtime.update_remote_security_device(device_id, action, approval_code)?;
    if json_flag || output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json!({ "ok": true, "device": device }))
                .map_err(|error| error.to_string())?,
        ]));
    }
    Ok(CoreCliExecution::ok(vec![
        render_core_remote_security_device_mutation_line(action, &device),
    ]))
}

fn render_json_or_lines(
    output_mode: CoreCliOutputMode,
    json_value: Value,
    lines: Vec<String>,
) -> Result<CoreCliExecution, String> {
    if output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json_value).map_err(|error| error.to_string())?,
        ]));
    }
    Ok(CoreCliExecution::ok(lines))
}
