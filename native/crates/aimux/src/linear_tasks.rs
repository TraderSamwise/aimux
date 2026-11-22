//! Linear issues, in the task shape every Aimux surface already renders.
//!
//! Requirement 4 is the reason this exists: "see real time if tasks are being
//! worked on and by who". The answer lives in Linear once it owns tasks, so
//! something has to turn an issue into the shape the TUI, the app and the CLI
//! already know how to show -- mapping ONCE here rather than teaching each
//! surface about Linear, which is the "One Answer, Many Surfaces" rule.

use serde_json::{Map, Value};

/// Translate Linear's state TYPE into the local status vocabulary.
///
/// Linear's type is a closed set and is the right thing to key on: a workspace
/// can rename "In Progress" to anything, but its type stays `started`. Keying
/// on the display NAME would break the moment somebody renamed a column.
///
/// `None` is deliberate and is not "pending". An unrecognised type means
/// Linear's own vocabulary moved, and guessing `pending` would report work as
/// not-started when it may well be finished -- a confident wrong answer about
/// the one thing a person is asking.
pub fn local_status_for_linear_state(state_type: &str) -> Option<&'static str> {
    match state_type {
        // Nothing has picked it up. Triage is lumped in here because, to
        // somebody asking whether work is happening, it is not.
        "triage" | "backlog" | "unstarted" => Some("pending"),
        // Somebody is on it. `accepted` is the local word for that.
        "started" => Some("accepted"),
        "completed" => Some("completed"),
        "canceled" => Some("canceled"),
        _ => None,
    }
}

/// The Linear state TYPE that expresses one local status.
///
/// The inverse of `local_status_for_linear_state`, and gated AGAINST it rather
/// than written independently -- two hand-written tables for one relationship
/// is how a read and a write start disagreeing about what `accepted` means.
///
/// `None` for a status Linear cannot express. `blocked` is the real case:
/// Linear has no state type for it, so a move to `blocked` is refused rather
/// than silently landing the issue somewhere else.
pub fn linear_state_type_for_local_status(status: &str) -> Option<&'static str> {
    match status {
        // `unstarted` rather than `backlog`, because an aimux task that is
        // pending has been CREATED and is waiting -- which is the todo column,
        // not the backlog somebody has not triaged yet.
        "pending" => Some("unstarted"),
        "accepted" => Some("started"),
        "completed" => Some("completed"),
        "canceled" => Some("canceled"),
        _ => None,
    }
}

/// Why there is no `blocked` above.
///
/// The local engine has a `blocked` status and Linear has no state TYPE for
/// it -- blocking is expressed with issue relations and labels instead. So a
/// blocked Linear issue arrives as `started` or `unstarted` like any other,
/// and inventing a mapping would report a blockage that Linear never said
/// existed. Reading relations is a bigger job and belongs with whatever first
/// needs it.
pub const LINEAR_HAS_NO_BLOCKED_STATE: &str =
    "Linear expresses blocking with relations rather than a state type";

/// One Linear issue, as a task.
///
/// `Err` is for an issue we cannot describe at all. Anything merely ABSENT --
/// no assignee, no state -- is reported as absent, because an unassigned issue
/// is a real and common answer while an issue with no identity is a protocol
/// change.
pub fn task_from_linear_issue(issue: &Value) -> Result<Value, String> {
    // Read FIRST so both refusals below can name the issue. The human-facing
    // key, like AIM-12, is carried because it is how a person finds the thing
    // in Linear, and a UUID is not -- which also makes it the only useful
    // thing to put in an error about a malformed row.
    let identifier = issue.get("identifier").and_then(Value::as_str);
    let id = issue
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| match identifier {
            Some(identifier) => format!("Linear issue {identifier} arrived with no id"),
            None => "a Linear issue arrived with neither an id nor an identifier".to_owned(),
        })?;
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| {
            format!(
                "Linear issue {} arrived with no title",
                identifier.unwrap_or(id)
            )
        })?;

    let state_type = issue
        .get("state")
        .and_then(|state| state.get("type"))
        .and_then(Value::as_str);

    let mut task = Map::new();
    task.insert("id".to_owned(), Value::String(id.to_owned()));
    if let Some(identifier) = identifier {
        task.insert(
            "identifier".to_owned(),
            Value::String(identifier.to_owned()),
        );
    }
    task.insert("description".to_owned(), Value::String(title.to_owned()));
    // Named so a surface can say where this came from without guessing from
    // the id's shape.
    task.insert("source".to_owned(), Value::String("linear".to_owned()));

    match state_type.map(local_status_for_linear_state) {
        Some(Some(status)) => {
            task.insert("status".to_owned(), Value::String(status.to_owned()));
        }
        // Recognised as PRESENT but not as anything we know. Both facts are
        // reported: no status, plus the word Linear used, so the surface says
        // "unknown" rather than painting it as pending.
        Some(None) => {
            task.insert(
                "statusUnknown".to_owned(),
                Value::String(state_type.unwrap_or_default().to_owned()),
            );
        }
        // Linear did not send a state at all.
        None => {
            task.insert("statusUnknown".to_owned(), Value::String(String::new()));
        }
    }

    // The display name of the state, when there is one -- useful because a
    // workspace's own word ("In Review") says more than `accepted`.
    if let Some(name) = issue
        .get("state")
        .and_then(|state| state.get("name"))
        .and_then(Value::as_str)
    {
        task.insert("stateName".to_owned(), Value::String(name.to_owned()));
    }

    // Absent is a real answer here: plenty of issues have nobody on them, and
    // that is exactly what "see who is working on what" needs to show.
    if let Some(assignee) = issue
        .get("assignee")
        .and_then(|assignee| assignee.get("name"))
        .and_then(Value::as_str)
    {
        task.insert("assignee".to_owned(), Value::String(assignee.to_owned()));
    }
    if let Some(updated) = issue.get("updatedAt").and_then(Value::as_str) {
        task.insert("updatedAt".to_owned(), Value::String(updated.to_owned()));
    }
    Ok(Value::Object(task))
}

/// Every issue in a `project_issues_query` answer, as tasks.
///
/// A malformed issue does NOT discard the rest: it is reported beside them.
/// Dropping it silently would under-report the project, and failing the whole
/// read would hide every healthy task behind one bad row -- the same reasoning
/// as keeping a failed machine in the fleet report.
pub fn tasks_from_linear_data(data: &Value) -> (Vec<Value>, Vec<String>) {
    let mut tasks = Vec::new();
    let mut problems = Vec::new();
    let nodes = data
        .get("issues")
        .and_then(|issues| issues.get("nodes"))
        .and_then(Value::as_array);
    let Some(nodes) = nodes else {
        problems.push("Linear's answer carried no issues list".to_owned());
        return (tasks, problems);
    };
    for node in nodes {
        match task_from_linear_issue(node) {
            Ok(task) => tasks.push(task),
            Err(problem) => problems.push(problem),
        }
    }
    (tasks, problems)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn issue(state_type: &str, assignee: Option<&str>) -> Value {
        let mut node = json!({
            "id": "uuid-1",
            "identifier": "AIM-12",
            "title": "Ship the fleet control plane",
            "state": { "name": "In Progress", "type": state_type },
            "updatedAt": "2026-11-21T10:00:00.000Z",
        });
        if let Some(assignee) = assignee {
            node["assignee"] = json!({ "name": assignee });
        }
        node
    }

    /// THE TWO DIRECTIONS MUST AGREE. Every local status the write direction
    /// can express must map back to that same status when read, or an agent
    /// that marks a task `accepted` sees something else on the next read.
    #[test]
    fn the_write_mapping_round_trips_through_the_read_mapping() {
        for status in ["pending", "accepted", "completed", "canceled"] {
            let state_type = linear_state_type_for_local_status(status)
                .unwrap_or_else(|| panic!("{status} must be expressible"));
            assert_eq!(
                local_status_for_linear_state(state_type),
                Some(status),
                "{status} -> {state_type} -> something else"
            );
        }
    }

    /// `blocked` is the status Linear cannot express, and it is REFUSED rather
    /// than landed somewhere else. Mapping it to any state would report a
    /// blockage Linear never recorded.
    #[test]
    fn blocked_cannot_be_expressed_as_a_linear_state() {
        assert_eq!(linear_state_type_for_local_status("blocked"), None);
        assert_eq!(linear_state_type_for_local_status("somethingElse"), None);
    }

    /// Pending goes to the TODO column, not the backlog: an aimux task that is
    /// pending has been created and is waiting, which is not the same as an
    /// untriaged backlog item.
    #[test]
    fn pending_lands_in_the_todo_column_rather_than_the_backlog() {
        assert_eq!(
            linear_state_type_for_local_status("pending"),
            Some("unstarted")
        );
    }

    /// Keyed on the TYPE, never the display name, because a workspace can
    /// rename any column and its type stays put.
    #[test]
    fn linear_state_types_map_onto_the_local_vocabulary() {
        assert_eq!(local_status_for_linear_state("triage"), Some("pending"));
        assert_eq!(local_status_for_linear_state("backlog"), Some("pending"));
        assert_eq!(local_status_for_linear_state("unstarted"), Some("pending"));
        assert_eq!(local_status_for_linear_state("started"), Some("accepted"));
        assert_eq!(
            local_status_for_linear_state("completed"),
            Some("completed")
        );
        assert_eq!(local_status_for_linear_state("canceled"), Some("canceled"));
    }

    /// THE GATE THIS MODULE TURNS ON. An unrecognised state must not become
    /// `pending`: that reports work as not-started when it may be finished,
    /// which is a confident wrong answer about the exact thing somebody is
    /// asking. It also must not be silently dropped.
    #[test]
    fn an_unrecognised_state_is_never_quietly_pending() {
        assert_eq!(local_status_for_linear_state("somethingNew"), None);

        let task = task_from_linear_issue(&issue("somethingNew", None)).expect("still a task");
        assert!(
            task.get("status").is_none(),
            "an unknown state was given a status: {task}"
        );
        assert_eq!(
            task["statusUnknown"],
            json!("somethingNew"),
            "the unknown state must be named, not swallowed"
        );
    }

    /// And a state Linear did not send at all is also unknown rather than
    /// pending -- absent and unrecognised are both "we cannot say".
    #[test]
    fn a_missing_state_is_unknown_rather_than_pending() {
        let mut node = issue("started", None);
        node.as_object_mut().expect("an object").remove("state");
        let task = task_from_linear_issue(&node).expect("still a task");
        assert!(task.get("status").is_none(), "{task}");
        assert_eq!(task["statusUnknown"], json!(""));
    }

    #[test]
    fn a_started_issue_reads_as_accepted_and_names_who_has_it() {
        let task = task_from_linear_issue(&issue("started", Some("Sam S."))).expect("a task");
        assert_eq!(task["status"], json!("accepted"));
        assert_eq!(task["assignee"], json!("Sam S."));
        assert_eq!(task["identifier"], json!("AIM-12"));
        assert_eq!(task["source"], json!("linear"));
        // The workspace's own word for the column, which says more than
        // `accepted` does.
        assert_eq!(task["stateName"], json!("In Progress"));
    }

    /// Nobody assigned is a REAL answer, not a failure -- and it is precisely
    /// what "see who is working on what" has to be able to show.
    #[test]
    fn an_unassigned_issue_is_a_task_with_no_assignee() {
        let task = task_from_linear_issue(&issue("unstarted", None)).expect("a task");
        assert_eq!(task["status"], json!("pending"));
        assert!(
            task.get("assignee").is_none(),
            "an unassigned issue invented an assignee: {task}"
        );
    }

    /// An issue with no identity cannot be described, and that is the one case
    /// that fails. The message names the issue so somebody can go and look.
    #[test]
    fn an_issue_with_no_identity_is_refused_and_says_which() {
        let no_id = json!({ "title": "x", "state": { "type": "started" } });
        assert!(task_from_linear_issue(&no_id).is_err());

        let no_title = json!({ "id": "uuid-9", "identifier": "AIM-99" });
        let error = task_from_linear_issue(&no_title).expect_err("no title is refused");
        assert!(
            error.contains("AIM-99"),
            "the refusal did not name the issue: {error}"
        );
    }

    /// ONE BAD ROW MUST NOT HIDE THE HEALTHY ONES, and must not vanish either.
    /// Same reasoning as keeping a failed machine in the fleet report: the
    /// surface needs both the work and the fact that something is wrong.
    #[test]
    fn a_malformed_issue_is_reported_beside_the_good_ones() {
        let data = json!({
            "issues": { "nodes": [
                issue("started", Some("Sam S.")),
                json!({ "identifier": "AIM-13" }),
                issue("completed", None),
            ]}
        });
        let (tasks, problems) = tasks_from_linear_data(&data);
        assert_eq!(tasks.len(), 2, "a bad row discarded the good ones");
        assert_eq!(problems.len(), 1, "the bad row vanished: {problems:?}");
        assert!(problems[0].contains("AIM-13"), "{problems:?}");
    }

    /// An empty project SUCCEEDED with nothing. No problems, no tasks.
    #[test]
    fn a_project_with_no_issues_is_empty_rather_than_broken() {
        let (tasks, problems) = tasks_from_linear_data(&json!({ "issues": { "nodes": [] } }));
        assert!(tasks.is_empty());
        assert!(
            problems.is_empty(),
            "an empty project reported a problem: {problems:?}"
        );
    }

    /// No issues list at all is NOT an empty project -- it means the answer
    /// was not the shape we asked for, and saying "no tasks" would read as a
    /// project nobody is working on.
    #[test]
    fn a_missing_issues_list_is_a_problem_not_an_empty_project() {
        let (tasks, problems) = tasks_from_linear_data(&json!({}));
        assert!(tasks.is_empty());
        assert_eq!(problems.len(), 1, "{problems:?}");
    }
}
