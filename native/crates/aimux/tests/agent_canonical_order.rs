//! One order for every agent surface: class, then the tmux window position.
//!
//! The dashboard numbers agents [1]..[N], the footer chips render the same
//! agents, the supervisor lane renders the control sessions, and the GUI draws
//! all of it. Each of those used to sort independently — by createdAt
//! descending, by team order then createdAt *ascending*, by role display order,
//! and in the GUI by a different field again — so the dashboard read 1..5 while
//! the chips read roughly the reverse.
//!
//! The order is now the agent's class — overseer, then any other control role,
//! then scribe, then coder — and inside one class the position of its tmux
//! window, which is the order Sam already navigates with the prefix keys and
//! already sees in his own tmux session. Class leads because the supervisor
//! lane is read as a hierarchy: the overseer is the agent you look for first,
//! and a window index that happens to be lower should not put a scribe above
//! it. Recency never enters into it.
//!
//! An agent with no live window still sorts after every agent that has one,
//! whatever its class — an offline overseer belongs at the bottom with the
//! other offline agents, not at the top of the lane.

use aimux::team_contract::{
    agent_class, agent_class_rank, agent_role, compare_agent_canonical_order,
};
use serde_json::{Value, json};

fn windowed(id: &str, window_index: i64) -> Value {
    json!({
        "id": id,
        "tool": "claude",
        "tmuxWindowId": format!("@{window_index}"),
        "tmuxWindowIndex": window_index,
    })
}

fn windowless(id: &str, created_at: &str) -> Value {
    json!({ "id": id, "tool": "claude", "createdAt": created_at })
}

/// Shapes a session the way the project service stores each class, so the test
/// exercises the same fields `is_overseer_session`, `is_scribe_session` and
/// `is_project_control_session` read in production rather than a rank field
/// invented here.
fn as_class(mut session: Value, class: &str) -> Value {
    match class {
        "overseer" => {
            session["overseer"] = json!(true);
            session["projectControl"] = json!(true);
            session["team"] = json!({ "role": "overseer", "teamId": "overseer" });
            session["lane"] = json!({ "kind": "supervisor" });
        }
        "scribe" => {
            session["scribe"] = json!(true);
            session["projectControl"] = json!(true);
            session["team"] = json!({ "role": "scribe", "teamId": "scribe" });
            session["lane"] = json!({ "kind": "supervisor" });
        }
        "coder" => {}
        // Any other role a control session displays. `control` is the default
        // for a supervisor-target agent; `qa` is an arbitrary one, and both
        // must land in the same class without the ladder naming either.
        other => {
            session["projectControl"] = json!(true);
            session["role"] = json!(other);
            session["team"] = json!({ "role": other, "teamId": other });
            session["lane"] = json!({ "kind": "supervisor" });
        }
    }
    session
}

fn ordered(mut sessions: Vec<Value>) -> Vec<String> {
    sessions.sort_by(compare_agent_canonical_order);
    sessions
        .iter()
        .map(|session| session["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[test]
fn agents_order_by_tmux_window_position() {
    let order = ordered(vec![
        windowed("third", 7),
        windowed("first", 1),
        windowed("second", 4),
    ]);

    // Sparse indexes are expected: windows interleave across planes and leave
    // holes when agents close. The index is a sort key, never a block.
    assert_eq!(order, ["first", "second", "third"]);
}

/// The regression Sam reported: the dashboard and the footer chips rendered the
/// same five agents in near-opposite orders. Whatever order one surface
/// produces, the other must produce the same one, from any input order.
#[test]
fn the_dashboard_and_the_footer_chips_agree() {
    let agents = vec![
        windowed("6nenaq", 2),
        windowed("a88iz7", 4),
        windowed("7owt0o", 3),
        windowed("2jdcpa", 5),
        windowed("3yfqu7", 1),
    ];

    let dashboard = ordered(agents.clone());
    let mut reversed = agents;
    reversed.reverse();
    let chips = ordered(reversed);

    assert_eq!(dashboard, chips);
    assert_eq!(
        dashboard,
        ["3yfqu7", "6nenaq", "7owt0o", "a88iz7", "2jdcpa"]
    );
}

/// Sam's ladder, with every window index working against it: the overseer holds
/// the highest window and still leads, the coder holds the lowest and still
/// trails.
#[test]
fn the_class_ladder_is_overseer_control_scribe_coder() {
    let order = ordered(vec![
        as_class(windowed("coder", 1), "coder"),
        as_class(windowed("scribe", 2), "scribe"),
        as_class(windowed("control", 3), "control"),
        as_class(windowed("overseer", 4), "overseer"),
    ]);

    assert_eq!(order, ["overseer", "control", "scribe", "coder"]);
}

/// The ladder is a class ladder, not a list of spellings. A control session
/// displaying an arbitrary role sits in the same rung as one displaying
/// `control`, above a scribe and below an overseer.
#[test]
fn an_unnamed_control_role_shares_the_control_rung() {
    let order = ordered(vec![
        as_class(windowed("scribe", 1), "scribe"),
        as_class(windowed("qa", 2), "qa"),
        as_class(windowed("overseer", 3), "overseer"),
    ]);

    assert_eq!(order, ["overseer", "qa", "scribe"]);
}

/// This inverts what the order used to promise. The window position used to
/// decide outright, so an overseer in window 9 rendered below a scribe in
/// window 2 — the supervisor lane read upside down, which is the complaint.
#[test]
fn class_outranks_window_position_in_the_supervisor_lane() {
    let overseer = as_class(windowed("overseer", 9), "overseer");
    let scribe = as_class(windowed("scribe", 2), "scribe");

    assert_eq!(ordered(vec![scribe, overseer]), ["overseer", "scribe"]);
}

/// Class leads; it does not replace. Within one class the tmux window still
/// decides, so moving a window still moves the agent everywhere at once.
#[test]
fn window_position_still_decides_within_one_class() {
    let order = ordered(vec![
        as_class(windowed("later", 7), "coder"),
        as_class(windowed("earlier", 1), "coder"),
    ]);

    assert_eq!(order, ["earlier", "later"]);
}

/// "Of course offline agents still at the bottom." An offline overseer is the
/// top of the ladder and the bottom of the list; class only orders agents that
/// are both on the same side of that line.
#[test]
fn offline_agents_stay_last_whatever_their_class() {
    let order = ordered(vec![
        // The offline overseer is the NEWER of the two, so creation order
        // alone would put it last. Class has to be what lifts it, or this
        // proves nothing about the offline branch of the key.
        as_class(
            windowless("offline-overseer", "2026-09-05T00:00:00.000Z"),
            "overseer",
        ),
        as_class(windowed("online-coder", 40), "coder"),
        as_class(
            windowless("offline-coder", "2026-09-02T00:00:00.000Z"),
            "coder",
        ),
        as_class(windowed("online-scribe", 2), "scribe"),
    ]);

    assert_eq!(
        order,
        [
            "online-scribe",
            "online-coder",
            "offline-overseer",
            "offline-coder"
        ]
    );
}

/// The rung is keyed on identity, not on the role string. A control session
/// displaying `qa` and one displaying `control` are the same class, and a
/// control session that names no role at all is still a control session --
/// which is the shape the fixtures actually store.
#[test]
fn the_control_rung_is_keyed_on_identity_not_spelling() {
    let mut names_no_role = windowed("names-no-role", 1);
    names_no_role["projectControl"] = json!(true);

    assert_eq!(agent_class(Some(&names_no_role)), "control");
    assert_eq!(
        agent_class(Some(&as_class(windowed("qa", 1), "qa"))),
        "control"
    );
    assert_eq!(
        agent_class(Some(&as_class(windowed("overseer", 1), "overseer"))),
        "overseer"
    );
    assert_eq!(
        agent_class(Some(&as_class(windowed("scribe", 1), "scribe"))),
        "scribe"
    );
    assert_eq!(
        agent_class(Some(&as_class(windowed("coder", 1), "coder"))),
        "coder"
    );

    let rank = |session: &Value| agent_class_rank(Some(session));
    let overseer = as_class(windowed("overseer", 1), "overseer");
    let scribe = as_class(windowed("scribe", 1), "scribe");
    let coder = as_class(windowed("coder", 1), "coder");
    assert!(
        rank(&overseer) < rank(&names_no_role),
        "overseer leads control"
    );
    assert!(rank(&names_no_role) < rank(&scribe), "control leads scribe");
    assert!(rank(&scribe) < rank(&coder), "scribe leads coder");
}

/// `team.order` was someone stating a roster position outright. It is not an
/// ordering key any more; the class and the window are.
#[test]
fn an_explicit_team_order_does_not_move_an_agent() {
    let mut later_window = windowed("later-window", 8);
    later_window["team"] = json!({ "order": 1 });
    let mut earlier_window = windowed("earlier-window", 3);
    earlier_window["team"] = json!({ "order": 2 });

    assert_eq!(
        ordered(vec![later_window, earlier_window]),
        ["earlier-window", "later-window"]
    );
}

/// An agent with no window has no tmux position, so it sorts after every agent
/// that has one, by creation time — the only other key on an agent that cannot
/// change while you are looking at it.
#[test]
fn windowless_agents_follow_in_creation_order() {
    let order = ordered(vec![
        windowless("offline-new", "2026-09-20T00:00:00.000Z"),
        windowed("online-late-window", 40),
        windowless("offline-old", "2026-09-01T00:00:00.000Z"),
        windowed("online-early-window", 2),
    ]);

    assert_eq!(
        order,
        [
            "online-early-window",
            "online-late-window",
            "offline-old",
            "offline-new"
        ]
    );
}

/// Ties must not reorder run to run.
#[test]
fn identical_positions_order_stably_by_id() {
    let order = ordered(vec![
        windowed("ccc", 3),
        windowed("aaa", 3),
        windowed("bbb", 3),
    ]);

    assert_eq!(order, ["aaa", "bbb", "ccc"]);
}

/// A control session takes the control rung whatever role it displays, so the
/// ladder cannot be dodged by storing an unexpected role string.
///
/// `agent_role` would call this one a coder, because that is the role it
/// carries. The rung is not the role: `is_project_control_session` is what
/// decides authority, and this agent has it.
#[test]
fn a_control_session_takes_the_control_rung_whatever_role_it_displays() {
    let mut displays_as_coder = windowed("displays-as-coder", 9);
    displays_as_coder["projectControl"] = json!(true);
    displays_as_coder["role"] = json!("coder");
    let scribe = as_class(windowed("scribe", 2), "scribe");

    assert_eq!(agent_role(Some(&displays_as_coder)), "coder");
    assert_eq!(agent_class(Some(&displays_as_coder)), "control");
    assert_eq!(
        ordered(vec![scribe, displays_as_coder]),
        ["displays-as-coder", "scribe"]
    );
}
