use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::osc_notifications::OscNotificationParser;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, AgentOutputResponseMode, MAX_AGENT_OUTPUT_CAPTURE_LINES,
    agent_output_capture_window, bounded_agent_output_end_line, bounded_agent_output_start_line,
    normalize_submitted_prompt, parse_agent_output_read_purpose, parse_agent_output_response_mode,
    project_agent_output_payload, route_agent_output_request_with_runtime, strip_sgr,
};
use aimux::project_service::agent_output_projection::{
    AgentOutputProjectionCache, project_agent_output,
};
use aimux::project_service::metadata::update_session_metadata;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const ATTACHMENT_TEXT: &str =
    include_str!("../../../../testdata/contracts/v1/attachments/text.json");
const OSC_NOTIFICATIONS: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/osc.json");

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
fn output_projection_reads_tool_progress_activity_text() {
    assert_eq!(
        project_agent_output("✻ Jitterbugging… (2m 23s · ↓ 8.1k tokens)", Some("claude"))
            .activity_text,
        "Jitterbugging… (2m 23s · ↓ 8.1k tokens)"
    );
    for frame in ["✢", "✳", "✶", "✻", "✽", "·"] {
        assert_eq!(
            project_agent_output(&format!("{frame} Transfiguring… (14s)"), Some("claude"))
                .activity_text,
            "Transfiguring… (14s)"
        );
    }
    assert_eq!(
        project_agent_output(
            "* Indexing… (running stop hook · 11s · ↓ 16 tokens)",
            Some("codex")
        )
        .activity_text,
        "Indexing… (running stop hook · 11s · ↓ 16 tokens)"
    );
    assert_eq!(
        project_agent_output("• Working (4s • esc to interrupt)", Some("codex")).activity_text,
        "Working (4s)"
    );
    assert_eq!(
        project_agent_output("- Worked for 20m 16s", Some("codex")).activity_text,
        ""
    );
    assert_eq!(
        project_agent_output(
            &[
                "✻ Booting… (1s)",
                "⏺ Did a thing.",
                "✻ Jitterbugging… (2m 23s)",
            ]
            .join("\n"),
            Some("claude")
        )
        .activity_text,
        "Jitterbugging… (2m 23s)"
    );

    let transcript = project_agent_output(
        &[
            "› should I retry?",
            "• Working (4s • esc to interrupt)",
            "• I will wait for 5s before retrying.",
        ]
        .join("\n"),
        Some("codex"),
    );
    assert_eq!(
        transcript
            .messages
            .iter()
            .map(|message| (
                message["role"].as_str().unwrap(),
                message["text"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("user", "should I retry?"),
            ("assistant", "I will wait for 5s before retrying."),
        ]
    );
    assert_eq!(transcript.messages[0]["latest"], Value::Null);
    assert_eq!(transcript.messages[1]["latest"], true);
}

#[test]
fn output_projection_recovers_wrapped_attachment_text_from_transcripts() {
    let contract: Value = serde_json::from_str(ATTACHMENT_TEXT).expect("valid attachment fixture");
    let cases = contract["cases"].as_array().expect("attachment cases");
    assert_eq!(cases.len(), 129, "unexpected attachment text case count");

    let mut failures = Vec::new();
    for case in cases {
        let tail = case["input"]["tail"].as_str().expect("case tail");
        let raw = format!("› Attached files:\n{tail}");
        let projection = project_agent_output(&raw, Some("codex"));
        let parts = projection
            .messages
            .first()
            .and_then(|message| message.get("parts"))
            .cloned()
            .unwrap_or(Value::Null);

        let actual = if case["output"].is_null() {
            json!({
                "structured": parts.as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        matches!(
                            part.get("type").and_then(Value::as_str),
                            Some("image_reference" | "attachment_reference")
                        )
                    })
                })
            })
        } else {
            json!({
                "parts": parts,
                "text": projection.messages[0]["text"],
            })
        };
        let expected = if case["output"].is_null() {
            json!({ "structured": false })
        } else {
            json!({
                "parts": expected_attachment_parts(&case["output"]),
                "text": case["output"]["prose"].as_str().unwrap_or(""),
            })
        };
        if actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} production attachment projection failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn output_projection_treats_bare_paths_under_image_header_as_images() {
    let projection = project_agent_output(
        "› Attached image files:\nlook: /srv/x/.aimux/attach ments/att_bare.png",
        Some("codex"),
    );
    assert_eq!(
        projection.messages[0]["parts"],
        json!([
            { "type": "text", "text": "look:" },
            {
                "type": "image_reference",
                "label": "[image #1]",
                "attachmentId": "att_bare",
                "mimeType": "image/unknown"
            }
        ])
    );
}

fn expected_attachment_parts(output: &Value) -> Vec<Value> {
    let mut parts = Vec::new();
    let prose = output["prose"].as_str().unwrap_or("");
    if !prose.is_empty() {
        parts.push(json!({ "type": "text", "text": prose }));
    }

    let mut image_index = 1;
    let mut file_index = 1;
    for attachment in output["attachments"]
        .as_array()
        .expect("output attachments")
    {
        let attachment_id = attachment["attachmentId"]
            .as_str()
            .expect("attachment id")
            .to_owned();
        let filename = attachment.get("filename").and_then(Value::as_str);
        let mime_type = attachment.get("mimeType").and_then(Value::as_str);
        let mut part = serde_json::Map::new();
        if mime_type.is_some_and(|mime_type| mime_type.starts_with("image/")) {
            part.insert(
                "type".to_owned(),
                Value::String("image_reference".to_owned()),
            );
            part.insert(
                "label".to_owned(),
                Value::String(format!("[image #{image_index}]")),
            );
            image_index += 1;
        } else {
            part.insert(
                "type".to_owned(),
                Value::String("attachment_reference".to_owned()),
            );
            part.insert(
                "label".to_owned(),
                Value::String(format!("[file #{file_index}]")),
            );
            file_index += 1;
            part.insert(
                "kind".to_owned(),
                Value::String(expected_attachment_kind(mime_type).to_owned()),
            );
        }
        part.insert("attachmentId".to_owned(), Value::String(attachment_id));
        if let Some(filename) = filename {
            part.insert("filename".to_owned(), Value::String(filename.to_owned()));
        }
        if let Some(mime_type) = mime_type {
            part.insert("mimeType".to_owned(), Value::String(mime_type.to_owned()));
        }
        parts.push(Value::Object(part));
    }
    parts
}

fn expected_attachment_kind(mime_type: Option<&str>) -> &'static str {
    match mime_type.unwrap_or_default() {
        "application/pdf" => "pdf",
        mime_type if mime_type.starts_with("text/") || mime_type == "application/json" => "text",
        _ => "file",
    }
}

#[test]
fn output_projection_cache_reuses_projection_for_same_output_version() {
    let cache = AgentOutputProjectionCache::new(Duration::from_secs(1));
    let key = AgentOutputProjectionCache::key_for("› hi", Some("codex"));
    let mut projections = 0;

    let first = cache.project_or_reuse(key.clone(), || {
        projections += 1;
        project_agent_output("› hi", Some("codex"))
    });
    let second = cache.project_or_reuse(key, || {
        projections += 1;
        project_agent_output("› changed", Some("codex"))
    });

    assert_eq!(projections, 1);
    assert_eq!(first.messages[0]["text"], "hi");
    assert_eq!(second.messages[0]["text"], "hi");
}

#[test]
fn output_osc_parser_matches_typescript_contract() {
    let contract: Value = serde_json::from_str(OSC_NOTIFICATIONS).expect("valid OSC fixture");
    let cases = contract["cases"].as_array().expect("OSC cases");
    assert_eq!(cases.len(), 7, "unexpected OSC case count");
    let mut failures = Vec::new();
    for case in cases {
        let mut parser = OscNotificationParser::new();
        let actual = Value::Array(
            case["input"]["chunks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|chunk| parser.parse_chunk(chunk))
                .collect(),
        );
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} OSC notification production parser failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn output_route_writes_osc_terminal_notifications_and_cleans_output() {
    let project = temp_project("osc-notification");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "before \u{1b}]777;notify;Build finished;Tests passed\u{7} after".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/live-pane/output?sessionId=codex-1&purpose=terminal",
        None,
        &mut runtime,
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body["output"], "before  after");
    assert_eq!(response.body["outputAnsi"], "before  after");

    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    let notification = &snapshot.notifications[0];
    assert_eq!(notification["title"], "Build finished");
    assert_eq!(notification["body"], "Tests passed");
    assert_eq!(notification["sessionId"], "codex-1");
    assert_eq!(notification["kind"], "terminal");
    assert_eq!(notification["subtitle"], "Terminal OSC osc777");
    assert_eq!(notification["dedupeKey"], notification["targetKey"]);

    let events = context.project_events.events_since(0, None);
    assert!(
        events
            .iter()
            .any(|event| event.event.get("type").and_then(Value::as_str) == Some("alert"))
    );

    let duplicate = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/live-pane/output?sessionId=codex-1&purpose=poll",
        None,
        &mut runtime,
    )
    .unwrap();
    assert_eq!(duplicate.status, 200);
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        1
    );
    cleanup(project);
}

#[test]
fn output_route_no_osc_fast_path_keeps_parser_state_empty() {
    let project = temp_project("osc-fast-path");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "plain output without escape sequences".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    for _ in 0..5 {
        let response = route_agent_output_request_with_runtime(
            &context,
            "GET",
            "/live-pane/output?sessionId=codex-1&purpose=poll",
            None,
            &mut runtime,
        )
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["output"],
            "plain output without escape sequences"
        );
    }
    assert_eq!(context.osc_notifications.retained_session_count(), 0);
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        0
    );
    cleanup(project);
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
    assert_eq!(response.body["paneState"]["promptVisible"], false);
    assert_eq!(response.body["paneState"]["interruptedVisible"], false);
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
fn output_route_classifies_live_pane_state_and_reconciles_activity() {
    let project = temp_project("pane-state");
    let state_dir = project.join("state");
    write_state(&state_dir);
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "idle",
                "attention": "normal"
            }),
        );
        json!(object)
    })
    .expect("seed metadata");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "Ready\n› ".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let prompt = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(prompt.status, 200);
    assert_eq!(prompt.body["paneState"]["promptVisible"], true);
    assert_eq!(prompt.body["paneState"]["errorVisible"], false);
    assert_eq!(prompt.body["activity"], "idle");

    runtime.output =
        "• Working (4s • esc to interrupt)\nInterrupted · What should Codex do instead?".into();
    let interrupted = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=-119",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(interrupted.status, 200);
    assert_eq!(interrupted.body["paneState"]["promptVisible"], false);
    assert_eq!(interrupted.body["paneState"]["errorVisible"], true);
    assert_eq!(interrupted.body["paneState"]["interruptedVisible"], true);
    assert_eq!(interrupted.body["activityText"], "");
    assert_eq!(interrupted.body["activity"], "interrupted");
    cleanup(project);
}

#[test]
fn output_route_projects_parsed_status_and_activity_text_from_capture() {
    let project = temp_project("parsed");
    let state_dir = project.join("state");
    write_state(&state_dir);
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "running",
                "attention": "normal"
            }),
        );
        json!(object)
    })
    .expect("seed metadata");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "› Build it\n• Working (12s • esc to interrupt)\n• Built the first slice.".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["activityText"], "Working (12s)");
    assert_eq!(response.body["parsed"]["parser"]["tool"], "codex");
    assert_eq!(response.body["parsed"]["parser"]["version"], 1);
    assert_eq!(response.body["parsed"]["blocks"][0]["type"], "prompt");
    assert_eq!(response.body["parsed"]["blocks"][0]["text"], "Build it");
    assert_eq!(response.body["parsed"]["blocks"][1]["type"], "status");
    assert_eq!(
        response.body["parsed"]["blocks"][1]["text"],
        "• Working (12s • esc to interrupt)"
    );
    assert_eq!(response.body["parsed"]["blocks"][2]["type"], "response");
    assert_eq!(response.body["messages"][0]["role"], "user");
    assert_eq!(response.body["messages"][0]["text"], "Build it");
    assert_eq!(response.body["messages"][1]["role"], "assistant");
    assert_eq!(
        response.body["messages"][1]["text"],
        "Built the first slice."
    );
    assert_eq!(response.body["messages"][1]["latest"], true);
    let diagnostics = route_project_service_request(&context, "GET", routes::DIAGNOSTICS, None);
    assert_eq!(diagnostics.body["agentOutputReads"]["total"]["count"], 1);
    assert_eq!(
        diagnostics.body["agentOutputReads"]["bySource"]["agent-output"]["changed"],
        1
    );
    assert_eq!(
        diagnostics.body["agentOutputReads"]["recent"][0]["sessionId"],
        "codex-1"
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
fn equivalent_output_reads_share_one_capture_inside_project_context() {
    let project = temp_project("cache");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeCaptureRuntime {
        output: "\u{1b}[31mfirst\u{1b}[0m".into(),
        calls: Vec::new(),
        actions: Vec::new(),
    };

    let full = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=25&mode=full",
        None,
        &mut runtime,
    )
    .unwrap();
    runtime.output = "\u{1b}[32msecond\u{1b}[0m".into();
    let chat = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=25&mode=chat",
        None,
        &mut runtime,
    )
    .unwrap();
    let next_slice = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=26&mode=chat",
        None,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(full.status, 200);
    assert_eq!(chat.status, 200);
    assert_eq!(next_slice.status, 200);
    assert_eq!(full.body["output"], "first");
    assert_eq!(runtime.calls.len(), 2);
    assert_eq!(runtime.calls[0].1.start_line, Some(25));
    assert_eq!(runtime.calls[1].1.start_line, Some(26));
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
fn agent_input_prepends_prompt_context_for_both_input_routes() {
    let project = temp_project("prompt-context-input");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let set_context = route_project_service_request(
        &context,
        "POST",
        routes::agents::PROMPT_CONTEXT,
        Some(&json!({ "sessionId": "codex-1", "text": "page=/admin\nform=event" })),
    );
    assert_eq!(set_context.status, 200);
    let mut runtime = FakeCaptureRuntime::default();

    let agents_input = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::agents::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "one" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(agents_input.status, 200);
    let live_pane_input = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "two" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(live_pane_input.status, 200);

    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Text(
                "@1".into(),
                "[aimux context] page=/admin form=event [/aimux context] one".into()
            ),
            FakeRuntimeAction::CarriageReturn("@1".into()),
            FakeRuntimeAction::Text(
                "@1".into(),
                "[aimux context] page=/admin form=event [/aimux context] two".into()
            ),
            FakeRuntimeAction::CarriageReturn("@1".into()),
        ]
    );
    cleanup(project);
}

#[test]
fn agent_input_stops_prepending_prompt_context_after_clear() {
    let project = temp_project("prompt-context-clear");
    let state_dir = project.join("state");
    write_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let set_context = route_project_service_request(
        &context,
        "POST",
        routes::agents::PROMPT_CONTEXT,
        Some(&json!({ "sessionId": "codex-1", "text": "form=event" })),
    );
    assert_eq!(set_context.status, 200);
    let clear_context = route_project_service_request(
        &context,
        "POST",
        routes::agents::PROMPT_CONTEXT,
        Some(&json!({ "sessionId": "codex-1", "text": "" })),
    );
    assert_eq!(clear_context.status, 200);
    let mut runtime = FakeCaptureRuntime::default();

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::live_pane::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "plain" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(
        runtime.actions,
        vec![
            FakeRuntimeAction::Text("@1".into(), "plain".into()),
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
    let metadata = load_metadata_state(&state_dir);
    let derived = metadata.sessions["codex-1"]["derived"].as_object().unwrap();
    assert_eq!(derived["activity"], "interrupted");
    assert_eq!(derived["attention"], "normal");
    assert!(derived.get("becameIdleAt").is_some());

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
