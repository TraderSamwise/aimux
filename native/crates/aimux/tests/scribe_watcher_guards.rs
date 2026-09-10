//! Behaviour the recovered corpus cannot see: two bugs the twin carried, and
//! the commit semantics of a failed delivery.

use aimux::scribe_watcher::{
    ScribeBriefing, ScribeWatcher, bounded_output, find_scribe_candidates_with_scribe,
};
use serde_json::{Value, json};

const NOW: i64 = 1_788_000_000_000;

#[test]
fn a_tail_full_of_box_drawing_is_trimmed_without_panicking() {
    // every char here is multi-byte, so a byte-offset slice lands mid-character
    let output = "─│┌┐└┘├┤┬┴┼".repeat(400);
    assert!(
        output.len() > 3_000,
        "the fixture must exceed the cap in bytes"
    );

    let bounded = bounded_output(&output, 3_000);

    assert_eq!(bounded.chars().count(), 3_000, "the cap is characters");
    assert!(
        output.ends_with(&bounded),
        "it keeps the tail, not the head"
    );
}

#[test]
fn an_emoji_tail_is_also_trimmed_by_character() {
    let output = "🙂🔥🚀".repeat(100);
    let bounded = bounded_output(&output, 10);
    assert_eq!(bounded.chars().count(), 10);
    assert!(output.ends_with(&bounded));
}

#[test]
fn a_short_tail_is_returned_untouched() {
    assert_eq!(bounded_output("hello", 3_000), "hello");
}

#[test]
fn an_overseer_known_only_by_team_role_is_not_a_briefing_candidate() {
    // production topology sessions carry `team` but not the boolean flags, so
    // the role branch is the only thing standing between the overseer and a
    // briefing that quotes its own output back at the scribe
    let input = json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            { "id": "boss", "status": "running", "team": { "teamId": "overseer", "role": "overseer" } },
            { "id": "worker", "status": "running" }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "boss":   { "derived": { "activity": "idle", "attention": "normal" } },
            "worker": { "derived": { "activity": "idle", "attention": "normal" } }
        }}
    });

    let ids = find_scribe_candidates_with_scribe(&input, Some("scribe"))
        .iter()
        .map(|candidate| candidate["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();

    assert_eq!(ids, ["worker"], "the overseer must not be briefed on");
}

#[test]
fn a_scribe_known_only_by_team_role_is_not_a_briefing_candidate() {
    let input = json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            { "id": "other-scribe", "status": "running", "team": { "role": "scribe" } }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "other-scribe": { "derived": { "activity": "idle", "attention": "normal" } }
        }}
    });

    assert!(find_scribe_candidates_with_scribe(&input, Some("scribe")).is_empty());
}

fn one_changed_agent() -> Value {
    json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            { "id": "worker", "status": "running", "tool": "claude" }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "worker": { "derived": { "activity": "idle", "attention": "normal" } }
        }}
    })
}

#[test]
fn a_failed_delivery_neither_burns_the_cooldown_nor_marks_the_tail_as_told() {
    let input = one_changed_agent();
    let mut watcher = ScribeWatcher::new();
    let mut read = |_: &str, _: i64| Some(String::from("some real work happened here"));

    let mut fail = |_: &ScribeBriefing| false;
    assert!(watcher.scan(&input, NOW, &mut read, &mut fail).is_some());

    // immediately inside the 60s cooldown, and with an unchanged tail: it must
    // still try, because nothing was ever delivered
    let mut sent = Vec::new();
    let mut ok = |briefing: &ScribeBriefing| {
        sent.push(briefing.scribe_id.clone());
        true
    };
    assert!(watcher.scan(&input, NOW + 1, &mut read, &mut ok).is_some());
    assert_eq!(sent, ["scribe"]);
}

#[test]
fn a_delivered_briefing_is_not_repeated_for_an_unchanged_tail() {
    let input = one_changed_agent();
    let mut watcher = ScribeWatcher::new();
    let mut read = |_: &str, _: i64| Some(String::from("some real work happened here"));
    let mut ok = |_: &ScribeBriefing| true;

    assert!(watcher.scan(&input, NOW, &mut read, &mut ok).is_some());
    // past the cooldown, but the tail has not moved
    assert!(
        watcher
            .scan(&input, NOW + 120_000, &mut read, &mut ok)
            .is_none()
    );
}

#[test]
fn the_scribe_is_left_alone_for_a_minute_after_a_briefing_lands() {
    let input = one_changed_agent();
    let mut watcher = ScribeWatcher::new();
    let mut tail = String::from("first pass of work");
    let mut ok = |_: &ScribeBriefing| true;

    {
        let mut read = |_: &str, _: i64| Some(tail.clone());
        assert!(watcher.scan(&input, NOW, &mut read, &mut ok).is_some());
    }

    // the tail moved, so only the cooldown can be holding it back
    tail = String::from("second pass, quite different work");
    {
        let mut read = |_: &str, _: i64| Some(tail.clone());
        assert!(
            watcher
                .scan(&input, NOW + 59_999, &mut read, &mut ok)
                .is_none(),
            "inside the cooldown"
        );
        assert!(
            watcher
                .scan(&input, NOW + 60_000, &mut read, &mut ok)
                .is_some(),
            "once it expires"
        );
    }
}

#[test]
fn a_project_with_no_scribe_is_a_no_op() {
    let input = json!({
        "sessions": [{ "id": "worker", "status": "running" }],
        "metadata": { "sessions": { "worker": { "derived": { "activity": "idle", "attention": "normal" } } } }
    });
    let mut watcher = ScribeWatcher::new();
    let mut read = |_: &str, _: i64| Some(String::from("work"));
    let mut ok = |_: &ScribeBriefing| true;

    assert!(watcher.scan(&input, NOW, &mut read, &mut ok).is_none());
}

mod task_budget {
    use aimux::project_service::scribe_watcher_task::{
        max_scan_candidates, readable_session_statuses,
    };

    #[test]
    fn only_sessions_with_a_pane_are_ever_read() {
        assert_eq!(readable_session_statuses(), ["starting", "running", "idle"]);
        for dead in ["graveyard", "offline", "exited", "stopped"] {
            assert!(
                !readable_session_statuses().contains(&dead),
                "{dead} has no pane to capture"
            );
        }
    }

    #[test]
    fn the_read_budget_stays_far_below_nodes_fifty() {
        // each candidate read is a tmux spawn; Node's 50 was affordable on an
        // async event loop and is not on a shared rail
        assert!(max_scan_candidates() <= 12, "got {}", max_scan_candidates());
        assert!(
            max_scan_candidates() >= 4,
            "must still cover a full briefing"
        );
    }
}

#[test]
fn an_overseer_is_still_control_even_when_scribe_is_explicitly_false() {
    // scribe:false answers "is it the scribe", not "is it a control session";
    // treating it as the latter turned the overseer into a briefing candidate
    let input = json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            { "id": "boss", "status": "running", "overseer": true },
            { "id": "worker", "status": "running" }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "boss":   { "scribe": false, "derived": { "activity": "idle", "attention": "normal" } },
            "worker": { "scribe": false, "derived": { "activity": "idle", "attention": "normal" } }
        }}
    });

    let ids = find_scribe_candidates_with_scribe(&input, Some("scribe"))
        .iter()
        .map(|candidate| candidate["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();

    assert_eq!(ids, ["worker"]);
}

#[test]
fn stored_scribe_false_beats_stale_project_control_object_for_scribe_candidates() {
    let input = json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            {
                "id": "worker",
                "status": "running",
                "team": { "role": "scribe" },
                "projectControl": { "enabled": true }
            }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "worker": { "scribe": false, "derived": { "activity": "idle", "attention": "normal" } }
        }}
    });

    let ids = find_scribe_candidates_with_scribe(&input, Some("scribe"))
        .iter()
        .map(|candidate| candidate["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();

    assert_eq!(ids, ["worker"]);
}

#[test]
fn a_wide_character_pane_still_produces_a_briefing() {
    // measured in bytes, a trimmed box-drawing tail is ~3x its character count,
    // so the fit re-check failed and the candidate was dropped on the floor
    let wide = "─│┌┐└┘├┤┬┴┼".repeat(600);
    let input = json!({
        "sessions": [
            { "id": "scribe", "status": "running" },
            { "id": "worker", "status": "running", "tool": "claude" }
        ],
        "metadata": { "sessions": {
            "scribe": { "scribe": true, "derived": { "activity": "idle", "attention": "normal" } },
            "worker": { "derived": { "activity": "idle", "attention": "normal" } }
        }}
    });

    let mut watcher = ScribeWatcher::new();
    let mut read = |_: &str, _: i64| Some(wide.clone());
    let mut delivered = None;
    let mut ok = |briefing: &ScribeBriefing| {
        delivered = Some(briefing.text.clone());
        true
    };

    assert!(watcher.scan(&input, NOW, &mut read, &mut ok).is_some());
    let text = delivered.expect("a briefing must be produced");
    assert!(text.contains("aimux scribe check"));
    assert!(
        text.chars().count() <= 16_000,
        "and must respect the budget"
    );
}
