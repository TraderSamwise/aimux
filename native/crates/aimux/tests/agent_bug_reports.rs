//! The opt-in and the store, judged against `docs/agent-bug-reports.md`.
//!
//! The security-relevant cases come first, because they are the reason the
//! feature is opt-in at all: a report is written by an agent that has the
//! user's repository open.

use aimux::agent_bug_reports::{
    AgentBugReport, BUG_REPORT_RECORD_KIND, BugReportRefusal, is_enabled, read_all, record,
    store_path,
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

fn file(machine: &Machine, report: &AgentBugReport) -> Result<PathBuf, BugReportRefusal> {
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
    let path = file(&machine, &report()).expect("a report is stored once reporting is on");
    assert_eq!(path, store_path(&machine.resolver()));

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
