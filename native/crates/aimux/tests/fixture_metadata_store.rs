use aimux::daemon_state::{
    MetadataState, load_metadata_state_at_unix_millis, metadata_state_path, save_metadata_state,
};
use aimux::project_service::agent_controls::{
    clear_project_flag_at, clear_session_loop_metadata_at, set_project_session_flag_at,
    set_session_loop_metadata_at,
};
use aimux::project_service::metadata::{
    MAX_SEGMENT_TTL_SECONDS, drop_statusline_segment_at, put_statusline_segment_at,
    segment_rejection, update_session_metadata_at,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const METADATA_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-store/store.json");
const FIXED_NOW: &str = "2026-02-03T04:05:06.000Z";

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new(case_id: &str) -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join("rust-metadata-store-fixtures")
            .join(format!("{}-{sequence}-{case_id}", std::process::id()));
        fs::create_dir_all(&path).expect("create fixture dir");
        Self(path)
    }

    fn state_dir(&self) -> PathBuf {
        self.0.join("state")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn fixture_metadata_store_cases_match_typescript_contract() {
    let contract: Value = serde_json::from_str(METADATA_STORE).expect("valid metadata fixture");
    let cases = contract["cases"].as_array().expect("metadata cases");
    assert_eq!(cases.len(), 21, "unexpected metadata-store case count");

    for case in cases {
        run_case(case);
    }
}

fn run_case(case: &Value) {
    let id = case["id"].as_str().expect("case id");
    let api = case["api"].as_str().expect("case api");
    match api {
        "loadMetadataState" => assert_load_metadata_state(id, &case["input"], &case["output"]),
        "saveMetadataState" => assert_save_metadata_state(id, &case["input"], &case["output"]),
        "setSessionLoop/clearSessionLoop/setSessionOverseer" => {
            assert_loop_and_overseer(id, &case["input"], &case["output"])
        }
        "updateSessionMetadata" => {
            assert_update_session_metadata(id, &case["input"], &case["output"])
        }
        "setSessionOverseer" => assert_single_flag(id, "overseer", &case["input"], &case["output"]),
        "setSessionScribe" => assert_single_flag(id, "scribe", &case["input"], &case["output"]),
        "putStatuslineSegment" => {
            assert_put_statusline_segment(id, &case["input"], &case["output"])
        }
        "dropStatuslineSegment" => {
            assert_drop_statusline_segment(id, &case["input"], &case["output"])
        }
        "segmentRejection" => assert_segment_rejection(id, &case["input"], &case["output"]),
        "MAX_SEGMENT_TTL_SECONDS" => assert_segment_ttl_constant(id, &case["output"]),
        other => panic!("{id}: unhandled metadata-store api {other}"),
    }
}

fn assert_load_metadata_state(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    if let Some(state) = input.get("state") {
        write_state(&state_dir, state);
    }
    if let Some(operations) = input.get("operations").and_then(Value::as_array) {
        for operation in operations {
            put_statusline_segment_at(
                &state_dir,
                input
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("s1"),
                operation["line"].as_str().expect("statusline line"),
                operation["segment"].clone(),
                FIXED_NOW,
            )
            .expect("put segment");
        }
    }
    if let Some(segment) = input.get("segment") {
        put_statusline_segment_at(
            &state_dir,
            input
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("s1"),
            input
                .get("line")
                .and_then(Value::as_str)
                .unwrap_or("bottom"),
            segment.clone(),
            FIXED_NOW,
        )
        .expect("put segment");
    }
    assert_eq!(
        state_value_at(&state_dir, input_now_millis(input)),
        *expected,
        "{id}"
    );
}

fn assert_save_metadata_state(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    let state: MetadataState =
        serde_json::from_value(input["state"].clone()).expect("metadata state");
    save_metadata_state(&state_dir, &state).expect("save metadata");
    assert_eq!(read_state_value(&state_dir), *expected, "{id}");
}

fn assert_loop_and_overseer(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    set_session_loop_metadata_at(
        &state_dir,
        "worker-1",
        input["loop"].clone(),
        "2026-06-13T00:00:05.000Z",
    )
    .expect("set loop");
    set_project_session_flag_at(
        &state_dir,
        "boss",
        "overseer",
        true,
        "2026-06-13T00:00:05.000Z",
    )
    .expect("set overseer");
    assert_eq!(
        json!({
            "state": state_value_at(&state_dir, iso_millis("2026-06-13T00:00:05.000Z")),
            "overseer": find_flag(&state_dir, "overseer")
        }),
        expected["afterSet"],
        "{id} afterSet"
    );

    clear_session_loop_metadata_at(
        &state_dir,
        "worker-1",
        Some(input["clearAction"].clone()),
        "2026-06-13T01:00:05.000Z",
    )
    .expect("clear loop");
    clear_project_flag_at(&state_dir, "boss", "overseer", "2026-06-13T01:00:05.000Z")
        .expect("clear overseer");
    assert_eq!(
        json!({
            "state": state_value_at(&state_dir, iso_millis("2026-06-13T01:00:05.000Z")),
            "overseer": find_flag(&state_dir, "overseer")
        }),
        expected["afterClear"],
        "{id} afterClear"
    );
}

fn assert_update_session_metadata(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    write_state(&state_dir, &expected["state"]);
    let before = fs::read_to_string(metadata_state_path(&state_dir)).expect("metadata file");
    let result = update_session_metadata_at(
        &state_dir,
        input["sessionId"].as_str().expect("session id"),
        FIXED_NOW,
        |current| object_insert(current, "status", input["status"].clone()),
    )
    .expect("update metadata");
    assert_eq!(!result.changed, expected["fileUnchanged"], "{id} unchanged");
    assert_eq!(
        fs::read_to_string(metadata_state_path(&state_dir)).expect("metadata file"),
        before,
        "{id} file unchanged"
    );
    assert_eq!(
        state_value_at(&state_dir, iso_millis(FIXED_NOW)),
        expected["state"],
        "{id}"
    );
}

fn assert_single_flag(id: &str, key: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    for step in input["sequence"].as_array().expect("sequence") {
        let raw = step.as_str().expect("sequence item");
        let (session_id, value) = raw.split_once('=').expect("session=value");
        set_project_session_flag_at(&state_dir, session_id, key, value == "true", FIXED_NOW)
            .expect("set flag");
    }
    assert_eq!(
        json!({
            "state": state_value_at(&state_dir, iso_millis(FIXED_NOW)),
            key: find_flag(&state_dir, key)
        }),
        *expected,
        "{id}"
    );
}

fn assert_put_statusline_segment(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    if let Some(operations) = input.get("operations").and_then(Value::as_array) {
        for operation in operations {
            put_statusline_segment_at(
                &state_dir,
                input["sessionId"].as_str().expect("session id"),
                operation["line"].as_str().expect("line"),
                operation["segment"].clone(),
                FIXED_NOW,
            )
            .expect("put segment");
        }
    } else {
        put_statusline_segment_at(
            &state_dir,
            input["sessionId"].as_str().expect("session id"),
            input["line"].as_str().expect("line"),
            input["segment"].clone(),
            FIXED_NOW,
        )
        .expect("put segment");
    }
    assert_eq!(
        state_value_at(&state_dir, iso_millis(FIXED_NOW)),
        *expected,
        "{id}"
    );
}

fn assert_drop_statusline_segment(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let state_dir = fixture.state_dir();
    for entry in input["before"].as_array().expect("before") {
        put_statusline_segment_at(
            &state_dir,
            "s1",
            entry["line"].as_str().expect("line"),
            entry["segment"].clone(),
            FIXED_NOW,
        )
        .expect("put segment");
    }
    let first_drop = &input["drops"][0];
    drop_statusline_segment_at(
        &state_dir,
        "s1",
        first_drop["id"].as_str().expect("drop id"),
        first_drop.get("line").and_then(Value::as_str),
        FIXED_NOW,
    )
    .expect("drop segment");
    assert_eq!(
        state_value_at(&state_dir, iso_millis(FIXED_NOW)),
        expected["afterTopOnly"],
        "{id} afterTopOnly"
    );
    let second_drop = &input["drops"][1];
    drop_statusline_segment_at(
        &state_dir,
        "s1",
        second_drop["id"].as_str().expect("drop id"),
        second_drop.get("line").and_then(Value::as_str),
        FIXED_NOW,
    )
    .expect("drop segment");
    assert_eq!(
        state_value_at(&state_dir, iso_millis(FIXED_NOW)),
        expected["afterBoth"],
        "{id} afterBoth"
    );
}

fn assert_segment_rejection(id: &str, input: &Value, expected: &Value) {
    let actual = segment_rejection(&input["segment"])
        .map(Value::String)
        .unwrap_or(Value::Null);
    assert_eq!(actual, *expected, "{id}");
}

fn assert_segment_ttl_constant(id: &str, expected: &Value) {
    assert_eq!(
        json!({
            "MAX_SEGMENT_TTL_SECONDS": MAX_SEGMENT_TTL_SECONDS as u64,
            "soonRejection": segment_rejection(&json!({
                "id": "soon",
                "text": "soon",
                "expiresAt": "2026-02-04T04:05:06.000Z"
            })).map(Value::String).unwrap_or(Value::Null)
        }),
        *expected,
        "{id}"
    );
}

fn write_state(state_dir: &Path, state: &Value) {
    fs::create_dir_all(state_dir).expect("create state dir");
    let mut bytes = serde_json::to_vec_pretty(state).expect("serialize state");
    bytes.push(b'\n');
    fs::write(metadata_state_path(state_dir), bytes).expect("write metadata state");
}

fn read_state_value(state_dir: &Path) -> Value {
    serde_json::from_slice(&fs::read(metadata_state_path(state_dir)).expect("read metadata state"))
        .expect("metadata json")
}

fn state_value_at(state_dir: &Path, now: u128) -> Value {
    serde_json::to_value(load_metadata_state_at_unix_millis(state_dir, now)).expect("state value")
}

fn input_now_millis(input: &Value) -> u128 {
    input
        .get("now")
        .and_then(Value::as_str)
        .map(iso_millis)
        .unwrap_or_else(|| iso_millis(FIXED_NOW))
}

fn find_flag(state_dir: &Path, key: &str) -> Value {
    let state = load_metadata_state_at_unix_millis(state_dir, iso_millis(FIXED_NOW));
    state
        .sessions
        .iter()
        .find_map(|(session_id, session)| {
            (session.get(key).and_then(Value::as_bool) == Some(true))
                .then(|| Value::String(session_id.clone()))
        })
        .unwrap_or(Value::Null)
}

fn object_insert(value: Value, key: &str, inserted: Value) -> Value {
    let mut object = match value {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    object.insert(key.to_owned(), inserted);
    Value::Object(object)
}

fn iso_millis(value: &str) -> u128 {
    let (date, time) = value.split_once('T').expect("date separator");
    let mut date_parts = date.split('-');
    let year = date_parts
        .next()
        .expect("year")
        .parse::<i64>()
        .expect("year number");
    let month = date_parts
        .next()
        .expect("month")
        .parse::<i64>()
        .expect("month number");
    let day = date_parts
        .next()
        .expect("day")
        .parse::<i64>()
        .expect("day number");
    let time = time.strip_suffix('Z').expect("utc suffix");
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts
        .next()
        .expect("hour")
        .parse::<u128>()
        .expect("hour number");
    let minute = time_parts
        .next()
        .expect("minute")
        .parse::<u128>()
        .expect("minute number");
    let second = time_parts
        .next()
        .expect("second")
        .parse::<u128>()
        .expect("second number");
    let mut millis = millis.parse::<u128>().expect("millis number");
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day);
    (((days as u128 * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
