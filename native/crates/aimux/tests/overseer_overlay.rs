//! What the overseer menu says about the overseer this project has.
//!
//! The menu described the project as having no overseer whenever the one it
//! has is down — which is exactly when you open it — and hid the `d` key on
//! the same test, while `unset_overseer_from_overlay` has always worked on an
//! offline overseer. A key that works and says nothing, next to a line that
//! says there is nothing to work on.

use aimux::tui_render::text::strip_ansi;
use aimux::tui_screen_renderers::render_overseer_overlay_output;
use serde_json::{Value, json};

fn overlay(overseers: Value) -> String {
    strip_ansi(&render_overseer_overlay_output(
        &json!({ "dashboardOverseerSessionsCache": overseers }),
        // Wide enough that the hint row is not truncated: the question here is
        // which keys are offered, not where the box clips them.
        170,
        40,
    ))
}

fn overseer(id: &str, status: &str) -> Value {
    json!({ "id": id, "label": id, "status": status, "overseer": true })
}

#[test]
fn an_offline_overseer_is_named_rather_than_reported_as_none() {
    let rendered = overlay(json!([overseer("claude-overseer", "offline")]));

    assert!(
        rendered.contains("claude-overseer"),
        "the overseer this project has must be named: {rendered}"
    );
    assert!(
        !rendered.contains("none configured"),
        "it is configured, it is just not running: {rendered}"
    );
    assert!(
        rendered.contains("Status: Off"),
        "and down is reported as down: {rendered}"
    );
}

#[test]
fn the_unset_key_is_offered_whenever_there_is_one_to_unset() {
    let offline = overlay(json!([overseer("claude-overseer", "offline")]));
    assert!(
        offline.contains("unset overseer"),
        "`d` works on an offline overseer, so it must be hinted: {offline}"
    );
    assert!(
        !offline.contains("stop overseer"),
        "`x` does not, because there is nothing running to stop: {offline}"
    );

    let running = overlay(json!([overseer("claude-overseer", "running")]));
    assert!(running.contains("unset overseer"));
    assert!(running.contains("stop overseer"));
}

#[test]
fn a_project_with_no_overseer_says_so_and_offers_neither_key() {
    let rendered = overlay(json!([]));

    assert!(
        rendered.contains("none configured"),
        "no overseer at all is a different state from one that is down: {rendered}"
    );
    assert!(rendered.contains("Status: None"));
    assert!(!rendered.contains("unset overseer"));
    assert!(!rendered.contains("stop overseer"));
}

#[test]
fn a_live_overseer_wins_over_a_stale_one_in_the_header() {
    let rendered = overlay(json!([
        overseer("claude-overseer-stale", "offline"),
        overseer("claude-overseer-live", "running"),
    ]));

    assert!(
        rendered.contains("Status: Active"),
        "a running overseer is active even with a stale record ahead of it: {rendered}"
    );
    assert!(
        rendered.contains("claude-overseer-live"),
        "and the live one is the one named: {rendered}"
    );
}

#[test]
fn every_overseer_is_rendered_in_published_order_and_add_is_always_available() {
    let rendered = overlay(json!([
        overseer("second-identity", "offline"),
        overseer("third-identity", "running"),
        overseer("first-identity", "running"),
    ]));
    assert!(rendered.contains("Overseers: 3"), "{rendered}");
    let mut after = rendered
        .find("second-identity")
        .expect("published first overseer");
    for id in ["second-identity", "third-identity", "first-identity"] {
        after += rendered[after..]
            .find(id)
            .expect("every overseer stays in service order")
            + id.len();
    }
    assert!(rendered.contains("add overseer"), "{rendered}");
    assert!(overlay(json!([])).contains("add overseer"));
}

#[test]
fn a_compact_fleet_overlay_reserves_visible_action_hints_and_watched_overflow() {
    let watched = (1..=8)
        .map(|index| {
            json!({
                "id": format!("worker-{index}"), "label": format!("worker-{index}"),
                "status": "idle", "loop": { "active": true, "goal": "finish work" },
            })
        })
        .collect::<Vec<_>>();
    let context = json!({
        "dashboardOverseerSessionsCache": [
            overseer("control-a", "running"), overseer("control-b", "running"), overseer("control-c", "running"),
        ],
        "dashboardSessionsCache": watched,
        "loopAlertState": { "ok": true, "globalPause": {
            "enabled": true, "bufferedCount": 3, "remainingMs": 60_000,
        } },
    });
    for cols in [80, 170] {
        let rendered = strip_ansi(&render_overseer_overlay_output(&context, cols, 24));
        let visible_workers = rendered.matches("• worker-").count();
        assert!(visible_workers > 0 && visible_workers < 8, "{rendered}");
        assert!(
            rendered.contains(&format!("{} more watched agents", 8 - visible_workers)),
            "{rendered}"
        );
        for text in [
            "Overseers: 3",
            "control-a",
            "control-b",
            "control-c",
            "Loop alerts: paused",
            "Watching: 8 agents",
            "more watched agents",
            "n  add overseer",
            "d  unset overseer",
            "x  stop overseer",
            "Esc  back",
        ] {
            assert!(
                rendered.contains(text),
                "{cols} columns must retain {text}: {rendered}"
            );
        }
    }
}

#[test]
fn a_large_overseer_set_keeps_its_action_target_and_hints_visible() {
    let overseers = (1..=10)
        .map(|index| overseer(&format!("control-{index:02}"), "running"))
        .collect::<Vec<_>>();
    let context = json!({
        "dashboardOverseerSessionsCache": overseers,
        "overseerTargetId": "control-10",
    });
    let rendered = strip_ansi(&render_overseer_overlay_output(&context, 80, 24));
    for text in [
        "Overseers: 10",
        "Target: control-10",
        "more rows",
        "n  add overseer",
        "d  unset overseer",
        "x  stop overseer",
        "Esc  back",
    ] {
        assert!(
            rendered.contains(text),
            "compact overlay must retain {text}: {rendered}"
        );
    }
    let target = rendered.find("Target: control-10").expect("action target");
    let first = rendered
        .find("control-01")
        .expect("published first overseer");
    let second = rendered
        .find("control-02")
        .expect("published second overseer");
    assert!(target < first && first < second, "{rendered}");
}
