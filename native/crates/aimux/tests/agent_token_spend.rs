//! Billed-equivalent token spend, and the traps in getting there.

use aimux::agent_token_spend::{
    BASELINE_JUST_TAKEN, NO_TRANSCRIPT_YET, SpendSinceBaseline, claude_spend_chunk,
    codex_cumulative_billed, cumulative_spend_since, offset_still_valid, runtime_reports_usage,
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
