//! Billed-equivalent token spend, and the traps in getting there.

use aimux::agent_token_spend::{
    BASELINE_JUST_TAKEN, ClaudeSpendChunk, MAX_CHUNK_BYTES, NO_TRANSCRIPT_YET, SpendBaseline,
    SpendSinceBaseline, advance_cumulative_baseline, advance_summed_baseline,
    chunk_spans_an_oversized_record, claude_spend_chunk, codex_cumulative_billed,
    cumulative_spend_since, offset_still_valid, rebaseline_for_new_episode, runtime_reports_usage,
    spend_for_session,
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
