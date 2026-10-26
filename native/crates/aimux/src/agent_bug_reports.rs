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

/// The longest a tool name may be. Every tool aimux knows is one short word.
const TOOL_BUDGET: usize = 32;

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

/// The agent's tool, reduced to something that cannot carry a secret.
///
/// This arrives from `AIMUX_TOOL`, and a shell sets the environment of its own
/// children -- so an agent can put anything there, including the contents of a
/// file. setting `AIMUX_TOOL` to the contents of a private key and filing a report would
/// otherwise have written a private key into the store, which is the one
/// category the standard is most explicit about. Anything that is not a short
/// lowercase word is not a tool name, and is recorded as unknown rather than
/// recorded as itself.
pub fn sanitized_tool(raw: &str) -> String {
    let trimmed = raw.trim();
    let plausible = !trimmed.is_empty()
        && trimmed.len() <= TOOL_BUDGET
        && trimmed.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if plausible {
        trimmed.to_owned()
    } else {
        UNKNOWN_TOOL.to_owned()
    }
}

/// What a tool that cannot be named is called.
pub const UNKNOWN_TOOL: &str = "unknown";

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

    let mut record = json!({
        "kind": BUG_REPORT_RECORD_KIND,
        "fingerprint": fingerprint,
        "at": at,
        // The opaque machine id, never the machine NAME: the name is a
        // hostname, and a report is read by someone who should be able to tell
        // two machines apart without being told whose they are.
        "machineId": machine_id,
        // Bounded and charset-checked: this comes from the agent's own
        // environment, which the agent controls.
        "tool": sanitized_tool(tool),
        "build": build,
    });
    if seen == 0 {
        // The report body goes with the FIRST sighting only. A later sighting
        // of the same bug carries its own repro and evidence, which `summarize`
        // never surfaces -- storing them would be tens of kilobytes of agent
        // text per bug that nothing reads, in a store whose whole point is
        // being readable by someone who does not have the machine.
        if let Value::Object(record) = &mut record {
            record.insert(
                "report".into(),
                serde_json::to_value(&report)
                    .map_err(|error| BugReportRefusal::Invalid(error.to_string()))?,
            );
        }
    }
    append_line(&store_path(resolver), &record).map_err(BugReportRefusal::Invalid)?;

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
    let mut line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    line.push('\n');
    // If the last append was interrupted the file does not end in a newline,
    // and writing straight after it would splice this record onto that
    // fragment. One leading newline closes the fragment off as a line of its
    // own, which the reader then skips on its own terms.
    //
    // Deliberately NOT by repairing the file. Two earlier attempts removed the
    // fragment instead and each lost a report: dropping it on the missing
    // newline alone deleted records that were complete, and truncating it is
    // an unlocked read-modify-write -- a second filer computes the length to
    // keep, a first filer appends a whole record, and the truncation takes
    // that record with it. Nothing here removes anything, so no filed report
    // can be lost by a later filing.
    if store_lacks_final_newline(path)? {
        line.insert(0, '\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    // ONE `write_all` of the line and its newline together. `writeln!` goes
    // through `fmt::write`, which issues a write per piece -- so the line and
    // the newline were two syscalls, and two agents filing at once could
    // produce `{a}{b}\n\n`.
    //
    // No test pins this: an interleaving of two syscalls is not something a
    // test can force deterministically, and a test that sometimes reproduced
    // it would be worse than none. What IS pinned is the consequence being
    // survivable -- `read_all` skips a torn final line rather than refusing
    // the store for ever. Treat this as belt and braces behind that.
    file.write_all(line.as_bytes())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    // A reported bug is the one thing nobody will think to re-file.
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))?;
    Ok(())
}

/// Whether the store's last byte is something other than a newline.
///
/// One byte from the end rather than reading the file, because this runs on
/// every filing -- and as a byte, because a tail cut mid-character is not
/// valid UTF-8 and must not make this fail.
fn store_lacks_final_newline(path: &Path) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("open {}: {error}", path.display())),
    };
    let length = file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("seek {}: {error}", path.display()))?;
    if length == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|error| format!("seek {}: {error}", path.display()))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(last[0] != b'\n')
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
    Ok(summarize_records(&read_store(resolver)?.records).bugs)
}

/// The bugs in a set of records already read, and how many of those records
/// could not be attributed to one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BugDigest {
    pub bugs: Vec<BugSummary>,
    /// Records that read cleanly but belong to no bug -- no fingerprint, or a
    /// fingerprint whose first sighting is gone. Counted, not hidden: a
    /// listing that showed fewer sightings than the file holds without saying
    /// so would be the quiet failure this store is built to avoid.
    pub unattributable: usize,
}

/// Group records into bugs, over records the caller has already read.
///
/// Taking the records rather than the resolver so a caller can read the file
/// ONCE. `bug list` used to call this and `read_store` separately, and a
/// filing in between made the two halves of its own output disagree.
pub fn summarize_records(records: &[Value]) -> BugDigest {
    let mut bugs: Vec<BugSummary> = Vec::new();
    let mut unattributable_count = 0;
    for record in records {
        // A record with no fingerprint cannot be grouped, and defaulting it to
        // the empty string would merge every such line into one invented bug.
        // Skipped like any other line that cannot be accounted for: the store
        // is never refused over one record, and `read_store`'s count is what
        // tells anyone the file holds lines nothing could use.
        let Some(fingerprint) = record
            .get("fingerprint")
            .and_then(Value::as_str)
            .filter(|fingerprint| !fingerprint.is_empty())
            .map(str::to_owned)
        else {
            unattributable(&mut unattributable_count, "no fingerprint");
            continue;
        };
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
        // Only a first sighting carries the body. A fingerprint whose first
        // sighting is gone has nothing to show, so it is skipped rather than
        // listed as a blank bug -- the store is never refused over one record,
        // and `read_store`'s count is what tells anyone the file holds lines
        // nothing could use.
        let stored_report = record.get("report").cloned();
        let Some(report) = stored_report
            .clone()
            .and_then(|report| serde_json::from_value::<AgentBugReport>(report).ok())
        else {
            // Two different states, and the log says which: a sighting whose
            // first is gone carries no body at all, while a body that will not
            // deserialize is a record somebody or something else wrote.
            unattributable(
                &mut unattributable_count,
                if stored_report.is_none() {
                    "no first sighting on file"
                } else {
                    "a report body that could not be read"
                },
            );
            continue;
        };
        bugs.push(BugSummary {
            fingerprint,
            count: 1,
            first_seen_at: at.clone(),
            last_seen_at: at,
            report,
        });
    }
    BugDigest {
        bugs,
        unattributable: unattributable_count,
    }
}

/// Count a record that read cleanly but belongs to no bug, and say so.
///
/// Logged as well as counted, because `read_store` logs every line it cannot
/// read and these were the one kind of skip that happened silently.
fn unattributable(count: &mut usize, reason: &str) {
    crate::debug_logging::log_lifecycle_always(
        "a bug report record could not be attributed to a bug",
        "bug-reports",
        Some(json!({ "reason": reason })),
    );
    *count += 1;
}

/// Every stored report, oldest first.
///
/// A line it cannot read is an error rather than a line to skip: a store that
/// quietly drops records is worse than one that says it is damaged.
/// What a read of the store found, including what it could not read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoreContents {
    pub records: Vec<Value>,
    /// Lines this could not account for. Skipped, logged, counted -- never
    /// removed from the file, and never hidden from the caller.
    pub unreadable: usize,
}

/// Every record in the store, plus how many lines were unreadable.
///
/// Read as BYTES and split on newlines, not through `read_to_string`. An
/// append cut mid-character leaves invalid UTF-8, and decoding the whole file
/// would then fail -- which, because `record` reads the store before it
/// writes, made `bug list` and every future filing fail for ever with nothing
/// able to repair it.
///
/// A line this cannot account for is skipped, logged and counted rather than
/// refusing the store. That is not the same as hiding it: nothing is removed
/// from the file, and the count comes back so a caller can say how many
/// records it could not read.
pub fn read_store(resolver: &PathResolver) -> Result<StoreContents, String> {
    let path = store_path(resolver);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoreContents::default());
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut contents = StoreContents::default();
    for (index, raw_line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        let skip = |reason: &str, contents: &mut StoreContents| {
            crate::debug_logging::log_lifecycle_always(
                "skipped an unreadable line in the bug report store",
                "bug-reports",
                Some(json!({
                    "path": path.to_string_lossy(),
                    "line": index + 1,
                    "reason": reason,
                })),
            );
            contents.unreadable += 1;
        };
        let Ok(line) = std::str::from_utf8(raw_line) else {
            skip("not valid utf-8", &mut contents);
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            skip("not json", &mut contents);
            continue;
        };
        if value.get("kind").and_then(Value::as_str) != Some(BUG_REPORT_RECORD_KIND) {
            skip("not a bug report record", &mut contents);
            continue;
        }
        contents.records.push(value);
    }
    Ok(contents)
}

/// Every record in the store.
pub fn read_all(resolver: &PathResolver) -> Result<Vec<Value>, String> {
    Ok(read_store(resolver)?.records)
}
