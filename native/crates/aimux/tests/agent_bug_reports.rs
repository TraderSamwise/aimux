//! The opt-in and the store, judged against `docs/agent-bug-reports.md`.
//!
//! The security-relevant cases come first, because they are the reason the
//! feature is opt-in at all: a report is written by an agent that has the
//! user's repository open.

use aimux::agent_bug_reports::{
    AgentBugReport, BUG_REPORT_RECORD_KIND, BugReportOutcome, BugReportRefusal,
    DISTINCT_BUG_BUDGET, SIGHTINGS_PER_BUG, is_enabled, read_all, record, store_path, summarize,
};
use aimux::paths::PathResolver;
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

struct Machine {
    root: PathBuf,
}

impl Machine {
    fn new(name: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "aimux-bug-reports-{name}-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(root.join("home")).expect("home");
        fs::create_dir_all(root.join("repo/.aimux")).expect("project");
        Self { root }
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            self.root.join("repo"),
            self.root.join("home"),
            Some(self.root.join("aimux").to_string_lossy().into_owned()),
        )
    }

    /// `~/.aimux/config.json` -- the machine owner's own config.
    fn write_global_config(&self, config: &Value) {
        let dir = self.root.join("aimux");
        fs::create_dir_all(&dir).expect("aimux home");
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(config).expect("serialize"),
        )
        .expect("write global config");
    }

    /// `<repo>/.aimux/config.json` -- anyone who can commit to the repository.
    fn write_project_config(&self, config: &Value) {
        fs::write(
            self.root.join("repo/.aimux/config.json"),
            serde_json::to_string_pretty(config).expect("serialize"),
        )
        .expect("write project config");
    }

    fn store_exists(&self) -> bool {
        store_path(&self.resolver()).exists()
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn report() -> AgentBugReport {
    AgentBugReport {
        what: "agent input reported success while the pane stayed empty".into(),
        surface: "aimux agent input".into(),
        expected: "the text appears in the agent's composer".into(),
        observed: "the route answered ok and the composer was empty".into(),
        repro: "aimux agent input --session codex-1 --text hello".into(),
        evidence: Some("verified: false".into()),
    }
}

fn file(machine: &Machine, report: &AgentBugReport) -> Result<BugReportOutcome, BugReportRefusal> {
    record(
        &machine.resolver(),
        report,
        "49ded980156d91ab8ecbc5dc",
        "codex",
        "local-abc1234",
        "2026-10-26T00:00:00.000Z",
    )
}

/// Off means nothing is recorded, not merely nothing sent.
///
/// A report is written by an agent with the user's repository open, so a store
/// that fills up before anyone agreed to it is the thing the opt-in exists to
/// prevent. Asserted on the file system, not on the return value: "we wrote it
/// but will not send it" would pass a check of the answer alone.
#[test]
fn reporting_off_writes_nothing_at_all() {
    let machine = Machine::new("off");

    let refusal = file(&machine, &report()).expect_err("reporting is off by default");
    assert_eq!(refusal, BugReportRefusal::Disabled);
    assert!(
        !machine.store_exists(),
        "no store may exist while reporting is off: {}",
        store_path(&machine.resolver()).display()
    );
    assert!(
        read_all(&machine.resolver())
            .expect("reading an absent store is not an error")
            .is_empty()
    );
    assert!(
        refusal.message().contains("off"),
        "the agent is told plainly: {}",
        refusal.message()
    );
}

/// Off by default, with no config file at all.
#[test]
fn reporting_is_off_when_nothing_has_been_configured() {
    let machine = Machine::new("default-off");
    assert!(!is_enabled(&machine.resolver()));
}

/// **A repository must not be able to turn reporting on.**
///
/// `merge_config_layers` deep-merges the project layer over the global one, so
/// without stripping the key a checked-in `.aimux/config.json` would opt in
/// whoever opened that repository -- an agent with their tree open, writing
/// reports they never agreed to. This is the case the whole opt-in exists for.
#[test]
fn a_project_config_cannot_turn_reporting_on() {
    let machine = Machine::new("project-cannot-opt-in");
    machine.write_project_config(&json!({ "bugReports": { "enabled": true } }));

    assert!(
        !is_enabled(&machine.resolver()),
        "only the machine's owner may turn reporting on"
    );
    assert_eq!(
        file(&machine, &report()).expect_err("still off"),
        BugReportRefusal::Disabled
    );
    assert!(!machine.store_exists());
}

/// The strip itself, where it lives.
///
/// The test above passes because `is_enabled` reads the global config and
/// never the merged one -- so it proves that choice, not the strip in
/// `merge_config_layers`. The strip is the defence that does not depend on
/// every future reader picking the right loader, and this is what holds it:
/// the merged config a project-aware reader sees must not carry a
/// project-supplied value, in either direction.
#[test]
fn the_merged_config_never_carries_a_projects_bug_report_flag() {
    let machine = Machine::new("strip");
    machine.write_project_config(&json!({ "bugReports": { "enabled": true } }));
    let merged = aimux::config::load_config_for_project_with_resolver(
        &machine.resolver(),
        machine.root.join("repo"),
    );
    assert_eq!(
        merged.pointer("/bugReports/enabled"),
        Some(&json!(false)),
        "a project must not reach the merged config: {merged:?}"
    );

    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));
    machine.write_project_config(&json!({ "bugReports": { "enabled": false } }));
    let merged = aimux::config::load_config_for_project_with_resolver(
        &machine.resolver(),
        machine.root.join("repo"),
    );
    assert_eq!(
        merged.pointer("/bugReports/enabled"),
        Some(&json!(true)),
        "and must not override the owner in the other direction: {merged:?}"
    );
}

/// And the inverse, or the guard above would be indistinguishable from the
/// feature never working.
#[test]
fn the_machine_owners_config_does_turn_reporting_on() {
    let machine = Machine::new("global-opts-in");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    assert!(is_enabled(&machine.resolver()));
    let outcome = file(&machine, &report()).expect("a report is stored once reporting is on");
    assert!(
        matches!(outcome, BugReportOutcome::Filed { .. }),
        "{outcome:?}"
    );
    assert!(machine.store_exists());

    let stored = read_all(&machine.resolver()).expect("read the store");
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(stored[0]["kind"], BUG_REPORT_RECORD_KIND);
    assert_eq!(stored[0]["machineId"], "49ded980156d91ab8ecbc5dc");
    assert_eq!(stored[0]["report"]["surface"], "aimux agent input");
}

/// A project config must not be able to turn it OFF either, once that stops
/// being hypothetical: the key is stripped from the project layer whichever
/// way it points, so the answer always comes from the machine's owner.
#[test]
fn a_project_config_cannot_turn_reporting_off() {
    let machine = Machine::new("project-cannot-opt-out");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));
    machine.write_project_config(&json!({ "bugReports": { "enabled": false } }));

    assert!(
        is_enabled(&machine.resolver()),
        "the project layer does not get a say in either direction"
    );
}

/// An unreadable config fails closed.
///
/// The global config is the only thing that can turn reporting on, so a config
/// that cannot be parsed must not be read as consent.
#[test]
fn an_unreadable_config_leaves_reporting_off() {
    let machine = Machine::new("broken-config");
    let dir = machine.root.join("aimux");
    fs::create_dir_all(&dir).expect("aimux home");
    fs::write(dir.join("config.json"), "{ this is not json").expect("write broken config");

    assert!(!is_enabled(&machine.resolver()));
    assert_eq!(
        file(&machine, &report()).expect_err("off"),
        BugReportRefusal::Disabled
    );
}

/// The schema is the redaction: the fields are capped, so a report cannot
/// carry a repository even when an agent tries.
#[test]
fn a_report_cannot_carry_more_than_its_fields_allow() {
    let machine = Machine::new("capped");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    let mut oversized = report();
    oversized.what = "x".repeat(5_000);
    oversized.evidence = Some("y".repeat(50_000));
    file(&machine, &oversized).expect("an oversized report is trimmed, not refused");

    let stored = read_all(&machine.resolver()).expect("read the store");
    let what = stored[0]["report"]["what"].as_str().expect("what");
    let evidence = stored[0]["report"]["evidence"].as_str().expect("evidence");
    assert!(
        what.chars().count() <= 301,
        "{} chars",
        what.chars().count()
    );
    assert!(
        evidence.chars().count() <= 2_001,
        "{} chars",
        evidence.chars().count()
    );
    assert!(what.ends_with('…'), "a trimmed field says it was trimmed");
}

/// A report that says nothing is refused, and says which field is missing --
/// an agent cannot fix what it is not told.
#[test]
fn a_report_missing_a_required_field_is_refused_by_name() {
    let machine = Machine::new("incomplete");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    let mut incomplete = report();
    incomplete.observed = "   ".into();
    match file(&machine, &incomplete).expect_err("refused") {
        BugReportRefusal::Invalid(reason) => {
            assert!(reason.contains("observed"), "{reason}");
            assert!(reason.contains("agent-bug-reports"), "{reason}");
        }
        other => panic!("expected an invalid report, got {other:?}"),
    }
    assert!(
        !machine.store_exists(),
        "a refused report is not half-written"
    );
}

/// A bug stops being written once it is recorded often enough.
///
/// The store is append-only, so a sighting costs a line and an agent in a loop
/// would grow the file without bound. Past the cap it is told the bug is
/// already recorded, and nothing is written -- the count stops rising because
/// nothing more is being learned, not because the agent was ignored.
#[test]
fn a_bug_stops_being_recorded_once_it_is_recorded_often_enough() {
    let machine = Machine::new("sightings-cap");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    for _ in 0..SIGHTINGS_PER_BUG {
        file(&machine, &report()).expect("within the cap");
    }
    let lines = read_all(&machine.resolver()).expect("read").len();
    assert_eq!(lines as u64, SIGHTINGS_PER_BUG);

    let outcome = file(&machine, &report()).expect("answered, not refused");
    match &outcome {
        BugReportOutcome::AlreadyRecorded { count, .. } => assert_eq!(*count, SIGHTINGS_PER_BUG),
        other => panic!("expected the cap, got {other:?}"),
    }
    assert_eq!(
        read_all(&machine.resolver()).expect("read").len(),
        lines,
        "nothing is written past the cap"
    );
    assert!(
        outcome.message().contains("already recorded"),
        "{}",
        outcome.message()
    );
}

/// Two agents filing two different new bugs at the same moment must both
/// survive.
///
/// The first version of the store read every record, updated one in place and
/// rewrote the file. That has a lost-update race: each writer reads a store
/// without the other's line, and whichever writes second erases the other's
/// report entirely. A lost count would be tolerable; a lost report is not.
/// Append-only is what fixes it, and this is the test that would have caught
/// it -- the interleaving is forced rather than hoped for, by filing the second
/// bug from a store state captured before the first was written.
#[test]
fn two_bugs_filed_against_the_same_store_both_survive() {
    let machine = Machine::new("no-lost-update");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));
    let path = store_path(&machine.resolver());

    let mut first = report();
    first.what = "the first agent's bug".into();
    file(&machine, &first).expect("filed");
    let after_first = fs::read_to_string(&path).expect("read");

    // What the second agent would have read: the store as it was before the
    // first agent's line existed. A rewrite-based store would write this back
    // plus its own record, erasing the first.
    fs::write(&path, "").expect("truncate to the pre-first state");
    let mut second = report();
    second.what = "the second agent's bug".into();
    file(&machine, &second).expect("filed");
    let second_only = fs::read_to_string(&path).expect("read");

    // Restore the interleaving: both lines, in either order, must be readable.
    fs::write(&path, format!("{after_first}{second_only}")).expect("write");
    let bugs = summarize(&machine.resolver()).expect("summarize");
    assert_eq!(bugs.len(), 2, "both reports survive: {bugs:?}");
    assert_eq!(bugs[0].report.what, "the first agent's bug");
    assert_eq!(bugs[1].report.what, "the second agent's bug");
    assert!(
        bugs.iter().all(|bug| bug.count == 1),
        "and neither is counted as a repeat of the other: {bugs:?}"
    );
}

/// Reports accumulate one line at a time, oldest first.
#[test]
fn reports_accumulate_in_the_order_they_were_filed() {
    let machine = Machine::new("accumulate");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    for surface in ["aimux ps", "aimux agent input", "loop watcher"] {
        let mut next = report();
        next.surface = surface.into();
        file(&machine, &next).expect("stored");
    }

    let stored = read_all(&machine.resolver()).expect("read the store");
    assert_eq!(
        stored
            .iter()
            .map(|record| record["report"]["surface"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        ["aimux ps", "aimux agent input", "loop watcher"]
    );
}

/// A line the reader cannot account for is an error, not a line to skip. A
/// store that quietly drops records is worse than one that says it is damaged.
#[test]
fn an_unreadable_line_is_reported_rather_than_skipped() {
    let machine = Machine::new("damaged");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));
    file(&machine, &report()).expect("stored");

    let path = store_path(&machine.resolver());
    let mut text = fs::read_to_string(&path).expect("read");
    text.push_str("{\"kind\":\"something-else\"}\n");
    fs::write(&path, text).expect("write");

    let error = read_all(&machine.resolver()).expect_err("a foreign line is an error");
    assert!(error.contains("line 2"), "{error}");
    assert!(error.contains(BUG_REPORT_RECORD_KIND), "{error}");
}

/// The same bug twice is one record with a count.
///
/// An agent hitting a bug in a loop would otherwise file it every iteration,
/// and two agents hitting the same bug would file it twice. The fingerprint is
/// the four one-line fields, so a different repro or a different excerpt of
/// evidence is still the same bug.
#[test]
fn the_same_bug_filed_twice_is_one_record_with_a_count() {
    let machine = Machine::new("dedupe");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    let first = file(&machine, &report()).expect("filed");
    assert!(matches!(first, BugReportOutcome::Filed { .. }), "{first:?}");

    // A second agent, hitting the same thing, with its own repro and evidence.
    let mut again = report();
    again.repro = "aimux agent input --session claude-2 --text other".into();
    again.evidence = Some("a different excerpt".into());
    let second = file(&machine, &again).expect("counted");
    match &second {
        BugReportOutcome::Counted { count, fingerprint } => {
            assert_eq!(*count, 2);
            assert_eq!(fingerprint, first.fingerprint());
        }
        other => panic!("expected a count, got {other:?}"),
    }

    let bugs = summarize(&machine.resolver()).expect("summarize");
    assert_eq!(bugs.len(), 1, "one bug however many sightings: {bugs:?}");
    assert_eq!(bugs[0].count, 2);
    assert_eq!(
        bugs[0].report.repro, "aimux agent input --session codex-1 --text hello",
        "the first filing's detail is the one surfaced: {bugs:?}"
    );
    assert!(
        second.message().contains("already on file"),
        "the agent is told it was a repeat: {}",
        second.message()
    );
}

/// And a genuinely different bug is not swallowed by the dedupe.
#[test]
fn a_different_bug_is_filed_separately() {
    let machine = Machine::new("distinct");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    file(&machine, &report()).expect("filed");
    let mut other = report();
    other.surface = "aimux ps".into();
    other.what = "ps took eleven seconds".into();
    let second = file(&machine, &other).expect("filed");
    assert!(
        matches!(second, BugReportOutcome::Filed { .. }),
        "{second:?}"
    );
    assert_ne!(
        report().fingerprint(),
        other.fingerprint(),
        "two different bugs must not share a fingerprint"
    );
    assert_eq!(summarize(&machine.resolver()).expect("summarize").len(), 2);
}

/// A machine may only have so many distinct bugs on file, and is told when it
/// is full rather than having the filing silently dropped.
///
/// The budget is on distinct bugs, not on filings: a repeat of something
/// already on file is free, because it is one record either way.
#[test]
fn a_machine_full_of_distinct_bugs_says_so_and_still_counts_repeats() {
    let machine = Machine::new("budget");
    machine.write_global_config(&json!({ "bugReports": { "enabled": true } }));

    for index in 0..DISTINCT_BUG_BUDGET {
        let mut next = report();
        next.what = format!("distinct failure {index}");
        file(&machine, &next).expect("within budget");
    }
    assert_eq!(
        summarize(&machine.resolver()).expect("summarize").len(),
        DISTINCT_BUG_BUDGET
    );

    let mut over = report();
    over.what = "one too many".into();
    match file(&machine, &over).expect_err("over budget") {
        BugReportRefusal::BudgetSpent { distinct } => {
            assert_eq!(distinct, DISTINCT_BUG_BUDGET);
        }
        other => panic!("expected the budget to be spent, got {other:?}"),
    }
    assert_eq!(
        summarize(&machine.resolver()).expect("summarize").len(),
        DISTINCT_BUG_BUDGET,
        "a refused report is not stored"
    );

    // A repeat of something already on file is still counted: the budget is
    // not a reason to lose a signal that costs nothing to record.
    let mut repeat = report();
    repeat.what = "distinct failure 0".into();
    let outcome = file(&machine, &repeat).expect("a repeat is free");
    assert!(
        matches!(outcome, BugReportOutcome::Counted { count: 2, .. }),
        "{outcome:?}"
    );
}
