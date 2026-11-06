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

pub use crate::daemon::scheduler::{RelayEndpointReporter, RelayProjectEndpointsPush};

/// Fold a report so each project root appears once, keeping the newest bind.
///
/// Two registry entries can share a `repo_root` -- normalization dedupes on
/// the project id and never recomputes the id from the root, and each keeps
/// its own endpoint file. Diffing a list against a map keyed by root then
/// reported one of them every tick for ever, alternating the share's port and
/// pushing every guest each time: exactly the per-tick cost the diff exists to
/// avoid.
///
/// The one that wins is the one whose service bound most recently. Taking the
/// last by project id was stable but arbitrary, and arbitrary here means the
/// share can be pinned to the duplicate whose service is long gone, which is
/// the stale port this whole change exists to move off.
fn fold_by_project_root(endpoints: Vec<(ProjectEndpoint, String)>) -> Vec<ProjectEndpoint> {
    let mut by_root: BTreeMap<String, (ProjectEndpoint, String)> = BTreeMap::new();
    for (endpoint, bound_at) in endpoints {
        match by_root.get(&endpoint.project_root) {
            // On an equal timestamp the first entry in registry order keeps
            // it. That IS an iteration-order dependency -- a documented one,
            // and the alternative is a different arbitrary answer rather than
            // a better one.
            //
            // Lexical on purpose: every writer goes through `now_iso()`, which
            // is fixed-width `YYYY-MM-DDTHH:MM:SS.mmmZ`, so lexical order IS
            // chronological. Which is also the limit of what this knows -- the
            // newest endpoint file is not necessarily the live service, since
            // the file is only removed on a clean exit.
            Some((_, held)) if held.as_str() >= bound_at.as_str() => {}
            _ => {
                by_root.insert(endpoint.project_root.clone(), (endpoint, bound_at));
            }
        }
    }
    by_root
        .into_values()
        .map(|(endpoint, _)| endpoint)
        .collect()
}

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
            Ok(Some(endpoint)) => endpoints.push((
                ProjectEndpoint {
                    project_root: entry.repo_root,
                    host: endpoint.host,
                    port: endpoint.port,
                },
                endpoint.updated_at,
            )),
            Ok(None) => {}
            Err(error) => read_errors.push(error),
        }
    }
    Ok((fold_by_project_root(endpoints), read_errors))
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
///
/// `relay_unavailable` is deliberately NOT here: it is a poisoned supervisor
/// mutex, which is a broken daemon and not a logged-out one.
fn is_relay_absent(error: &str) -> bool {
    matches!(error, "relay_off" | "relay_disconnected")
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
            let push = context.relay_project_endpoints_push()?;
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
            let report = crate::async_runtime::spawn_blocking_named(
                crate::async_runtime::scoped_task_name(
                    RELAY_PROJECT_ENDPOINTS_TASK_NAME,
                    "report",
                    "daemon",
                ),
                move || report_moved_endpoints(push.as_deref(), &resolver, &baseline),
            )
            .await
            .map_err(|error| format!("relay endpoint report did not finish: {error}"))??;
            let Some(report) = report else {
                // Refused, so the reminder is still owed and the next tick
                // tries again rather than waiting out another five minutes.
                self.ticks_since_full_report = self.ticks_since_full_report.saturating_add(1);
                return Ok(());
            };
            // Forgotten before recorded, so a root that has left the
            // registry does not sit in this map for the daemon's life. Only
            // on a complete read: a project whose endpoint file could not be
            // read is absent from `known`, and dropping it there would be the
            // same "could not tell means gone" collapse the reader refuses.
            if report.complete {
                forget_unknown_roots(&mut self.last_reported, &report.known);
            }
            for endpoint in report.accepted {
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

/// Forget roots the registry no longer has.
///
/// `last_reported` is this daemon's memory of what the relay accepted, so an
/// entry for a project that has been removed is a row nothing will consult
/// again -- and if that project is re-added on the port it used to have, the
/// stale memory would suppress the very report that tells the relay so.
fn forget_unknown_roots(
    last_reported: &mut BTreeMap<String, (String, u16)>,
    known: &[ProjectEndpoint],
) {
    let roots: std::collections::BTreeSet<&str> = known
        .iter()
        .map(|known| known.project_root.as_str())
        .collect();
    last_reported.retain(|root, _| roots.contains(root.as_str()));
}

/// What one report found: what the relay took, and every root it read.
pub struct Report {
    /// Only what the relay accepted; see `report_moved_endpoints`.
    pub accepted: Vec<ProjectEndpoint>,
    /// Every root the registry still has, so the caller can forget the rest.
    pub known: Vec<ProjectEndpoint>,
    /// Whether every registered project could be read.
    ///
    /// A project whose endpoint file could not be read is missing from
    /// `known` -- it is reported as an error instead, which is the whole point
    /// of distinguishing the two -- so forgetting against an incomplete read
    /// would treat "could not tell" as "gone", the exact collapse the reader
    /// refuses to make one call earlier.
    pub complete: bool,
}

/// Report what moved, and answer with what the relay took.
///
/// `None` means there was no relay to take it -- logged out, or between
/// sockets. `Some` carries what it took, which is empty when nothing moved.
/// The three are different answers: a report the relay refused must not be
/// recorded, or the share stays on the dead port until the next time the port
/// changes.
pub fn report_moved_endpoints(
    push: Option<&dyn RelayEndpointReporter>,
    resolver: &PathResolver,
    last_reported: &BTreeMap<String, (String, u16)>,
) -> Result<Option<Report>, String> {
    // Asked before the registry is read, and asked of the relay rather than of
    // the build: the reporter is registered at startup whether or not anyone
    // has ever logged in, so "is it registered" answered the wrong question
    // and a logged-out machine paid a registry read -- and a registry
    // REWRITE, since `load_registry` saves a normalized copy -- every tick.
    // `None`, not an empty report: an empty report reads as "taken, nothing
    // moved", which resets the reminder -- so a reminder tick that fell while
    // the machine was logged out was consumed without a frame ever being
    // sent, and the next one was another five minutes away.
    let Some(push) = push.filter(|push| push.ready()) else {
        return Ok(None);
    };
    let (endpoints, read_errors) = read_project_endpoints(resolver)?;
    let complete = read_errors.is_empty();
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
        return Ok(Some(Report {
            accepted: Vec::new(),
            known: endpoints,
            complete,
        }));
    }
    match push.report(&moved) {
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
            Ok(Some(Report {
                accepted: moved,
                known: endpoints,
                complete,
            }))
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
    use crate::daemon::scheduler::DaemonSchedulerContext;
    use crate::daemon_state::AimuxDaemonInfo;

    /// A poisoned reporter slot is a broken daemon, not a logged-out one. The
    /// task has to fail its tick on it: answering Ok left a green scheduler
    /// over every share sitting on a stale port, with nothing saying why.
    /// Only a test inside the crate can poison that lock.
    #[test]
    fn a_poisoned_reporter_slot_fails_the_tick() {
        let context = DaemonSchedulerContext::new(
            PathResolver::new("/", "/", None),
            AimuxDaemonInfo {
                pid: 1,
                port: 43190,
                started_at: "2099-01-01T00:00:00.000Z".to_owned(),
                updated_at: "2099-01-01T00:00:00.000Z".to_owned(),
            },
        );
        context.poison_relay_reporter_slot();
        let mut task = RelayProjectEndpointsTask::new();

        // aimux-async-seam: test - sync test drives the periodic task body
        let result = crate::async_runtime::block_on_named("test:relay-endpoints-poisoned", async {
            task.run(&context).await
        });

        assert_eq!(
            result,
            Err("daemon scheduler relay endpoints lock poisoned".to_owned())
        );
    }

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
