use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::project_content::{
    DaemonProjectContentTextRuntime, route_project_content_text_request,
};
use aimux::daemon_state::metadata_state_path;
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::usage_model::UsageState;
use aimux::project_service::usage_monitor::collect_usage;
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct ProbeDirectory(PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct CliRuntime(Value);

impl DaemonProjectContentTextRuntime for CliRuntime {
    fn get_project_service_json(&mut self, _: &str, path: &str) -> ProjectServiceJsonResult {
        assert_eq!(path, "/usage");
        ProjectServiceJsonResult::ok("/probe", self.0.clone())
    }
    fn post_project_service_json(
        &mut self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<u64>,
    ) -> ProjectServiceJsonResult {
        panic!("usage is read from the shared project service");
    }
}

fn capture(context: &ProjectServiceRequestContext, now: i64, expected: UsageState) -> Value {
    let snapshot = collect_usage(context, now).expect("collect fixture usage");
    assert_eq!(snapshot.state, expected);
    let response = route_project_service_request(context, "GET", "/usage", None);
    assert_eq!(response.status, 200);
    let usage = response.body;
    assert_eq!(usage["displayLines"], json!(snapshot.display_lines));
    let cli = route_project_content_text_request(
        &mut CliRuntime(usage.clone()),
        "GET",
        "/core/usage-text?project=%2Fprobe",
        None,
    )
    .expect("CLI usage route");
    assert_eq!(cli.status, 200);
    let DaemonResponseBody::Text(cli) = cli.body else {
        panic!("CLI text response");
    };
    let cli_lines: Vec<_> = cli.lines().map(str::to_owned).collect();
    assert_eq!(cli_lines, snapshot.display_lines);

    let golden: DesktopStateGoldenFixture = serde_json::from_str(include_str!(
        "../../../../src/multiplexer/desktop-state-golden.fixture.json"
    ))
    .expect("desktop golden");
    let mut desktop: DesktopStateSnapshot = golden.runtime_light;
    desktop.extra.insert("usage".into(), usage.clone());
    let rendered = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &desktop,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 600,
        rows: 200,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("test"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&rendered.frame);
    let lines: Vec<_> = plain.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.contains("╭ USAGE "))
        .expect("TUI usage card is visible");
    let tui_lines = lines
        .iter()
        .skip(start + 1)
        .take_while(|line| !line.contains('╰'))
        .map(|line| {
            let (_, content) = line.split_once("│ ").expect("usage card row");
            let (content, _) = content.rsplit_once(" │").expect("usage card row end");
            content.trim_end().to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tui_lines, snapshot.display_lines,
        "TUI must render the same service facts as CLI"
    );
    json!({"usage":usage,"tuiLines":tui_lines,"cliLines":cli_lines})
}

#[test]
fn service_cli_tui_and_app_render_the_same_usage_outcomes() {
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("aimux-usage-surfaces-{}", std::process::id())),
    );
    let state = directory.0.join("state");
    fs::create_dir_all(&state).expect("isolated state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&directory.0, &state);
    let root = directory.0.to_string_lossy();
    let sessions = ["claude", "codex"].map(|tool| json!({
        "id":tool,"nodeId":format!("agent:{tool}"),"tool":tool,"status":"running","worktreePath":root,
        "createdAt":"1970-01-01T00:16:40.000Z","updatedAt":"1970-01-01T00:16:40.000Z"
    }));
    let nodes = ["claude", "codex"].map(|tool| json!({"id":format!("agent:{tool}"),"rigId":"rig","logicalId":tool,"createdAt":"1970-01-01T00:16:40.000Z"}));
    write_runtime_topology(runtime_topology_path(&state), &json!({
        "version":1,"generatedAt":"1970-01-01T00:16:40.000Z",
        "rigs":[{"id":"rig","name":"local","projectRoot":root,"createdAt":"1970-01-01T00:16:40.000Z","updatedAt":"1970-01-01T00:16:40.000Z"}],
        "nodes":nodes,"sessions":sessions,"edges":[],"bindings":[],"services":[],"worktrees":[],"teamRoles":[],"remoteClients":[],"lifecycleOperations":[]
    })).expect("seed topology");
    let claude = directory.0.join("claude.jsonl");
    let codex = directory.0.join("codex.jsonl");
    fs::write(
        metadata_state_path(&state),
        serde_json::to_vec(&json!({"version":1,"sessions":{
            "claude":{"toolConfigKey":"claude","context":{"transcriptPath":claude}},
            "codex":{"toolConfigKey":"codex","context":{"transcriptPath":codex}}
        }}))
        .expect("metadata JSON"),
    )
    .expect("seed metadata");

    let absent = capture(&context, 1_000, UsageState::Absent);
    fs::write(&claude, "").expect("Claude transcript");
    let codex_record = |percent: Value| {
        json!({
        "timestamp":"1970-01-01T00:16:40.000Z","type":"event_msg","payload":{
            "type":"token_count","info":{"total_token_usage":{"input_tokens":10000,"cached_input_tokens":9900,"output_tokens":17}},
            "rate_limits":{"primary":{"used_percent":percent,"window_minutes":300,"resets_at":2000},"tertiary":{"used_percent":42,"window_minutes":1440,"resets_at":2000}}
        }
    }).to_string() + "\n"
    };
    fs::write(&codex, codex_record(json!(0))).expect("Codex reported quota");
    let known = capture(&context, 1_001, UsageState::Known);
    assert!(
        known["usage"]["displayLines"]
            .as_array()
            .expect("lines")
            .iter()
            .any(|line| line
                .as_str()
                .is_some_and(|line| line.contains("codex") && line.contains("0% used")))
    );
    fs::write(&codex, codex_record(json!("malformed"))).expect("malformed quota report");
    let error = capture(&context, 1_002, UsageState::Error);
    assert!(
        error["usage"]["displayLines"]
            .as_array()
            .expect("lines")
            .iter()
            .any(|line| line
                .as_str()
                .is_some_and(|line| line.contains("codex") && line.contains("error:")))
    );

    let probe = directory.0.join("surfaces.json");
    fs::write(
        &probe,
        serde_json::to_vec(&json!({"cases":[absent,known,error]})).expect("probe JSON"),
    )
    .expect("write observations");
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let result = Command::new(project.join("scripts/run-yarn"))
        .current_dir(&project)
        .args([
            "--cwd",
            "app",
            "vitest",
            "run",
            "lib/usage-monitor.cross-surface.test.ts",
        ])
        .env("AIMUX_USAGE_SURFACE_PROBE", &probe)
        .output()
        .expect("run app surface comparison");
    assert!(
        result.status.success(),
        "usage app/CLI/TUI comparison failed ({}):\n{}\n{}",
        result.status,
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
