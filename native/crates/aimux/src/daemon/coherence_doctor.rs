//! The runtime-coherence checks, with the repair for each one.
//!
//! Every finding here is a way the durable record and the live machine can
//! disagree after something outside aimux changes underneath it — a reboot, a
//! `tmux kill-server`, a deleted checkout. Individually each is small; together
//! they are why a dashboard can offer an agent it cannot reach and a routine
//! install can end in an error.
//!
//! Each check names what it found and how to fix it, and `--repair` applies the
//! fixes it can make safely. A check that could not be evaluated says so and is
//! never reported as clean: "could not ask" and "nothing wrong" are different
//! answers, and only one of them means the machine is healthy.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{Value, json};

use crate::dashboard_processes::{DashboardProcess, dashboard_project_root_of};
use crate::project_service::window_reconciliation::{
    BindingRepair, OwnedWindow, apply_binding_repairs, plan_binding_repairs,
};

/// What one check concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    /// Evaluated, nothing wrong.
    Clean,
    /// Evaluated, and these are the problems, each with how to fix it.
    Findings(Vec<CoherenceFinding>),
    /// Could not be evaluated. Never clean.
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoherenceFinding {
    pub subject: String,
    pub detail: String,
    pub repair: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoherenceCheck {
    pub name: &'static str,
    pub title: &'static str,
    pub outcome: CheckOutcome,
    /// Set by a `--repair` run: what this check actually changed.
    pub repaired: Vec<String>,
}

impl CoherenceCheck {
    pub fn findings(&self) -> &[CoherenceFinding] {
        match &self.outcome {
            CheckOutcome::Findings(findings) => findings,
            _ => &[],
        }
    }

    pub fn status(&self) -> &'static str {
        match &self.outcome {
            CheckOutcome::Clean => "ok",
            CheckOutcome::Findings(_) => "found",
            CheckOutcome::Unavailable(_) => "unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoherenceReport {
    pub project_root: String,
    pub repaired: bool,
    pub checks: Vec<CoherenceCheck>,
}

impl CoherenceReport {
    pub fn finding_count(&self) -> usize {
        self.checks.iter().map(|check| check.findings().len()).sum()
    }

    pub fn unavailable_count(&self) -> usize {
        self.checks
            .iter()
            .filter(|check| matches!(check.outcome, CheckOutcome::Unavailable(_)))
            .count()
    }
}

/// Everything the checks need from the machine, behind one seam so the rules
/// are testable without a tmux server, a daemon, or a process table.
pub trait CoherenceDoctorRuntime {
    fn topology(&mut self, project_root: &Path) -> Result<Value, String>;
    fn owned_windows(&mut self, project_root: &Path) -> Result<Vec<OwnedWindow>, String>;
    fn restore_snapshot_session_ids(
        &mut self,
        project_root: &Path,
    ) -> Result<BTreeSet<String>, String>;
    fn dashboard_processes(&mut self) -> Result<Vec<DashboardProcess>, String>;
    /// The tmux session each dashboard process runs in, keyed by its pid. A
    /// dashboard whose session cannot be resolved falls back to being grouped
    /// by project root alone, which is the older, coarser rule.
    fn dashboard_tmux_sessions(
        &mut self,
        dashboards: &[DashboardProcess],
    ) -> Result<BTreeMap<i32, String>, String>;
    fn registered_project_roots(&mut self) -> Result<Vec<String>, String>;
    fn project_root_is_reachable(&mut self, project_root: &str) -> bool;
    /// Applies binding repairs to the durable topology. Only called under
    /// `--repair`.
    fn write_repaired_topology(
        &mut self,
        project_root: &Path,
        repairs: &[BindingRepair],
    ) -> Result<(), String>;
    /// Marks sessions offline in the durable topology. Only called under
    /// `--repair`, and only for sessions proven to have no managed window.
    fn mark_sessions_offline(
        &mut self,
        project_root: &Path,
        session_ids: &[String],
    ) -> Result<(), String>;
    /// Re-records the restore snapshot from the topology. Only called under
    /// `--repair`.
    fn rebuild_restore_snapshot(&mut self, project_root: &Path) -> Result<(), String>;
}

pub fn build_coherence_report(
    runtime: &mut impl CoherenceDoctorRuntime,
    project_root: &Path,
    repair: bool,
) -> CoherenceReport {
    let topology = runtime.topology(project_root);
    let owned_windows = runtime.owned_windows(project_root);
    let mut checks = vec![
        check_stale_window_bindings(runtime, project_root, &topology, &owned_windows, repair),
        check_sessions_without_windows(runtime, project_root, &topology, &owned_windows, repair),
        check_restore_snapshot(runtime, project_root, &topology, &owned_windows, repair),
        check_duplicate_dashboards(runtime),
        check_unreachable_projects(runtime),
    ];
    checks.sort_by_key(|check| check.name);
    CoherenceReport {
        project_root: project_root.to_string_lossy().into_owned(),
        repaired: repair,
        checks,
    }
}

fn check_stale_window_bindings(
    runtime: &mut impl CoherenceDoctorRuntime,
    project_root: &Path,
    topology: &Result<Value, String>,
    owned_windows: &Result<Vec<OwnedWindow>, String>,
    repair: bool,
) -> CoherenceCheck {
    let name = "stale-window-bindings";
    let title = "tmux window ids that no longer name this project's windows";
    let (topology, owned_windows) = match (topology, owned_windows) {
        (Ok(topology), Ok(owned_windows)) => (topology, owned_windows),
        (Err(error), _) | (_, Err(error)) => {
            return unavailable(name, title, error.clone());
        }
    };
    let repairs = plan_binding_repairs(topology, owned_windows);
    if repairs.is_empty() {
        return clean(name, title);
    }
    let findings = repairs
        .iter()
        .map(|repair| match repair {
            BindingRepair::Rebind {
                session_id,
                from_window_id,
                to,
                ..
            } => CoherenceFinding {
                subject: session_id.clone(),
                detail: format!(
                    "recorded window {from_window_id}, but the session's window is now {}",
                    to.window_id
                ),
                repair: format!("rebind to {}", to.window_id),
            },
            BindingRepair::Invalidate {
                session_id,
                stale_window_id,
                ..
            } => CoherenceFinding {
                subject: session_id.clone(),
                detail: format!(
                    "recorded window {stale_window_id} is not a window this project owns"
                ),
                repair: "drop the binding so the session reads offline and restorable".to_owned(),
            },
        })
        .collect::<Vec<_>>();
    let mut check = CoherenceCheck {
        name,
        title,
        outcome: CheckOutcome::Findings(findings),
        repaired: Vec::new(),
    };
    if repair {
        match runtime.write_repaired_topology(project_root, &repairs) {
            Ok(()) => {
                check.repaired = repairs
                    .iter()
                    .map(|repair| repair.session_id().to_owned())
                    .collect();
            }
            Err(error) => {
                check.outcome = CheckOutcome::Unavailable(format!("repair failed: {error}"));
            }
        }
    }
    check
}

/// A session that claims a live status with no binding at all cannot be
/// entered: focus has nothing to address. The durable status is what makes the
/// dashboard offer it, so the record is what is wrong.
fn check_sessions_without_windows(
    runtime: &mut impl CoherenceDoctorRuntime,
    project_root: &Path,
    topology: &Result<Value, String>,
    owned_windows: &Result<Vec<OwnedWindow>, String>,
    repair: bool,
) -> CoherenceCheck {
    let name = "sessions-without-windows";
    let title = "sessions that claim to be running with no managed window";
    let Ok(topology) = topology else {
        return unavailable(name, title, topology.clone().unwrap_err());
    };
    // The repair writes a durable status, so it needs the tmux inventory to
    // have actually been taken. Reporting only needs the topology.
    if repair && let Err(error) = owned_windows {
        return unavailable(name, title, error.clone());
    }
    let bound_nodes = array_of(topology, "bindings")
        .iter()
        .filter(|binding| !string_of(binding, "tmuxWindowId").is_empty())
        .map(|binding| string_of(binding, "nodeId"))
        .collect::<BTreeSet<_>>();
    let findings = array_of(topology, "sessions")
        .iter()
        .filter(|session| LIVE_STATUSES.contains(&string_of(session, "status").as_str()))
        .filter(|session| !bound_nodes.contains(&string_of(session, "nodeId")))
        .map(|session| CoherenceFinding {
            subject: string_of(session, "id"),
            detail: format!(
                "status is {} but no tmux window is bound to it",
                string_of(session, "status")
            ),
            repair: "resume it, or stop it if it is finished; it cannot be entered as it is"
                .to_owned(),
        })
        .collect::<Vec<_>>();
    if findings.is_empty() {
        return clean(name, title);
    }
    let mut check = found(name, title, findings);
    if repair {
        // `starting` is excluded: its window is being created right now, and
        // the binding lands a moment later.
        let repairable = check
            .findings()
            .iter()
            .filter(|finding| !finding.detail.contains("status is starting"))
            .map(|finding| finding.subject.clone())
            .collect::<Vec<_>>();
        if !repairable.is_empty() {
            match runtime.mark_sessions_offline(project_root, &repairable) {
                Ok(()) => check.repaired = repairable,
                Err(error) => {
                    check.outcome = CheckOutcome::Unavailable(format!("repair failed: {error}"));
                }
            }
        }
    }
    check
}

/// The snapshot is what the restore prompt is built from. When it holds fewer
/// sessions than the topology still says are restorable, the prompt will offer
/// back less than it could — which is how eight agents went unoffered.
/// The snapshot records the agents that were ONLINE, so that a run which dies
/// with agents up can offer them back. An agent someone stopped is absent by
/// design, and so is one that went offline in some previous era.
///
/// Comparing the snapshot against every non-finished session in the topology
/// therefore reported history as drift: on tealstreet-next it flagged 24
/// sessions, some offline since August, none of which the snapshot ever held.
///
/// The checkable contradiction is narrower and has no false positives: an agent
/// running in a window this project owns RIGHT NOW must be in the snapshot,
/// because that is exactly what the snapshot claims to describe.
fn check_restore_snapshot(
    runtime: &mut impl CoherenceDoctorRuntime,
    project_root: &Path,
    topology: &Result<Value, String>,
    owned_windows: &Result<Vec<OwnedWindow>, String>,
    repair: bool,
) -> CoherenceCheck {
    let name = "restore-snapshot";
    let title = "restore snapshot against the agents that are online now";
    let Ok(topology) = topology else {
        return unavailable(name, title, topology.clone().unwrap_err());
    };
    let owned_windows = match owned_windows {
        Ok(owned_windows) => owned_windows,
        Err(error) => return unavailable(name, title, error.clone()),
    };
    let snapshot_ids = match runtime.restore_snapshot_session_ids(project_root) {
        Ok(ids) => ids,
        Err(error) => return unavailable(name, title, error),
    };
    if snapshot_ids.is_empty() {
        // No snapshot is a legitimate state: it is what a clean shutdown leaves.
        return clean(name, title);
    }
    let online = online_session_ids(topology, owned_windows);
    let missing = online
        .difference(&snapshot_ids)
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return clean(name, title);
    }
    let mut check = found(
        name,
        title,
        missing
            .iter()
            .map(|session_id| CoherenceFinding {
                subject: session_id.clone(),
                detail: "running in a window this project owns, but missing from the restore \
                         snapshot that is supposed to record who is online"
                    .to_owned(),
                repair: "re-record the snapshot from the topology".to_owned(),
            })
            .collect(),
    );
    if repair {
        match runtime.rebuild_restore_snapshot(project_root) {
            Ok(()) => check.repaired = missing,
            Err(error) => {
                check.outcome = CheckOutcome::Unavailable(format!("repair failed: {error}"));
            }
        }
    }
    check
}

/// One dashboard per project. A second one for the same project root is a leak:
/// both draw the same state, and the one that is not in the project's window is
/// invisible work.
fn check_duplicate_dashboards(runtime: &mut impl CoherenceDoctorRuntime) -> CoherenceCheck {
    let name = "duplicate-dashboards";
    let title = "dashboard processes per project";
    let processes = match runtime.dashboard_processes() {
        Ok(processes) => processes,
        Err(error) => return unavailable(name, title, error),
    };
    let sessions = match runtime.dashboard_tmux_sessions(&processes) {
        Ok(sessions) => sessions,
        Err(error) => return unavailable(name, title, error),
    };
    // One dashboard per project per tmux session: a project legitimately has
    // one in its own session and one in each attached client session, so the
    // session is part of the key rather than the project root alone.
    let mut findings = Vec::new();
    let dashboards = processes
        .iter()
        .filter_map(|process| {
            dashboard_project_root_of(&process.args).map(|root| {
                let session = sessions.get(&process.pid).cloned().unwrap_or_default();
                ((root, session), process.pid)
            })
        })
        .collect::<Vec<_>>();
    let keys = dashboards
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    for (root, session) in keys {
        let pids = dashboards
            .iter()
            .filter(|((candidate_root, candidate_session), _)| {
                candidate_root == &root && candidate_session == &session
            })
            .map(|(_, pid)| *pid)
            .collect::<Vec<_>>();
        if pids.len() > 1 {
            let location = if session.is_empty() {
                "with no resolvable tmux session".to_owned()
            } else {
                format!("in tmux session {session}")
            };
            findings.push(CoherenceFinding {
                subject: root.clone(),
                detail: format!(
                    "{} dashboard processes {location} for one project: {}",
                    pids.len(),
                    pids.iter()
                        .map(i32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                repair: format!(
                    "aimux restart --project {root} restarts the one that should exist"
                ),
            });
        }
    }
    if findings.is_empty() {
        clean(name, title)
    } else {
        found(name, title, findings)
    }
}

/// A registration whose root is gone fails every post-install restart forever.
fn check_unreachable_projects(runtime: &mut impl CoherenceDoctorRuntime) -> CoherenceCheck {
    let name = "unreachable-projects";
    let title = "registered projects whose root is gone";
    let roots = match runtime.registered_project_roots() {
        Ok(roots) => roots,
        Err(error) => return unavailable(name, title, error),
    };
    let findings = roots
        .into_iter()
        .filter(|root| !runtime.project_root_is_reachable(root))
        .map(|root| CoherenceFinding {
            subject: root.clone(),
            detail: "registered, but this machine cannot reach the root".to_owned(),
            repair: format!("aimux projects remove {root}"),
        })
        .collect::<Vec<_>>();
    if findings.is_empty() {
        clean(name, title)
    } else {
        found(name, title, findings)
    }
}

/// Sessions claiming a live status whose bound window this project actually
/// owns. Anything else is offline, however it got there.
fn online_session_ids(topology: &Value, owned_windows: &[OwnedWindow]) -> BTreeSet<String> {
    let bound_windows = array_of(topology, "bindings")
        .iter()
        .map(|binding| {
            (
                string_of(binding, "nodeId"),
                string_of(binding, "tmuxWindowId"),
            )
        })
        .collect::<Vec<_>>();
    array_of(topology, "sessions")
        .iter()
        .filter(|session| LIVE_STATUSES.contains(&string_of(session, "status").as_str()))
        .filter(|session| {
            let node_id = string_of(session, "nodeId");
            bound_windows.iter().any(|(bound_node, window_id)| {
                bound_node == &node_id
                    && owned_windows
                        .iter()
                        .any(|owned| &owned.window_id == window_id)
            })
        })
        .map(|session| string_of(session, "id"))
        .filter(|id| !id.is_empty())
        .collect()
}

const LIVE_STATUSES: &[&str] = &["starting", "running", "idle"];

fn clean(name: &'static str, title: &'static str) -> CoherenceCheck {
    CoherenceCheck {
        name,
        title,
        outcome: CheckOutcome::Clean,
        repaired: Vec::new(),
    }
}

fn found(
    name: &'static str,
    title: &'static str,
    findings: Vec<CoherenceFinding>,
) -> CoherenceCheck {
    CoherenceCheck {
        name,
        title,
        outcome: CheckOutcome::Findings(findings),
        repaired: Vec::new(),
    }
}

fn unavailable(name: &'static str, title: &'static str, error: String) -> CoherenceCheck {
    CoherenceCheck {
        name,
        title,
        outcome: CheckOutcome::Unavailable(error),
        repaired: Vec::new(),
    }
}

fn array_of(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

pub fn render_coherence_report(report: &CoherenceReport) -> String {
    let mut lines = vec![
        "Aimux Runtime Coherence".to_owned(),
        format!("  project: {}", report.project_root),
        format!(
            "  findings: {}  unavailable checks: {}{}",
            report.finding_count(),
            report.unavailable_count(),
            if report.repaired {
                "  (repair run)"
            } else {
                ""
            }
        ),
    ];
    for check in &report.checks {
        lines.push(String::new());
        lines.push(format!("{}: {}", check.name, check.status()));
        lines.push(format!("  {}", check.title));
        match &check.outcome {
            CheckOutcome::Clean => lines.push("  nothing to fix".to_owned()),
            CheckOutcome::Unavailable(error) => {
                lines.push(format!("  could not check: {error}"));
            }
            CheckOutcome::Findings(findings) => {
                for finding in findings {
                    lines.push(format!("  - {}: {}", finding.subject, finding.detail));
                    lines.push(format!("      fix: {}", finding.repair));
                }
            }
        }
        if !check.repaired.is_empty() {
            lines.push(format!("  repaired: {}", check.repaired.join(", ")));
        }
    }
    lines.join("\n")
}

pub fn coherence_report_json(report: &CoherenceReport) -> Value {
    json!({
        "projectRoot": report.project_root,
        "repairRun": report.repaired,
        "findings": report.finding_count(),
        "unavailableChecks": report.unavailable_count(),
        "checks": report.checks.iter().map(|check| json!({
            "name": check.name,
            "title": check.title,
            "status": check.status(),
            "error": match &check.outcome {
                CheckOutcome::Unavailable(error) => Value::String(error.clone()),
                _ => Value::Null,
            },
            "findings": check.findings().iter().map(|finding| json!({
                "subject": finding.subject,
                "detail": finding.detail,
                "repair": finding.repair,
            })).collect::<Vec<_>>(),
            "repaired": check.repaired,
        })).collect::<Vec<_>>(),
    })
}

/// Reuse the reconciliation writer so the doctor's repair and the tick task's
/// repair cannot drift into two different answers.
pub fn apply_topology_binding_repairs(topology: Value, repairs: &[BindingRepair]) -> Value {
    apply_binding_repairs(topology, repairs)
}

/// The real machine. Every read is fallible and stays fallible: a failure here
/// becomes an `Unavailable` check rather than a clean one.
pub struct SystemCoherenceDoctorRuntime {
    resolver: crate::paths::PathResolver,
}

impl SystemCoherenceDoctorRuntime {
    pub fn new(resolver: crate::paths::PathResolver) -> Self {
        Self { resolver }
    }

    fn topology_path(&mut self, project_root: &Path) -> std::path::PathBuf {
        crate::runtime_topology::runtime_topology_path(
            self.resolver
                .project_state_dir_for(project_root.to_string_lossy().as_ref()),
        )
    }
}

impl CoherenceDoctorRuntime for SystemCoherenceDoctorRuntime {
    fn topology(&mut self, project_root: &Path) -> Result<Value, String> {
        let path = self.topology_path(project_root);
        crate::runtime_topology::read_runtime_topology(path)
    }

    fn owned_windows(&mut self, project_root: &Path) -> Result<Vec<OwnedWindow>, String> {
        Ok(crate::tmux::TmuxRuntimeManager::new()
            .list_project_managed_windows(project_root)?
            .iter()
            .map(OwnedWindow::from_managed)
            .collect())
    }

    fn restore_snapshot_session_ids(
        &mut self,
        project_root: &Path,
    ) -> Result<BTreeSet<String>, String> {
        let state_dir = self
            .resolver
            .project_state_dir_for(project_root.to_string_lossy().as_ref());
        let path = state_dir.join("last-online-agents.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeSet::new());
            }
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        let snapshot: Value = serde_json::from_str(&text)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        Ok(array_of(&snapshot, "sessions")
            .iter()
            .map(|session| string_of(session, "id"))
            .filter(|id| !id.is_empty())
            .collect())
    }

    fn dashboard_processes(&mut self) -> Result<Vec<DashboardProcess>, String> {
        Ok(crate::process_inspector::try_list_process_args()?
            .into_iter()
            .filter(|entry| crate::dashboard_processes::is_dashboard_process_args(&entry.args))
            .map(|entry| DashboardProcess {
                pid: entry.pid,
                args: entry.args,
            })
            .collect())
    }

    fn dashboard_tmux_sessions(
        &mut self,
        dashboards: &[DashboardProcess],
    ) -> Result<BTreeMap<i32, String>, String> {
        let parents = crate::process_inspector::try_list_process_parents()?;
        let session_by_pane_pid = crate::tmux::TmuxRuntimeManager::new().try_pane_session_pids()?;
        Ok(dashboards
            .iter()
            .filter_map(|dashboard| {
                crate::dashboard_processes::tmux_session_for_process(
                    dashboard.pid,
                    &parents,
                    &session_by_pane_pid,
                )
                .map(|session| (dashboard.pid, session))
            })
            .collect())
    }

    fn registered_project_roots(&mut self) -> Result<Vec<String>, String> {
        Ok(self
            .resolver
            .list_projects()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|project| project.repo_root)
            .filter(|root| !root.trim().is_empty())
            .collect())
    }

    fn project_root_is_reachable(&mut self, project_root: &str) -> bool {
        !matches!(
            crate::paths::project_root_status(Path::new(project_root.trim())),
            crate::paths::ProjectRootStatus::Unreachable
        )
    }

    fn write_repaired_topology(
        &mut self,
        project_root: &Path,
        repairs: &[BindingRepair],
    ) -> Result<(), String> {
        let path = self.topology_path(project_root);
        let owned = repairs.to_vec();
        crate::runtime_topology::update_runtime_topology(&path, move |current| {
            apply_binding_repairs(current, &owned)
        })
        .map(|_| ())
    }

    fn rebuild_restore_snapshot(&mut self, project_root: &Path) -> Result<(), String> {
        let topology = self.topology(project_root)?;
        let state_dir = self
            .resolver
            .project_state_dir_for(project_root.to_string_lossy().as_ref());
        crate::project_service::agent_restore_task::rebuild_restore_snapshot_from_topology(
            &state_dir, &topology,
        )
        .map(|_| ())
    }

    fn mark_sessions_offline(
        &mut self,
        project_root: &Path,
        session_ids: &[String],
    ) -> Result<(), String> {
        let path = self.topology_path(project_root);
        let ids = session_ids.iter().cloned().collect::<BTreeSet<_>>();
        crate::runtime_topology::update_runtime_topology(&path, move |mut current| {
            if let Some(sessions) = current.get_mut("sessions").and_then(Value::as_array_mut) {
                for session in sessions.iter_mut() {
                    if ids.contains(&string_of(session, "id"))
                        && let Value::Object(map) = session
                    {
                        map.insert("status".into(), Value::String("offline".into()));
                    }
                }
            }
            current
        })
        .map(|_| ())
    }
}
