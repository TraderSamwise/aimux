use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::project_content::{
    DaemonProjectContentTextRuntime, route_project_content_text_request,
};
use aimux::daemon_state::metadata_state_path;
use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, DashboardScreen,
    parse_dashboard_key,
};
use aimux::dashboard_internal::{
    dashboard_screen_actions_with_width, dashboard_screen_resource_path,
};
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_project_events::{DashboardProjectEvent, DashboardProjectRefreshState};
use aimux::dashboard_renderer::{
    DashboardSubscreenRenderInput, render_dashboard_subscreen_frame, usage_screen_rows,
};
use aimux::project_service::desktop_state::desktop_state_for_context;
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

#[test]
fn usage_screen_navigation_reaches_the_final_line_at_eighty_by_twenty_four() {
    let desktop: DesktopStateSnapshot = serde_json::from_value(json!({
        "sessions":[],"teammates":[],"services":[],"worktrees":[],"worktreeGroups":[],
        "mainCheckoutInfo":{"name":"test","branch":"master"},
        "usage":{"displayLines":["cached usage"]}
    }))
    .expect("desktop fixture");
    let long_path = format!(
        "/{}SentinelSuffix.jsonl",
        "unbroken-transcript-path".repeat(10)
    );
    let resource = json!({"ok":true,"displayLines":(0..80).map(|index| format!("codex: meter {index}: unknown: runtime did not report this quota")).chain([long_path.clone(), "claude: final weekly window: error: permission denied".to_owned()]).collect::<Vec<_>>()});
    let mut controller = DashboardController::new(&desktop);
    assert_eq!(
        controller.handle_key(&desktop, parse_dashboard_key(b"U")),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen, DashboardScreen::Usage);
    let mut refresh = DashboardProjectRefreshState::default();
    refresh.observe_for_screen(
        &DashboardProjectEvent::ProjectUpdate(
            json!({"views":["desktop-state"],"reason":"usage-monitor"})
                .as_object()
                .expect("event")
                .clone(),
        ),
        Some(controller.screen.as_str()),
    );
    assert!(
        refresh.take_refresh_request(),
        "collector desktop-state events must refresh the open Usage screen"
    );
    refresh.complete_refresh();
    let expected_rows = usage_screen_rows(Some(&resource), 80);
    let count = expected_rows.len();
    let original_lines: String = resource["displayLines"]
        .as_array()
        .expect("service display lines")
        .iter()
        .map(|line| line.as_str().expect("service text"))
        .collect();
    assert_eq!(expected_rows.concat(), original_lines);
    assert!(count > 82, "the long unbroken path must wrap across rows");
    controller.set_subscreen_actions(dashboard_screen_actions_with_width(
        controller.screen,
        Some(&resource),
        80,
    ));
    assert_eq!(controller.subscreen_item_count, count);
    let mut scroll_offset = 0;
    let mut last_frame = String::new();
    for (index, expected_row) in expected_rows.iter().enumerate() {
        assert_eq!(controller.subscreen_index, index);
        let rendered = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
            screen: controller.screen,
            resource: Some(&resource),
            error: None,
            selected_index: controller.subscreen_index,
            cols: 80,
            rows: 24,
            scroll_offset,
            footer_progress: None,
            footer_note: None,
            footer_alerts: &[],
            details_sidebar_visible: true,
            runtime_label: Some("tmux"),
            version: Some("test"),
        });
        scroll_offset = rendered.scroll_offset;
        last_frame = strip_ansi(&rendered.frame);
        assert!(
            last_frame.contains(expected_row),
            "selected usage row {index} must remain visible in the actual viewport"
        );
        if index + 1 < count {
            assert_eq!(
                controller.handle_key(&desktop, DashboardKey::Down),
                DashboardControllerEffect::Render
            );
        }
    }
    assert!(scroll_offset > 0);
    assert!(last_frame.contains("SentinelSuffix.jsonl"));
    assert!(last_frame.contains("claude: final weekly window: error: permission denied"));
    assert!(last_frame.contains("scroll usage"));
    assert_eq!(
        controller.handle_key(&desktop, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen, DashboardScreen::Dashboard);
}

fn capture(context: &ProjectServiceRequestContext, now: i64, expected: UsageState) -> Value {
    let snapshot = collect_usage(context, now).expect("collect fixture usage");
    assert_eq!(snapshot.state, expected);
    let usage_path =
        dashboard_screen_resource_path(DashboardScreen::Usage).expect("usage screen service route");
    assert_eq!(usage_path, "/usage");
    let response = route_project_service_request(context, "GET", usage_path, None);
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

    let desktop =
        desktop_state_for_context(context).expect("real service desktop-state projection");
    assert_eq!(
        desktop["usage"],
        serde_json::to_value(&snapshot).expect("usage JSON")
    );
    let rendered = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Usage,
        resource: Some(&usage),
        error: None,
        selected_index: 0,
        cols: 600,
        rows: 200,
        runtime_label: Some("tmux"),
        version: Some("test"),
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
    });
    let plain = strip_ansi(&rendered.frame.replace("\x1b[m\x1b[K", ""));
    let lines: Vec<_> = plain.lines().collect();
    let tui_lines = lines
        .iter()
        .skip(4)
        .take(snapshot.display_lines.len())
        .map(|line| {
            line.strip_prefix("▸ ")
                .or_else(|| line.strip_prefix("  "))
                .expect("usage row selection chrome")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tui_lines, snapshot.display_lines,
        "TUI must render the same service facts as CLI"
    );
    json!({"usage":usage,"desktop":desktop,"tuiLines":tui_lines,"cliLines":cli_lines})
}

#[test]
fn service_cli_tui_and_app_render_the_same_usage_outcomes() {
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("aimux-usage-surfaces-{}", std::process::id())),
    );
    let state = directory.0.join("state");
    fs::create_dir_all(&state).expect("isolated state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&directory.0, &state)
        .with_live_windows(Default::default());
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
