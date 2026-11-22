//! The Linear issues dialog: what is being worked on, and by whom.
//!
//! Phase 6's TUI half. The app got this first because a phone is where Sam
//! asked to see it; this is the same answer for somebody already in a
//! terminal, reading the same daemon route.
//!
//! FETCHED ON OPEN, NEVER ON A TICK, and that is the design decision worth
//! defending. A Linear read on the dashboard's refresh cadence would have
//! every open dashboard polling Linear's API continuously -- the churn class
//! `docs/` warns about, plus a rate limit nobody would see coming. The dialog
//! costs nothing until somebody asks for it.

/// What the dialog is looking at.
///
/// The three outcomes are the ones the route distinguishes, and they are kept
/// apart here for the same reason: "nothing to ask" and "asked and failed" are
/// different facts, and an empty project is a third. Collapsing any pair would
/// show "no tasks" to somebody whose Linear is simply unreachable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardLinearOverlayState {
    /// The read is in flight. Said out loud, because a blank dialog reads as
    /// an empty project.
    Loading,
    /// Nothing was asked, and this is why -- no project configured, or no
    /// token.
    NotAsked { reason: String },
    /// Linear was asked and the ask failed.
    Failed { reason: String },
    /// Linear answered. `tasks` may legitimately be empty.
    Tasks {
        project: String,
        tasks: Vec<DashboardLinearTask>,
        /// Issues the service could not describe. Shown, never dropped.
        problems: Vec<String>,
    },
}

/// One task, reduced to what a line needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardLinearTask {
    pub key: String,
    pub title: String,
    /// The local status word, when the service recognised the Linear state.
    pub status: Option<String>,
    /// Linear's own word, when it did not. Never both.
    pub unknown_status: Option<String>,
    pub assignee: Option<String>,
}

/// What a key in the dialog asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardLinearOverlayAction {
    Close,
    /// Ask again. The dialog does not poll, so a refresh has to be asked for.
    Refresh,
}

/// Which keys the dialog answers.
pub fn linear_overlay_key(key: char) -> Option<DashboardLinearOverlayAction> {
    match key {
        'q' | 'Q' => Some(DashboardLinearOverlayAction::Close),
        'r' | 'R' => Some(DashboardLinearOverlayAction::Refresh),
        _ => None,
    }
}

/// Read the daemon's `linear tasks` report into the dialog's state.
///
/// Keys on `checked` exactly as the app's view does, because that is the field
/// the service sets to separate "did not look" from "looked and failed".
pub fn linear_overlay_from_report(report: &serde_json::Value) -> DashboardLinearOverlayState {
    let checked = report.get("checked").and_then(serde_json::Value::as_bool) == Some(true);
    if !checked {
        return DashboardLinearOverlayState::NotAsked {
            reason: report
                .get("reason")
                .or_else(|| report.get("error"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Linear was not asked.")
                .to_owned(),
        };
    }
    let Some(nodes) = report.get("tasks").and_then(serde_json::Value::as_array) else {
        // Asked, and the whole ask failed. A per-issue problem is NOT this:
        // those arrive beside real tasks.
        return DashboardLinearOverlayState::Failed {
            reason: report
                .get("error")
                .or_else(|| report.get("reason"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Linear could not be read.")
                .to_owned(),
        };
    };
    DashboardLinearOverlayState::Tasks {
        project: report
            .get("project")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Linear")
            .to_owned(),
        tasks: nodes
            .iter()
            .map(|node| {
                let string = |key: &str| {
                    node.get(key)
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                };
                DashboardLinearTask {
                    key: string("identifier")
                        .or_else(|| string("id"))
                        .unwrap_or_else(|| "?".to_owned()),
                    title: string("description").unwrap_or_else(|| "(no title)".to_owned()),
                    status: string("status"),
                    // Present-but-empty means Linear sent no state at all,
                    // which is still unknown rather than absent -- so the
                    // key's presence is what matters, not its content.
                    unknown_status: node
                        .get("statusUnknown")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    assignee: string("assignee"),
                }
            })
            .collect(),
        problems: report
            .get("problems")
            .and_then(serde_json::Value::as_array)
            .map(|problems| {
                problems
                    .iter()
                    .filter_map(|problem| problem.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The status to show for one task.
///
/// Mirrors the service's rule rather than re-deriving it: an unrecognised
/// Linear state is SAID, never shown as `pending` and never left blank. A
/// blank reads as "nothing yet", which is the one thing it does not mean.
pub fn task_status_label(task: &DashboardLinearTask) -> String {
    if let Some(status) = task.status.as_deref().filter(|status| !status.is_empty()) {
        return status.to_owned();
    }
    match task.unknown_status.as_deref() {
        Some("") | None => "state unknown".to_owned(),
        Some(other) => format!("state unknown ({other})"),
    }
}

/// How many tasks somebody is actively working.
///
/// `in_progress` only -- the word `route_task_accept` writes and the one the
/// Linear read maps `started` onto. Counting `pending` too would answer a
/// different question than "is anything being worked on".
pub fn active_task_count(tasks: &[DashboardLinearTask]) -> usize {
    tasks
        .iter()
        .filter(|task| task.status.as_deref() == Some("in_progress"))
        .count()
}

/// The dialog, as lines.
pub fn render_linear_overlay(state: &DashboardLinearOverlayState) -> Vec<String> {
    let mut lines = Vec::new();
    match state {
        DashboardLinearOverlayState::Loading => {
            lines.push("Linear".to_owned());
            lines.push("Reading the project's issues...".to_owned());
        }
        DashboardLinearOverlayState::NotAsked { reason } => {
            lines.push("Linear".to_owned());
            lines.push(reason.clone());
        }
        DashboardLinearOverlayState::Failed { reason } => {
            lines.push("Linear".to_owned());
            lines.push(reason.clone());
            lines.push("r refresh   q close".to_owned());
        }
        DashboardLinearOverlayState::Tasks {
            project,
            tasks,
            problems,
        } => {
            lines.push(format!(
                "Linear — {project}   {} being worked",
                active_task_count(tasks)
            ));
            if tasks.is_empty() && problems.is_empty() {
                lines.push("No issues in this Linear project.".to_owned());
            }
            for task in tasks {
                let who = task.assignee.as_deref().unwrap_or("unassigned");
                lines.push(format!(
                    "{}  {}  {who}  {}",
                    task.key,
                    task_status_label(task),
                    task.title
                ));
            }
            // Shown, not dropped: hiding them would under-report the project
            // while the dialog looked complete.
            for problem in problems {
                lines.push(format!("problem: {problem}"));
            }
            lines.push("r refresh   q close".to_owned());
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task(key: &str, status: Option<&str>, assignee: Option<&str>) -> DashboardLinearTask {
        DashboardLinearTask {
            key: key.to_owned(),
            title: "Ship the plane".to_owned(),
            status: status.map(str::to_owned),
            unknown_status: None,
            assignee: assignee.map(str::to_owned),
        }
    }

    /// THE DISTINCTION THE DIALOG EXISTS FOR, and the same one the app's view
    /// keys on: `checked` separates "did not look" from "looked and failed",
    /// and an empty project is a third answer. Collapsing any pair shows "no
    /// tasks" to somebody whose Linear is simply unreachable.
    #[test]
    fn not_asked_failed_and_empty_are_three_states() {
        let not_asked = linear_overlay_from_report(&json!({
            "ok": false, "checked": false, "reason": "No Linear project is configured."
        }));
        assert_eq!(
            not_asked,
            DashboardLinearOverlayState::NotAsked {
                reason: "No Linear project is configured.".to_owned()
            }
        );

        let failed = linear_overlay_from_report(&json!({
            "ok": false, "checked": true, "error": "Linear returned 503"
        }));
        assert_eq!(
            failed,
            DashboardLinearOverlayState::Failed {
                reason: "Linear returned 503".to_owned()
            }
        );

        let empty = linear_overlay_from_report(&json!({
            "ok": true, "checked": true, "project": "Aimux", "tasks": []
        }));
        assert_eq!(
            empty,
            DashboardLinearOverlayState::Tasks {
                project: "Aimux".to_owned(),
                tasks: Vec::new(),
                problems: Vec::new(),
            }
        );
    }

    #[test]
    fn each_state_explains_itself_rather_than_rendering_blank() {
        for state in [
            DashboardLinearOverlayState::Loading,
            DashboardLinearOverlayState::NotAsked {
                reason: "nothing configured".to_owned(),
            },
            DashboardLinearOverlayState::Failed {
                reason: "503".to_owned(),
            },
            DashboardLinearOverlayState::Tasks {
                project: "Aimux".to_owned(),
                tasks: Vec::new(),
                problems: Vec::new(),
            },
        ] {
            let lines = render_linear_overlay(&state);
            assert!(lines.len() >= 2, "{state:?} rendered {lines:?}");
            assert!(
                lines.iter().all(|line| !line.is_empty()),
                "{state:?} rendered an empty line: {lines:?}"
            );
        }
    }

    /// A per-issue problem is NOT a failed ask: the tasks are still shown, and
    /// the problem beside them.
    #[test]
    fn a_problem_does_not_hide_the_tasks() {
        let state = linear_overlay_from_report(&json!({
            "ok": false,
            "checked": true,
            "project": "Aimux",
            "tasks": [{ "identifier": "AIM-1", "description": "Real", "status": "pending" }],
            "problems": ["Linear issue AIM-2 arrived with no title"],
        }));
        let lines = render_linear_overlay(&state);
        assert!(lines.iter().any(|line| line.contains("AIM-1")), "{lines:?}");
        assert!(
            lines.iter().any(|line| line.starts_with("problem:")),
            "{lines:?}"
        );
    }

    /// THE RENDERER'S HALF OF THE UNKNOWN-STATE RULE. The service refuses to
    /// guess `pending`; a blank here would read as "nothing yet", which is the
    /// one thing an unrecognised state does not mean.
    #[test]
    fn an_unknown_state_is_said_and_never_shown_as_pending() {
        let named = DashboardLinearTask {
            unknown_status: Some("somethingNew".to_owned()),
            status: None,
            ..task("AIM-3", None, None)
        };
        let label = task_status_label(&named);
        assert!(label.contains("state unknown"), "{label}");
        assert!(label.contains("somethingNew"), "{label}");
        assert!(!label.contains("pending"), "{label}");

        // Linear sent no state at all: still said, just unnamed.
        let absent = DashboardLinearTask {
            unknown_status: Some(String::new()),
            status: None,
            ..task("AIM-4", None, None)
        };
        assert_eq!(task_status_label(&absent), "state unknown");

        // And a real status is shown as itself.
        assert_eq!(
            task_status_label(&task("AIM-5", Some("done"), None)),
            "done"
        );
    }

    /// `in_progress`, which is the word the task routes write. Counting
    /// `accepted` here would be the defect #646 fixed in the app, repeated.
    #[test]
    fn only_in_progress_counts_as_being_worked() {
        let tasks = vec![
            task("a", Some("in_progress"), None),
            task("b", Some("in_progress"), None),
            task("c", Some("pending"), None),
            task("d", Some("done"), None),
            task("e", Some("accepted"), None),
        ];
        assert_eq!(active_task_count(&tasks), 2);
        assert_eq!(active_task_count(&[]), 0);
    }

    /// Unassigned is a REAL answer and is said, not left as a gap -- it is
    /// exactly what "see who is working on what" has to show.
    #[test]
    fn an_unassigned_task_says_so() {
        let state = DashboardLinearOverlayState::Tasks {
            project: "Aimux".to_owned(),
            tasks: vec![task("AIM-6", Some("pending"), None)],
            problems: Vec::new(),
        };
        let lines = render_linear_overlay(&state);
        assert!(
            lines.iter().any(|line| line.contains("unassigned")),
            "{lines:?}"
        );
    }

    /// The header carries the count, so the answer to "is anything happening"
    /// is visible without reading every row.
    #[test]
    fn the_header_names_the_project_and_the_count() {
        let state = DashboardLinearOverlayState::Tasks {
            project: "Aimux".to_owned(),
            tasks: vec![
                task("a", Some("in_progress"), Some("Sam S.")),
                task("b", Some("pending"), None),
            ],
            problems: Vec::new(),
        };
        let lines = render_linear_overlay(&state);
        assert!(lines[0].contains("Aimux"), "{lines:?}");
        assert!(lines[0].contains("1 being worked"), "{lines:?}");
    }

    /// The dialog does not poll, so refresh has to be a key. Anything else
    /// falls through to the dashboard rather than being swallowed.
    #[test]
    fn the_dialog_answers_close_and_refresh_and_nothing_else() {
        assert_eq!(
            linear_overlay_key('q'),
            Some(DashboardLinearOverlayAction::Close)
        );
        assert_eq!(
            linear_overlay_key('r'),
            Some(DashboardLinearOverlayAction::Refresh)
        );
        assert_eq!(
            linear_overlay_key('R'),
            Some(DashboardLinearOverlayAction::Refresh)
        );
        assert_eq!(linear_overlay_key('x'), None);
        assert_eq!(linear_overlay_key('I'), None);
    }

    /// A task with no identifier still gets a row. Dropping it would
    /// under-report the project, and the service already guarantees an id.
    #[test]
    fn a_task_with_no_identifier_falls_back_to_its_id() {
        let state = linear_overlay_from_report(&json!({
            "ok": true,
            "checked": true,
            "project": "Aimux",
            "tasks": [{ "id": "uuid-1", "description": "No key", "status": "pending" }],
        }));
        let DashboardLinearOverlayState::Tasks { tasks, .. } = &state else {
            panic!("expected tasks: {state:?}");
        };
        assert_eq!(tasks[0].key, "uuid-1");
    }
}
