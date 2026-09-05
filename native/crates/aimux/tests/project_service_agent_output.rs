use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, AgentOutputResponseMode, MAX_AGENT_OUTPUT_CAPTURE_LINES,
    agent_output_capture_window, bounded_agent_output_end_line, bounded_agent_output_start_line,
    normalize_submitted_prompt, parse_agent_output_read_purpose, parse_agent_output_response_mode,
    project_agent_output_payload, route_agent_output_request_with_runtime, strip_sgr,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeCaptureRuntime {
    output: String,
    calls: Vec<(String, CapturePaneOptions)>,
    actions: Vec<FakeRuntimeAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FakeRuntimeAction {
    Capture(String),
    Resize(String, i64, i64),
    Text(String, String),
    Key(String, String),
    CarriageReturn(String),
    Escape(String),
}

impl AgentOutputCaptureRuntime for FakeCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        self.actions
            .push(FakeRuntimeAction::Capture(window_id.to_owned()));
        Ok(self.output.clone())
    }

    fn resize_window(&mut self, window_id: &str, cols: i64, rows: i64) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Resize(window_id.to_owned(), cols, rows));
        Ok(())
    }

    fn send_text(&mut self, window_id: &str, text: &str) -> Result<(), String> {
        self.actions.push(FakeRuntimeAction::Text(
            window_id.to_owned(),
            text.to_owned(),
        ));
        Ok(())
    }

    fn send_key(&mut self, window_id: &str, key: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Key(window_id.to_owned(), key.to_owned()));
        Ok(())
    }

    fn send_carriage_return(&mut self, window_id: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::CarriageReturn(window_id.to_owned()));
        Ok(())
    }

    fn send_escape(&mut self, window_id: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Escape(window_id.to_owned()));
        Ok(())
    }
}

#[test]
fn output_bounds_match_typescript_capture_window_contract() {
    assert_eq!(bounded_agent_output_start_line(None), -120);
    assert_eq!(bounded_agent_output_start_line(Some(-80)), -80);
    assert_eq!(
        bounded_agent_output_start_line(Some(-999_999)),
        -MAX_AGENT_OUTPUT_CAPTURE_LINES
    );
    assert_eq!(bounded_agent_output_end_line(-80), None);
    assert_eq!(bounded_agent_output_end_line(25), Some(2024));

    assert_eq!(
        agent_output_capture_window(Some(-999_999)),
        aimux::project_service::agent_output::AgentOutputCaptureWindow {
            requested_start_line: -999_999,
            start_line: -2000,
            end_line: None,
            max_lines: 2000,
            tail_only: true,
            clamped: true,
        }
    );
}

#[test]
fn output_mode_purpose_sgr_and_payload_projection_match_http_contract() {
    assert_eq!(
        parse_agent_output_response_mode(None).unwrap(),
        AgentOutputResponseMode::Full
    );
    assert_eq!(
        parse_agent_output_response_mode(Some("chat")).unwrap(),
        AgentOutputResponseMode::Chat
    );
    assert_eq!(
        parse_agent_output_response_mode(Some("compact")).unwrap_err(),
        "mode must be full or chat"
    );
    assert_eq!(
        parse_agent_output_read_purpose(Some("preview")).unwrap(),
        Some("preview".into())
    );
    assert_eq!(
        parse_agent_output_read_purpose(Some("forever")).unwrap_err(),
        "purpose is invalid"
    );
    assert_eq!(
        strip_sgr("\u{1b}[31mred\u{1b}[0m and \u{1b}[38;2;1;2;3mtrue\u{1b}[0m"),
        "red and true"
    );

    let window = agent_output_capture_window(Some(-50));
    let result = json!({
        "sessionId": "codex-1",
        "startLine": -50,
        "output": "plain",
        "outputAnsi": "\u{1b}[32mplain\u{1b}[0m",
        "parsed": { "blocks": [{ "type": "response", "text": "plain" }] },
        "messages": [{ "id": "assistant:1", "role": "assistant", "text": "plain" }],
        "activity": "idle",
        "attention": "normal"
    });

    let full = project_agent_output_payload(&result, window, -50, AgentOutputResponseMode::Full);
    assert_eq!(full["sessionId"], "codex-1");
    assert_eq!(full["output"], "plain");
    assert_eq!(full["outputAnsi"], "\u{1b}[32mplain\u{1b}[0m");
    assert_eq!(full["parsed"]["blocks"][0]["type"], "response");
    assert_eq!(full["messages"][0]["text"], "plain");
    assert_eq!(full["outputAvailable"], true);

    let chat = project_agent_output_payload(&result, window, -50, AgentOutputResponseMode::Chat);
    assert!(chat.get("output").is_none());
    assert!(chat.get("outputAnsi").is_none());
    assert!(chat.get("parsed").is_none());
    assert_eq!(chat["messages"][0]["text"], "plain");
    assert_eq!(chat["outputAvailable"], true);
}

#[test]
fn output_routes_validate_query_params_before_touching_tmux() {
    let project = temp_project("validation");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    let mut runtime = FakeCaptureRuntime::default();

    let missing = route_agent_output_request_with_runtime(
        &context,
        "GET",
        routes::agents::OUTPUT,
        None,
        &mut runtime,
    )
    .unwrap();
    assert_eq!(missing.status, 400);
    assert_eq!(
        missing.body,
        json!({ "ok": false, "error": "sessionId is required" })
    );

    let invalid_start = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=10.5",
        None,
        &mut runtime,
    )
    .unwrap();
    assert_eq!(invalid_start.status, 400);
    assert_eq!(invalid_start.body["error"], "startLine must be an integer");

    let invalid_mode = route_project_service_request(
        &context,
        "GET",
        "/live-pane/output?sessionId=codex-1&mode=compact",
        None,
    );
    assert_eq!(invalid_mode.status, 400);
    assert_eq!(invalid_mode.body["error"], "mode must be full or chat");

    let invalid_purpose = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/live-pane/output?sessionId=codex-1&purpose=forever",
        None,
        &mut runtime,
    )
    .unwrap();
    assert_eq!(invalid_purpose.status, 400);
    assert_eq!(invalid_purpose.body["error"], "purpose is invalid");
    assert!(runtime.calls.is_empty());
    cleanup(project);
}

#[test]
fn output_route_captures_live_topology_target_and_shapes_full_payload() {
    let project = temp_project("full");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "\u{1b}[32mhello\u{1b}[0m\n".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/live-pane/output?sessionId=codex-1&startLine=-999999&purpose=terminal",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["sessionId"], "codex-1");
    assert_eq!(response.body["output"], "hello\n");
    assert_eq!(response.body["outputAnsi"], "\u{1b}[32mhello\u{1b}[0m\n");
    assert_eq!(response.body["startLine"], -2000);
    assert_eq!(response.body["requestedStartLine"], -999999);
    assert!(response.body.get("endLine").is_none());
    assert_eq!(response.body["captureLineLimit"], 2000);
    assert_eq!(response.body["outputTailOnly"], true);
    assert_eq!(response.body["outputStartLineClamped"], true);
    assert_eq!(response.body["outputAvailable"], true);
    assert_eq!(response.body["activity"], "running");
    assert_eq!(response.body["attention"], "needs_input");
    assert_eq!(response.body["activityText"], "Working");
    assert_eq!(runtime.calls.len(), 1);
    assert_eq!(runtime.calls[0].0, "@1");
    assert_eq!(
        runtime.calls[0].1,
        CapturePaneOptions {
            start_line: Some(-2000),
            end_line: None,
            include_escapes: true,
        }
    );
    cleanup(project);
}

#[test]
fn output_route_omits_terminal_fields_in_chat_mode_and_bounds_forward_reads() {
    let project = temp_project("chat");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "\u{1b}[31mnew line\u{1b}[0m".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=25&mode=chat",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert!(response.body.get("output").is_none());
    assert!(response.body.get("outputAnsi").is_none());
    assert!(response.body.get("parsed").is_none());
    assert_eq!(response.body["sessionId"], "codex-1");
    assert_eq!(response.body["startLine"], 25);
    assert_eq!(response.body["endLine"], 2024);
    assert_eq!(response.body["outputAvailable"], true);
    assert_eq!(
        runtime.calls[0].1,
        CapturePaneOptions {
            start_line: Some(25),
            end_line: Some(2024),
            include_escapes: true,
        }
    );
    cleanup(project);
}

#[test]
fn output_route_rejects_offline_sessions_without_capture() {
    let project = temp_project("offline");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime::default();

    let response = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-offline",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(
        response.body,
        json!({ "ok": false, "error": "Session \"codex-offline\" is not running" })
    );
    assert!(runtime.calls.is_empty());
    cleanup(project);
}

#[test]
fn live_pane_attach_resizes_before_full_output_and_returns_stream_metadata() {
    let project = temp_project("attach");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "\u{1b}[32mhello\u{1b}[0m".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::ATTACH,
        Some(&json!({
            "sessionId": "codex-1",
            "startLine": 10,
            "cols": 120,
            "rows": 40
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["sessionId"], "codex-1");
    assert_eq!(response.body["output"], "hello");
    assert_eq!(response.body["resize"], json!({ "cols": 120, "rows": 40 }));
    assert_eq!(response.body["stream"]["route"], routes::EVENTS);
    assert_eq!(response.body["stream"]["sessionId"], "codex-1");
    assert_eq!(response.body["stream"]["startLine"], 10);
    assert_eq!(response.body["stream"]["requestedStartLine"], 10);
    assert_eq!(response.body["stream"]["endLine"], 2009);
    assert_eq!(response.body["stream"]["captureLineLimit"], 2000);
    assert_eq!(response.body["stream"]["outputTailOnly"], false);
    assert_eq!(response.body["stream"]["outputStartLineClamped"], false);
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Resize("@1".into(), 120, 40),
            FakeRuntimeAction::Capture("@1".into())
        ]
    );
    cleanup(project);
}

#[test]
fn live_pane_attach_omits_stream_end_line_for_tail_reads() {
    let project = temp_project("attach-tail");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "tail".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::ATTACH,
        Some(&json!({ "sessionId": "codex-1" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["stream"]["startLine"], -120);
    assert!(response.body["stream"].get("endLine").is_none());
    cleanup(project);
}

#[test]
fn live_pane_mutation_routes_validate_before_touching_tmux() {
    let project = temp_project("mutations-validation");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime::default();

    let attach_partial_resize = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::ATTACH,
        Some(&json!({ "sessionId": "codex-1", "cols": 80 })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(attach_partial_resize.status, 400);
    assert_eq!(
        attach_partial_resize.body["error"],
        "rows must be an integer"
    );

    let bad_resize = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::RESIZE,
        Some(&json!({ "sessionId": "codex-1", "cols": 0, "rows": 24 })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(bad_resize.status, 400);
    assert_eq!(bad_resize.body["error"], "cols must be an integer >= 1");

    let empty_input = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "   " })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(empty_input.status, 400);
    assert_eq!(empty_input.body["error"], "text is required");

    let attachment_input = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-1", "attachmentIds": ["att_1"] })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(attachment_input.status, 400);
    assert_eq!(
        attachment_input.body["error"],
        "attachment not found: att_1"
    );
    assert!(runtime.actions.is_empty());
    cleanup(project);
}

#[test]
fn shared_guest_input_is_limited_to_live_pane_shared_session() {
    let project = temp_project("guest-input");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_request_headers([
            ("x-aimux-actor-role", "guest"),
            ("x-aimux-actor-display-name", "Ada Guest"),
            ("x-aimux-share-session-id", "codex-1"),
        ]);
    let mut runtime = FakeCaptureRuntime::default();

    let rejected_agents_route = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::agents::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "hi" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(rejected_agents_route.status, 403);
    assert_eq!(
        rejected_agents_route.body["error"],
        "shared guests can only write to their shared session"
    );

    let rejected_session = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-offline", "text": "hi" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(rejected_session.status, 403);
    assert_eq!(
        rejected_session.body["error"],
        "shared guest cannot access another session"
    );

    let accepted = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "hi" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(accepted.status, 200);
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Text("@1".into(), "[Ada Guest] hi".into()),
            FakeRuntimeAction::CarriageReturn("@1".into()),
        ]
    );
    cleanup(project);
}

#[test]
fn input_formats_session_bound_attachments_into_submitted_prompt() {
    let project = temp_project("attachment-input");
    let state_dir = project.join("state");
    write_state(&state_dir);
    write_attachment(
        &project,
        "att_notes",
        "codex-1",
        "notes.md",
        "text/markdown",
        42,
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime::default();

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({
            "sessionId": "codex-1",
            "text": "Review this",
            "attachmentIds": ["att_notes"]
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let content_path = project
        .join(".aimux")
        .join("attachments")
        .join("att_notes.md");
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Text(
                "@1".into(),
                format!(
                    "Review this Attached files: - notes.md (text/markdown, 42 bytes): {}",
                    content_path.display()
                )
            ),
            FakeRuntimeAction::CarriageReturn("@1".into()),
        ]
    );
    cleanup(project);
}

#[test]
fn body_shared_chat_actor_requires_identity_before_prefixing() {
    let project = temp_project("body-actor");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime::default();

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({
            "sessionId": "codex-1",
            "text": "hello",
            "sharedChatActor": { "role": "owner" }
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Text("@1".into(), "hello".into()),
            FakeRuntimeAction::CarriageReturn("@1".into()),
        ]
    );
    cleanup(project);
}

#[test]
fn live_pane_resize_interrupt_and_input_send_tmux_commands() {
    let project = temp_project("mutations");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime::default();

    let resize = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::RESIZE,
        Some(&json!({ "sessionId": "codex-1", "cols": 100, "rows": 32 })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(resize.status, 200);
    assert_eq!(
        resize.body,
        json!({ "ok": true, "sessionId": "codex-1", "cols": 100, "rows": 32 })
    );

    let interrupt = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::agents::INTERRUPT,
        Some(&json!({ "sessionId": "codex-1" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(interrupt.status, 200);
    assert_eq!(interrupt.body["ok"], true);
    assert_eq!(interrupt.body["accepted"], true);
    assert_eq!(interrupt.body["transition"]["operation"], "agent.interrupt");
    assert_eq!(interrupt.body["transition"]["targetId"], "codex-1");
    assert_eq!(interrupt.body["transition"]["phase"], "succeeded");

    let input = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({
            "sessionId": "codex-1",
            "text": "line one\nline two\n",
            "sharedChatActor": { "role": "guest", "displayName": "  Shared   User  " }
        })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(input.status, 200);
    assert_eq!(
        input.body,
        json!({ "ok": true, "sessionId": "codex-1", "accepted": true })
    );
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Resize("@1".into(), 100, 32),
            FakeRuntimeAction::Escape("@1".into()),
            FakeRuntimeAction::Text("@1".into(), "[Shared User] line one line two".into()),
            FakeRuntimeAction::CarriageReturn("@1".into()),
        ]
    );
    cleanup(project);
}

#[test]
fn prompt_normalization_matches_submitted_tmux_prompt_contract() {
    assert_eq!(
        normalize_submitted_prompt("Aimux task\n\nRun:\n  aimux task show t1\n"),
        "Aimux task Run: aimux task show t1"
    );
    assert_eq!(
        normalize_submitted_prompt("  keep  spacing  "),
        "  keep  spacing  "
    );
    assert_eq!(normalize_submitted_prompt("a  \n  b"), "a b");
    assert_eq!(normalize_submitted_prompt("single line"), "single line");
}

fn write_state(state_dir: &PathBuf) {
    create_dir_all(state_dir).unwrap();
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-1".into(),
                json!({
                    "derived": {
                        "activity": "running",
                        "attention": "needs_input",
                        "activityText": "Working"
                    },
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
}

fn write_attachment(
    project: &std::path::Path,
    id: &str,
    session_id: &str,
    filename: &str,
    mime_type: &str,
    size_bytes: i64,
) {
    let attachments_dir = project.join(".aimux").join("attachments");
    create_dir_all(&attachments_dir).unwrap();
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let content_path = attachments_dir.join(format!("{id}{extension}"));
    write(&content_path, b"attachment").unwrap();
    write(
        attachments_dir.join(format!("{id}.json")),
        serde_json::to_string(&json!({
            "id": id,
            "kind": "file",
            "filename": filename,
            "mimeType": mime_type,
            "sizeBytes": size_bytes,
            "contentPath": content_path,
            "sessionId": session_id,
            "createdAt": "2026-09-05T00:00:00.000Z",
            "source": "upload"
        }))
        .unwrap(),
    )
    .unwrap();
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-1", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-offline", "rigId": "rig-1", "logicalId": "codex-offline", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-offline", "nodeId": "node-offline", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-1", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "codex-offline", "nodeId": "node-offline", "status": "offline", "command": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-agent-output-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
