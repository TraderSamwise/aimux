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

#[cfg(feature = "remote-control")]
pub use enabled::{has_remote_credentials, plan_remote_core_cli, run_remote_cli_action};

#[cfg(not(feature = "remote-control"))]
pub use disabled::{has_remote_credentials, plan_remote_core_cli, run_remote_cli_action};

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
