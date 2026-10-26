//! Where an agent's report about aimux itself goes.
//!
//! The standard this enforces is `docs/agent-bug-reports.md`: what counts,
//! what evidence is worth having, and what a report may never contain. Two of
//! its rules are structural rather than advisory, and live here.
//!
//! **Off until turned on, and off means nothing is recorded.** A report is
//! written by an agent that has the user's repository open, so the weaker
//! reading -- record locally, send on consent -- would leave a file of project
//! detail on disk for someone who never agreed to any of it.
//!
//! A checked-in `.aimux/config.json` cannot opt a user in, because
//! `merge_config_layers` strips the key from the project layer the way it
//! already strips `hosted` and `installs`. That strip is the load-bearing
//! defence and the one a test can hold: `is_enabled` also reads the global
//! config rather than the merged one, which is belt and braces that cannot be
//! told apart behaviourally while the strip holds -- so it is written for the
//! reader, not claimed as a second guarantee.
//!
//! **The schema is the redaction.** The record has no field big enough to hold
//! a repository, the text fields are capped, and nothing here takes a path, an
//! environment, or a log line aimux did not write. A reviewer's one-line test
//! is: can this struct carry the user's code? It cannot.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::config::load_global_config_with_resolver;
use crate::paths::PathResolver;

/// One line per report, like the loop self-report spool beside it.
const STORE_RELATIVE_PATH: &str = "bug-reports.jsonl";

/// The discriminator every stored line carries, so a reader that meets an
/// unknown shape can say so instead of skipping it.
pub const BUG_REPORT_RECORD_KIND: &str = "agent-bug-report";

/// A one-line field. Long enough to say what happened, too short to paste
/// anything into.
const LINE_BUDGET: usize = 300;

/// The evidence field: a handful of lines of aimux's own output, not a log.
const EVIDENCE_BUDGET: usize = 2_000;

/// How many distinct bugs one machine may have on file.
///
/// This bounds how many DIFFERENT things a machine can claim are broken.
pub const DISTINCT_BUG_BUDGET: usize = 100;

/// How many times one bug may be recorded before further sightings are
/// answered without writing anything.
///
/// The store is append-only, so a repeat costs a line. An agent hitting a bug
/// every iteration of a loop would otherwise grow the file without bound; past
/// this it is told the bug is already recorded and nothing is written. Twenty
/// sightings is already more than anyone reading the store needs to believe
/// it is recurring.
pub const SIGHTINGS_PER_BUG: u64 = 20;

/// What an agent is allowed to say about a bug in aimux.
///
/// Every field is a statement about aimux. There is deliberately no field for
/// a path, a project, a command line other than the repro, or free-form
/// context -- see the module docs.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBugReport {
    /// What aimux did that it should not have, or did not do that it should.
    pub what: String,
    /// The CLI verb, daemon route, or runtime component involved.
    pub surface: String,
    pub expected: String,
    pub observed: String,
    /// The shortest sequence that shows it, as aimux commands.
    pub repro: String,
    /// The smallest excerpt of aimux's own output that shows the failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

impl AgentBugReport {
    /// What makes two filings the same bug.
    ///
    /// The four one-line fields, and deliberately not the repro or the
    /// evidence: those vary between two agents hitting the same thing, and a
    /// fingerprint that varied with them would file one record per agent --
    /// which is the spam this exists to prevent.
    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        for field in [&self.what, &self.surface, &self.expected, &self.observed] {
            // Length-prefixed, so two fields cannot run together into the same
            // digest as a different pair that happens to concatenate equally.
            hasher.update(field.len().to_le_bytes());
            hasher.update(field.as_bytes());
        }
        format!("{:x}", hasher.finalize())[..24].to_owned()
    }

    /// Trim every field to its budget and reject one that says nothing.
    ///
    /// Capping rather than refusing, because an agent that wrote three lines
    /// where one was asked for has still told us something true; a report with
    /// no `what` has not.
    pub fn normalized(&self) -> Result<Self, String> {
        let report = Self {
            what: capped(&self.what, LINE_BUDGET),
            surface: capped(&self.surface, LINE_BUDGET),
            expected: capped(&self.expected, LINE_BUDGET),
            observed: capped(&self.observed, LINE_BUDGET),
            repro: capped(&self.repro, EVIDENCE_BUDGET),
            evidence: self
                .evidence
                .as_deref()
                .map(|evidence| capped(evidence, EVIDENCE_BUDGET))
                .filter(|evidence| !evidence.is_empty()),
        };
        for (name, value) in [
            ("what", &report.what),
            ("surface", &report.surface),
            ("expected", &report.expected),
            ("observed", &report.observed),
            ("repro", &report.repro),
        ] {
            if value.is_empty() {
                return Err(format!(
                    "a bug report needs {name}; see docs/agent-bug-reports.md"
                ));
            }
        }
        Ok(report)
    }
}

fn capped(value: &str, budget: usize) -> String {
    let trimmed = value.trim();
    match trimmed.char_indices().nth(budget) {
        None => trimmed.to_owned(),
        Some((index, _)) => format!("{}…", &trimmed[..index]),
    }
}

pub fn store_path(resolver: &PathResolver) -> PathBuf {
    resolver.global_aimux_dir().join(STORE_RELATIVE_PATH)
}

/// Whether this machine's owner has turned reporting on.
///
/// The global config only. `load_global_config_with_resolver` falls back to
/// the defaults when the file cannot be read, and the default is off, so an
/// unreadable config fails closed rather than guessing.
pub fn is_enabled(resolver: &PathResolver) -> bool {
    load_global_config_with_resolver(resolver)
        .pointer("/bugReports/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Why a report was not stored, so a caller can say which it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BugReportRefusal {
    /// The machine's owner has not turned reporting on.
    Disabled,
    /// The report does not meet the standard.
    Invalid(String),
    /// This machine already has as many distinct bugs on file as it may.
    BudgetSpent { distinct: usize },
}

impl BugReportRefusal {
    pub fn message(&self) -> String {
        match self {
            Self::Disabled => "aimux bug reporting is off. Turn it on with \
                 `bugReports.enabled` in ~/.aimux/config.json; see \
                 docs/agent-bug-reports.md"
                .to_owned(),
            Self::Invalid(reason) => reason.clone(),
            Self::BudgetSpent { distinct } => format!(
                "this machine already has {distinct} distinct bug reports on file, the most \
                 it may hold. Go through them before filing more; see \
                 docs/agent-bug-reports.md"
            ),
        }
    }
}

/// What filing a report did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BugReportOutcome {
    /// A bug nothing had filed before.
    Filed { fingerprint: String },
    /// A bug already on file; this sighting was recorded too.
    Counted { fingerprint: String, count: u64 },
    /// A bug already recorded as often as it will be. Nothing was written.
    AlreadyRecorded { fingerprint: String, count: u64 },
}

impl BugReportOutcome {
    pub fn fingerprint(&self) -> &str {
        match self {
            Self::Filed { fingerprint }
            | Self::Counted { fingerprint, .. }
            | Self::AlreadyRecorded { fingerprint, .. } => fingerprint,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Filed { fingerprint } => format!("filed bug report {fingerprint}"),
            Self::Counted { fingerprint, count } => {
                format!("bug report {fingerprint} was already on file; seen {count} times now")
            }
            Self::AlreadyRecorded { fingerprint, count } => format!(
                "bug report {fingerprint} is already recorded {count} times; \
                 nothing more to add"
            ),
        }
    }
}

/// Store one report, or say why not.
///
/// `Err(Disabled)` is the whole of the opt-in: no file is created, no
/// directory is made, nothing is written. An agent is told plainly rather than
/// being allowed to believe it filed something, because an agent that thinks
/// it reported a bug will not mention it any other way.
/// Store one sighting of a bug, or say why not.
///
/// Append-only, deliberately. The first version of this read the store,
/// updated a record in place and rewrote the file -- which has a lost-update
/// race: two agents filing two DIFFERENT new bugs at the same moment each read
/// a store without the other's line, and whichever wrote second erased the
/// other's report. A lost count would have been tolerable; a lost report is
/// not, since a reported bug is the one thing nobody will think to re-file.
///
/// So a sighting is a line, the reader groups lines by fingerprint, and growth
/// is bounded by refusing to write past `SIGHTINGS_PER_BUG` rather than by
/// rewriting what is already there.
pub fn record(
    resolver: &PathResolver,
    report: &AgentBugReport,
    machine_id: &str,
    tool: &str,
    build: &str,
    at: &str,
) -> Result<BugReportOutcome, BugReportRefusal> {
    if !is_enabled(resolver) {
        return Err(BugReportRefusal::Disabled);
    }
    let report = report.normalized().map_err(BugReportRefusal::Invalid)?;
    let fingerprint = report.fingerprint();
    let bugs = summarize(resolver).map_err(BugReportRefusal::Invalid)?;
    let seen = bugs
        .iter()
        .find(|bug| bug.fingerprint == fingerprint)
        .map(|bug| bug.count)
        .unwrap_or(0);

    if seen >= SIGHTINGS_PER_BUG {
        // Already as recorded as it is going to get. The agent is told, rather
        // than being left to believe nothing happened.
        return Ok(BugReportOutcome::AlreadyRecorded {
            fingerprint,
            count: seen,
        });
    }
    // The budget is on DISTINCT bugs. A sighting of one already on file is
    // never refused by it: that line costs nothing anybody has to triage.
    if seen == 0 && bugs.len() >= DISTINCT_BUG_BUDGET {
        return Err(BugReportRefusal::BudgetSpent {
            distinct: bugs.len(),
        });
    }

    append_line(
        &store_path(resolver),
        &json!({
            "kind": BUG_REPORT_RECORD_KIND,
            "fingerprint": fingerprint,
            "at": at,
            // The opaque machine id, never the machine NAME: the name is a
            // hostname, and a report is read by someone who should be able to
            // tell two machines apart without being told whose they are.
            "machineId": machine_id,
            "tool": tool,
            "build": build,
            "report": report,
        }),
    )
    .map_err(BugReportRefusal::Invalid)?;

    Ok(if seen == 0 {
        BugReportOutcome::Filed { fingerprint }
    } else {
        BugReportOutcome::Counted {
            fingerprint,
            count: seen + 1,
        }
    })
}

fn append_line(path: &Path, record: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    // One `write` of a line that is far below the pipe-atomic size, to a
    // descriptor opened for append: two agents writing at once interleave
    // lines, not bytes within a line.
    writeln!(file, "{line}").map_err(|error| format!("write {}: {error}", path.display()))?;
    // A reported bug is the one thing nobody will think to re-file.
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))?;
    Ok(())
}

/// One bug, however many times it was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BugSummary {
    pub fingerprint: String,
    pub count: u64,
    pub first_seen_at: String,
    pub last_seen_at: String,
    /// The first filing's report. Later sightings of the same bug carry their
    /// own repro and evidence, and this is the one somebody will read.
    pub report: AgentBugReport,
}

/// Every distinct bug on file, in the order each was first seen.
///
/// This is where the dedupe lives, now that the store is append-only: the
/// lines are sightings and a bug is a group of them.
pub fn summarize(resolver: &PathResolver) -> Result<Vec<BugSummary>, String> {
    let mut bugs: Vec<BugSummary> = Vec::new();
    for record in read_all(resolver)? {
        let fingerprint = record
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let at = record
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(bug) = bugs.iter_mut().find(|bug| bug.fingerprint == fingerprint) {
            bug.count += 1;
            bug.last_seen_at = at;
            continue;
        }
        let report = serde_json::from_value::<AgentBugReport>(
            record.get("report").cloned().unwrap_or(Value::Null),
        )
        .map_err(|error| format!("read bug report {fingerprint}: {error}"))?;
        bugs.push(BugSummary {
            fingerprint,
            count: 1,
            first_seen_at: at.clone(),
            last_seen_at: at,
            report,
        });
    }
    Ok(bugs)
}

/// Every stored report, oldest first.
///
/// A line it cannot read is an error rather than a line to skip: a store that
/// quietly drops records is worse than one that says it is damaged.
pub fn read_all(resolver: &PathResolver) -> Result<Vec<Value>, String> {
    let path = store_path(resolver);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut records = Vec::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(line)
            .map_err(|error| format!("parse {} line {}: {error}", path.display(), index + 1))?;
        if value.get("kind").and_then(Value::as_str) != Some(BUG_REPORT_RECORD_KIND) {
            return Err(format!(
                "{} line {} is not a {BUG_REPORT_RECORD_KIND}",
                path.display(),
                index + 1
            ));
        }
        records.push(value);
    }
    Ok(records)
}
