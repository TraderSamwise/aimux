//! The typed classification and the JSON one, held against each other.
//!
//! The dashboard asks whether a session is a control agent about eight times a
//! frame per session, and again per group across the nine grouping builds a
//! repaint makes. It used to answer by serialising the typed row into a
//! `serde_json::Map` -- the whole `team` object included -- and handing that to
//! `agent_lane`, which built a second `json!`. Two allocations per session per
//! ask, for six fields that were already sitting on the row.
//!
//! So the dashboard now reads those six fields straight off the row. The risk
//! that buys is the one AGENTS.md "One Answer, Many Surfaces" names: a second
//! copy of the rule that agrees today and drifts later. The rule did not move
//! -- `team_contract` still owns it and only gained a second input shape -- but
//! the REDUCTION did: `is_in_supervisor_plane` is `agent_lane(..).kind ==
//! "supervisor"` rewritten as the question it actually asks, and a rewrite is
//! exactly the kind of thing that is right for every input somebody thought of.
//!
//! Hence this file compares the two over every shape of input rather than
//! testing either alone. `session_is_in_supervisor_plane` is UNTOUCHED and
//! still goes through `agent_lane`, so the comparison is against the original
//! implementation and not against a restatement of the new one.
//!
//! Prove-failed on 2026-10-28 by dropping the path guard from the
//! pathless-worktree arm of `is_in_supervisor_plane`, so it read
//! `Some("worktree") => return false`. Both tests here failed, and the
//! agreement one named the input: `lane=worktree-pathless control=unset
//! overseer=unset scribe=unset role=role-overseer: the row says false and
//! agent_lane says true`. That is the case a reduction is most likely to get
//! wrong and the least likely to be noticed -- an overseer whose stored lane
//! lost its path drops out of the supervisor plane.

use aimux::dashboard_model::{DASHBOARD_CLASSIFIER_PROBES, DashboardSession};
use aimux::project_service::session_visibility::session_is_in_supervisor_plane;
use aimux::team_contract::{AgentControlFacts, is_overseer, is_project_control, is_scribe};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

/// Every lane a stored record can carry, including the ones that are not a
/// lane at all.
///
/// The pathless and blank-path worktree lanes are the interesting rows:
/// `stored_agent_lane` declines to honour a worktree plane with no identity, so
/// those fall through to the control question instead of settling it. A
/// reduction that treated any `kind: "worktree"` as "not supervisor" passes
/// every other case in this file.
fn lanes() -> Vec<(&'static str, Option<Value>)> {
    vec![
        ("absent", None),
        ("supervisor", Some(json!({ "kind": "supervisor" }))),
        ("supervisor-padded", Some(json!({ "kind": " supervisor " }))),
        (
            "worktree-with-path",
            Some(json!({ "kind": "worktree", "worktreePath": "/w" })),
        ),
        ("worktree-pathless", Some(json!({ "kind": "worktree" }))),
        (
            "worktree-blank-path",
            Some(json!({ "kind": "worktree", "worktreePath": "   " })),
        ),
        ("unrecognised-kind", Some(json!({ "kind": "mezzanine" }))),
        ("kindless", Some(json!({ "note": "no kind here" }))),
        ("not-an-object", Some(json!("supervisor"))),
    ]
}

/// Where a role can come from, including the two spellings that are no role.
fn roles() -> Vec<(&'static str, Option<&'static str>, Option<&'static str>)> {
    vec![
        ("no-role", None, None),
        ("role-overseer", Some("overseer"), None),
        ("role-scribe", Some("scribe"), None),
        ("role-coder", Some("coder"), None),
        ("role-blank", Some("   "), None),
        ("team-role-overseer", None, Some("overseer")),
        ("team-role-scribe", None, Some("scribe")),
        ("team-role-coder", None, Some("coder")),
        ("role-wins-over-team", Some("coder"), Some("overseer")),
    ]
}

fn flags() -> Vec<(&'static str, Option<bool>)> {
    vec![
        ("unset", None),
        ("true", Some(true)),
        ("false", Some(false)),
    ]
}

fn record(
    lane: &Option<Value>,
    control: Option<bool>,
    overseer: Option<bool>,
    scribe: Option<bool>,
    role: Option<&str>,
    team_role: Option<&str>,
) -> Value {
    let mut session = json!({
        "index": 0,
        "id": "codex-1",
        "command": "codex",
        "status": "running",
        "active": true,
    });
    let map = session.as_object_mut().expect("a session object");
    if let Some(lane) = lane {
        map.insert("lane".into(), lane.clone());
    }
    if let Some(control) = control {
        map.insert("projectControl".into(), Value::Bool(control));
    }
    if let Some(overseer) = overseer {
        map.insert("overseer".into(), Value::Bool(overseer));
    }
    if let Some(scribe) = scribe {
        map.insert("scribe".into(), Value::Bool(scribe));
    }
    if let Some(role) = role {
        map.insert("role".into(), Value::String(role.to_owned()));
    }
    if let Some(team_role) = team_role {
        map.insert("team".into(), json!({ "role": team_role }));
    }
    session
}

/// The dashboard's typed answer equals `agent_lane`'s, for every input.
#[test]
fn the_typed_classification_agrees_with_the_lane_it_replaced() {
    let mut cases = 0usize;
    let mut supervisors = 0usize;
    for (lane_name, lane) in lanes() {
        for (control_name, control) in flags() {
            for (overseer_name, overseer) in flags() {
                for (scribe_name, scribe) in flags() {
                    for (role_name, role, team_role) in roles() {
                        let session = record(&lane, control, overseer, scribe, role, team_role);
                        let typed: DashboardSession = serde_json::from_value(session.clone())
                            .expect("the record deserialises into a row");

                        let through_lane = session_is_in_supervisor_plane(&session);
                        let through_fields =
                            aimux::dashboard_model::is_dashboard_supervisor_plane_session(&typed);

                        assert_eq!(
                            through_fields, through_lane,
                            "lane={lane_name} control={control_name} \
                             overseer={overseer_name} scribe={scribe_name} \
                             role={role_name}: the row says {through_fields} and \
                             agent_lane says {through_lane}"
                        );
                        cases += 1;
                        if through_lane {
                            supervisors += 1;
                        }
                    }
                }
            }
        }
    }

    println!("{cases} inputs compared, {supervisors} of them in the supervisor plane");
    // Both answers appear, so neither side is being agreed with vacuously by a
    // matrix that only ever produces one verdict.
    // 9 lanes x 3 x 3 x 3 flags x 9 role shapes. A floor rather than an
    // equality so adding a case is free, but deleting the matrix is not.
    assert!(cases >= 2_187, "the matrix shrank to {cases} cases");
    assert!(
        supervisors > 0 && supervisors < cases,
        "{supervisors}/{cases} in the plane: this matrix proves nothing"
    );
}

/// And the typed answer costs no serialisation.
///
/// The counter is process-global and `cargo test` runs a file's tests as
/// concurrent threads, so this is the only test in this file that reads it --
/// a sibling calling the typed path would not move it, but one calling the JSON
/// path would, and the delta is the whole claim.
#[test]
fn asking_the_row_does_not_serialise_the_row() {
    let session = record(
        &Some(json!({ "kind": "worktree" })),
        None,
        None,
        None,
        Some("overseer"),
        Some("overseer"),
    );
    let typed: DashboardSession =
        serde_json::from_value(session).expect("the record deserialises into a row");

    let before = DASHBOARD_CLASSIFIER_PROBES.load(Ordering::Relaxed);
    for _ in 0..1_000 {
        assert!(aimux::dashboard_model::is_dashboard_supervisor_plane_session(&typed));
    }
    let probes = DASHBOARD_CLASSIFIER_PROBES.load(Ordering::Relaxed) - before;

    assert_eq!(
        probes, 0,
        "a thousand classifications built {probes} JSON probes; the dashboard is \
         serialising rows again, which is the cost this change removed"
    );
}

/// The control predicate as it read BEFORE this change, transcribed.
///
/// Why this exists: the agreement test above compares against `agent_lane`,
/// which is untouched -- but `agent_lane` asks `is_project_control_session`,
/// and that now delegates to the new code. So that comparison is independent
/// for the LANE logic and shared for the control predicate, and on its own it
/// could not see a change in meaning inside `is_project_control`.
///
/// This closes that half. It is a literal transcription of the three functions
/// as they were, kept deliberately dumb -- nested ifs, no helpers, no reuse of
/// anything under test -- so that agreeing with it means something. If the
/// contract is ever meant to CHANGE, this is the function to change first and
/// on purpose; a diff that edits it is a diff that is changing who counts as a
/// control agent.
/// The record as the dashboard holds it.
fn typed_row(session: &Value) -> DashboardSession {
    serde_json::from_value(session.clone()).expect("the record deserialises into a row")
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn original_legacy_role(session: &Value) -> Option<&str> {
    trimmed(session.get("role").and_then(Value::as_str)).or_else(|| {
        trimmed(
            session
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str),
        )
    })
}

fn original_flag(session: &Value, key: &str) -> Option<bool> {
    session.get(key).and_then(Value::as_bool)
}

fn original_is_overseer(session: &Value) -> bool {
    if let Some(value) = original_flag(session, "overseer") {
        return value;
    }
    if original_flag(session, "projectControl") == Some(false) {
        return false;
    }
    original_legacy_role(session) == Some("overseer")
}

fn original_is_scribe(session: &Value) -> bool {
    if let Some(value) = original_flag(session, "scribe") {
        return value;
    }
    if original_flag(session, "projectControl") == Some(false) {
        return false;
    }
    original_legacy_role(session) == Some("scribe")
}

fn original_is_project_control(session: &Value) -> bool {
    match original_flag(session, "projectControl") {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    original_is_overseer(session) || original_is_scribe(session)
}

/// None of the three control predicates changed meaning when they moved
/// behind `AgentControlFacts`.
#[test]
fn the_control_predicates_still_mean_what_they_meant() {
    let mut cases = 0usize;
    let mut control = 0usize;
    for (lane_name, lane) in lanes() {
        for (control_name, control_flag) in flags() {
            for (overseer_name, overseer) in flags() {
                for (scribe_name, scribe) in flags() {
                    for (role_name, role, team_role) in roles() {
                        let session =
                            record(&lane, control_flag, overseer, scribe, role, team_role);
                        let facts = AgentControlFacts::from_record(&session);
                        // All THREE, not just the composite. `is_project_control`
                        // returns on `projectControl: false` before it ever asks
                        // the other two, so comparing only the composite leaves
                        // the short-circuit INSIDE each of them unreachable --
                        // and `is_overseer_session` / `is_scribe_session` are
                        // called directly elsewhere, where it is live. Deleting
                        // that line passed an earlier version of this test.
                        for (name, after, before) in [
                            (
                                "project_control",
                                is_project_control(&facts),
                                original_is_project_control(&session),
                            ),
                            (
                                "overseer",
                                is_overseer(&facts),
                                original_is_overseer(&session),
                            ),
                            ("scribe", is_scribe(&facts), original_is_scribe(&session)),
                            // The typed row's own answers, not just the
                            // record's. `is_project_control` is `is_overseer ||
                            // is_scribe`, so swapping the `overseer:` and
                            // `scribe:` fields in
                            // `dashboard_session_control_facts` would leave the
                            // composite identical and flip both public helpers.
                            // Two reviewers found the matrix could not tell
                            // them apart.
                            (
                                "row-overseer",
                                aimux::dashboard_model::is_dashboard_overseer_session(&typed_row(
                                    &session,
                                )),
                                original_is_overseer(&session),
                            ),
                            (
                                "row-scribe",
                                aimux::dashboard_model::is_dashboard_scribe_session(&typed_row(
                                    &session,
                                )),
                                original_is_scribe(&session),
                            ),
                        ] {
                            assert_eq!(
                                after, before,
                                "{name}: lane={lane_name} control={control_name} \
                                 overseer={overseer_name} scribe={scribe_name} \
                                 role={role_name}: facts say {after}, the original \
                                 said {before}"
                            );
                        }
                        cases += 1;
                        if original_is_project_control(&session) {
                            control += 1;
                        }
                    }
                }
            }
        }
    }
    println!("{cases} inputs compared, {control} of them control agents");
    assert!(cases >= 2_187, "the matrix shrank to {cases} cases");
    assert!(
        control > 0 && control < cases,
        "{control}/{cases} control: this matrix proves nothing"
    );
}
