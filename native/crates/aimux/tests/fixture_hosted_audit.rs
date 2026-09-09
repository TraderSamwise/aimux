use aimux::hosted_audit::{
    HOSTED_AUDIT_MAX_BYTES, HostedAuditRecord, HostedAuditStore, HostedPromptRecord, hash_prompt,
    pending_path_for, pending_staged_path_for,
};
use aimux::paths::PathResolver;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/hosted/audit.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn hosted_audit_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("hosted audit fixture parses");
    assert_eq!(contract.cases.len(), 13);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_hosted_audit_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "hosted audit parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_hosted_audit_contract_case(input: &Value) -> Value {
    let fixture = Fixture::new();
    match str_field(input, "scenario") {
        "append-jsonl-mode" => append_jsonl_mode(&fixture),
        "prompt-hash-no-text" => prompt_hash_no_text(&fixture),
        "prompt-body-side-file" => prompt_body_side_file(&fixture),
        "append-never-throws" => append_never_throws(&fixture),
        "pending-visible-to-tail" => pending_visible_to_tail(&fixture),
        "fold-pending" => fold_pending(&fixture),
        "recover-staged" => recover_staged(&fixture),
        "staged-and-fresh-pending" => staged_and_fresh_pending(&fixture),
        "pending-not-rotated" => pending_not_rotated(&fixture),
        "drop-expired-pending" => drop_expired_pending(&fixture),
        "drop-expired-live" => drop_expired_live(&fixture),
        "prune-prompts" => prune_prompts(&fixture),
        "rotated-retention" => rotated_retention(&fixture),
        scenario => panic!("unknown hosted audit scenario: {scenario}"),
    }
}

struct Fixture {
    root: PathBuf,
    store: HostedAuditStore,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-audit-contract-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self {
            root,
            store: HostedAuditStore::with_resolver(resolver),
        }
    }

    fn record(&self, ts: &str, principal_id: &str, status: i64, detail: &str) -> HostedAuditRecord {
        HostedAuditRecord {
            ts: ts.to_owned(),
            principal_id: principal_id.to_owned(),
            label: "grand".to_owned(),
            method: "POST".to_owned(),
            path: "/proxy/prj/agents/input".to_owned(),
            session_id: Some("ses_a".to_owned()),
            status,
            request_bytes: 12,
            response_bytes: 34,
            prompt_hash: None,
            prompt_ref: None,
            event: None,
            detail: Some(detail.to_owned()),
        }
    }

    fn prompt(&self, ts: &str, prompt_ref: &str, text: &str) -> HostedPromptRecord {
        HostedPromptRecord {
            ts: ts.to_owned(),
            prompt_ref: prompt_ref.to_owned(),
            principal_id: "prn_a".to_owned(),
            prompt_hash: hash_prompt(text),
            prompt_text: text.to_owned(),
            truncated: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn append_jsonl_mode(fixture: &Fixture) -> Value {
    fixture
        .store
        .append_audit(&fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "one"));
    fixture
        .store
        .append_audit(&fixture.record("2026-01-01T00:00:01.000Z", "prn_b", 403, "two"));
    let records = fixture.store.tail_audit(10);
    json!({
        "count": records.len(),
        "firstPrincipalId": records[0].principal_id,
        "secondStatus": records[1].status,
        "mode": mode_for(&fixture.store.audit_path()),
    })
}

fn prompt_hash_no_text(fixture: &Fixture) -> Value {
    let prompt = "how much did we take on Friday";
    let hash = hash_prompt(prompt);
    let mut record = fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "prompt");
    record.prompt_hash = Some(hash.clone());
    fixture.store.append_audit(&record);
    let raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    json!({
        "promptHash": record.prompt_hash,
        "expectedHash": hash,
        "promptRef": record.prompt_ref,
        "rawContainsText": raw.contains(prompt),
    })
}

fn prompt_body_side_file(fixture: &Fixture) -> Value {
    let prompt = "what did we take on Friday";
    let mut record = fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "prompt");
    record.prompt_hash = Some(hash_prompt(prompt));
    record.prompt_ref = Some("prompt_1".to_owned());
    fixture.store.append_audit(&record);
    fixture
        .store
        .append_prompt(&fixture.prompt("2026-01-01T00:00:00.000Z", "prompt_1", prompt));
    let audit_raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    let prompts = fixture.store.tail_prompts(vec!["prompt_1".to_owned()]);
    json!({
        "auditContainsText": audit_raw.contains(prompt),
        "promptText": prompts.get("prompt_1").map(|record| record.prompt_text.clone()),
        "promptMode": mode_for(&fixture.store.prompts_path()),
    })
}

fn append_never_throws(fixture: &Fixture) -> Value {
    fs::write(fixture.root.join(".aimux"), "not a directory").expect("aimux file");
    let threw = std::panic::catch_unwind(|| {
        fixture.store.append_audit(&fixture.record(
            "2026-01-01T00:00:00.000Z",
            "prn_a",
            200,
            "one",
        ));
    })
    .is_err();
    json!({ "threw": threw })
}

fn pending_visible_to_tail(fixture: &Fixture) -> Value {
    write_jsonl(
        &fixture.store.audit_path(),
        &fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "in the live file"),
    );
    write_jsonl(
        &pending_path_for(&fixture.store.audit_path()),
        &fixture.record(
            "2026-01-01T00:00:01.000Z",
            "prn_a",
            200,
            "arrived during a prune",
        ),
    );
    json!(
        fixture
            .store
            .tail_audit(10)
            .into_iter()
            .filter_map(|record| record.detail)
            .collect::<Vec<_>>()
    )
}

fn fold_pending(fixture: &Fixture) -> Value {
    write_jsonl(
        &fixture.store.audit_path(),
        &fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "live"),
    );
    write_jsonl(
        &pending_path_for(&fixture.store.audit_path()),
        &fixture.record("2026-01-01T00:00:01.000Z", "prn_a", 200, "pending"),
    );
    fixture
        .store
        .prune(3650, parse_fixture_time("2026-01-02T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    json!({
        "containsPending": raw.contains("pending"),
        "containsLive": raw.contains("live"),
        "pendingExists": pending_path_for(&fixture.store.audit_path()).exists(),
        "stagedExists": pending_staged_path_for(&fixture.store.audit_path()).exists(),
    })
}

fn recover_staged(fixture: &Fixture) -> Value {
    write_jsonl(
        &pending_staged_path_for(&fixture.store.audit_path()),
        &fixture.record("2026-01-01T00:00:01.000Z", "prn_a", 200, "staged"),
    );
    fixture
        .store
        .prune(3650, parse_fixture_time("2026-01-02T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    json!({
        "rawContains": raw.contains("staged"),
        "stagedExists": pending_staged_path_for(&fixture.store.audit_path()).exists(),
    })
}

fn staged_and_fresh_pending(fixture: &Fixture) -> Value {
    write_jsonl(
        &pending_staged_path_for(&fixture.store.audit_path()),
        &fixture.record("2026-01-01T00:00:01.000Z", "prn_a", 200, "staged"),
    );
    write_jsonl(
        &pending_path_for(&fixture.store.audit_path()),
        &fixture.record("2026-01-01T00:00:02.000Z", "prn_a", 200, "new pending"),
    );
    fixture
        .store
        .prune(3650, parse_fixture_time("2026-01-02T00:00:00.000Z"));
    let raw_after_first = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    let after_first = json!({
        "rawContainsStaged": raw_after_first.contains("staged"),
        "pendingExists": pending_path_for(&fixture.store.audit_path()).exists(),
    });
    fixture
        .store
        .prune(3650, parse_fixture_time("2026-01-02T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    json!({
        "afterFirst": after_first,
        "rawContainsNewPending": raw.contains("new pending"),
    })
}

fn pending_not_rotated(fixture: &Fixture) -> Value {
    let pending = pending_path_for(&fixture.store.audit_path());
    fs::create_dir_all(pending.parent().expect("pending parent")).expect("pending parent");
    fs::write(&pending, vec![b'x'; HOSTED_AUDIT_MAX_BYTES as usize + 1]).expect("pending");
    json!({
        "sizeGreaterThanLimit": fs::metadata(&pending).expect("pending metadata").len() > HOSTED_AUDIT_MAX_BYTES,
        "rotatedSidecarExists": PathBuf::from(format!("{}.1", pending.to_string_lossy())).exists(),
    })
}

fn drop_expired_pending(fixture: &Fixture) -> Value {
    write_jsonl(
        &pending_path_for(&fixture.store.audit_path()),
        &fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "expired"),
    );
    fixture
        .store
        .prune(1, parse_fixture_time("2026-01-03T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.audit_path()).unwrap_or_default();
    json!({ "rawContainsExpired": raw.contains("expired") })
}

fn drop_expired_live(fixture: &Fixture) -> Value {
    write_jsonl(
        &fixture.store.audit_path(),
        &fixture.record("2026-01-01T00:00:00.000Z", "prn_a", 200, "ancient"),
    );
    write_jsonl(
        &fixture.store.audit_path(),
        &fixture.record("2026-01-03T00:00:00.000Z", "prn_a", 200, "recent"),
    );
    fixture
        .store
        .prune(1, parse_fixture_time("2026-01-03T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.audit_path()).expect("audit raw");
    let records = fixture.store.tail_audit(10);
    json!({
        "count": records.len(),
        "detail": records[0].detail,
        "rawContainsAncient": raw.contains("ancient"),
    })
}

fn prune_prompts(fixture: &Fixture) -> Value {
    fixture
        .store
        .append_prompt(&fixture.prompt("2026-01-01T00:00:00.000Z", "old", "ancient"));
    fixture
        .store
        .append_prompt(&fixture.prompt("2026-01-03T00:00:00.000Z", "new", "recent"));
    fixture
        .store
        .prune(1, parse_fixture_time("2026-01-03T00:00:00.000Z"));
    let raw = fs::read_to_string(fixture.store.prompts_path()).expect("prompts raw");
    let prompts = fixture
        .store
        .tail_prompts(vec!["old".to_owned(), "new".to_owned()]);
    json!({
        "hasOld": prompts.contains_key("old"),
        "newText": prompts.get("new").map(|record| record.prompt_text.clone()),
        "rawContainsAncient": raw.contains("ancient"),
    })
}

fn rotated_retention(fixture: &Fixture) -> Value {
    write_jsonl(
        &fixture.store.audit_path(),
        &fixture.record("2026-01-03T00:00:00.000Z", "prn_a", 200, "live"),
    );
    let old = PathBuf::from(format!(
        "{}.1",
        fixture.store.audit_path().to_string_lossy()
    ));
    let new = PathBuf::from(format!(
        "{}.2",
        fixture.store.audit_path().to_string_lossy()
    ));
    fs::write(&old, "old\n").expect("old rotated");
    fs::write(&new, "new\n").expect("new rotated");
    set_mtime(&old, SystemTime::UNIX_EPOCH + Duration::from_secs(1));
    set_mtime(&new, SystemTime::now());
    fixture
        .store
        .prune(1, parse_fixture_time("2026-01-03T00:00:00.000Z"));
    json!({
        "oldExists": old.exists(),
        "newExists": new.exists(),
        "liveExists": fixture.store.audit_path().exists(),
    })
}

fn write_jsonl(path: &Path, record: &impl serde::Serialize) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("jsonl parent");
    }
    let line = serde_json::to_string(record).expect("jsonl") + "\n";
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("jsonl open")
        .write_all(line.as_bytes())
        .expect("jsonl write");
}

#[cfg(unix)]
fn mode_for(path: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).expect("metadata").mode() & 0o777
}

#[cfg(not(unix))]
fn mode_for(_path: &Path) -> u32 {
    0
}

#[cfg(unix)]
fn set_mtime(path: &Path, time: SystemTime) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let times = [
        libc::timespec {
            tv_sec: duration.as_secs() as libc::time_t,
            tv_nsec: duration.subsec_nanos() as libc::c_long,
        },
        libc::timespec {
            tv_sec: duration.as_secs() as libc::time_t,
            tv_nsec: duration.subsec_nanos() as libc::c_long,
        },
    ];
    let c_path = CString::new(path.as_os_str().as_bytes()).expect("path c string");
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(result, 0, "set mtime");
}

#[cfg(not(unix))]
fn set_mtime(_path: &Path, _time: SystemTime) {}

fn parse_fixture_time(value: &str) -> u128 {
    parse_iso_millis(value).expect("fixture time")
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<u128>().ok()?;
    let minute = value.get(14..16)?.parse::<u128>().ok()?;
    let second = value.get(17..19)?.parse::<u128>().ok()?;
    let millis = value.get(20..23)?.parse::<u128>().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some(
        u128::try_from(days).ok()? * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
