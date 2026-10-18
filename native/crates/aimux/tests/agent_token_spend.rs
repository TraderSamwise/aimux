//! Billed-equivalent token spend, and the traps in getting there.

use aimux::agent_token_spend::{
    BASELINE_JUST_TAKEN, ClaudeSpendChunk, MAX_CHUNK_BYTES, NO_TRANSCRIPT_YET, SpendBaseline,
    SpendSinceBaseline, TRANSCRIPT_UNREADABLE, advance_cumulative_baseline,
    advance_summed_baseline, chunk_spans_an_oversized_record, claude_spend_chunk,
    codex_cumulative_billed, cumulative_spend_since, offset_still_valid,
    rebaseline_for_new_episode, runtime_reports_usage, spend_for_session, try_spend_for_session,
};

fn claude_line(id: &str, input: u64, cache_read: u64, cache_creation: u64, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","message":{{"id":"{id}","usage":{{"input_tokens":{input},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_creation},"output_tokens":{output}}}}}}}"#
    ) + "\n"
}

/// One assistant message writes one usage record PER CONTENT BLOCK, all with
/// the same totals. On a real transcript that is 43,591 records for 27,902
/// messages, and summing them inflates output by 88%.
#[test]
fn repeated_records_for_one_message_are_counted_once() {
    let text = claude_line("msg-1", 100, 0, 0, 10).repeat(3);
    let chunk = claude_spend_chunk(&text, None);
    assert_eq!(
        chunk.billed, 110,
        "three blocks of one message is one charge"
    );
    assert_eq!(chunk.last_id.as_deref(), Some("msg-1"));
}

/// The repeats are adjacent, which is the fact that makes an incremental
/// reader possible: carrying one id across the boundary is enough.
#[test]
fn a_message_split_across_two_chunks_is_not_counted_twice() {
    let first = claude_line("msg-1", 100, 0, 0, 10).repeat(2);
    let second = claude_line("msg-1", 100, 0, 0, 10) + &claude_line("msg-2", 50, 0, 0, 5);
    let a = claude_spend_chunk(&first, None);
    let b = claude_spend_chunk(&second, a.last_id.as_deref());
    assert_eq!(a.billed, 110);
    assert_eq!(b.billed, 55, "only the new message is charged");
}

/// Cache reads are the cheap ones. Counting them made a human-set budget fire
/// on noise -- one live codex rollout was 710M cached of 721M total.
#[test]
fn cache_reads_are_not_billed() {
    let chunk = claude_spend_chunk(&claude_line("msg-1", 100, 999_999, 7, 10), None);
    assert_eq!(chunk.billed, 117, "input + cache_creation + output only");
}

/// A transcript is appended to while this reads, so the tail is routinely a
/// half-written record. Parsing it would charge a fraction of a message and
/// then re-charge the whole thing next tick.
#[test]
fn a_partial_trailing_line_is_left_for_next_time() {
    let whole = claude_line("msg-1", 100, 0, 0, 10);
    let text = format!("{whole}{{\"message\":{{\"id\":\"msg-2\",\"usa");
    let chunk = claude_spend_chunk(&text, None);
    assert_eq!(chunk.billed, 110);
    assert_eq!(
        chunk.consumed,
        whole.len() as u64,
        "only the complete line is consumed"
    );
}

#[test]
fn records_without_usage_are_ignored_rather_than_counted_as_zero() {
    let text = "{\"type\":\"user\",\"message\":{\"id\":\"u-1\"}}\n".to_owned()
        + "not json at all\n"
        + &claude_line("msg-1", 10, 0, 0, 1);
    let chunk = claude_spend_chunk(&text, None);
    assert_eq!(chunk.billed, 11);
    assert_eq!(
        chunk.consumed,
        text.len() as u64,
        "all whole lines consumed"
    );
}

/// Codex keeps a running total, so a tail read answers without summing, and
/// the newest record wins.
#[test]
fn codex_reads_its_newest_cumulative_total() {
    let line = |input: u64, cached: u64, write: u64, output: u64| {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":{write},"output_tokens":{output}}}}}}}}}"#
        ) + "\n"
    };
    let text = line(1_000, 900, 5, 10) + &line(2_000, 1_900, 7, 20);
    // input - cached + write + output on the NEWEST record.
    assert_eq!(codex_cumulative_billed(&text), Some(100 + 7 + 20));
}

/// Codex counts cached input inside `input_tokens`, so without subtracting it
/// back out the same work reads orders of magnitude larger than claude's.
#[test]
fn codex_does_not_bill_its_cached_input() {
    let text = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":721000000,"cached_input_tokens":710000000,"cache_write_input_tokens":0,"output_tokens":0}}}}"#.to_owned() + "\n";
    assert_eq!(codex_cumulative_billed(&text), Some(11_000_000));
}

#[test]
fn a_rollout_with_no_token_count_is_unmeasured() {
    let text = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\"}}\n";
    assert_eq!(codex_cumulative_billed(text), None);
}

/// A budget is for THIS goal, and the transcript in front of me is 415MB. So
/// the first sight takes a baseline and reports nothing rather than charging a
/// goal for everything that happened before it existed.
#[test]
fn the_first_sight_takes_a_baseline_instead_of_charging_history() {
    assert_eq!(
        cumulative_spend_since(None, Some(5_000_000)),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    assert_eq!(
        cumulative_spend_since(Some(5_000_000), Some(5_000_400)),
        SpendSinceBaseline::Measured(400)
    );
}

/// A total that went backwards is a different session's file -- a resume forks
/// a new transcript -- so re-baseline rather than report a wrapped number.
#[test]
fn a_cumulative_that_went_backwards_re_baselines() {
    assert_eq!(
        cumulative_spend_since(Some(5_000_000), Some(12)),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
}

#[test]
fn no_transcript_is_unmeasured_not_zero() {
    assert_eq!(
        cumulative_spend_since(Some(10), None),
        SpendSinceBaseline::Unmeasured(NO_TRANSCRIPT_YET)
    );
}

/// Reading on from a stale position would sum somebody else's tokens into this
/// goal.
#[test]
fn an_offset_past_the_end_of_the_file_is_invalid() {
    assert!(offset_still_valid(100, 100));
    assert!(offset_still_valid(100, 4_000));
    assert!(
        !offset_still_valid(100, 99),
        "the file shrank: it was replaced"
    );
}

/// aider and shell write no structured usage, so a token goal on one has to
/// say it cannot be measured rather than report nothing spent.
#[test]
fn only_the_runtimes_that_report_usage_can_be_measured() {
    assert!(runtime_reports_usage("claude"));
    assert!(runtime_reports_usage("codex"));
    for tool in ["aider", "shell", "", "Claude"] {
        assert!(!runtime_reports_usage(tool), "{tool} reports no usage");
    }
}

/// A resumed session forks a new transcript, so a baseline naming the old file
/// belongs to somebody else: charging on would sum another session's tokens
/// into this goal.
#[test]
fn a_new_transcript_re_baselines_rather_than_charging_on() {
    let mut baseline = SpendBaseline {
        offset: 4_000,
        billed: 900,
        transcript: Some("/old.jsonl".into()),
        ..SpendBaseline::default()
    };
    advance_summed_baseline(
        &mut baseline,
        "/new.jsonl",
        10_000,
        ClaudeSpendChunk {
            billed: 123,
            consumed: 50,
            last_id: Some("msg-9".into()),
        },
    );
    assert_eq!(baseline.billed, 0, "the new file starts this goal at zero");
    assert_eq!(
        baseline.offset, 10_000,
        "and from the end of what exists now"
    );
    assert_eq!(baseline.transcript.as_deref(), Some("/new.jsonl"));
}

/// A file shorter than the stored position was replaced or truncated.
#[test]
fn a_truncated_transcript_re_baselines() {
    let mut baseline = SpendBaseline {
        offset: 9_000,
        billed: 900,
        transcript: Some("/t.jsonl".into()),
        ..SpendBaseline::default()
    };
    advance_summed_baseline(&mut baseline, "/t.jsonl", 10, ClaudeSpendChunk::default());
    assert_eq!(baseline.billed, 0);
    assert_eq!(baseline.offset, 10);
}

#[test]
fn a_continuing_transcript_accumulates_across_ticks() {
    let mut baseline = SpendBaseline {
        transcript: Some("/t.jsonl".into()),
        ..SpendBaseline::default()
    };
    advance_summed_baseline(
        &mut baseline,
        "/t.jsonl",
        100,
        ClaudeSpendChunk {
            billed: 40,
            consumed: 100,
            last_id: Some("msg-1".into()),
        },
    );
    advance_summed_baseline(
        &mut baseline,
        "/t.jsonl",
        250,
        ClaudeSpendChunk {
            billed: 60,
            consumed: 150,
            last_id: Some("msg-2".into()),
        },
    );
    assert_eq!(baseline.billed, 100);
    assert_eq!(baseline.offset, 250);
    assert_eq!(baseline.last_id.as_deref(), Some("msg-2"));
}

/// The cumulative runtime's first sight measures nothing, then differences.
#[test]
fn a_cumulative_baseline_measures_from_first_sight() {
    let mut baseline = SpendBaseline::default();
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "/r.jsonl", Some(1_000_000)),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "/r.jsonl", Some(1_000_250)),
        SpendSinceBaseline::Measured(250)
    );
    assert_eq!(baseline.billed, 250);
}

/// First sight reads NOTHING: the baseline is the file's current end, taken
/// from a stat. The old code called the reader at offset 0 and discarded the
/// chunk, parsing up to 4MB of a 418MB file on the tick thread while the
/// module header claimed a cold start never parses history. Found by review.
#[test]
fn first_sight_takes_the_end_of_the_file_without_reading_it() {
    let dir = scratch("first-sight");
    let path = dir.join("transcript.jsonl");
    let history = format!(
        "{}{}",
        claude_line("old-1", 900_000, 0, 0, 100_000),
        claude_line("old-2", 800_000, 0, 0, 100_000)
    );
    std::fs::write(&path, &history).expect("seed history");

    let mut baseline = SpendBaseline::default();
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    assert_eq!(
        baseline.offset,
        history.len() as u64,
        "the baseline is the end of the file"
    );
    assert_eq!(
        baseline.billed, 0,
        "and nothing written before the goal is charged to it"
    );
    assert_eq!(
        baseline.last_id, None,
        "nothing was parsed, so no id was carried"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A full window with no complete line in it is one record longer than the
/// window, not a quiet file. Leaving the offset alone re-reads the same bytes
/// every tick for ever.
#[test]
fn a_full_window_with_no_line_in_it_is_an_oversized_record() {
    assert!(chunk_spans_an_oversized_record(0, MAX_CHUNK_BYTES));
    // A short read with nothing complete in it is a record still being
    // written, which MUST be waited for rather than stepped over.
    assert!(!chunk_spans_an_oversized_record(0, 64));
    // And a window that did yield lines is just a busy session.
    assert!(!chunk_spans_an_oversized_record(4_096, MAX_CHUNK_BYTES));
}

/// The stall this exists to stop: one record bigger than the window froze the
/// offset, so spend never moved again and the goal reminded as unmet for ever.
/// The longest line in the transcript this was built against is 2,992,506
/// bytes, so it is one large tool result away.
#[test]
fn a_record_longer_than_the_window_is_stepped_over_rather_than_re_read() {
    let dir = std::env::temp_dir().join(format!("aimux-oversized-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("transcript.jsonl");
    std::fs::write(&path, claude_line("msg-1", 10, 0, 0, 5)).expect("seed transcript");

    let mut baseline = SpendBaseline::default();
    // First sight only takes the baseline; nothing before it is this goal's.
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );

    let oversized = format!(
        "{{\"type\":\"assistant\",\"pad\":\"{}\"}}\n",
        "x".repeat(MAX_CHUNK_BYTES as usize + 1_024)
    );
    let appended = format!("{oversized}{}", claude_line("msg-2", 100, 9_000, 20, 30));
    std::fs::write(
        &path,
        format!("{}{appended}", claude_line("msg-1", 10, 0, 0, 5)),
    )
    .expect("append transcript");

    // Ten ticks is far more than the two it takes to step over a record this
    // size, and the point is that the offset MOVES every time.
    let mut offsets = Vec::new();
    for _ in 0..10 {
        spend_for_session("claude", Some(path.as_path()), &mut baseline);
        offsets.push(baseline.offset);
    }
    assert!(
        offsets.windows(2).any(|pair| pair[0] != pair[1]),
        "the offset must advance past an oversized record, got {offsets:?}"
    );
    assert_eq!(
        baseline.offset,
        std::fs::metadata(&path).expect("stat").len(),
        "and it must end up at the end of the file"
    );
    // The oversized record's own tokens are lost -- it was never parsed -- but
    // the record AFTER it is counted, which is what proves the reader
    // recovered instead of being left mid-line for ever.
    assert_eq!(
        baseline.billed, 150,
        "100 input + 20 cache creation + 30 output, with the 9000 cache reads excluded"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A session can hold one token goal after another without its loop ever going
/// inactive, and the spend of the one before is not this one's. Carrying it
/// over made a fresh 50,000 budget read as met the moment it was set, on a
/// session that had already spent more than that, and the reminders never
/// fired again.
#[test]
fn a_replaced_goal_starts_counting_again() {
    let mut baseline = SpendBaseline {
        billed: 60_000,
        offset: 4_096,
        last_id: Some("msg-9".into()),
        transcript: Some("/t.jsonl".into()),
        episode: Some("2026-10-12T00:00:00.000Z|250000".into()),
        cumulative_at_baseline: Some(1_000),
    };

    assert!(
        rebaseline_for_new_episode(&mut baseline, "2026-10-12T09:00:00.000Z|50000"),
        "a different goal is a different count"
    );
    assert_eq!(
        baseline.billed, 0,
        "the previous goal's spend is not this one's"
    );
    assert_eq!(baseline.offset, 0);
    assert_eq!(baseline.last_id, None);
    assert_eq!(baseline.cumulative_at_baseline, None);
    assert_eq!(
        baseline.transcript, None,
        "cleared so the next read takes a fresh position rather than summing \
         forward from the old goal's"
    );

    // Re-adding the SAME budget at a new time is still a new goal, because the
    // start moved.
    assert!(rebaseline_for_new_episode(
        &mut baseline,
        "2026-10-12T10:00:00.000Z|50000"
    ));

    // And an unchanged goal is not disturbed tick after tick.
    baseline.billed = 1_234;
    assert!(!rebaseline_for_new_episode(
        &mut baseline,
        "2026-10-12T10:00:00.000Z|50000"
    ));
    assert_eq!(baseline.billed, 1_234, "an unchanged goal keeps counting");
}

/// The episode survives the OTHER two resets, which are about the file rather
/// than the goal: a truncated or forked transcript still belongs to the goal
/// that was running.
#[test]
fn a_forked_transcript_does_not_look_like_a_new_goal() {
    let mut baseline = SpendBaseline {
        episode: Some("since|500".into()),
        transcript: Some("/old.jsonl".into()),
        billed: 10,
        ..SpendBaseline::default()
    };
    advance_summed_baseline(
        &mut baseline,
        "/new.jsonl",
        4_096,
        ClaudeSpendChunk::default(),
    );
    assert_eq!(
        baseline.episode.as_deref(),
        Some("since|500"),
        "a new file is not a new goal"
    );
    assert_eq!(baseline.billed, 0, "but it does restart the count");
    assert!(!rebaseline_for_new_episode(&mut baseline, "since|500"));
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-spend-{}-{}-{name}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

#[test]
fn fallible_reader_distinguishes_missing_transcript_from_stat_failure() {
    let dir = scratch("stat-outcomes");
    let missing = dir.join("not-written.jsonl");
    let regular = dir.join("regular-file");
    std::fs::write(&regular, "not a directory").expect("seed regular file");
    let invalid = regular.join("transcript.jsonl");
    let mut baseline = SpendBaseline::default();

    assert_eq!(
        try_spend_for_session("claude", Some(&missing), &mut baseline),
        Ok(SpendSinceBaseline::Unmeasured(NO_TRANSCRIPT_YET))
    );
    let error = try_spend_for_session("claude", Some(&invalid), &mut baseline)
        .expect_err("a non-directory path component is a failed stat, not absence");
    assert!(error.contains("stat"), "operation must be named: {error}");
    assert!(error.contains(invalid.to_str().expect("path")));
    assert_eq!(baseline, SpendBaseline::default());
    assert_eq!(
        spend_for_session("claude", Some(&invalid), &mut baseline),
        SpendSinceBaseline::Unmeasured(TRANSCRIPT_UNREADABLE)
    );
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn a_directory_at_the_transcript_path_is_a_collection_error() {
    let dir = scratch("directory-outcome");
    let error = try_spend_for_session("codex", Some(&dir), &mut SpendBaseline::default())
        .expect_err("a directory is not a transcript that has yet to be written");
    assert!(error.contains("not a regular file"));
    assert!(error.contains(dir.to_str().expect("path")));
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn persisted_baseline_resumes_without_recounting_and_runtimes_share_a_currency() {
    let dir = scratch("shared-currency");
    let claude = dir.join("claude.jsonl");
    let codex = dir.join("codex.jsonl");
    let codex_line = |input: u64, cached: u64, write: u64, output: u64| {
        serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": input,
                        "cached_input_tokens": cached,
                        "cache_write_input_tokens": write,
                        "output_tokens": output,
                    }
                }
            }
        })
        .to_string()
            + "\n"
    };
    let old_claude = claude_line("old", 1_000, 900_000, 20, 30);
    let old_codex = codex_line(901_000, 900_000, 20, 30);
    std::fs::write(&claude, &old_claude).expect("seed Claude");
    std::fs::write(&codex, &old_codex).expect("seed Codex");

    for (tool, path, appended) in [
        (
            "claude",
            &claude,
            format!("{old_claude}{}", claude_line("new", 100, 999_999, 7, 10)),
        ),
        (
            "codex",
            &codex,
            format!("{old_codex}{}", codex_line(1_901_099, 1_899_999, 27, 40)),
        ),
    ] {
        let mut baseline = SpendBaseline::default();
        assert_eq!(
            try_spend_for_session(tool, Some(path), &mut baseline),
            Ok(SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN))
        );
        std::fs::write(path, appended).expect("append usage");
        assert_eq!(
            try_spend_for_session(tool, Some(path), &mut baseline),
            Ok(SpendSinceBaseline::Measured(117)),
            "{tool} must count 100 fresh input + 7 cache writes + 10 output"
        );
        let saved = serde_json::to_value(&baseline).expect("serialize baseline");
        assert!(saved.get("cumulativeAtBaseline").is_some());
        assert!(saved.get("lastId").is_some());
        let mut restored: SpendBaseline = serde_json::from_value(saved).expect("restore baseline");
        assert_eq!(restored, baseline);
        assert_eq!(
            try_spend_for_session(tool, Some(path), &mut restored),
            Ok(SpendSinceBaseline::Measured(117)),
            "{tool} must retain its count across persisted-baseline restore"
        );
    }
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

/// A transcript truncated or replaced in place under the SAME name restarts
/// the count, and reporting that as `Measured(0)` told a goal at 480,000 of a
/// 500,000 budget that it had spent nothing -- labelled as a measurement, so
/// every surface believed it. Found by review.
#[test]
fn a_truncated_transcript_says_it_is_measuring_again_rather_than_zero() {
    let dir = scratch("truncate");
    let path = dir.join("transcript.jsonl");
    std::fs::write(&path, claude_line("msg-1", 10, 0, 0, 5)).expect("seed");

    let mut baseline = SpendBaseline::default();
    spend_for_session("claude", Some(path.as_path()), &mut baseline);
    std::fs::write(
        &path,
        format!(
            "{}{}",
            claude_line("msg-1", 10, 0, 0, 5),
            claude_line("msg-2", 400_000, 0, 20_000, 60_000)
        ),
    )
    .expect("append");
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Measured(480_000),
        "spent, and measured"
    );

    // Replaced in place, same path, now shorter than the stored offset.
    std::fs::write(&path, claude_line("msg-9", 1, 0, 0, 1)).expect("truncate");
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN),
        "a restarted count is not a measurement of zero"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A read that FAILED is a third outcome. Reporting it as "no transcript
/// written yet" told the user nothing had been written while the cause went
/// nowhere -- AGENTS.md "errors are not empty values".
#[test]
fn an_unreadable_transcript_is_not_reported_as_one_that_was_never_written() {
    let dir = scratch("unreadable");
    let path = dir.join("transcript.jsonl");
    std::fs::write(&path, claude_line("msg-1", 10, 0, 0, 5)).expect("seed");

    // The baseline is taken from a stat, so the failure has to happen on a
    // tick that actually reads -- which is every tick after the first.
    let mut baseline = SpendBaseline::default();
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    std::fs::write(
        &path,
        format!(
            "{}{}",
            claude_line("msg-1", 10, 0, 0, 5),
            claude_line("msg-2", 20, 0, 0, 5)
        ),
    )
    .expect("append");
    let mut permissions = std::fs::metadata(&path).expect("stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o000);
    std::fs::set_permissions(&path, permissions).expect("chmod");

    // Asked directly rather than inferred from the result: a test that
    // accepted NO_TRANSCRIPT_YET as "probably root" could never fail, which is
    // the whole class of bug this file exists to catch.
    assert!(
        std::fs::File::open(&path).is_err(),
        "this process can read a 0o000 file, so the case cannot be set up here"
    );
    let error = try_spend_for_session("claude", Some(&path), &mut baseline)
        .expect_err("preserve the failed open for usage collection");
    assert!(error.contains("open"), "operation must be named: {error}");
    assert!(error.contains(path.to_str().expect("path")));
    assert_eq!(
        spend_for_session("claude", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(TRANSCRIPT_UNREADABLE),
        "an I/O failure must not read as absence"
    );
    assert_ne!(
        TRANSCRIPT_UNREADABLE, NO_TRANSCRIPT_YET,
        "and the two must be distinguishable at all"
    );

    let mut permissions = std::fs::metadata(&path).expect("stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o600);
    std::fs::set_permissions(&path, permissions).ok();
    std::fs::remove_dir_all(&dir).ok();
}

/// Codex keeps a running total, and the tail has to be big enough to contain
/// one. On a real 154MB rollout 128 of 1,832 gaps between `token_count`
/// records exceed 256KiB, the largest being 2,380,073 bytes -- and those are
/// the big-tool-output windows where spend is highest. A tail that misses the
/// record read as no transcript at all.
#[test]
fn a_codex_total_far_from_the_end_of_the_file_is_still_found() {
    let dir = scratch("codex-tail");
    let path = dir.join("rollout.jsonl");
    let total = r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"cache_write_input_tokens":200,"output_tokens":300}}}}"#;
    // One megabyte of ordinary records after the total, which is four times
    // the old window and well inside the real gaps measured above.
    let filler = (0..4_000)
        .map(|index| {
            format!(
                "{{\"payload\":{{\"type\":\"event\",\"index\":{index},\"pad\":\"{}\"}}}}\n",
                "y".repeat(240)
            )
        })
        .collect::<String>();
    assert!(
        filler.len() > 256 * 1024,
        "the filler must exceed the old 256KiB tail, got {}",
        filler.len()
    );
    std::fs::write(&path, format!("{total}\n{filler}")).expect("seed rollout");

    let mut baseline = SpendBaseline::default();
    assert_eq!(
        spend_for_session("codex", Some(path.as_path()), &mut baseline),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN),
        "first sight takes the baseline"
    );
    assert_eq!(
        baseline.cumulative_at_baseline,
        Some(4_500),
        "5000 input - 1000 cached + 200 cache write + 300 output, found past \
         the old window"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A multi-byte character straddling the tail boundary made the strict reader
/// return nothing, and nothing read as "no transcript written yet". Spend
/// cannot be stopped by one mangled character.
#[test]
fn a_split_character_at_the_tail_boundary_does_not_erase_the_reading() {
    let dir = scratch("codex-split");
    let path = dir.join("rollout.jsonl");
    let total = r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10}}}}"#;
    // Padded so the window starts inside a multi-byte character: the tail is
    // taken from the END, so the boundary lands wherever the file length puts
    // it, and a run of them guarantees one is split.
    let padding = "é".repeat(3_000_000);
    std::fs::write(&path, format!("{{\"pad\":\"{padding}\"}}\n{total}\n")).expect("seed rollout");

    let mut baseline = SpendBaseline::default();
    spend_for_session("codex", Some(path.as_path()), &mut baseline);
    assert_eq!(
        baseline.cumulative_at_baseline,
        Some(100),
        "the total must still be read across a split character"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn strict_claude_usage_errors_preserve_baseline_and_repair_counts_once() {
    let dir = scratch("strict-claude");
    let path = dir.join("claude.jsonl");
    let seed = "{}\n";
    for bad in [
        "{\"message\":{\"usage\": broken}\n",
        "{\"message\":{\"usage\":false}}\n",
        "{\"message\":{\"usage\":{\"input_tokens\":\"broken\"}}}\n",
        "{\"message\":{\"usage\":{\"output_tokens\":-1}}}\n",
        "{\"message\":{\"usage\":{}}}\n",
    ] {
        std::fs::write(&path, seed).unwrap();
        let mut baseline = SpendBaseline::default();
        try_spend_for_session("claude", Some(&path), &mut baseline).unwrap();
        let saved = baseline.clone();
        std::fs::write(&path, format!("{seed}{bad}")).unwrap();
        let error = try_spend_for_session("claude", Some(&path), &mut baseline).unwrap_err();
        assert!(error.contains("Claude"), "{error}");
        assert!(error.contains(path.to_str().unwrap()), "{error}");
        assert_eq!(baseline, saved, "failed parsing cannot consume bytes");
        assert!(try_spend_for_session("claude", Some(&path), &mut baseline).is_err());
        std::fs::write(
            &path,
            format!("{seed}{}", claude_line("repaired", 100, 900000, 20, 30)),
        )
        .unwrap();
        assert_eq!(
            try_spend_for_session("claude", Some(&path), &mut baseline).unwrap(),
            SpendSinceBaseline::Measured(150)
        );
        assert_eq!(
            try_spend_for_session("claude", Some(&path), &mut baseline).unwrap(),
            SpendSinceBaseline::Measured(150)
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn strict_claude_reader_leaves_partial_usage_and_accepts_nonusage_records() {
    let dir = scratch("strict-claude-partial");
    let path = dir.join("claude.jsonl");
    std::fs::write(&path, "{}\n").unwrap();
    let mut baseline = SpendBaseline::default();
    try_spend_for_session("claude", Some(&path), &mut baseline).unwrap();
    let nonusage = "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n";
    let complete = claude_line("partial", 10, 999999, 2, 3);
    let split = complete.find("input_tokens").unwrap() + 6;
    std::fs::write(&path, format!("{{}}\n{nonusage}{}", &complete[..split])).unwrap();
    assert_eq!(
        try_spend_for_session("claude", Some(&path), &mut baseline).unwrap(),
        SpendSinceBaseline::Measured(0)
    );
    assert_eq!(baseline.offset, 3 + nonusage.len() as u64);
    std::fs::write(&path, format!("{{}}\n{nonusage}{complete}")).unwrap();
    assert_eq!(
        try_spend_for_session("claude", Some(&path), &mut baseline).unwrap(),
        SpendSinceBaseline::Measured(15)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

fn strict_codex_record(input: u64) -> String {
    serde_json::json!({"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"cached_input_tokens":0,"output_tokens":0}}}}).to_string() + "\n"
}

#[test]
fn strict_codex_usage_errors_do_not_rebaseline_or_fall_back_to_stale_totals() {
    let dir = scratch("strict-codex");
    let path = dir.join("codex.jsonl");
    let seed = strict_codex_record(100);
    for bad in [
        "{\"payload\":{\"type\":\"token_count\",broken}\n",
        "{\"payload\":{\"type\":\"token_count\",\"info\":false}}\n",
        "{\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":false}}}\n",
        "{\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":\"broken\"}}}}\n",
        "{\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{}}}}\n",
    ] {
        std::fs::write(&path, &seed).unwrap();
        let mut baseline = SpendBaseline::default();
        try_spend_for_session("codex", Some(&path), &mut baseline).unwrap();
        let saved = baseline.clone();
        std::fs::write(&path, format!("{seed}{bad}")).unwrap();
        let error = try_spend_for_session("codex", Some(&path), &mut baseline).unwrap_err();
        assert!(error.contains("Codex"), "{error}");
        assert_eq!(baseline, saved);
        std::fs::write(&path, format!("{seed}{}", strict_codex_record(150))).unwrap();
        assert_eq!(
            try_spend_for_session("codex", Some(&path), &mut baseline).unwrap(),
            SpendSinceBaseline::Measured(50)
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn strict_codex_reader_ignores_partial_records_and_quota_only_events() {
    let dir = scratch("strict-codex-partial");
    let path = dir.join("codex.jsonl");
    let seed = strict_codex_record(100);
    let no_usage = "{\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":null}}\n";
    std::fs::write(&path, &seed).unwrap();
    let mut baseline = SpendBaseline::default();
    try_spend_for_session("codex", Some(&path), &mut baseline).unwrap();
    std::fs::write(
        &path,
        format!("{seed}{no_usage}{{\"payload\":{{\"type\":\"token_count\",\"info\":"),
    )
    .unwrap();
    assert_eq!(
        try_spend_for_session("codex", Some(&path), &mut baseline).unwrap(),
        SpendSinceBaseline::Measured(0)
    );
    std::fs::write(&path, no_usage).unwrap();
    assert_eq!(
        try_spend_for_session("codex", Some(&path), &mut baseline).unwrap(),
        SpendSinceBaseline::Unmeasured(NO_TRANSCRIPT_YET)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cumulative_reset_clears_old_billed_value_before_next_delta() {
    let mut baseline = SpendBaseline::default();
    advance_cumulative_baseline(&mut baseline, "same", Some(100));
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "same", Some(250)),
        SpendSinceBaseline::Measured(150)
    );
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "same", Some(10)),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    assert_eq!(baseline.billed, 0);
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "same", Some(30)),
        SpendSinceBaseline::Measured(20)
    );
}

#[test]
fn cumulative_drop_above_initial_baseline_still_restarts_measurement() {
    let mut baseline = SpendBaseline::default();
    advance_cumulative_baseline(&mut baseline, "same", Some(100));
    advance_cumulative_baseline(&mut baseline, "same", Some(250));
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "same", Some(200)),
        SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)
    );
    assert_eq!(baseline.billed, 0);
    assert_eq!(
        advance_cumulative_baseline(&mut baseline, "same", Some(220)),
        SpendSinceBaseline::Measured(20)
    );
}

#[test]
fn strict_claude_reader_recovers_after_oversized_usage_record_fragment() {
    let dir = scratch("strict-claude-oversized");
    let path = dir.join("claude.jsonl");
    let seed = "{}\n";
    std::fs::write(&path, seed).unwrap();
    let mut baseline = SpendBaseline::default();
    try_spend_for_session("claude", Some(&path), &mut baseline).unwrap();
    let oversized = format!(
        "{{\"pad\":\"{}\",\"message\":{{\"usage\":{{\"input_tokens\":50}}}}}}\n",
        "x".repeat(MAX_CHUNK_BYTES as usize)
    );
    std::fs::write(
        &path,
        format!("{seed}{oversized}{}", claude_line("after", 10, 100, 2, 3)),
    )
    .unwrap();
    try_spend_for_session("claude", Some(&path), &mut baseline).unwrap();
    assert_eq!(
        try_spend_for_session("claude", Some(&path), &mut baseline).unwrap(),
        SpendSinceBaseline::Measured(15)
    );
    assert_eq!(baseline.offset, std::fs::metadata(&path).unwrap().len());
    std::fs::remove_dir_all(dir).unwrap();
}
