//! One order for every agent surface.
//!
//! The dashboard numbers agents [1]..[N], the footer chips render the same
//! agents, the supervisor lane renders the control sessions, and the GUI draws
//! all of it. Each of those used to sort independently — by createdAt
//! descending, by team order then createdAt *ascending*, by role display order,
//! and in the GUI by a different field again — so the dashboard read 1..5 while
//! the chips read roughly the reverse.

use aimux::team_contract::compare_agent_display_order;
use serde_json::{Value, json};

fn session(id: &str, created_at: &str) -> Value {
    json!({ "id": id, "createdAt": created_at, "tool": "claude" })
}

fn ordered(mut sessions: Vec<Value>) -> Vec<String> {
    sessions.sort_by(compare_agent_display_order);
    sessions
        .iter()
        .map(|session| session["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// Newest first, which is what the dashboard's visible numbering is built on.
#[test]
fn agents_order_newest_first() {
    let order = ordered(vec![
        session("oldest", "2026-09-01T00:00:00.000Z"),
        session("newest", "2026-09-20T00:00:00.000Z"),
        session("middle", "2026-09-10T00:00:00.000Z"),
    ]);

    assert_eq!(order, ["newest", "middle", "oldest"]);
}

/// The regression Sam reported: the dashboard and the footer chips rendered the
/// same five agents in near-opposite orders. Whatever order one surface
/// produces, the other must produce the same one.
#[test]
fn the_dashboard_and_the_footer_chips_agree() {
    let agents = vec![
        session("6nenaq", "2026-09-20T10:00:00.000Z"),
        session("a88iz7", "2026-09-19T10:00:00.000Z"),
        session("7owt0o", "2026-09-15T10:00:00.000Z"),
        session("2jdcpa", "2026-09-14T10:00:00.000Z"),
        session("3yfqu7", "2026-09-13T10:00:00.000Z"),
    ];

    // Both surfaces sort with the shared comparator, from any input order.
    let dashboard = ordered(agents.clone());
    let mut reversed = agents;
    reversed.reverse();
    let chips = ordered(reversed);

    assert_eq!(dashboard, chips);
    assert_eq!(
        dashboard,
        ["6nenaq", "a88iz7", "7owt0o", "2jdcpa", "3yfqu7"]
    );
}

/// The supervisor lane's overseer-before-scribe is deliberate, so role order
/// outranks recency rather than being a separate sort on a separate surface.
#[test]
fn role_order_outranks_recency() {
    let mut overseer = session("overseer", "2026-09-01T00:00:00.000Z");
    overseer["team"] = json!({ "role": "overseer", "teamId": "overseer" });
    overseer["overseer"] = json!(true);
    overseer["projectControl"] = json!(true);
    let mut scribe = session("scribe", "2026-09-20T00:00:00.000Z");
    scribe["team"] = json!({ "role": "scribe", "teamId": "scribe" });
    scribe["scribe"] = json!(true);
    scribe["projectControl"] = json!(true);

    let order = ordered(vec![scribe, overseer]);

    assert_eq!(
        order[0], "overseer",
        "the older overseer still leads the lane: {order:?}"
    );
}

/// An explicit `team.order` is someone stating the order outright, so it wins
/// over recency.
#[test]
fn an_explicit_team_order_wins_over_recency() {
    let mut first = session("explicitly-first", "2026-09-01T00:00:00.000Z");
    first["team"] = json!({ "order": 1 });
    let mut second = session("explicitly-second", "2026-09-20T00:00:00.000Z");
    second["team"] = json!({ "order": 2 });

    assert_eq!(
        ordered(vec![second, first]),
        ["explicitly-first", "explicitly-second"]
    );
}

/// Ties must not reorder run to run.
#[test]
fn identical_timestamps_order_stably_by_id() {
    let same = "2026-09-20T00:00:00.000Z";
    let order = ordered(vec![
        session("ccc", same),
        session("aaa", same),
        session("bbb", same),
    ]);

    assert_eq!(order, ["aaa", "bbb", "ccc"]);
}
