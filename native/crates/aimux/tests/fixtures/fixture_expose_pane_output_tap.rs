use aimux::expose_pane_output_tap::{
    ExposePaneOutputTap, ExposePaneOutputTapItem, ExposePaneOutputTapOptions,
    ExposePaneOutputTapTmux, PanePipeFileOptions, PanePipeOwnership,
};
use aimux::tmux::TmuxTarget;
use serde_json::{Value, json};
use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

const EXPOSE_PANE_OUTPUT_TAP: &str =
    include_str!("../../../../../testdata/contracts/v1/expose/pane-output-tap.json");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_expose_pane_output_tap_cases_match_typescript_contract() {
    let contract: Value =
        serde_json::from_str(EXPOSE_PANE_OUTPUT_TAP).expect("valid expose tap fixture");
    let cases = contract["cases"].as_array().expect("expose tap cases");
    assert_eq!(cases.len(), 14, "unexpected expose tap case count");

    let mut failures = Vec::new();
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let expected = case["output"].clone();
        let actual = run_case(id, &case["input"]);
        if actual != expected {
            failures.push(format!(
                "{id}\nexpected: {}\nactual:   {}",
                serde_json::to_string_pretty(&expected).expect("expected json"),
                serde_json::to_string_pretty(&actual).expect("actual json")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} expose pane-output tap fixture failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

fn run_case(id: &str, input: &Value) -> Value {
    let dir = TempStateDir::new();
    match id {
        "expose-pane-output-tap-001" => case_starts_pipe_and_reads(input, dir.path()),
        "expose-pane-output-tap-002" => case_renews_existing(input, dir.path()),
        "expose-pane-output-tap-003" => case_skips_existing_pipe(input, dir.path()),
        "expose-pane-output-tap-004" => case_adopts_after_restart(dir.path()),
        "expose-pane-output-tap-005" => case_late_ownership(dir.path()),
        "expose-pane-output-tap-006" => case_restarts_after_ownership_loss(dir.path()),
        "expose-pane-output-tap-007" => case_pending_start_retry(input, dir.path()),
        "expose-pane-output-tap-008" => case_preserves_foreign_pending(input, dir.path()),
        "expose-pane-output-tap-009" => case_preserves_foreign_tracked(input, dir.path()),
        "expose-pane-output-tap-010" => case_expires_on_read(input, dir.path()),
        "expose-pane-output-tap-011" => case_reads_and_compacts(input, dir.path()),
        "expose-pane-output-tap-012" => case_maintenance_compacts(input, dir.path()),
        "expose-pane-output-tap-013" => case_stop_after_ownership_loss(dir.path()),
        "expose-pane-output-tap-014" => case_pipe_start_fails(dir.path()),
        other => panic!("unhandled expose pane-output tap case {other}"),
    }
}

fn case_starts_pipe_and_reads(input: &Value, project_state_dir: &Path) -> Value {
    let now = parse_iso_millis(input["now"].as_str().expect("now"));
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteOwnedOutputForTarget),
        move || now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let snapshot = tap.read("@1", None);
    let files_before_stop = tap_log_names(project_state_dir);
    tap.stop();
    let tmux = tap.into_tmux();
    json!({
        "snapshot": snapshot,
        "filesBeforeStop": files_before_stop,
        "filesAfterStop": tap_log_names(project_state_dir).len(),
        "calls": tmux.calls_json(),
    })
}

fn case_renews_existing(input: &Value, project_state_dir: &Path) -> Value {
    let now = Rc::new(Cell::new(parse_iso_millis("2026-07-20T13:00:00.000Z")));
    let mut tap = tap_with_cell(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteOwnedOutputForTarget),
        Rc::clone(&now),
        input["activeMs"].as_i64(),
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    now.set(now.get() + input["renewAfterMs"].as_i64().expect("renewAfterMs"));
    tap.track_items(&[item("a-fresh", "@1")]);
    let read_output = tap.read("@1", None).map(|snapshot| snapshot.output);
    let stats = tap.stats();
    let tmux = tap.into_tmux();
    json!({
        "pipeCalls": tmux.pipe_calls.len(),
        "stopCalls": tmux.stop_calls.len(),
        "readOutput": read_output,
        "stats": stats,
    })
}

fn case_skips_existing_pipe(input: &Value, project_state_dir: &Path) -> Value {
    let mut tmux = FakeTmux::new(PipeBehavior::NoWrite);
    tmux.is_pane_piped = input["isPanePiped"].as_bool().unwrap_or(false);
    let mut tap = tap_with_options(project_state_dir, tmux, systemish_now, None, None, None);
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    tap.stop();
    let read = tap.read("@1", None);
    let tmux = tap.into_tmux();
    json!({
        "pipeCalls": tmux.pipe_calls.len(),
        "stopCalls": tmux.stop_calls.len(),
        "read": read,
        "filesAfterStop": tap_log_names(project_state_dir).len(),
    })
}

fn case_adopts_after_restart(project_state_dir: &Path) -> Value {
    let mut initial = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStatic("warm tap output\n")),
        systemish_now,
        None,
        None,
        None,
    );
    initial.start();
    initial.track_items(&[item("a", "@1")]);

    let mut restarted_tmux = FakeTmux::new(PipeBehavior::NoWrite);
    restarted_tmux.is_pane_piped = true;
    let mut restarted = tap_with_options(
        project_state_dir,
        restarted_tmux,
        systemish_now,
        None,
        None,
        None,
    );
    restarted.start();
    restarted.track_items(&[item("a-restarted", "@1")]);
    let read_output = restarted.read("@1", None).map(|snapshot| snapshot.output);
    restarted.stop();
    initial.stop();
    let restarted_tmux = restarted.into_tmux();
    let initial_tmux = initial.into_tmux();
    json!({
        "readOutput": read_output,
        "restartedCalls": restarted_tmux.calls_json(),
        "initialStopCalls": initial_tmux.stop_calls.len(),
        "filesAfterStop": tap_log_names(project_state_dir).len(),
    })
}

fn case_late_ownership(project_state_dir: &Path) -> Value {
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WritePendingLate("late token output\n")),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let before = tap.read("@1", None);
    let ownership = tap
        .tmux_mut()
        .pending_ownership
        .clone()
        .expect("pending ownership");
    mark_owned(&ownership);
    let after = tap.read("@1", None).map(|snapshot| snapshot.output);
    tap.stop();
    let tmux = tap.into_tmux();
    json!({
        "beforeOwnership": before,
        "afterOwnership": after,
        "calls": tmux.calls_json(),
        "filesAfterStop": tap_log_names(project_state_dir).len(),
    })
}

fn case_restarts_after_ownership_loss(project_state_dir: &Path) -> Value {
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStaleThenFresh),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let first_output = tap.read("@1", None).map(|snapshot| snapshot.output);
    for path in tap_token_paths(project_state_dir) {
        let _ = fs::remove_file(path);
    }
    tap.track_items(&[item("a-fresh", "@1")]);
    let second_output = tap.read("@1", None).map(|snapshot| snapshot.output);
    tap.stop();
    let tmux = tap.into_tmux();
    json!({
        "firstOutput": first_output,
        "secondOutput": second_output,
        "pipeCalls": tmux.pipe_calls.len(),
        "stopCalls": tmux.stop_calls.len(),
    })
}

fn case_pending_start_retry(input: &Value, project_state_dir: &Path) -> Value {
    let now = Rc::new(Cell::new(parse_iso_millis("2026-07-20T13:00:00.000Z")));
    let mut tap = tap_with_cell(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStaticWithoutOwnership(
            "pending output\n",
        )),
        Rc::clone(&now),
        None,
        None,
        input["maintenanceMs"].as_i64(),
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    now.set(now.get() + input["renewAtMs"][0].as_i64().expect("renewAtMs[0]"));
    tap.track_items(&[item("a-renewed", "@1")]);
    let after_renew = tap.tmux_mut().pipe_calls.len();
    now.set(
        parse_iso_millis("2026-07-20T13:00:00.000Z")
            + input["renewAtMs"][1].as_i64().expect("renewAtMs[1]"),
    );
    tap.track_items(&[item("a-retry", "@1")]);
    let after_retry = tap.tmux_mut().pipe_calls.len();
    let read = tap.read("@1", None);
    let stats = tap.stats();
    json!({
        "afterRenew": after_renew,
        "afterRetry": after_retry,
        "read": read,
        "stats": stats,
    })
}

fn case_preserves_foreign_pending(input: &Value, project_state_dir: &Path) -> Value {
    let foreign_token = input["foreignToken"].as_str().expect("foreignToken");
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WritePendingLate("foreign output\n")),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let ownership = tap
        .tmux_mut()
        .pending_ownership
        .clone()
        .expect("pending ownership");
    fs::write(
        &ownership.token_file_path,
        format!("{}\t{foreign_token}\n", std::process::id()),
    )
    .expect("write foreign token");
    let read_before = tap.read("@1", None);
    tap.tmux_mut().is_pane_piped = true;
    tap.track_items(&[item("a-still-demanded", "@1")]);
    let log_content = read_log_content(project_state_dir);
    let token_contains_foreign = fs::read_to_string(&ownership.token_file_path)
        .expect("token file")
        .contains(foreign_token);
    let stats = tap.stats();
    let tmux = tap.into_tmux();
    json!({
        "readBefore": read_before,
        "pipeCalls": tmux.pipe_calls.len(),
        "stopCalls": tmux.stop_calls.len(),
        "logContent": log_content,
        "tokenContainsForeign": token_contains_foreign,
        "stats": stats,
    })
}

fn case_preserves_foreign_tracked(input: &Value, project_state_dir: &Path) -> Value {
    let foreign_token = input["foreignToken"].as_str().expect("foreignToken");
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStatic("owned output\n")),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let token_path = tap_token_paths(project_state_dir)
        .into_iter()
        .next()
        .expect("token path");
    fs::write(
        &token_path,
        format!("{}\t{foreign_token}\n", std::process::id()),
    )
    .expect("write foreign token");
    tap.track_items(&[item("a-still-demanded", "@1")]);
    let read = tap.read("@1", None);
    let log_content = read_log_content(project_state_dir);
    let token_contains_foreign = fs::read_to_string(&token_path)
        .expect("token file")
        .contains(foreign_token);
    let stats = tap.stats();
    let tmux = tap.into_tmux();
    json!({
        "read": read,
        "pipeCalls": tmux.pipe_calls.len(),
        "stopCalls": tmux.stop_calls.len(),
        "logContent": log_content,
        "tokenContainsForeign": token_contains_foreign,
        "stats": stats,
    })
}

fn case_expires_on_read(input: &Value, project_state_dir: &Path) -> Value {
    let now = Rc::new(Cell::new(parse_iso_millis("2026-07-20T13:00:00.000Z")));
    let mut tap = tap_with_cell(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteOwnedOutputForTarget),
        Rc::clone(&now),
        input["activeMs"].as_i64(),
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    now.set(now.get() + input["readAfterMs"].as_i64().expect("readAfterMs"));
    let read = tap.read("@1", None);
    let stats = tap.stats();
    let tmux = tap.into_tmux();
    json!({
        "read": read,
        "stopCalls": target_vec_json(&tmux.stop_calls),
        "filesAfterExpiry": tap_log_names(project_state_dir).len(),
        "stats": stats,
    })
}

fn case_reads_and_compacts(input: &Value, project_state_dir: &Path) -> Value {
    let content = input["content"].as_str().expect("content").to_owned();
    let now = parse_iso_millis("2026-09-06T09:49:13.747Z");
    let max_bytes = input["maxBytes"].as_u64().map(|value| value as usize);
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteDynamic(content)),
        move || now,
        None,
        max_bytes,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let snapshot = tap.read("@1", None);
    json!({
        "snapshot": snapshot,
        "contents": tap_log_contents(project_state_dir),
    })
}

fn case_maintenance_compacts(input: &Value, project_state_dir: &Path) -> Value {
    let now = Rc::new(Cell::new(parse_iso_millis("2026-07-20T13:00:00.000Z")));
    let mut tap = tap_with_cell(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStatic("0123456789")),
        Rc::clone(&now),
        input["activeMs"].as_i64(),
        input["maxBytes"].as_u64().map(|value| value as usize),
        input["maintenanceMs"].as_i64(),
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    let before = tap_log_contents(project_state_dir);
    now.set(now.get() + input["renewAfterMs"].as_i64().expect("renewAfterMs"));
    tap.compact_tracked_files_for_test();
    let after = tap_log_contents(project_state_dir);
    tap.stop();
    let tmux = tap.into_tmux();
    json!({
        "before": before,
        "after": after,
        "stopCalls": tmux.stop_calls.len(),
    })
}

fn case_stop_after_ownership_loss(project_state_dir: &Path) -> Value {
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::WriteStatic("output\n")),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    for path in tap_token_paths(project_state_dir) {
        let _ = fs::remove_file(path);
    }
    tap.stop();
    let tmux = tap.into_tmux();
    json!({
        "stopCalls": tmux.stop_calls.len(),
        "filesAfterStop": tap_log_names(project_state_dir).len(),
    })
}

fn case_pipe_start_fails(project_state_dir: &Path) -> Value {
    let mut tap = tap_with_options(
        project_state_dir,
        FakeTmux::new(PipeBehavior::Throws),
        systemish_now,
        None,
        None,
        None,
    );
    tap.start();
    tap.track_items(&[item("a", "@1")]);
    tap.stop();
    let read = tap.read("@1", None);
    let stats = tap.stats();
    let tmux = tap.into_tmux();
    json!({
        "read": read,
        "stopCalls": tmux.stop_calls.len(),
        "filesAfterStop": tap_log_names(project_state_dir).len(),
        "stats": stats,
    })
}

fn tap_with_cell(
    project_state_dir: &Path,
    tmux: FakeTmux,
    now: Rc<Cell<i64>>,
    active_ms: Option<i64>,
    max_bytes: Option<usize>,
    maintenance_ms: Option<i64>,
) -> ExposePaneOutputTap<FakeTmux> {
    tap_with_options(
        project_state_dir,
        tmux,
        move || now.get(),
        active_ms,
        max_bytes,
        maintenance_ms,
    )
}

fn tap_with_options<F>(
    project_state_dir: &Path,
    tmux: FakeTmux,
    now_millis: F,
    active_ms: Option<i64>,
    max_bytes: Option<usize>,
    maintenance_ms: Option<i64>,
) -> ExposePaneOutputTap<FakeTmux>
where
    F: Fn() -> i64 + 'static,
{
    let mut options = ExposePaneOutputTapOptions::new(project_state_dir);
    if let Some(active_ms) = active_ms {
        options.active_ms = active_ms;
    }
    if let Some(max_bytes) = max_bytes {
        options.max_bytes = max_bytes;
    }
    if let Some(maintenance_ms) = maintenance_ms {
        options.maintenance_ms = maintenance_ms;
    }
    options.now_millis = Box::new(now_millis);
    ExposePaneOutputTap::new(options, tmux)
}

fn item(id: &str, window_id: &str) -> ExposePaneOutputTapItem {
    ExposePaneOutputTapItem {
        id: id.to_owned(),
        target: TmuxTarget {
            session_name: "aimux-test".to_owned(),
            window_id: window_id.to_owned(),
            window_index: 1,
            window_name: "codex".to_owned(),
            pane_dead: None,
        },
    }
}

#[derive(Debug, Clone)]
struct FakeTmux {
    is_pane_piped: bool,
    pipe_behavior: PipeBehavior,
    is_pane_piped_calls: Vec<TmuxTarget>,
    pipe_calls: Vec<PipeCall>,
    stop_calls: Vec<TmuxTarget>,
    pending_ownership: Option<PanePipeOwnership>,
    writes: usize,
}

impl FakeTmux {
    fn new(pipe_behavior: PipeBehavior) -> Self {
        Self {
            is_pane_piped: false,
            pipe_behavior,
            is_pane_piped_calls: Vec::new(),
            pipe_calls: Vec::new(),
            stop_calls: Vec::new(),
            pending_ownership: None,
            writes: 0,
        }
    }

    fn calls_json(&self) -> Value {
        json!({
            "isPanePiped": target_vec_json(&self.is_pane_piped_calls),
            "pipeTargetToFile": self.pipe_calls.iter().map(PipeCall::to_json).collect::<Vec<_>>(),
            "stopPanePipe": target_vec_json(&self.stop_calls),
        })
    }
}

impl ExposePaneOutputTapTmux for FakeTmux {
    fn is_pane_piped(&mut self, target: &TmuxTarget) -> bool {
        self.is_pane_piped_calls.push(target.clone());
        self.is_pane_piped
    }

    fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &Path,
        options: PanePipeFileOptions,
    ) -> Result<(), String> {
        self.pipe_calls.push(PipeCall {
            target: target.clone(),
            file_name: file_path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned(),
            only_if_not_piped: options.only_if_not_piped,
            has_ownership: options.ownership.is_some(),
        });
        if matches!(self.pipe_behavior, PipeBehavior::Throws) {
            return Err("tmux unavailable".to_owned());
        }
        if let Some(ownership) = &options.ownership {
            self.pending_ownership = Some(ownership.clone());
        }
        self.writes += 1;
        match &self.pipe_behavior {
            PipeBehavior::WriteOwnedOutputForTarget => {
                mark_owned_option(&options);
                fs::write(file_path, format!("output for {}\n", target.window_id))
                    .expect("write output");
            }
            PipeBehavior::WriteStatic(content) => {
                mark_owned_option(&options);
                fs::write(file_path, content).expect("write output");
            }
            PipeBehavior::WriteDynamic(content) => {
                mark_owned_option(&options);
                fs::write(file_path, content).expect("write output");
            }
            PipeBehavior::WriteStaleThenFresh => {
                mark_owned_option(&options);
                fs::write(
                    file_path,
                    if self.writes == 1 {
                        "stale output\n"
                    } else {
                        "fresh output\n"
                    },
                )
                .expect("write output");
            }
            PipeBehavior::WritePendingLate(content)
            | PipeBehavior::WriteStaticWithoutOwnership(content) => {
                fs::write(file_path, content).expect("write output");
            }
            PipeBehavior::NoWrite | PipeBehavior::Throws => {}
        }
        Ok(())
    }

    fn stop_pane_pipe(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.stop_calls.push(target.clone());
        Ok(())
    }
}

#[derive(Debug, Clone)]
enum PipeBehavior {
    NoWrite,
    WriteOwnedOutputForTarget,
    WriteStatic(&'static str),
    WriteDynamic(String),
    WriteStaticWithoutOwnership(&'static str),
    WritePendingLate(&'static str),
    WriteStaleThenFresh,
    Throws,
}

#[derive(Debug, Clone)]
struct PipeCall {
    target: TmuxTarget,
    file_name: String,
    only_if_not_piped: bool,
    has_ownership: bool,
}

impl PipeCall {
    fn to_json(&self) -> Value {
        json!({
            "target": target_json(&self.target),
            "file": self.file_name,
            "onlyIfNotPiped": self.only_if_not_piped,
            "hasOwnership": self.has_ownership,
        })
    }
}

fn mark_owned_option(options: &PanePipeFileOptions) {
    if let Some(ownership) = &options.ownership {
        mark_owned(ownership);
    }
}

fn mark_owned(ownership: &PanePipeOwnership) {
    fs::write(
        &ownership.token_file_path,
        format!("{}\t{}\n", std::process::id(), ownership.token),
    )
    .expect("write token");
}

fn target_vec_json(targets: &[TmuxTarget]) -> Value {
    Value::Array(targets.iter().map(target_json).collect())
}

fn target_json(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

fn tap_log_names(project_state_dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = tap_entries(project_state_dir, "log")
        .into_iter()
        .map(|path| {
            path.file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

fn tap_token_paths(project_state_dir: &Path) -> Vec<PathBuf> {
    tap_entries(project_state_dir, "token")
}

fn tap_entries(project_state_dir: &Path, extension: &str) -> Vec<PathBuf> {
    let dir = project_state_dir.join("expose-pane-taps");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some(extension))
        .collect();
    paths.sort();
    paths
}

fn tap_log_contents(project_state_dir: &Path) -> Value {
    let map = tap_entries(project_state_dir, "log")
        .into_iter()
        .map(|path| {
            (
                path.file_name()
                    .expect("file name")
                    .to_string_lossy()
                    .into_owned(),
                Value::String(fs::read_to_string(path).expect("log content")),
            )
        })
        .collect();
    Value::Object(map)
}

fn read_log_content(project_state_dir: &Path) -> String {
    let path = tap_entries(project_state_dir, "log")
        .into_iter()
        .next()
        .expect("log path");
    fs::read_to_string(path).expect("log content")
}

fn parse_iso_millis(value: &str) -> i64 {
    let year = value[0..4].parse::<i32>().expect("year");
    let month = value[5..7].parse::<u8>().expect("month");
    let day = value[8..10].parse::<u8>().expect("day");
    let hour = value[11..13].parse::<u8>().expect("hour");
    let minute = value[14..16].parse::<u8>().expect("minute");
    let second = value[17..19].parse::<u8>().expect("second");
    let millis = value[20..23].parse::<u16>().expect("millis");
    let month = time::Month::try_from(month).expect("month value");
    let date = time::Date::from_calendar_date(year, month, day).expect("date");
    let time = time::Time::from_hms_milli(hour, minute, second, millis).expect("time");
    date.with_time(time).assume_utc().unix_timestamp_nanos() as i64 / 1_000_000
}

fn systemish_now() -> i64 {
    parse_iso_millis("2026-07-20T13:00:00.000Z")
}

struct TempStateDir {
    path: PathBuf,
}

impl TempStateDir {
    fn new() -> Self {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "aimux-rust-expose-tap-{}-{counter}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp state dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempStateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
