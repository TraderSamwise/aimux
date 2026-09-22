//! Repairing tmux window bindings that a tmux server restart invalidated.
//!
//! tmux assigns window ids per server and restarts numbering when the server
//! dies, so every persisted `tmuxWindowId` in the topology is meaningless the
//! moment the server is replaced. Liveness reads already refuse to trust an id
//! that is not in the session the binding names, but refusing is not repairing:
//! the durable record stays wrong, so an agent that IS alive under a new id is
//! never reachable again, and a dead one keeps its phantom binding forever.
//!
//! The identity that survives a restart is the `@aimux-meta` window option,
//! which carries the aimux session id. Matching on that — never on a window
//! name or index, which collide across projects — is what makes the repair
//! safe to apply without asking.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};

use crate::debug_logging::log_lifecycle_always;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};
use crate::tmux::{TmuxManagedWindow, TmuxRuntimeManager};

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};

/// One window this project owns right now, reduced to what reconciliation
/// needs. Built from `@aimux-meta`, so a window aimux did not create has no
/// session id and can never claim someone's binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedWindow {
    pub session_id: Option<String>,
    pub tmux_session: String,
    pub window_id: String,
    pub window_index: i64,
    pub window_name: String,
}

impl OwnedWindow {
    pub fn from_managed(window: &TmuxManagedWindow) -> Self {
        Self {
            session_id: window
                .metadata
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tmux_session: window.target.session_name.clone(),
            window_id: window.target.window_id.clone(),
            window_index: window.target.window_index,
            window_name: window.target.window_name.clone(),
        }
    }
}

/// What to do with one binding whose recorded window no longer checks out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingRepair {
    /// The agent is alive under a new window. Point the binding at it.
    Rebind {
        node_id: String,
        session_id: String,
        from_window_id: String,
        to: OwnedWindow,
    },
    /// Nothing this project owns claims this session. Drop the binding so the
    /// session reads as offline and restorable rather than focusable.
    Invalidate {
        node_id: String,
        session_id: String,
        stale_window_id: String,
        stale_tmux_session: String,
    },
}

impl BindingRepair {
    pub fn node_id(&self) -> &str {
        match self {
            Self::Rebind { node_id, .. } | Self::Invalidate { node_id, .. } => node_id,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::Rebind { session_id, .. } | Self::Invalidate { session_id, .. } => session_id,
        }
    }
}

/// Decide what each binding needs, given the windows this project owns.
///
/// `owned_windows` must be the complete inventory for this project across all
/// of its tmux sessions. An incomplete list would invalidate live bindings, so
/// callers pass an error up rather than a partial inventory: the caller that
/// could not ask tmux plans nothing at all.
pub fn plan_binding_repairs(topology: &Value, owned_windows: &[OwnedWindow]) -> Vec<BindingRepair> {
    let mut repairs = Vec::new();
    for binding in &array_field(topology, "bindings") {
        let Some(node_id) = string_field(binding, "nodeId") else {
            continue;
        };
        let Some(window_id) = string_field(binding, "tmuxWindowId") else {
            continue;
        };
        let tmux_session = string_field(binding, "tmuxSession").unwrap_or_default();
        let Some(session_id) = session_id_for_node(topology, &node_id) else {
            continue;
        };
        let claimed = owned_windows
            .iter()
            .find(|window| window.session_id.as_deref() == Some(session_id.as_str()));
        match claimed {
            Some(window)
                if window.window_id == window_id && window.tmux_session == tmux_session => {}
            Some(window) => repairs.push(BindingRepair::Rebind {
                node_id,
                session_id,
                from_window_id: window_id,
                to: window.clone(),
            }),
            None => {
                // A window this project owns but whose metadata names nobody is
                // not evidence either way, so only an id that no owned window
                // carries at all is treated as stale.
                let owned_by_this_project = owned_windows.iter().any(|window| {
                    window.window_id == window_id && window.tmux_session == tmux_session
                });
                if !owned_by_this_project {
                    repairs.push(BindingRepair::Invalidate {
                        node_id,
                        session_id,
                        stale_window_id: window_id,
                        stale_tmux_session: tmux_session,
                    });
                }
            }
        }
    }
    repairs
}

/// Apply repairs to a topology value. Pure, so the caller owns the write and
/// the same function is used by the task and by `aimux doctor`.
pub fn apply_binding_repairs(mut topology: Value, repairs: &[BindingRepair]) -> Value {
    if repairs.is_empty() {
        return topology;
    }
    let Some(bindings) = topology
        .get_mut("bindings")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
    else {
        return topology;
    };
    let repaired = bindings
        .into_iter()
        .filter_map(|binding| {
            let node_id = string_field(&binding, "nodeId").unwrap_or_default();
            match repairs.iter().find(|repair| repair.node_id() == node_id) {
                Some(BindingRepair::Rebind { to, .. }) => Some(rebound(binding, to)),
                Some(BindingRepair::Invalidate { .. }) => None,
                None => Some(binding),
            }
        })
        .collect::<Vec<_>>();
    topology["bindings"] = Value::Array(repaired);
    topology
}

fn rebound(binding: Value, window: &OwnedWindow) -> Value {
    let Value::Object(mut map) = binding else {
        return binding;
    };
    map.insert(
        "tmuxSession".into(),
        Value::String(window.tmux_session.clone()),
    );
    map.insert(
        "tmuxWindowId".into(),
        Value::String(window.window_id.clone()),
    );
    map.insert("tmuxWindowIndex".into(), Value::from(window.window_index));
    map.insert(
        "tmuxWindowName".into(),
        Value::String(window.window_name.clone()),
    );
    Value::Object(map)
}

fn session_id_for_node(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "sessions")
        .iter()
        .find(|session| string_field(session, "nodeId").as_deref() == Some(node_id))
        .and_then(|session| string_field(session, "id"))
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The windows this project owns right now.
///
/// Behind a trait so the repair rules can be tested without a tmux server, and
/// so an inventory failure stays an error rather than becoming an empty list
/// that would invalidate every live binding. Async because the tmux inventory
/// is a blocking multi-command walk: running it inline panics the tick task.
pub trait OwnedWindowSource: Send {
    fn owned_windows<'a>(
        &'a mut self,
        project_root: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OwnedWindow>, String>> + Send + 'a>>;
}

pub struct TmuxOwnedWindowSource;

impl OwnedWindowSource for TmuxOwnedWindowSource {
    fn owned_windows<'a>(
        &'a mut self,
        project_root: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OwnedWindow>, String>> + Send + 'a>> {
        let project_root = project_root.to_path_buf();
        Box::pin(async move {
            spawn_blocking_named(
                scoped_task_name("window-reconciliation", "tmux-inventory", "project"),
                move || {
                    Ok(TmuxRuntimeManager::new()
                        .list_project_managed_windows(&project_root)?
                        .iter()
                        .map(OwnedWindow::from_managed)
                        .collect::<Vec<_>>())
                },
            )
            .await
            .map_err(|error| format!("tmux inventory task did not finish: {error}"))?
        })
    }
}

/// Ten seconds. Window ids only change when tmux creates, kills, or renumbers
/// windows, and the restart case that motivates this is repaired on the first
/// run at startup rather than by the cadence.
const DEFAULT_SCAN_INTERVAL_MS: i64 = 10_000;
const DEFAULT_SCAN_EVERY_TICKS: u64 = 40;

pub struct WindowReconciliationTask {
    windows: Box<dyn OwnedWindowSource>,
}

impl WindowReconciliationTask {
    pub fn new() -> Self {
        Self::with_window_source(Box::new(TmuxOwnedWindowSource))
    }

    pub fn with_window_source(windows: Box<dyn OwnedWindowSource>) -> Self {
        Self { windows }
    }
}

impl Default for WindowReconciliationTask {
    fn default() -> Self {
        Self::new()
    }
}

impl PeriodicTask for WindowReconciliationTask {
    fn name(&self) -> &str {
        "window-reconciliation"
    }

    fn interval_ms(&self) -> i64 {
        DEFAULT_SCAN_INTERVAL_MS
    }

    fn tick_multiple(&self) -> u64 {
        DEFAULT_SCAN_EVERY_TICKS
    }

    /// The restart this exists for has already happened by the time the service
    /// starts, so waiting a cadence would leave every binding stale for the
    /// first ten seconds of the session the user is looking at.
    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let topology_path = runtime_topology_path(context.project_state_dir());
            let topology = read_runtime_topology(&topology_path)
                .map_err(|error| format!("window reconciliation topology unavailable: {error}"))?;
            let owned_windows = self
                .windows
                .owned_windows(context.project_root())
                .await
                .map_err(|error| {
                    format!("window reconciliation tmux inventory unavailable: {error}")
                })?;
            let repairs = plan_binding_repairs(&topology, &owned_windows);
            if repairs.is_empty() {
                return Ok(());
            }
            update_runtime_topology(&topology_path, |current| {
                // Re-plan against the topology under the lock: another writer may
                // have changed the bindings since the read above.
                let repairs = plan_binding_repairs(&current, &owned_windows);
                apply_binding_repairs(current, &repairs)
            })
            .map_err(|error| format!("window reconciliation could not write topology: {error}"))?;
            log_lifecycle_always(
                "repaired stale tmux window bindings",
                "window-reconciliation",
                Some(json!({
                    "rebound": repair_summary(&repairs, true),
                    "invalidated": repair_summary(&repairs, false),
                })),
            );
            Ok(())
        })
    }
}

fn repair_summary(repairs: &[BindingRepair], rebound: bool) -> Vec<String> {
    repairs
        .iter()
        .filter(|repair| matches!(repair, BindingRepair::Rebind { .. }) == rebound)
        .map(|repair| repair.session_id().to_owned())
        .collect()
}

pub fn window_reconciliation_task() -> Box<dyn PeriodicTask> {
    Box::new(WindowReconciliationTask::new())
}
