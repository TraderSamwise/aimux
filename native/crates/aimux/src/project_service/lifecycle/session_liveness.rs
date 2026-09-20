//! Whether a session in the topology is actually running.
//!
//! The topology status is durable, not live. When a window dies without the
//! project service seeing it — a crash, a `tmux kill-server`, a machine that
//! lost power — the row keeps reading `running` and nothing rewrites it. The
//! desktop-state read already corrects that for display; the lifecycle routes
//! did not, so a lost agent was refused a resume and told it was already
//! running, and a restore offer for one was discarded as unrestorable.
//!
//! This is the one place that asks the question, so resume, restore, and the
//! snapshot producer cannot drift into three different answers.

use serde_json::Value;
use std::collections::BTreeSet;

use crate::project_service::agents::{
    session_is_backed_by_live_window, try_live_window_ids_for_session_projection,
};
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::topology_session_to_session_state;

use super::LIVE_STATUSES;
use super::json_helpers::string_field;

/// What tmux says exists, or the error explaining why tmux could not be asked.
///
/// A query that failed is not an empty window list: every caller here falls
/// back to the durable status rather than declaring every agent dead.
pub(super) struct LiveWindows(Result<BTreeSet<String>, String>);

impl LiveWindows {
    /// Prefers the inventory the request already carries, so one request does
    /// not ask tmux the same question twice and gets one consistent answer.
    pub(super) fn for_context(context: &ProjectServiceRequestContext, surface: &str) -> Self {
        match context.live_window_ids_status() {
            Some(Ok(live_window_ids)) => Self(Ok(live_window_ids.clone())),
            Some(Err(error)) => Self(Err(error.to_owned())),
            None => Self(try_live_window_ids_for_session_projection(surface)),
        }
    }

    /// True only when tmux answered and the session's window was not in it.
    fn window_is_provably_gone(&self, session: &Value, topology: &Value) -> bool {
        let Ok(live_window_ids) = self.0.as_ref() else {
            return false;
        };
        let state = topology_session_to_session_state(session, topology);
        !session_is_backed_by_live_window(&state, live_window_ids)
    }

    /// A session that can be brought back: already offline, or claiming a live
    /// status while its window is provably gone.
    pub(super) fn session_is_restorable(&self, session: &Value, topology: &Value) -> bool {
        let status = string_field(session, "status");
        if status == "offline" {
            return true;
        }
        LIVE_STATUSES.contains(&status.as_str()) && self.window_is_provably_gone(session, topology)
    }

    /// A session that is genuinely running, so resuming it would be a no-op.
    pub(super) fn session_is_live(&self, session: &Value, topology: &Value) -> bool {
        LIVE_STATUSES.contains(&string_field(session, "status").as_str())
            && !self.window_is_provably_gone(session, topology)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn topology_with_running_session(window_id: &str) -> (Value, Value) {
        let session = json!({
            "id": "codex-live",
            "nodeId": "node-1",
            "tool": "codex",
            "status": "running",
        });
        let topology = json!({
            "nodes": [{ "id": "node-1", "toolConfigKey": "codex", "cwd": "/repo" }],
            "bindings": [{
                "nodeId": "node-1",
                "tmuxSession": "aimux-test",
                "tmuxWindowId": window_id,
                "tmuxWindowIndex": 1,
                "tmuxWindowName": "codex",
            }],
        });
        (session, topology)
    }

    #[test]
    fn tmux_query_error_is_not_treated_as_empty_live_window_set() {
        let (session, topology) = topology_with_running_session("@1");
        let live_windows = LiveWindows(Err("tmux list-windows failed".to_owned()));

        assert!(
            live_windows.session_is_live(&session, &topology),
            "could-not-query falls back to durable live status rather than declaring dead"
        );
        assert!(
            !live_windows.session_is_restorable(&session, &topology),
            "could-not-query must not make a running session look restorable"
        );
    }

    #[test]
    fn empty_successful_live_window_set_marks_running_session_gone() {
        let (session, topology) = topology_with_running_session("@1");
        let live_windows = LiveWindows(Ok(BTreeSet::new()));

        assert!(
            !live_windows.session_is_live(&session, &topology),
            "an empty successful tmux query proves the window is gone"
        );
        assert!(
            live_windows.session_is_restorable(&session, &topology),
            "a running row with a verified-missing window can be restored"
        );
    }
}
