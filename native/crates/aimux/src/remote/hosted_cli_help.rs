//! The hosted CLI's own help text.
//!
//! It lives with the commands it documents. It used to sit in the binary,
//! gated, beside an empty twin -- which put the far side's vocabulary in a
//! file the local build compiles, and made a reviewer check which half was in
//! play. The binary asks `remote_control_edge` now and prints what it is
//! given.

pub const ROOT_HELP_COMMANDS: &str = "  remote                       Manage remote access\n  security                     Manage aimux security controls\n  hosted                       Manage hosted mode\n";

pub fn should_defer_to_hosted_cli(
    command: &str,
    subcommand: Option<&str>,
    help_requested: bool,
    arg_count: usize,
) -> bool {
    matches!(command, "hosted")
        && matches!(subcommand, Some("token" | "audit"))
        && !help_requested
        && arg_count > 2
}

pub fn command_help(
    command: &str,
    subcommand: Option<&str>,
    help_requested: bool,
) -> Option<&'static str> {
    match (command, subcommand, help_requested) {
        ("remote", None, _) => Some(REMOTE_HELP),
        ("remote", Some("status"), true) => Some(REMOTE_STATUS_HELP),
        ("remote", Some("enable"), true) => Some(REMOTE_ENABLE_HELP),
        ("remote", Some("disable"), true) => Some(REMOTE_DISABLE_HELP),
        ("whoami", _, true) => Some(WHOAMI_HELP),
        ("login", _, true) => Some(LOGIN_HELP),
        ("logout", _, true) => Some(LOGOUT_HELP),
        ("security", None, _) => Some(SECURITY_HELP),
        ("security", Some("unlock"), true) => Some(SECURITY_UNLOCK_HELP),
        ("security", Some("devices"), true) => Some(SECURITY_DEVICES_HELP),
        ("security", Some("device"), true) => Some(SECURITY_DEVICE_HELP),
        ("security", Some("approve"), true) => Some(SECURITY_APPROVE_HELP),
        ("security", Some("block" | "revoke"), true) => Some(SECURITY_BLOCK_HELP),
        ("security", Some("unblock"), true) => Some(SECURITY_UNBLOCK_HELP),
        ("hosted", None, _) => Some(HOSTED_HELP),
        ("hosted", Some("status"), true) => Some(HOSTED_STATUS_HELP),
        ("hosted", Some("grant"), true) => Some(HOSTED_GRANT_HELP),
        ("hosted", Some("ungrant"), true) => Some(HOSTED_UNGRANT_HELP),
        ("hosted", Some("lockdown"), true) => Some(HOSTED_LOCKDOWN_HELP),
        ("hosted", Some("token"), _) => Some(HOSTED_TOKEN_HELP),
        ("hosted", Some("audit"), _) => Some(HOSTED_AUDIT_HELP),
        _ => None,
    }
}

const REMOTE_HELP: &str = "Usage: aimux remote [options] [command]\n\nManage remote access\n\nCommands:\n  status                      Show remote access status\n  enable                      Enable remote access\n  disable                     Disable remote access";
const REMOTE_STATUS_HELP: &str = "Usage: aimux remote status [options]\n\nShow remote access status\n\nOptions:\n  --json                      Emit JSON";
const REMOTE_ENABLE_HELP: &str = "Usage: aimux remote enable\n\nEnable remote access";
const REMOTE_DISABLE_HELP: &str = "Usage: aimux remote disable\n\nDisable remote access";
const WHOAMI_HELP: &str = "Usage: aimux whoami [options]\n\nShow current remote access identity\n\nOptions:\n  --json                      Emit JSON";
const LOGIN_HELP: &str = "Usage: aimux login\n\nAuthenticate remote access";
const LOGOUT_HELP: &str = "Usage: aimux logout\n\nClear remote access credentials";
const SECURITY_HELP: &str = "Usage: aimux security [options] [command]\n\nManage aimux security controls\n\nCommands:\n  devices                     List remote client devices\n  device                      Approve a live remote client device\n  approve <deviceId>          Approve a remote client device\n  block <deviceId>            Block a remote client device\n  unblock <deviceId>          Unblock a remote client device\n  unlock                      Unlock security credentials";
const SECURITY_DEVICES_HELP: &str = "Usage: aimux security devices [options]\n\nList remote client devices\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_DEVICE_HELP: &str = "Usage: aimux security device [options] [command]\n\nApprove a live remote client device\n\nCommands:\n  approve [deviceId]          Approve the most recent live remote client waiting for access";
const SECURITY_APPROVE_HELP: &str = "Usage: aimux security approve <deviceId> [options]\n\nApprove a remote client device\n\nOptions:\n  --code <code>               Approval code shown on the waiting device\n  --json                      Emit JSON";
const SECURITY_BLOCK_HELP: &str = "Usage: aimux security block <deviceId> [options]\n\nBlock a remote client device\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_UNBLOCK_HELP: &str = "Usage: aimux security unblock <deviceId> [options]\n\nUnblock a remote client device without approving it\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_UNLOCK_HELP: &str = "Usage: aimux security unlock\n\nUnlock security credentials";
const HOSTED_HELP: &str = "Usage: aimux hosted [options] [command]\n\nManage hosted mode: principals, grants, audit, lockdown\n\nCommands:\n  status                      Show hosted mode configuration and principals\n  token                       Manage hosted bearer tokens\n  grant <principalId>         Allow a principal to converse with one session\n  ungrant <principalId>       Remove a principal's access to one session\n  lockdown <state>            Close or reopen the hosted listener\n  audit                       Inspect the hosted audit log";
const HOSTED_STATUS_HELP: &str = "Usage: aimux hosted status [options]\n\nShow hosted mode configuration and principals\n\nOptions:\n  --json                      Emit JSON";
const HOSTED_TOKEN_HELP: &str = "Usage: aimux hosted token [options] [command]\n\nManage hosted bearer tokens\n\nCommands:\n  create                      Create a principal and print its token once\n  list                        List principals\n  revoke <principalId>        Revoke a principal's token";
const HOSTED_GRANT_HELP: &str = "Usage: aimux hosted grant <principalId> [options]\n\nAllow a principal to converse with one session\n\nOptions:\n  --project <root>            Project root the session belongs to\n  --session <id>              Session id";
const HOSTED_UNGRANT_HELP: &str = "Usage: aimux hosted ungrant <principalId> [options]\n\nRemove a principal's access to one session\n\nOptions:\n  --project <root>            Project root the session belongs to\n  --session <id>              Session id";
const HOSTED_LOCKDOWN_HELP: &str = "Usage: aimux hosted lockdown <state>\n\nClose or reopen the hosted listener (\"on\" or \"off\")";
const HOSTED_AUDIT_HELP: &str = "Usage: aimux hosted audit [options] [command]\n\nInspect the hosted audit log\n\nCommands:\n  tail                        Show the most recent audit records";
