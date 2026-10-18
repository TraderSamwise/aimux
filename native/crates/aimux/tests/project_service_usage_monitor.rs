use aimux::atomic_write::write_json_atomic;
use aimux::daemon_state::metadata_state_path;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::usage_model::UsageState;
use aimux::project_service::usage_monitor::{
    USAGE_MONITOR_INTERVAL_MS, USAGE_MONITOR_TASK_NAME, UsageSnapshot, claude_quota_path,
    collect_usage, usage_monitor_state_path, usage_monitor_task,
};
use aimux::runtime_topology::{
    empty_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    context: ProjectServiceRequestContext,
}

impl Fixture {
    fn new(tools: &[(&str, &str)]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-usage-monitor-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let project = root.join("project");
        let state = root.join("state");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&state).unwrap();
        let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state);
        let fixture = Self { root, context };
        fixture.sessions(tools);
        fixture
    }

    fn sessions(&self, tools: &[(&str, &str)]) {
        let stamp = "2026-10-18T00:00:00.000Z";
        let mut topology = empty_runtime_topology();
        topology["rigs"] = json!([{"id":"rig","name":"local","projectRoot":self.context.project_root(),"createdAt":stamp,"updatedAt":stamp}]);
        topology["nodes"] = json!(tools.iter().map(|(id,_)| json!({"id":format!("agent:{id}"),"rigId":"rig","logicalId":id,"createdAt":stamp})).collect::<Vec<_>>());
        topology["sessions"] = json!(tools.iter().map(|(id,tool)| json!({"id":id,"nodeId":format!("agent:{id}"),"status":"running","tool":tool,"createdAt":stamp,"updatedAt":stamp})).collect::<Vec<_>>());
        write_runtime_topology(
            runtime_topology_path(self.context.project_state_dir()),
            &topology,
        )
        .unwrap();
        let sessions = tools.iter().map(|(id,tool)| ((*id).to_owned(), json!({"toolConfigKey":tool,"backendSessionId":format!("backend-{id}"),"context":{"transcriptPath":self.transcript(id)}}))).collect::<serde_json::Map<_,_>>();
        write_json_atomic(
            metadata_state_path(self.context.project_state_dir()),
            &json!({"version":1,"sessions":sessions}),
        )
        .unwrap();
    }

    fn transcript(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.jsonl"))
    }
    fn collect(&self, now: i64) -> UsageSnapshot {
        collect_usage(&self.context, now).unwrap()
    }
    fn get(&self) -> Value {
        route_project_service_request(&self.context, "GET", "/usage", None).body
    }
    fn post(
        &self,
        id: &str,
        limits: Value,
    ) -> aimux::project_service::dispatcher::ProjectServiceDispatchResponse {
        route_project_service_request(
            &self.context,
            "POST",
            "/usage/claude/statusline",
            Some(&json!({"sessionId":id,"rateLimits":limits})),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn append(path: &Path, record: Value) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{record}").unwrap();
}

fn claude_record(id: &str) -> Value {
    json!({"message":{"id":id,"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":900000,"output_tokens":30}}})
}

fn codex_record(multiplier: u64, rate_limits: Value) -> Value {
    json!({"timestamp":"2026-10-18T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000*multiplier,"cached_input_tokens":900*multiplier,"cache_write_input_tokens":20*multiplier,"output_tokens":30*multiplier}},"rate_limits":rate_limits}})
}

fn tokens(snapshot: &UsageSnapshot, tool: &str) -> Option<u64> {
    snapshot
        .tools
        .iter()
        .find(|summary| summary.tool == tool)
        .unwrap()
        .token_spend
        .billed_tokens
}

#[test]
fn service_cross_runtime_currency_persists_across_restart_without_goal_budgets() {
    let fixture = Fixture::new(&[("cc", "claude"), ("cx", "codex")]);
    append(&fixture.transcript("cc"), claude_record("history"));
    append(&fixture.transcript("cx"), codex_record(10, Value::Null));
    let cold = fixture.collect(100);
    assert_eq!(tokens(&cold, "claude"), None);
    assert_eq!(tokens(&cold, "codex"), None);
    append(&fixture.transcript("cc"), claude_record("new"));
    append(&fixture.transcript("cc"), claude_record("new"));
    append(&fixture.transcript("cx"), codex_record(11, Value::Null));
    let measured = fixture.collect(200);
    assert_eq!(tokens(&measured, "claude"), Some(150));
    assert_eq!(tokens(&measured, "codex"), Some(150));
    let restarted = ProjectServiceRequestContext::with_project_state_dir(
        fixture.context.project_root(),
        fixture.context.project_state_dir(),
    );
    append(&fixture.transcript("cc"), claude_record("after-restart"));
    append(&fixture.transcript("cx"), codex_record(12, Value::Null));
    let after_restart = collect_usage(&restarted, 300).unwrap();
    assert_eq!(after_restart.started_at, 100);
    assert_eq!(tokens(&after_restart, "claude"), Some(300));
    assert_eq!(tokens(&after_restart, "codex"), Some(300));
    assert!(after_restart.display_lines.iter().any(|line| {
        line.contains("claude: 300 billed-equivalent tokens since monitoring started (100)")
    }));
    assert!(after_restart.display_lines.iter().any(|line| {
        line.contains("codex: 300 billed-equivalent tokens since monitoring started (100)")
    }));
    assert_eq!(fixture.get()["ok"], true);
}

#[test]
fn cold_claude_collection_takes_eof_baseline_without_parsing_history() {
    let fixture = Fixture::new(&[("cc", "claude")]);
    fs::write(fixture.transcript("cc"), "not-json historical data\n").unwrap();
    fixture.collect(100);
    let state: Value = serde_json::from_str(
        &fs::read_to_string(usage_monitor_state_path(
            fixture.context.project_state_dir(),
        ))
        .unwrap(),
    )
    .unwrap();
    let baseline = &state["sessions"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["baseline"];
    assert_eq!(
        baseline["offset"],
        fs::metadata(fixture.transcript("cc")).unwrap().len()
    );
    append(&fixture.transcript("cc"), claude_record("first-observed"));
    assert_eq!(tokens(&fixture.collect(200), "claude"), Some(150));
}

#[test]
fn missing_weekly_known_zero_and_collection_error_survive_service_route() {
    let fixture = Fixture::new(&[("cx", "codex")]);
    append(
        &fixture.transcript("cx"),
        codex_record(
            1,
            json!({"primary":{"used_percent":0,"window_minutes":300,"resets_at":2000},"secondary":null}),
        ),
    );
    fixture.collect(1000);
    let body = fixture.get();
    let codex = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["tool"] == "codex")
        .unwrap();
    let windows = codex["quotaSources"][0]["observation"]["windows"]
        .as_array()
        .unwrap();
    assert_eq!(windows[0]["state"], "known");
    assert_eq!(windows[0]["usedPercent"].as_f64(), Some(0.0));
    assert_eq!(windows[1]["state"], "absent");
    assert!(windows[1]["usedPercent"].is_null());
    append(
        &fixture.transcript("cx"),
        codex_record(
            2,
            json!({"primary":{"used_percent":"broken","window_minutes":300}}),
        ),
    );
    fixture.collect(1100);
    let failed = fixture.get();
    assert_eq!(failed["state"], "error");
    assert!(
        failed["reason"]
            .as_str()
            .unwrap()
            .contains("Codex quota source")
    );
    assert!(
        failed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["tool"] == "codex"
                && tool["quotaSources"][0]["observation"]["state"] == "error")
    );
}

#[test]
fn read_and_refresh_route_use_cached_snapshot_without_filesystem_collection() {
    let fixture = Fixture::new(&[("cx", "codex")]);
    fixture.collect(100);
    fs::write(
        metadata_state_path(fixture.context.project_state_dir()),
        "invalid JSON",
    )
    .unwrap();
    let before = fixture.get();
    let refreshed =
        route_project_service_request(&fixture.context, "GET", "/usage?refresh=1", None);
    assert_eq!(refreshed.status, 200);
    assert_eq!(refreshed.body, before);
    assert_eq!(refreshed.body["observedAt"], 100);
    assert!(
        fixture
            .context
            .scheduler
            .take_forced_task(USAGE_MONITOR_TASK_NAME)
    );
    assert!(
        collect_usage(&fixture.context, 200)
            .unwrap_err()
            .contains("metadata.json")
    );
    let failed = fixture.get();
    assert_eq!(failed["state"], "error");
    assert!(!failed["tools"].as_array().unwrap().is_empty());
}

#[test]
fn claude_statusline_route_validates_identity_and_kicks_only_changed_quota_values() {
    let fixture = Fixture::new(&[("cc", "claude"), ("cx", "codex")]);
    let limits = json!({"five_hour":{"used_percentage":0,"resets_at":4102444800_i64}});
    assert_eq!(fixture.post("missing", limits.clone()).status, 404);
    assert_eq!(fixture.post("cx", limits.clone()).status, 400);
    assert_eq!(
        fixture
            .post("cc", json!({"seven_day":{"used_percentage":"bad"}}))
            .status,
        400
    );
    let first = fixture.post("cc", limits.clone());
    assert_eq!(first.status, 200);
    assert_eq!(first.body["changed"], true);
    assert!(
        fixture
            .context
            .scheduler
            .take_forced_task(USAGE_MONITOR_TASK_NAME)
    );
    assert_eq!(fixture.post("cc", limits).body["changed"], false);
    assert!(
        !fixture
            .context
            .scheduler
            .take_forced_task(USAGE_MONITOR_TASK_NAME)
    );
    assert!(claude_quota_path(fixture.context.project_state_dir()).is_file());
    let snapshot = fixture.collect(1000);
    let claude = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "claude")
        .unwrap();
    assert_eq!(claude.quota_sources[0].session_id.as_deref(), Some("cc"));
    assert_eq!(
        claude.quota_sources[0].observation.windows[0].used_percent,
        Some(0.0)
    );
    assert_eq!(
        claude.quota_sources[0].observation.windows[1].state,
        UsageState::Absent
    );
}

#[test]
fn quota_observations_remain_per_session_and_expired_windows_are_unknown() {
    let fixture = Fixture::new(&[("one", "codex"), ("two", "codex")]);
    append(
        &fixture.transcript("one"),
        codex_record(
            1,
            json!({"primary":{"used_percent":10,"window_minutes":10080,"resets_at":2000}}),
        ),
    );
    append(
        &fixture.transcript("two"),
        codex_record(
            1,
            json!({"primary":{"used_percent":20,"window_minutes":300,"resets_at":2000}}),
        ),
    );
    let snapshot = fixture.collect(1000);
    let codex = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap();
    assert_eq!(codex.quota_sources.len(), 2);
    assert_eq!(
        codex.quota_sources[0].observation.windows[1].used_percent,
        Some(10.0)
    );
    assert_eq!(
        codex.quota_sources[0].observation.windows[0].used_percent,
        None
    );
    assert_eq!(
        codex.quota_sources[1].observation.windows[0].used_percent,
        Some(20.0)
    );
    let expired = fixture.collect(3000);
    let codex = expired
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap();
    assert!(
        codex
            .quota_sources
            .iter()
            .all(|source| source.observation.state == UsageState::Absent)
    );
    assert!(
        codex
            .quota_sources
            .iter()
            .flat_map(|source| &source.observation.windows)
            .all(|window| window.used_percent.is_none())
    );
}

#[test]
fn observed_totals_survive_transcript_rotation_truncation_tool_switch_and_removal() {
    let fixture = Fixture::new(&[("worker", "claude")]);
    append(&fixture.transcript("worker"), json!({}));
    fixture.collect(100);
    append(&fixture.transcript("worker"), claude_record("one"));
    assert_eq!(tokens(&fixture.collect(200), "claude"), Some(150));
    fs::write(fixture.transcript("worker"), "{}\n").unwrap();
    assert_eq!(tokens(&fixture.collect(300), "claude"), Some(150));
    append(&fixture.transcript("worker"), claude_record("two"));
    assert_eq!(tokens(&fixture.collect(400), "claude"), Some(300));
    fixture.sessions(&[("worker", "codex")]);
    append(&fixture.transcript("worker"), codex_record(1, Value::Null));
    fixture.collect(500);
    append(&fixture.transcript("worker"), codex_record(2, Value::Null));
    let switched = fixture.collect(600);
    assert_eq!(tokens(&switched, "claude"), Some(300));
    assert_eq!(tokens(&switched, "codex"), Some(150));
    fixture.sessions(&[]);
    let retired = fixture.collect(700);
    assert_eq!(tokens(&retired, "claude"), Some(300));
    assert_eq!(tokens(&retired, "codex"), Some(150));
}

#[test]
fn malformed_authority_sources_publish_errors_and_do_not_reset_baselines() {
    for source in ["state", "metadata", "topology", "claude-quota"] {
        let fixture = Fixture::new(&[("cc", "claude")]);
        fixture.collect(100);
        let path = match source {
            "state" => usage_monitor_state_path(fixture.context.project_state_dir()),
            "metadata" => metadata_state_path(fixture.context.project_state_dir()),
            "topology" => runtime_topology_path(fixture.context.project_state_dir()),
            _ => claude_quota_path(fixture.context.project_state_dir()),
        };
        fs::write(&path, "{ broken source").unwrap();
        let reason = collect_usage(&fixture.context, 200).unwrap_err();
        assert!(
            reason.contains(path.file_name().unwrap().to_str().unwrap()),
            "{reason}"
        );
        assert_eq!(fixture.get()["state"], "error");
        assert!(collect_usage(&fixture.context, 300).is_err());
        let cache = fixture.context.usage_monitor.read().unwrap();
        assert_eq!(
            cache
                .display_lines
                .iter()
                .filter(|line| line.starts_with("Usage collection error:"))
                .count(),
            1
        );
    }
}

#[test]
fn unsupported_monitor_state_version_is_not_a_fresh_empty_monitor() {
    let fixture = Fixture::new(&[]);
    write_json_atomic(
        usage_monitor_state_path(fixture.context.project_state_dir()),
        &json!({"version":99,"startedAt":1,"sessions":{}}),
    )
    .unwrap();
    assert!(
        collect_usage(&fixture.context, 100)
            .unwrap_err()
            .contains("version 99 unsupported")
    );
    assert_eq!(fixture.get()["state"], "error");
}

#[test]
fn usage_task_is_shared_periodic_and_reports_source_failure_to_scheduler() {
    let fixture = Fixture::new(&[]);
    let context = Arc::new(fixture.context.clone());
    let mut task = usage_monitor_task(&context);
    assert_eq!(task.name(), USAGE_MONITOR_TASK_NAME);
    assert_eq!(task.interval_ms(), USAGE_MONITOR_INTERVAL_MS);
    assert!(task.tick_multiple() > 1);
    assert!(task.run_immediately());
    fs::write(metadata_state_path(context.project_state_dir()), "{ broken").unwrap();
    aimux::async_runtime::init_process_runtime().unwrap();
    // aimux-async-seam: test - exercise scheduled collector with its blocking worker.
    let failure =
        aimux::async_runtime::block_on_named("usage-monitor-test:run", task.run(&context))
            .unwrap_err();
    assert!(failure.contains("metadata.json"));
    assert_eq!(
        context.usage_monitor.read().unwrap().state,
        UsageState::Error
    );
}

#[test]
fn nonregular_transcript_reports_error_without_opening_a_stream() {
    let fixture = Fixture::new(&[("cx", "codex")]);
    fs::create_dir(fixture.transcript("cx")).unwrap();
    let snapshot = fixture.collect(100);
    assert_eq!(snapshot.state, UsageState::Error);
    assert!(
        snapshot
            .reason
            .as_deref()
            .unwrap()
            .contains("not a regular file")
    );
    let source = &snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap()
        .quota_sources[0]
        .observation;
    assert_eq!(source.state, UsageState::Error);
    assert!(
        source
            .reason
            .as_deref()
            .unwrap()
            .contains("not a regular file")
    );
}

#[test]
fn bounded_tail_discards_leading_and_trailing_partial_quota_records() {
    let fixture = Fixture::new(&[("cx", "codex")]);
    let mut oversized = "x".repeat(aimux::agent_token_spend::CODEX_TAIL_BYTES as usize + 1);
    oversized.push_str("token_count rate_limits\n");
    fs::write(fixture.transcript("cx"), oversized).unwrap();
    let snapshot = fixture.collect(100);
    let source = &snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap()
        .quota_sources[0]
        .observation;
    assert_eq!(source.state, UsageState::Absent);
    assert!(source.reason.as_deref().unwrap().contains("no complete"));
    append(
        &fixture.transcript("cx"),
        codex_record(
            1,
            json!({"primary":{"used_percent":8,"window_minutes":300,"resets_at":2000}}),
        ),
    );
    let mut file = OpenOptions::new()
        .append(true)
        .open(fixture.transcript("cx"))
        .unwrap();
    write!(
        file,
        "{{\"payload\":{{\"type\":\"token_count\",\"rate_limits\":"
    )
    .unwrap();
    let snapshot = fixture.collect(200);
    let source = &snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap()
        .quota_sources[0]
        .observation;
    assert_eq!(source.state, UsageState::Known);
    assert_eq!(source.windows[0].used_percent, Some(8.0));
}

#[test]
fn codex_keeps_newest_complete_observation_per_metered_bucket() {
    let fixture = Fixture::new(&[("cx", "codex")]);
    let global = json!({"limit_id":"codex","primary":{"used_percent":10,"window_minutes":300,"resets_at":4102444800_i64},"secondary":{"used_percent":70,"window_minutes":10080,"resets_at":4102444800_i64}});
    append(&fixture.transcript("cx"), codex_record(1, global.clone()));
    let mut scoped = codex_record(
        2,
        json!({"limit_id":"premium","limit_name":"Premium","primary":{"used_percent":20,"window_minutes":300,"resets_at":4102444800_i64}}),
    );
    scoped["timestamp"] = json!("2026-10-18T00:01:00.000Z");
    append(&fixture.transcript("cx"), scoped);
    let mut latest_global = codex_record(3, global);
    latest_global["timestamp"] = json!("2026-10-18T00:02:00.000Z");
    latest_global["payload"]["rate_limits"]["primary"]["used_percent"] = json!(30);
    append(&fixture.transcript("cx"), latest_global);
    let snapshot = fixture.collect(1000);
    let sources = &snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "codex")
        .unwrap()
        .quota_sources;
    assert_eq!(sources.len(), 2);
    let global = sources
        .iter()
        .find(|source| {
            source
                .observation
                .windows
                .iter()
                .any(|window| window.id == "weekly" && window.state == UsageState::Known)
        })
        .unwrap();
    let scoped = sources
        .iter()
        .find(|source| {
            source
                .observation
                .windows
                .iter()
                .any(|window| window.id == "premium:five_hour")
        })
        .unwrap();
    assert_eq!(global.observation.windows[0].used_percent, Some(30.0));
    assert_eq!(global.observation.windows[1].used_percent, Some(70.0));
    assert_eq!(
        global.observation.observed_at - scoped.observation.observed_at,
        60
    );
    assert_eq!(global.session_id.as_deref(), Some("cx"));
    assert_eq!(scoped.session_id.as_deref(), Some("cx"));
    assert!(
        scoped
            .observation
            .windows
            .iter()
            .any(|window| window.used_percent == Some(20.0))
    );
}

#[test]
fn stale_and_live_aliases_share_one_physical_runtime_baseline() {
    let fixture = Fixture::new(&[("old", "claude")]);
    let path = fixture.transcript("old");
    append(&path, json!({}));
    let metadata_path = metadata_state_path(fixture.context.project_state_dir());
    let mut metadata: Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata["sessions"]["old"]["backendSessionId"] = json!("shared-backend");
    write_json_atomic(&metadata_path, &metadata).unwrap();
    fixture.collect(100);
    fixture.sessions(&[("old", "claude"), ("new", "claude")]);
    let mut topology: Value = aimux::runtime_topology::read_runtime_topology(
        runtime_topology_path(fixture.context.project_state_dir()),
    )
    .unwrap();
    topology["sessions"][0]["status"] = json!("offline");
    write_runtime_topology(
        runtime_topology_path(fixture.context.project_state_dir()),
        &topology,
    )
    .unwrap();
    let mut metadata: Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    for id in ["old", "new"] {
        metadata["sessions"][id]["backendSessionId"] = json!("shared-backend");
        metadata["sessions"][id]["context"]["transcriptPath"] = json!(path);
    }
    write_json_atomic(&metadata_path, &metadata).unwrap();
    append(&path, claude_record("new-work"));
    let snapshot = fixture.collect(200);
    assert_eq!(tokens(&snapshot, "claude"), Some(150));
    let claude = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "claude")
        .unwrap();
    assert_eq!(claude.token_spend.measured_sessions, 1);
    assert_eq!(claude.quota_sources.len(), 1);
    assert_eq!(claude.quota_sources[0].session_id.as_deref(), Some("new"));
    let state: Value = serde_json::from_str(
        &fs::read_to_string(usage_monitor_state_path(
            fixture.context.project_state_dir(),
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(state["sessions"].as_object().unwrap().len(), 1);
}

#[test]
fn configured_aliases_use_actual_runtime_and_spoofed_claude_key_is_rejected() {
    let fixture = Fixture::new(&[
        ("cc", "claude-fast"),
        ("cx", "codex-fast"),
        ("spoof", "claude"),
    ]);
    write_json_atomic(aimux::config::project_config_path_for_known_root(fixture.context.project_root()), &json!({"tools":{"claude-fast":{"command":"/installed/claude"},"codex-fast":{"command":"/installed/codex"}}})).unwrap();
    let metadata_path = metadata_state_path(fixture.context.project_state_dir());
    let mut metadata: Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata["sessions"]["spoof"]["command"] = json!("/installed/codex");
    write_json_atomic(&metadata_path, &metadata).unwrap();
    assert_eq!(
        fixture
            .post("cc", json!({"five_hour":{"used_percentage":0}}))
            .status,
        200
    );
    assert_eq!(fixture.post("cx", Value::Null).status, 400);
    assert_eq!(fixture.post("spoof", Value::Null).status, 400);
    append(&fixture.transcript("cc"), json!({}));
    append(&fixture.transcript("cx"), codex_record(1, Value::Null));
    fixture.collect(100);
    append(&fixture.transcript("cc"), claude_record("alias-work"));
    append(&fixture.transcript("cx"), codex_record(2, Value::Null));
    let measured = fixture.collect(200);
    assert_eq!(tokens(&measured, "claude-fast"), Some(150));
    assert_eq!(tokens(&measured, "codex-fast"), Some(150));
    assert!(
        measured
            .display_lines
            .iter()
            .any(|line| line.starts_with("claude-fast:"))
    );
    assert!(
        measured
            .display_lines
            .iter()
            .any(|line| line.starts_with("codex-fast:"))
    );
}

#[test]
fn claude_raw_spend_and_collector_failure_are_visible_without_guessed_percentage() {
    let fixture = Fixture::new(&[("cc", "claude")]);
    assert_eq!(
        fixture
            .post(
                "cc",
                json!({"spend_limit":{"used_usd":12.5,"period":"monthly","resets_at":2000}})
            )
            .status,
        200
    );
    let snapshot = fixture.collect(1000);
    let claude = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool == "claude")
        .unwrap();
    let spend = claude.quota_sources[0]
        .observation
        .windows
        .iter()
        .find(|window| window.id == "spend_limit")
        .unwrap();
    assert_eq!(spend.used_usd, Some(12.5));
    assert_eq!(spend.used_percent, None);
    assert_eq!(spend.limit_usd, None);
    assert!(
        claude
            .display_lines
            .iter()
            .any(|line| line.contains("$12.5 used, monthly"))
    );
    let expired = fixture.collect(3000);
    let spend = expired
        .tools
        .iter()
        .find(|tool| tool.tool == "claude")
        .unwrap()
        .quota_sources[0]
        .observation
        .windows
        .iter()
        .find(|window| window.id == "spend_limit")
        .unwrap();
    assert_eq!(spend.state, UsageState::Absent);
    assert_eq!(spend.used_usd, None);
    assert!(!spend.display_text().contains("$12.5"));
    let failed = route_project_service_request(
        &fixture.context,
        "POST",
        "/usage/claude/statusline",
        Some(&json!({"sessionId":"cc","collectorError":"Claude statusline quota parse failed"})),
    );
    assert_eq!(failed.status, 200);
    let failed = fixture.collect(3100);
    assert_eq!(failed.state, UsageState::Error);
    assert!(
        failed
            .display_lines
            .iter()
            .any(|line| line.contains("Claude statusline quota parse failed"))
    );
    let oversized = route_project_service_request(
        &fixture.context,
        "POST",
        "/usage/claude/statusline",
        Some(&json!({"sessionId":"cc","collectorError":"x".repeat(1025)})),
    );
    assert_eq!(oversized.status, 400);
}

#[test]
fn service_route_labels_each_tool_and_keeps_their_usage_separate() {
    let fixture = Fixture::new(&[("cc", "claude"), ("cx", "codex")]);
    fixture.collect(100);
    let body = fixture.get();
    for tool in ["claude", "codex"] {
        let summary = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|summary| summary["tool"] == tool)
            .expect("separate tool summary");
        assert_eq!(summary["label"], tool);
        let lines = summary["displayLines"].as_array().unwrap();
        assert!(!lines.is_empty());
        assert!(lines.iter().all(|line| {
            let line = line.as_str().unwrap();
            line.starts_with(&format!("{tool}:")) || line.starts_with(&format!("{tool} ["))
        }));
        assert!(
            body["displayLines"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line.as_str().unwrap().starts_with(&format!("{tool}:")))
        );
    }
}
