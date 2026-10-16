//! The one place the local build meets the remote half.
//!
//! `docs/security/local-only-boundary-extraction.md` asks for a single
//! dependency edge rather than a `#[cfg]` at every call site, because the
//! audience for this boundary reads SOURCE: a reviewer can check one edge in
//! ten seconds, and cannot check seventy gates at all.
//!
//! The shape is the one `daemon/remote_control.rs` already uses: an `enabled`
//! module and a `disabled` module with the same names, and one `pub use` that
//! picks between them. Callers carry no gate, so there is nothing in them for
//! a reviewer to verify.
//!
//! Two rules for anything added here:
//!
//! - The signatures must be local on both sides. A function whose argument or
//!   return type comes from `remote/` cannot be behind this edge, because the
//!   local build would have to name that type to call it. That is what moving
//!   the CLI vocabulary into [`crate::remote_cli_vocabulary`] bought.
//! - The disabled side must answer, not panic. A local binary asked to do a
//!   remote thing has a correct answer -- "this build cannot" -- and the
//!   caller already knows how to render it.

/// What a command run on the far side printed, in a shape the local build owns.
///
/// The binary prints it and exits with it; nothing about printing is remote,
/// and naming the far side's own output type here would put a remote type in
/// the binary's signature -- which is the thing this edge exists to prevent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteCommandOutput {
    pub code: u8,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

#[cfg(feature = "remote-control")]
pub use enabled::{
    command_help, forward_alert_to_mobile_push, forward_alert_to_mobile_push_with_context,
    has_remote_credentials, host_published_attachment, hosted_backlog_snapshots,
    is_remote_control_command_word, plan_remote_core_cli, root_help_commands,
    run_hosted_root_command, run_remote_cli_action, should_defer_to_hosted_cli,
};

#[cfg(not(feature = "remote-control"))]
pub use disabled::{
    command_help, forward_alert_to_mobile_push, forward_alert_to_mobile_push_with_context,
    has_remote_credentials, host_published_attachment, hosted_backlog_snapshots,
    is_remote_control_command_word, plan_remote_core_cli, root_help_commands,
    run_hosted_root_command, run_remote_cli_action, should_defer_to_hosted_cli,
};

#[cfg(feature = "remote-control")]
mod enabled {
    use crate::core_cli::CoreCliOutputMode;
    use crate::core_cli_executor::CoreCliExecution;
    use crate::paths::PathResolver;
    use crate::remote_cli_vocabulary::RemoteCliAction;

    pub use crate::remote::cli::plan_remote_core_cli;

    pub fn has_remote_credentials() -> bool {
        let resolver = PathResolver::from_env();
        crate::remote::remote_credentials::load_credentials(&resolver).is_some()
    }

    /// The backlogs the remote half keeps, for the health report.
    pub fn hosted_backlog_snapshots() -> Vec<crate::backlog_metrics::BacklogMetricSnapshot> {
        vec![crate::remote::hosted_outbox::hosted_outbox_backlog_snapshot_from_env()]
    }

    pub fn forward_alert_to_mobile_push(event: &serde_json::Value) {
        crate::remote::mobile_push_bridge::forward_alert_to_mobile_push(event);
    }

    pub fn forward_alert_to_mobile_push_with_context(
        project_root: Option<&std::path::Path>,
        project_state_dir: Option<&std::path::Path>,
        event: &serde_json::Value,
    ) {
        crate::remote::mobile_push_bridge::forward_alert_to_mobile_push_with_context(
            project_root,
            project_state_dir,
            event,
        );
    }

    /// Upload a published attachment to the relay, if this machine is set up
    /// to. The decision is `attachment_hosting`'s, which is local; the
    /// credentials and the HTTP client are the far side's.
    pub fn host_published_attachment(
        input: &crate::attachment_hosting::PublishedAttachmentHostInput<'_>,
        resolver: &crate::paths::PathResolver,
    ) -> crate::attachment_hosting::AttachmentHostingResult {
        let Some(credentials) = crate::remote::remote_credentials::load_credentials(resolver)
        else {
            return crate::attachment_hosting::AttachmentHostingResult::Skipped;
        };
        crate::attachment_hosting::maybe_host_published_attachment(
            input,
            &credentials.relay_url,
            &credentials.token,
            credentials.remote_enabled,
            &crate::remote::attachment_upload::HttpAttachmentUploader,
        )
    }

    /// The hosted CLI's own run, flattened into the local output shape.
    pub fn run_hosted_root_command(args: &[String]) -> Option<super::RemoteCommandOutput> {
        if args.first().map(String::as_str) != Some("hosted") {
            return None;
        }
        let execution = crate::remote::hosted_cli::run_hosted_cli_command(args);
        Some(super::RemoteCommandOutput {
            code: execution.code,
            stdout: execution.stdout,
            stderr: execution.stderr,
        })
    }

    /// The root help lines for the commands this build can carry out.
    pub fn root_help_commands() -> &'static str {
        crate::remote::hosted_cli_help::ROOT_HELP_COMMANDS
    }

    pub fn should_defer_to_hosted_cli(
        command: &str,
        subcommand: Option<&str>,
        help_requested: bool,
        arg_count: usize,
    ) -> bool {
        crate::remote::hosted_cli_help::should_defer_to_hosted_cli(
            command,
            subcommand,
            help_requested,
            arg_count,
        )
    }

    pub fn command_help(
        command: &str,
        subcommand: Option<&str>,
        help_requested: bool,
    ) -> Option<&'static str> {
        crate::remote::hosted_cli_help::command_help(command, subcommand, help_requested)
    }

    /// Whether a bare command word belongs to the remote half.
    ///
    /// Wider than the CLI planner's list: this one includes `hosted`, which
    /// the planner never sees because the hosted CLI is dispatched before it.
    pub fn is_remote_control_command_word(word: &str) -> bool {
        matches!(
            word,
            "hosted" | "login" | "logout" | "remote" | "security" | "whoami"
        )
    }

    /// The runtime reaches the remote half's own trait here, which is the one
    /// place that name is spoken outside `remote/`.
    pub fn run_remote_cli_action(
        action: RemoteCliAction,
        output_mode: CoreCliOutputMode,
        runtime: &mut impl crate::remote::cli::RemoteCliRuntime,
    ) -> Result<CoreCliExecution, String> {
        crate::remote::cli::run_remote_cli_action(action, output_mode, runtime)
    }
}

#[cfg(not(feature = "remote-control"))]
mod disabled {
    use crate::core_cli::{
        CoreCliAction, CoreCliContext, CoreCliFallback, CoreCliOperation, CoreCliPlanError,
    };

    /// The same answer the local build gave before this edge existed.
    ///
    /// The gate used to delete the match arm, so a remote command fell through
    /// to `_ => Unsupported` and exited 2. Nothing about that changes: what
    /// changes is that the fall-through is written down here instead of being
    /// the absence of code somewhere else.
    pub fn plan_remote_core_cli(
        args: &[String],
        _context: &CoreCliContext,
    ) -> Result<(CoreCliOperation, CoreCliAction, CoreCliFallback), CoreCliPlanError> {
        Err(CoreCliPlanError::Unsupported {
            args: args.to_vec(),
        })
    }

    /// A local build holds none, which is an answer and not an absence.
    pub fn has_remote_credentials() -> bool {
        false
    }

    /// No remote half, no backlogs of its own. An empty list rather than a
    /// missing entry, so the caller merges one shape in both builds.
    pub fn hosted_backlog_snapshots() -> Vec<crate::backlog_metrics::BacklogMetricSnapshot> {
        Vec::new()
    }

    /// Nowhere to forward an alert to. Dropped deliberately and silently: a
    /// local build has no mobile push bridge, and the alert it would have
    /// carried is already published to every local subscriber.
    pub fn forward_alert_to_mobile_push(_event: &serde_json::Value) {}

    pub fn forward_alert_to_mobile_push_with_context(
        _project_root: Option<&std::path::Path>,
        _project_state_dir: Option<&std::path::Path>,
        _event: &serde_json::Value,
    ) {
    }

    /// Nothing to upload to. The decision function would answer the same way
    /// -- there are no credentials in a local build -- and this says so
    /// without the local build naming an uploader it does not have.
    pub fn host_published_attachment(
        _input: &crate::attachment_hosting::PublishedAttachmentHostInput<'_>,
        _resolver: &crate::paths::PathResolver,
    ) -> crate::attachment_hosting::AttachmentHostingResult {
        crate::attachment_hosting::AttachmentHostingResult::Skipped
    }

    /// Nothing to run, so nothing printed.
    pub fn run_hosted_root_command(_args: &[String]) -> Option<super::RemoteCommandOutput> {
        None
    }

    /// No remote commands to list in the root help.
    pub fn root_help_commands() -> &'static str {
        ""
    }

    pub const fn should_defer_to_hosted_cli(
        _command: &str,
        _subcommand: Option<&str>,
        _help_requested: bool,
        _arg_count: usize,
    ) -> bool {
        false
    }

    /// No help for commands this build does not have. The root help lists
    /// none of them either, so a user is not pointed at a command that would
    /// then be refused.
    pub const fn command_help(
        _command: &str,
        _subcommand: Option<&str>,
        _help_requested: bool,
    ) -> Option<&'static str> {
        None
    }

    /// No command word belongs to a half this build does not have.
    pub fn is_remote_control_command_word(_word: &str) -> bool {
        false
    }

    /// Unreachable through the planner -- it refuses these commands above --
    /// and answered rather than panicked anyway, because a type that exists
    /// can be constructed by anything.
    pub fn run_remote_cli_action(
        _action: crate::remote_cli_vocabulary::RemoteCliAction,
        _output_mode: crate::core_cli::CoreCliOutputMode,
        _runtime: &mut impl crate::core_cli_executor::CoreCliRuntime,
    ) -> Result<crate::core_cli_executor::CoreCliExecution, String> {
        Err("this build has no remote-control support".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use crate::core_cli::{CoreCliContext, CoreCliPlanError};

    fn context() -> CoreCliContext {
        CoreCliContext {
            current_working_dir: "/repo".to_owned(),
            current_project_root: "/repo".to_owned(),
            daemon_running: false,
            has_credentials: false,
            loop_actor: crate::core_cli::CoreLoopActorContext::default(),
        }
    }

    /// What this build answers when asked to do a remote thing.
    ///
    /// Compiled both ways and asserted both ways, because the two sides of the
    /// edge are two different answers and a test that only ever sees one of
    /// them is not checking the edge at all. `cargo test --no-default-features`
    /// is what exercises the other arm.
    #[test]
    fn the_edge_answers_for_the_build_it_is_in() {
        let args = ["remote".to_owned(), "status".to_owned()];
        let planned = super::plan_remote_core_cli(&args, &context());

        #[cfg(not(feature = "remote-control"))]
        {
            assert_eq!(
                planned,
                Err(CoreCliPlanError::Unsupported {
                    args: args.to_vec()
                }),
                "a local build refuses it the way it always did -- exit 2"
            );
            assert!(
                !super::has_remote_credentials(),
                "and holds no credentials, which is an answer rather than an absence"
            );
        }
        #[cfg(feature = "remote-control")]
        {
            assert!(
                planned.is_ok(),
                "a full build plans it: {:?}",
                planned.map(|_| ())
            );
            let _ = CoreCliPlanError::Unsupported { args: Vec::new() };
        }
    }
}
