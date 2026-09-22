//! One order for every agent surface: the tmux window order.
//!
//! The dashboard numbers agents [1]..[N], the footer chips render the same
//! agents, the supervisor lane renders the control sessions, and the GUI draws
//! all of it. Each of those used to sort independently — by createdAt
//! descending, by team order then createdAt *ascending*, by role display order,
//! and in the GUI by a different field again — so the dashboard read 1..5 while
//! the chips read roughly the reverse.
//!
//! The order is now the position of the agent's tmux window, which is the
//! order Sam already navigates with the prefix keys and already sees in his
//! own tmux session. Role, team and recency do not enter into it.

use aimux::team_contract::compare_agent_canonical_order;
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

/// Neither role nor plane decides the order. The supervisor lane is a plane —
/// a grouping — and within it the window order still decides.
#[test]
fn role_does_not_outrank_window_position() {
    let mut overseer = windowed("overseer", 9);
    overseer["team"] = json!({ "role": "overseer", "teamId": "overseer" });
    overseer["overseer"] = json!(true);
    overseer["projectControl"] = json!(true);
    overseer["lane"] = json!({ "kind": "supervisor" });
    let mut scribe = windowed("scribe", 2);
    scribe["team"] = json!({ "role": "scribe", "teamId": "scribe" });
    scribe["scribe"] = json!(true);
    scribe["projectControl"] = json!(true);
    scribe["lane"] = json!({ "kind": "supervisor" });

    assert_eq!(ordered(vec![overseer, scribe]), ["scribe", "overseer"]);
}

/// `team.order` was someone stating a roster position outright. It is not an
/// ordering key any more; the window it runs in is.
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
