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
#[derive(Debug, Clone)]
pub struct RemoteCommandOutput {
    pub code: u8,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

#[cfg(feature = "remote-control")]
pub use enabled::{
    command_help, forward_alert_to_mobile_push, forward_alert_to_mobile_push_with_context,
    has_remote_credentials, host_published_attachment, hosted_backlog_snapshots,
    plan_remote_core_cli, root_help_commands, run_hosted_root_command, run_remote_cli_action,
    should_defer_to_hosted_cli,
};

#[cfg(not(feature = "remote-control"))]
pub use disabled::{
    command_help, forward_alert_to_mobile_push, forward_alert_to_mobile_push_with_context,
    has_remote_credentials, host_published_attachment, hosted_backlog_snapshots,
    plan_remote_core_cli, root_help_commands, run_hosted_root_command, run_remote_cli_action,
    should_defer_to_hosted_cli,
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

/// The daemon's half of the remote half.
///
/// One field on `RealDaemonRuntime` instead of three, and one type instead of
/// thirty-nine `#[cfg]` sites. It owns the relay connection, the login flows
/// in progress and the resolved machine identity, because those are the things
/// a daemon keeps that only mean anything with a remote half.
///
/// The local build gets a unit struct whose every method answers "off". That
/// is not a stub standing in for missing behaviour: a daemon with no remote
/// half genuinely has no relay, no login flow and no machine to route to, and
/// every one of these answers says so in the shape the caller already renders.
#[cfg(feature = "remote-control")]
pub use enabled_state::RemoteDaemonState;

#[cfg(not(feature = "remote-control"))]
pub use disabled_state::RemoteDaemonState;

#[cfg(feature = "remote-control")]
mod enabled_state {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    use serde_json::{Value, json};

    use crate::machine_identity::MachineIdentity;
    use crate::paths::PathResolver;
    use crate::remote::remote_login::LoginFlowWaiter;

    #[derive(Default)]
    pub struct RemoteDaemonState {
        auth_flows: Mutex<HashMap<String, LoginFlowWaiter>>,
        relay: Arc<crate::remote::daemon_relay::RelaySupervisor>,
        /// Resolved once per process; see `machine_identity`.
        machine_identity: OnceLock<MachineIdentity>,
    }

    impl RemoteDaemonState {
        pub fn new() -> Self {
            Self::default()
        }

        /// How many login flows are waiting. `None` means there is no remote
        /// half to have flows, which the doctor report prints differently from
        /// zero.
        pub fn auth_flow_count(&self) -> Option<usize> {
            self.auth_flows.lock().map(|flows| flows.len()).ok()
        }

        /// The flows map, for the auth-text runtime that drives them.
        pub fn auth_flows(&self) -> &Mutex<HashMap<String, LoginFlowWaiter>> {
            &self.auth_flows
        }

        pub fn relay(&self) -> &Arc<crate::remote::daemon_relay::RelaySupervisor> {
            &self.relay
        }

        /// Dial the relay if the resolved target says we should.
        pub fn start_relay(&self, resolver: &PathResolver, force: bool) {
            let Some(credentials) = crate::remote::remote_credentials::load_credentials(resolver)
            else {
                return;
            };
            self.start_relay_with(resolver, &credentials, force);
        }

        /// The same dial, for a caller that already has the credentials in
        /// hand. `enable` has just written them, and reloading from disk there
        /// is both a second read and a silent no-op if the reload misses.
        fn start_relay_with(
            &self,
            resolver: &PathResolver,
            credentials: &crate::remote::remote_credentials::AimuxCredentials,
            force: bool,
        ) {
            let env_url = std::env::var("AIMUX_RELAY_URL").ok();
            let env_token = std::env::var("AIMUX_RELAY_TOKEN").ok();
            if let Some((url, token)) = crate::remote::daemon_relay::resolve_relay_target(
                Some(credentials.relay_url.as_str()),
                Some(credentials.token.as_str()),
                credentials.remote_enabled,
                env_url.as_deref(),
                env_token.as_deref(),
            ) {
                self.relay
                    .connect(&url, &token, self.machine_identity(resolver), force);
            }
        }

        /// Which machine the relay should route to. A home directory we cannot
        /// read must not become a machine-less connect -- that is the eviction
        /// bug the identity exists to stop -- so the failure is logged with its
        /// cause and a distinct in-memory identity is used until the next
        /// restart.
        ///
        /// Resolved once per process. `start_relay` is called on every status
        /// poll and usually returns without reconnecting, so reading the file
        /// each time would be a disk read per tick -- and with an unreadable
        /// file, a new ephemeral id and a log line per tick.
        pub fn machine_identity(&self, resolver: &PathResolver) -> MachineIdentity {
            self.machine_identity
                .get_or_init(|| match crate::machine_identity::load_or_create(resolver) {
                    Ok(identity) => identity,
                    Err(error) => {
                        let identity = MachineIdentity::ephemeral(
                            crate::machine_identity::os_hostname().as_deref(),
                        );
                        crate::debug_logging::log_lifecycle_always(
                            "relay could not persist machine identity; using an ephemeral id",
                            "daemon",
                            Some(json!({
                                "path": resolver.machine_identity_path().display().to_string(),
                                "error": error.to_string(),
                                "machineId": identity.id,
                            })),
                        );
                        identity
                    }
                })
                .clone()
        }

        /// What `aimux doctor` prints for this machine. A `~/.aimux` copied to
        /// a second host carries its id, and two daemons claiming one id is
        /// invisible from either side, so the id has to be readable somewhere.
        ///
        /// Never creates: see `machine_identity::read_stored`.
        pub fn machine_identity_report(&self, resolver: &PathResolver) -> Value {
            if let Some(resolved) = self.machine_identity.get() {
                return json!({
                    "id": resolved.id,
                    "name": resolved.name,
                    "source": "resolved",
                });
            }
            match crate::machine_identity::read_stored(resolver) {
                Ok(Some(stored)) => json!({
                    "id": stored.id,
                    "name": stored.name,
                    "source": "stored",
                }),
                // Not yet named is a different answer from could not be read,
                // and a report that collapsed them would hide an unreadable
                // home.
                Ok(None) => json!({ "source": "unnamed" }),
                Err(error) => json!({ "source": "unreadable", "error": error.to_string() }),
            }
        }

        /// Start the hosted listener, if this machine is configured for one.
        ///
        /// The handle comes back so the caller can hold it for the daemon's
        /// lifetime. It is a tokio task handle, which the local build can name
        /// too -- tokio is not the remote dependency, `tokio-tungstenite` is --
        /// so both sides return the same type and the local one answers
        /// `None`.
        pub fn start_hosted_server(
            resolver: &PathResolver,
            runtime: std::sync::Arc<std::sync::Mutex<crate::daemon::runtime::RealDaemonRuntime>>,
            scheduler_context: Option<
                std::sync::Arc<crate::daemon::scheduler::DaemonSchedulerContext>,
            >,
            scheduler: Option<crate::daemon::scheduler::DaemonSchedulerHandle>,
        ) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
            let hosted_config =
                crate::remote::hosted_config::load_hosted_config_with_resolver(resolver);
            crate::remote::hosted_server::start_hosted_server_background_with_scheduler(
                hosted_config,
                resolver.clone(),
                runtime,
                scheduler_context,
                scheduler,
            )
        }

        /// The periodic tasks the remote half adds to the daemon's loop.
        ///
        /// A list rather than two spellings of the whole loop: the local build
        /// had its own copy of every task, so adding one meant editing two
        /// lists and a reviewer comparing them by eye.
        pub fn daemon_periodic_tasks() -> Vec<Box<dyn crate::daemon::scheduler::DaemonPeriodicTask>>
        {
            vec![
                Box::new(crate::remote::hosted_server::HostedPruneTask),
                Box::new(crate::remote::hosted_server::HostedOutboxDrainTask),
            ]
        }

        pub fn has_credentials(&self, resolver: &PathResolver) -> bool {
            crate::remote::remote_credentials::load_credentials(resolver).is_some()
        }

        /// Turn the relay on for a user who asked.
        ///
        /// Enabling used to only flip a flag and then report "disconnected"
        /// for ever, because nothing dialled the relay afterwards.
        pub fn enable_relay_for_user_request(&self, resolver: &PathResolver) -> Value {
            match crate::remote::remote_credentials::set_remote_enabled(resolver, true) {
                Ok(Some(credentials)) => {
                    self.start_relay_with(resolver, &credentials, true);
                    // The RAW status, which is what this answered before the
                    // move: the wrapper below reports `disconnected` for a
                    // user who has asked for remote and is waiting, and an
                    // enable that declined to dial answered `off`.
                    self.relay.status()
                }
                Ok(None) => json!({ "status": "off" }),
                Err(error) => {
                    json!({ "status": "auth_failed", "lastError": error.to_string() })
                }
            }
        }

        pub fn disable_relay(&self, resolver: &PathResolver) -> Value {
            let _ = crate::remote::remote_credentials::set_remote_enabled(resolver, false);
            self.disconnect();
            json!({ "status": "off" })
        }

        pub fn disconnect(&self) {
            self.relay.disconnect();
        }

        /// The live client's own state. This used to answer a hardcoded
        /// "disconnected" whenever remote was enabled, which was
        /// indistinguishable from a relay that was up and working.
        pub fn relay_status(&self, resolver: &PathResolver) -> Value {
            let status = self.relay.status();
            if status.get("status").and_then(Value::as_str) != Some("off") {
                return status;
            }
            // No client running: report off unless the user has asked for
            // remote, in which case they are waiting on a connection that has
            // not started.
            let Some(credentials) = crate::remote::remote_credentials::load_credentials(resolver)
            else {
                return json!({ "status": "off" });
            };
            if credentials.remote_enabled {
                json!({
                    "status": "disconnected",
                    "relayUrl": credentials.relay_url,
                    "lastConnectedAt": Value::Null,
                })
            } else {
                json!({ "status": "off" })
            }
        }

        /// Deliver a notification to the mobile push bridge through the
        /// relay. Takes the payload, not the built notification: building it
        /// is the far side's shape.
        pub fn deliver_push(&self, payload: &Value) -> Value {
            let notification = crate::remote::mobile_push_bridge::relay_notification(payload);
            match self.relay.push(&notification) {
                Ok(()) => json!({ "ok": true, "suppressed": false }),
                Err(reason) => json!({ "ok": true, "suppressed": true, "reason": reason }),
            }
        }
    }
}

#[cfg(not(feature = "remote-control"))]
mod disabled_state {
    use serde_json::{Value, json};

    use crate::machine_identity::MachineIdentity;
    use crate::paths::PathResolver;

    #[derive(Default)]
    pub struct RemoteDaemonState {
        /// Resolved once, like the other side.
        ///
        /// Not because anything routes to this daemon -- nothing does -- but
        /// because "the identity is resolved once per process and is never
        /// absent" is a property of the daemon, not of the remote half, and a
        /// local build that minted a fresh id per call would make that
        /// property untrue in exactly the build a reviewer reads.
        machine_identity: std::sync::OnceLock<MachineIdentity>,
    }

    impl RemoteDaemonState {
        pub fn new() -> Self {
            Self::default()
        }

        /// Not zero: there is no remote half to have login flows, and the
        /// doctor report prints the difference.
        pub fn auth_flow_count(&self) -> Option<usize> {
            None
        }

        pub fn start_relay(&self, _resolver: &PathResolver, _force: bool) {}

        /// An ephemeral identity rather than a stored one: nothing routes to
        /// this daemon, so nothing should be written down claiming an id. Held
        /// once resolved, so it does not change under a caller that asks
        /// twice.
        pub fn machine_identity(&self, _resolver: &PathResolver) -> MachineIdentity {
            self.machine_identity
                .get_or_init(|| {
                    MachineIdentity::ephemeral(crate::machine_identity::os_hostname().as_deref())
                })
                .clone()
        }

        /// `off`, which is a different answer from `unnamed` -- this build
        /// cannot have a machine identity rather than not having one yet.
        pub fn machine_identity_report(&self, _resolver: &PathResolver) -> Value {
            json!({ "source": "off" })
        }

        /// No listener to start, and nothing to hold open.
        pub fn start_hosted_server(
            _resolver: &PathResolver,
            _runtime: std::sync::Arc<std::sync::Mutex<crate::daemon::runtime::RealDaemonRuntime>>,
            _scheduler_context: Option<
                std::sync::Arc<crate::daemon::scheduler::DaemonSchedulerContext>,
            >,
            _scheduler: Option<crate::daemon::scheduler::DaemonSchedulerHandle>,
        ) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
            Ok(None)
        }

        /// No remote half, no tasks of its own.
        pub fn daemon_periodic_tasks() -> Vec<Box<dyn crate::daemon::scheduler::DaemonPeriodicTask>>
        {
            Vec::new()
        }

        /// None to load, so none held.
        pub fn has_credentials(&self, _resolver: &PathResolver) -> bool {
            false
        }

        /// There is no relay to enable. `off` rather than an error, because
        /// the caller renders a status and the status is off.
        pub fn enable_relay_for_user_request(&self, _resolver: &PathResolver) -> Value {
            json!({ "status": "off" })
        }

        pub fn disable_relay(&self, _resolver: &PathResolver) -> Value {
            json!({ "status": "off" })
        }

        pub fn disconnect(&self) {}

        /// Off, and not "disconnected": nothing is waiting on a connection
        /// that could be made.
        pub fn relay_status(&self, _resolver: &PathResolver) -> Value {
            json!({ "status": "off" })
        }

        /// Suppressed with a reason that names why, rather than a generic
        /// failure: nothing is wrong, this build has nowhere to push to.
        pub fn deliver_push(&self, _payload: &Value) -> Value {
            json!({
                "ok": true,
                "suppressed": true,
                "reason": "remote_unavailable_in_local_build",
            })
        }
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

#[cfg(test)]
mod state_tests {
    use super::RemoteDaemonState;
    use crate::paths::PathResolver;

    /// The one value that must never be absent, in either build.
    ///
    /// A machine-less connect is what lets a second daemon evict the first, so
    /// the identity is resolved once per process and is never empty. That is a
    /// property of the daemon rather than of the remote half, which is why it
    /// is asserted here and not only on the side that has a relay: a local
    /// build minting a fresh id per call would make it untrue in exactly the
    /// build a reviewer reads.
    #[test]
    fn the_machine_identity_resolves_once_and_never_to_nothing() {
        let home = std::env::temp_dir().join(format!(
            "aimux-edge-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("fixture home");
        let resolver = PathResolver::new("/", "/", Some(home.to_string_lossy().into_owned()));
        let state = RemoteDaemonState::new();

        let first = state.machine_identity(&resolver);
        assert!(!first.id.is_empty(), "never to nothing");
        assert_eq!(
            state.machine_identity(&resolver).id,
            first.id,
            "and once, so a later connect cannot route to a different machine"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    /// A push that went nowhere never reports as delivered.
    ///
    /// Both builds: with no relay connected there is nothing to deliver to,
    /// and the answer says so with a reason. A local build claiming
    /// `suppressed: false` would be the silent-success shape -- the caller
    /// logs a delivery that never happened.
    #[test]
    fn a_push_with_nowhere_to_go_says_so() {
        let state = RemoteDaemonState::new();
        let answer = state.deliver_push(&serde_json::json!({
            "title": "something happened",
            "body": "to an agent",
        }));

        assert_eq!(answer["ok"], serde_json::json!(true), "{answer}");
        assert_eq!(
            answer["suppressed"],
            serde_json::json!(true),
            "nothing is connected, so nothing was delivered: {answer}"
        );
        let reason = answer
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        assert!(!reason.is_empty(), "and the reason names why: {answer}");
        #[cfg(not(feature = "remote-control"))]
        assert_eq!(
            reason, "remote_unavailable_in_local_build",
            "a local build says which build, not just that it failed"
        );
    }

    /// The report never establishes the identity.
    ///
    /// Letting a diagnostic resolve it means that on a home it cannot write,
    /// `aimux doctor` caches an ephemeral id that every later connect then
    /// uses.
    #[test]
    fn the_report_does_not_resolve_it() {
        let home = std::env::temp_dir().join(format!(
            "aimux-edge-report-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("fixture home");
        let resolver = PathResolver::new("/", "/", Some(home.to_string_lossy().into_owned()));
        let state = RemoteDaemonState::new();

        let report = state.machine_identity_report(&resolver);
        assert!(
            report.get("id").is_none(),
            "a report that names an id has resolved one: {report}"
        );
        assert!(
            !resolver.machine_identity_path().exists(),
            "and it must not have written one either"
        );
        // The source says which answer this is, and the three are different:
        // `off` in a local build, `unnamed` when there is nothing stored yet,
        // `unreadable` when the home cannot be read.
        assert!(
            matches!(
                report.get("source").and_then(serde_json::Value::as_str),
                Some("off" | "unnamed")
            ),
            "got {report}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(all(test, feature = "remote-control"))]
mod enable_tests {
    use super::RemoteDaemonState;
    use crate::paths::PathResolver;

    /// Enabling answers with the relay's OWN status, not the wrapped one.
    ///
    /// The wrapper reports `disconnected` for a user who has asked for remote
    /// and is waiting on a connection that has not started. An enable that
    /// declined to dial -- empty url or token, or a target the resolver
    /// refuses -- answered `off`, and moving the call behind the state
    /// silently upgraded that to `disconnected`. The CLI prints this verbatim.
    #[test]
    fn enabling_answers_with_the_relays_own_status() {
        let home = std::env::temp_dir().join(format!(
            "aimux-edge-enable-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("fixture home");
        let resolver = PathResolver::new("/", "/", Some(home.to_string_lossy().into_owned()));
        let state = RemoteDaemonState::new();

        // No credentials stored, so `set_remote_enabled` has nothing to enable.
        let answer = state.enable_relay_for_user_request(&resolver);
        assert_eq!(
            answer["status"], "off",
            "nothing to enable is off, not disconnected: {answer}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}
