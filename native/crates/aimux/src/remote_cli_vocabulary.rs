//! What can be asked of the remote half, as plain data.
//!
//! The local CLI has to be able to *name* these to route them: `aimux remote
//! status`, `aimux login`, `aimux security devices` are commands the parser
//! sees whether or not this build can carry them out. Keeping the names on the
//! far side of the boundary meant the local crate's own enums carried
//! remote-typed variants, and those variants had to be `#[cfg]`-gated -- four
//! gates in `core_cli.rs` alone, each a place a source reviewer has to check
//! for a leak.
//!
//! So the vocabulary is local and the execution is not. Nothing here reaches a
//! socket, a credential or a relay: it is an enum of things a user can type and
//! an enum of what we decided to do about it. The code that actually does any
//! of it lives in `remote/cli.rs`, behind the one dependency edge.
//!
//! See `docs/security/local-only-boundary-extraction.md`.

use serde::{Deserialize, Serialize};

use crate::core_cli::CoreCommandCall;

/// A remote-half operation the CLI can name.
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

/// Why a remote operation did less than it was asked to.
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

/// What the planner decided to do about a remote command.
///
/// `CoreCommandCall` is a local type: these carry the daemon call to make, not
/// a connection to make it on.
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

/// Whether a bare command word belongs to the remote half.
///
/// Wider than [`is_remote_core_cli_command`], and deliberately a different
/// question: this one includes `hosted`, which the core planner never sees
/// because the hosted CLI is dispatched before it. Both live here because
/// neither needs a remote half to answer -- they are facts about the command
/// line, and the dispatcher has to know them before anything can be routed.
pub fn is_remote_control_command_word(word: &str) -> bool {
    matches!(
        word,
        "hosted" | "login" | "logout" | "remote" | "security" | "whoami"
    )
}

/// Whether a command belongs to the remote half at all.
///
/// Local, because the local CLI needs the answer before it can route anything
/// to the edge -- and because a build with no remote half still has to tell a
/// user that `aimux login` is a command this binary cannot carry out, rather
/// than that it does not exist.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_remote_commands_are_named_here_whatever_this_build_can_do() {
        for (command, subcommand) in [
            ("remote", "status"),
            ("whoami", ""),
            ("logout", ""),
            ("login", ""),
            ("security", "unlock"),
            ("security", "devices"),
            ("security", "device"),
            ("security", "approve"),
            ("security", "block"),
            ("security", "revoke"),
            ("security", "unblock"),
        ] {
            assert!(
                is_remote_core_cli_command(command, subcommand),
                "{command} {subcommand}"
            );
        }
    }

    #[test]
    fn the_word_list_covers_the_dispatcher_and_the_planner() {
        // The dispatcher's question is wider: `hosted` never reaches the core
        // planner, because the hosted CLI is dispatched before it.
        assert!(is_remote_control_command_word("hosted"));
        assert!(!is_remote_core_cli_command("hosted", ""));
        // Everything the planner claims, the dispatcher claims too. A word the
        // planner routes and the dispatcher does not would reach neither.
        for command in ["remote", "whoami", "logout", "login", "security"] {
            assert!(
                is_remote_control_command_word(command),
                "{command} is routed by the planner, so the dispatcher must know it"
            );
        }
        assert!(!is_remote_control_command_word("ps"));
    }

    #[test]
    fn a_local_command_is_not_one_of_them() {
        for (command, subcommand) in [
            ("ps", ""),
            ("spawn", ""),
            ("security", ""),
            ("security", "audit"),
            ("remotely", "status"),
        ] {
            assert!(
                !is_remote_core_cli_command(command, subcommand),
                "{command} {subcommand}"
            );
        }
    }

    /// The wire names, because these cross a process boundary as JSON.
    #[test]
    fn the_operation_and_fallback_names_are_kebab_case() {
        assert_eq!(
            serde_json::to_value(RemoteCliOperation::SecurityDeviceApprove).expect("encode"),
            serde_json::json!("security-device-approve")
        );
        assert_eq!(
            serde_json::to_value(RemoteCliFallback::RelayDeferredUntilDaemonStart).expect("encode"),
            serde_json::json!("relay-deferred-until-daemon-start")
        );
    }
}
