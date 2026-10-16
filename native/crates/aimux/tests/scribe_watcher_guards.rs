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
        // async event loop and is not on a shared tick loop
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

/// Why a stranded `needs_input` on the scribe is a deadlock and not a label.
///
/// `scribe_readiness` refuses a scribe whose attention is not normal, and
/// nothing used to clear a stranded `needs_input` -- so the scribe watcher
/// returned `None` on every scan, forever. Observed on tealstreet-next
/// 2026-10-05: the scribe had finished its turn at 11:40 PM and had not been
/// briefed in fifteen hours.
///
/// Pinned here beside the watcher it silences, because the fix is in the
/// transcript reconciler and this is the consequence that makes it worth
/// making. Both halves have to hold for the scribe to be briefed again.
#[test]
fn a_scribe_stranded_at_needs_input_is_never_briefed() {
    let mut waiting = one_changed_agent();
    waiting["metadata"]["sessions"]["scribe"]["derived"] =
        json!({ "activity": "waiting", "attention": "needs_input" });

    let mut watcher = ScribeWatcher::new();
    let mut read = |_: &str, _: i64| Some(String::from("some real work happened here"));
    let mut ok = |_: &ScribeBriefing| true;

    for tick in 0..5 {
        assert!(
            watcher
                .scan(&waiting, NOW + tick * 120_000, &mut read, &mut ok)
                .is_none(),
            "tick {tick}: the watcher refuses a scribe that is not ready, however long it waits"
        );
    }

    // Clearing the attention is not enough on its own, which is why Part C
    // writes both fields. `one_changed_agent()` sets activity `idle` AND
    // attention `normal`, so asserting readiness with it would have proved
    // nothing about which write mattered.
    let mut attention_only = one_changed_agent();
    attention_only["metadata"]["sessions"]["scribe"]["derived"] =
        json!({ "activity": "waiting", "attention": "normal" });
    assert!(
        watcher
            .scan(&attention_only, NOW + 600_000, &mut read, &mut ok)
            .is_none(),
        "readiness is an AND; a waiting scribe is still refused"
    );

    // Both fields, which is the state Part C leaves behind.
    let settled = one_changed_agent();
    assert!(
        watcher
            .scan(&settled, NOW + 1_200_000, &mut read, &mut ok)
            .is_some(),
        "activity idle and attention normal together are the unblock"
    );
}

/// Which scribe the watcher briefs, when the metadata disagrees with reality.
mod which_scribe {
    use aimux::scribe_watcher::{find_scribe_session_id, scribe_readiness};
    use serde_json::{Value, json};

    fn input(sessions: Value, metadata: Value) -> Value {
        json!({ "sessions": sessions, "metadata": { "sessions": metadata } })
    }

    #[test]
    fn a_dead_scribes_flag_does_not_silence_a_live_one() {
        // An ordinary kill leaves the metadata flag behind. The first flag in
        // map order used to win whatever state its session was in, so one dead
        // `claude-scribe` silenced a live `codex-scribe` -- and `claude-` sorts
        // first, which is why this was not a rare ordering.
        let found = find_scribe_session_id(&input(
            json!([
                { "id": "claude-scribe", "status": "offline" },
                { "id": "codex-scribe", "status": "running" },
            ]),
            json!({
                "claude-scribe": { "scribe": true },
                "codex-scribe": { "scribe": true },
            }),
        ));
        assert_eq!(found.as_deref(), Some("codex-scribe"));
    }

    #[test]
    fn a_flag_with_no_live_session_is_no_scribe_at_all() {
        // Not that session: the watcher then reads as having no scribe, which
        // is true, instead of waiting for a corpse to become ready.
        let input = input(
            json!([{ "id": "claude-scribe", "status": "graveyard" }]),
            json!({ "claude-scribe": { "scribe": true } }),
        );
        assert_eq!(find_scribe_session_id(&input), None);
        assert!(!scribe_readiness(&input, None));
    }

    #[test]
    fn a_scribe_whose_role_is_not_a_flag_is_still_the_scribe() {
        // The topology deliberately keeps `team: {"role": "scribe"}` on a
        // session carrying no explicit flag, and the project's own predicate
        // accepts it. Reading the boolean alone left that scribe in the
        // dashboard and never briefed it.
        for metadata in [
            json!({ "legacy-scribe": { "team": { "role": "scribe" } } }),
            json!({ "legacy-scribe": { "role": "scribe" } }),
        ] {
            let found = find_scribe_session_id(&input(
                json!([{ "id": "legacy-scribe", "status": "running" }]),
                metadata.clone(),
            ));
            assert_eq!(found.as_deref(), Some("legacy-scribe"), "{metadata}");
        }
    }

    #[test]
    fn a_demoted_session_is_not_the_scribe() {
        // `projectControl: false` demotes a session the topology still
        // describes by role, and the shared predicate honours that.
        let found = find_scribe_session_id(&input(
            json!([{ "id": "demoted", "status": "running" }]),
            json!({ "demoted": { "role": "scribe", "projectControl": false } }),
        ));
        assert_eq!(found, None);
    }

    #[test]
    fn a_starting_scribe_is_the_scribe_but_is_not_ready() {
        // Picking it is right -- it is the project's scribe -- and readiness is
        // what says "not yet", so the watcher waits rather than creating a
        // second one.
        let input = input(
            json!([{ "id": "claude-scribe", "status": "starting" }]),
            json!({ "claude-scribe": { "scribe": true } }),
        );
        assert_eq!(
            find_scribe_session_id(&input).as_deref(),
            Some("claude-scribe")
        );
        assert!(!scribe_readiness(&input, Some("claude-scribe")));
    }

    #[test]
    fn two_live_scribes_pick_the_same_one_every_tick() {
        let sessions = json!([
            { "id": "b-scribe", "status": "running" },
            { "id": "a-scribe", "status": "running" },
        ]);
        let metadata = json!({
            "b-scribe": { "scribe": true },
            "a-scribe": { "scribe": true },
        });
        let first = find_scribe_session_id(&input(sessions.clone(), metadata.clone()));
        assert_eq!(
            first.as_deref(),
            Some("a-scribe"),
            "sorted by id, not map order"
        );
        assert_eq!(
            find_scribe_session_id(&input(sessions, metadata)),
            first,
            "and the same one next tick"
        );
    }
}

/// Whose tail the tick reads.
mod read_targets {
    use aimux::project_service::scribe_watcher_task::scribe_read_targets;
    use serde_json::{Value, json};

    /// A project whose first twelve positions the watcher will not write up,
    /// and two real agents after them.
    fn crowded_project() -> Value {
        let mut sessions = Vec::new();
        let mut metadata = serde_json::Map::new();
        // The scribe itself, then eleven agents mid-turn: all ineligible, all
        // ahead of the work in topology order.
        sessions.push(json!({ "id": "claude-scribe", "status": "running" }));
        metadata.insert(
            "claude-scribe".into(),
            json!({ "scribe": true, "derived": { "activity": "idle", "attention": "normal" } }),
        );
        for index in 0..11 {
            let id = format!("busy-{index}");
            sessions.push(json!({ "id": id, "status": "running" }));
            metadata.insert(
                id,
                json!({ "derived": { "activity": "running", "attention": "normal" } }),
            );
        }
        for id in ["quiet-a", "quiet-b"] {
            sessions.push(json!({ "id": id, "status": "running" }));
            metadata.insert(
                id.into(),
                json!({ "derived": { "activity": "idle", "attention": "normal" } }),
            );
        }
        json!({
            "sessions": sessions,
            "metadata": { "sessions": Value::Object(metadata) },
            "maxScanCandidates": 12,
        })
    }

    #[test]
    fn the_candidates_decide_the_reads_not_topology_order() {
        // The two agents worth writing up sit at positions 12 and 13. Reading
        // the first twelve SESSIONS read eleven busy agents and the scribe,
        // and then the watcher skipped the only two candidates it had -- the
        // same number counted in two places.
        assert_eq!(
            scribe_read_targets(&crowded_project()),
            vec!["quiet-a".to_owned(), "quiet-b".to_owned()]
        );
    }

    /// Every agent the briefing describes had its tail read.
    ///
    /// The real invariant, and the one the defect broke: the task chooses what
    /// to read and the watcher chooses what to write up, so a test that only
    /// checks one of them passes while the two disagree. This drives the
    /// watcher with a reader that records what it was asked for, and compares
    /// that against the briefing the watcher produced.
    #[test]
    fn everything_the_briefing_names_was_read_first() {
        let input = crowded_project();
        let targets = scribe_read_targets(&input);
        let mut watcher = aimux::scribe_watcher::ScribeWatcher::new();
        let mut asked = Vec::new();
        let mut read = |session_id: &str, start_line: i64| {
            asked.push(session_id.to_owned());
            // What the task supplies: the tail it read for a candidate.
            (start_line == -80 && targets.iter().any(|id| id == session_id))
                .then(|| format!("work from {session_id}"))
        };
        let mut collect = |_: &aimux::scribe_watcher::ScribeBriefing| false;
        let briefing = watcher
            .scan(&input, 1_000, &mut read, &mut collect)
            .expect("the crowded project has work to write up");

        for named in ["quiet-a", "quiet-b"] {
            assert!(
                briefing.text.contains(named),
                "the briefing names {named}: {}",
                briefing.text
            );
            assert!(
                asked.iter().any(|id| id == named),
                "and its tail was read: {asked:?}"
            );
        }
        assert!(
            asked
                .iter()
                .all(|id| targets.iter().any(|target| target == id)),
            "nothing outside the read set was asked for: {asked:?} vs {targets:?}"
        );
    }

    #[test]
    fn a_project_with_nothing_to_write_up_reads_nothing() {
        let input = json!({
            "sessions": [{ "id": "busy", "status": "running" }],
            "metadata": { "sessions": { "busy": { "derived": { "activity": "running" } } } },
        });
        assert!(scribe_read_targets(&input).is_empty());
    }
}

/// The watcher and its task agree about which scribe exists.
///
/// Three definitions of "a scribe that is there" live in this subsystem, and
/// the dangerous disagreement is the watcher being STRICTER than the creation
/// guard: a live scribe the watcher refuses reads as no scribe, and the
/// guard then makes a second one. That is worse than the silence this change
/// set out to fix.
#[test]
fn the_watcher_and_its_reader_share_one_idea_of_a_briefable_scribe() {
    assert_eq!(
        aimux::scribe_watcher::SCRIBE_BRIEFABLE_STATUSES,
        aimux::project_service::scribe_watcher_task::readable_session_statuses(),
        "the task pre-filters the topology with the watcher's own list"
    );
    // And every one of them is a status the creation guard also calls live, so
    // the watcher never refuses a scribe the guard would decline to replace.
    for status in aimux::scribe_watcher::SCRIBE_BRIEFABLE_STATUSES {
        let input = serde_json::json!({
            "sessions": [{ "id": "claude-scribe", "status": status }],
            "metadata": { "sessions": { "claude-scribe": { "scribe": true } } },
        });
        assert_eq!(
            aimux::scribe_watcher::find_scribe_session_id(&input).as_deref(),
            Some("claude-scribe"),
            "{status} is briefable"
        );
    }
}

/// What the project service says about the scribe it did or did not get.
mod startup_report {
    use aimux::project_service::process::report_default_scribe_outcome;
    use serde_json::json;

    #[test]
    fn an_ordinary_outcome_is_not_a_warning() {
        assert_eq!(
            report_default_scribe_outcome(
                &json!({ "created": true, "sessionId": "claude-scribe" })
            ),
            None
        );
        // The project asked not to have one.
        assert_eq!(
            report_default_scribe_outcome(&json!({ "created": false, "reason": "disabled" })),
            None
        );
        // And one it already has, in a state it can be briefed in.
        assert_eq!(
            report_default_scribe_outcome(&json!({
                "created": false,
                "reason": "existing",
                "sessionId": "claude-scribe",
                "status": "running",
            })),
            None
        );
    }

    #[test]
    fn a_scribe_nothing_can_brief_is_reported_even_though_it_exists() {
        // The creator's idea of live is wider than the watcher's on purpose: a
        // scribe at `planned` is live enough not to replace and not live
        // enough to talk to. That combination said `existing` while the
        // watcher saw no scribe at all, for ever, and nothing said so.
        for status in ["planned", "unknown", "exited"] {
            let said = report_default_scribe_outcome(&json!({
                "created": false,
                "reason": "existing",
                "sessionId": "claude-scribe",
                "status": status,
            }));
            assert_eq!(
                said,
                Some("this project's scribe cannot be briefed in the state it is in"),
                "{status}"
            );
        }
    }

    #[test]
    fn every_reason_it_could_not_make_one_is_reported() {
        for reason in [
            "unknown-tool",
            "disabled-tool",
            "program-not-found",
            "claim-error",
            "topology-unreadable",
            "launch-failed",
        ] {
            assert_eq!(
                report_default_scribe_outcome(&json!({ "created": false, "reason": reason })),
                Some("no default scribe for this project"),
                "{reason}"
            );
        }
    }
}
