//! Keep a shared session reachable after its project service restarts.
//!
//! A share stores the endpoint it was created with, and a project service binds
//! a fresh port on every start. So the first restart after a share was made
//! left that share proxying to a port nothing was listening on: the daemon
//! connected, the agent working, every request from the share refused, and the
//! only repair was issuing another invite, which emails somebody.
//!
//! This reports the current endpoints to the relay, which moves the shares for
//! that project root and pushes the new summary to the guests holding a copy.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::json;

use crate::daemon::scheduler::{DaemonPeriodicTask, DaemonSchedulerContext, PeriodicTaskFuture};
use crate::debug_logging::{LogLevel, log_always_at};
use crate::paths::PathResolver;
use crate::remote::relay_client::ProjectEndpoint;

pub const RELAY_PROJECT_ENDPOINTS_TASK_NAME: &str = "relay-project-endpoints";

/// A port change is only visible to a guest once this has run, so the cadence
/// is the width of the window in which a restarted service is unreachable
/// through its share. It reads the project registry and one small file per
/// project -- no tmux, no subprocess, no daemon mutex -- and the relay refuses
/// a report that moved nothing, so a quiet fleet costs a handful of reads.
pub const RELAY_PROJECT_ENDPOINTS_INTERVAL_MS: i64 = 30 * 1_000;

/// Hands a report to the live relay, or says why it could not go.
///
/// Fallible on purpose. A refusal must not be recorded as pushed, or the share
/// stays on the dead port until the next time the port happens to change.
/// How many unchanged ticks before the whole set is reported again.
///
/// A level, not only an edge. `queue()` answering Ok means the frame reached
/// the outbox, not the relay: a socket that closes before the drain, or a
/// runner replaced by a re-dial, loses it -- and it is recorded here as
/// reported, so nothing would correct the share until its port happened to
/// change again. Ten ticks is five minutes, and the relay writes nothing for a
/// share that did not move, so a reminder costs one frame.
pub const REMINDER_TICKS: u32 = 10;

pub use crate::daemon::scheduler::RelayProjectEndpointsPush;

/// Read where every registered project's service is listening.
///
/// A project with no endpoint file has never had a service, and a file we
/// cannot read is reported rather than treated as absent -- an unreadable
/// endpoint is not the same answer as no endpoint, and silently dropping it
/// would leave a share pinned to a port nobody can see is wrong.
pub fn read_project_endpoints(
    resolver: &PathResolver,
) -> Result<(Vec<ProjectEndpoint>, Vec<String>), String> {
    let entries = resolver
        .list_projects()
        .map_err(|error| format!("failed to load project registry: {error}"))?;
    let mut endpoints = Vec::new();
    let mut read_errors = Vec::new();
    for entry in entries {
        match crate::daemon::runtime::read_metadata_endpoint_for_project_id(resolver, &entry.id) {
            Ok(Some(endpoint)) => endpoints.push(ProjectEndpoint {
                project_root: entry.repo_root,
                host: endpoint.host,
                port: endpoint.port,
            }),
            Ok(None) => {}
            Err(error) => read_errors.push(error),
        }
    }
    Ok((endpoints, read_errors))
}

/// What has moved since the last report the relay accepted.
///
/// Only the changes. The relay fans each one out to every guest on the share,
/// and this task runs on a timer, so reporting the whole fleet every tick
/// would be a durable-storage write and a guest push per tick for ever.
pub fn endpoints_to_report(
    last_reported: &BTreeMap<String, (String, u16)>,
    current: &[ProjectEndpoint],
) -> Vec<ProjectEndpoint> {
    current
        .iter()
        .filter(|endpoint| {
            last_reported.get(&endpoint.project_root)
                != Some(&(endpoint.host.clone(), endpoint.port))
        })
        .cloned()
        .collect()
}

/// Whether this is "there is no relay to report to right now" rather than a
/// failure to report. Both leave the report unrecorded, but only one of them
/// is worth waking somebody over.
fn is_relay_absent(error: &str) -> bool {
    matches!(
        error,
        "relay_off" | "relay_disconnected" | "relay_unavailable"
    )
}

pub struct RelayProjectEndpointsTask {
    /// What the relay has accepted, so an unchanged fleet reports nothing.
    /// Written only after a push succeeded.
    last_reported: BTreeMap<String, (String, u16)>,
    /// Ticks since the whole set was last reported. See `REMINDER_TICKS`.
    ticks_since_full_report: u32,
}

impl RelayProjectEndpointsTask {
    pub fn new() -> Self {
        Self {
            last_reported: BTreeMap::new(),
            ticks_since_full_report: 0,
        }
    }
}

impl Default for RelayProjectEndpointsTask {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonPeriodicTask for RelayProjectEndpointsTask {
    fn name(&self) -> &str {
        RELAY_PROJECT_ENDPOINTS_TASK_NAME
    }

    fn interval_ms(&self) -> i64 {
        RELAY_PROJECT_ENDPOINTS_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(10)
    }

    /// A daemon that has just started is the case most likely to be holding a
    /// stale endpoint, because the services came up with it.
    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let push = context.relay_project_endpoints_push();
            let resolver = context.resolver.clone();
            let remind = self.ticks_since_full_report + 1 >= REMINDER_TICKS;
            // A reminder diffs against nothing, so every endpoint counts as
            // moved and the relay hears the whole set again.
            let baseline = if remind {
                BTreeMap::new()
            } else {
                self.last_reported.clone()
            };
            // Disk reads and a queue onto the relay socket, so the body goes
            // to the blocking pool. A periodic task that works on an async
            // worker holds the daemon's accept loop with it -- the health
            // watchdog then reads the unanswered `/health` as a wedge and ends
            // the process -- and a future that never yields is never
            // cancelled, so its own `timeout()` stops applying too.
            let accepted = crate::async_runtime::spawn_blocking_named(
                crate::async_runtime::scoped_task_name(
                    RELAY_PROJECT_ENDPOINTS_TASK_NAME,
                    "report",
                    "daemon",
                ),
                move || report_moved_endpoints(push.as_ref(), &resolver, &baseline),
            )
            .await
            .map_err(|error| format!("relay endpoint report did not finish: {error}"))??;
            let Some(accepted) = accepted else {
                // Refused, so the reminder is still owed and the next tick
                // tries again rather than waiting out another five minutes.
                self.ticks_since_full_report = self.ticks_since_full_report.saturating_add(1);
                return Ok(());
            };
            for endpoint in accepted {
                self.last_reported
                    .insert(endpoint.project_root, (endpoint.host, endpoint.port));
            }
            self.ticks_since_full_report = if remind {
                0
            } else {
                self.ticks_since_full_report.saturating_add(1)
            };
            Ok(())
        })
    }
}

/// Report what moved, and answer with what the relay took.
///
/// `None` means there was no relay to take it -- logged out, or between
/// sockets. `Some` carries what it took, which is empty when nothing moved.
/// The three are different answers: a report the relay refused must not be
/// recorded, or the share stays on the dead port until the next time the port
/// changes.
pub fn report_moved_endpoints(
    push: Option<&RelayProjectEndpointsPush>,
    resolver: &PathResolver,
    last_reported: &BTreeMap<String, (String, u16)>,
) -> Result<Option<Vec<ProjectEndpoint>>, String> {
    // No reporter means no relay in this build, or none dialled yet. Reading
    // the registry to find that out would be a disk read per tick on a machine
    // that has never logged in.
    let Some(push) = push else {
        return Ok(Some(Vec::new()));
    };
    let (endpoints, read_errors) = read_project_endpoints(resolver)?;
    for error in read_errors {
        log_always_at(
            LogLevel::Warn,
            "project service endpoint unreadable",
            "relay",
            Some(json!({ "error": error })),
        );
    }
    let moved = endpoints_to_report(last_reported, &endpoints);
    if moved.is_empty() {
        return Ok(Some(Vec::new()));
    }
    match push(&moved) {
        Ok(()) => {
            log_always_at(
                LogLevel::Info,
                "reported moved project service endpoints to the relay",
                "relay",
                Some(json!({
                    "projects": moved
                        .iter()
                        .map(|endpoint| json!({
                            "projectRoot": endpoint.project_root,
                            "port": endpoint.port,
                        }))
                        .collect::<Vec<_>>(),
                })),
            );
            Ok(Some(moved))
        }
        // Nothing recorded either way, so the next tick tries again. A machine
        // that is logged out or between sockets is an ordinary state and not a
        // failed task; anything else -- a full outbox, a poisoned lock -- is,
        // and is named.
        Err(error) if is_relay_absent(&error) => {
            log_always_at(
                LogLevel::Debug,
                "project endpoints not reported to the relay",
                "relay",
                Some(json!({ "error": error, "projectCount": moved.len() })),
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(root: &str, port: u16) -> ProjectEndpoint {
        ProjectEndpoint {
            project_root: root.to_owned(),
            host: "127.0.0.1".to_owned(),
            port,
        }
    }

    #[test]
    fn reports_a_project_the_relay_has_never_heard_about() {
        let moved = endpoints_to_report(&BTreeMap::new(), &[endpoint("/cs/next", 49226)]);
        assert_eq!(moved, vec![endpoint("/cs/next", 49226)]);
    }

    #[test]
    fn reports_nothing_when_no_service_moved() {
        let last = BTreeMap::from([("/cs/next".to_owned(), ("127.0.0.1".to_owned(), 49226))]);
        assert!(endpoints_to_report(&last, &[endpoint("/cs/next", 49226)]).is_empty());
    }

    #[test]
    fn reports_only_the_project_that_moved() {
        let last = BTreeMap::from([
            ("/cs/next".to_owned(), ("127.0.0.1".to_owned(), 44659)),
            ("/cs/other".to_owned(), ("127.0.0.1".to_owned(), 43444)),
        ]);
        let moved = endpoints_to_report(
            &last,
            &[endpoint("/cs/next", 49226), endpoint("/cs/other", 43444)],
        );
        assert_eq!(moved, vec![endpoint("/cs/next", 49226)]);
    }

    #[test]
    fn a_service_that_moved_host_is_a_move() {
        let last = BTreeMap::from([("/cs/next".to_owned(), ("127.0.0.1".to_owned(), 49226))]);
        let moved = endpoints_to_report(
            &last,
            &[ProjectEndpoint {
                project_root: "/cs/next".to_owned(),
                host: "0.0.0.0".to_owned(),
                port: 49226,
            }],
        );
        assert_eq!(moved.len(), 1);
    }
}
