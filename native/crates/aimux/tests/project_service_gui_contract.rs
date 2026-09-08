use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
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
}

impl AgentOutputCaptureRuntime for FakeCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        Ok(self.output.clone())
    }
}

#[test]
fn advertised_gui_capabilities_have_backing_http_contracts() {
    let project = temp_project("capabilities");
    let state_dir = project.join("state");
    seed_running_agent(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let health = route_project_service_request(&context, "GET", routes::HEALTH, None);
    assert_eq!(health.status, 200);
    assert_eq!(health.body["ok"], true);
    assert_eq!(health.body["serviceInfo"]["apiVersion"], 5);
    assert!(health.body["serviceInfo"]["buildStamp"].as_str().is_some());
    assert_eq!(
        health.body["serviceInfo"]["capabilities"],
        json!({
            "agentActivityState": true,
            "agentTranscriptMessages": true,
            "attachmentRead": true,
            "chatEventStream": true,
            "parsedAgentOutput": true,
        })
    );

    let mut runtime = FakeCaptureRuntime {
        output: "› Build the GUI contract\n• Working (12s • esc to interrupt)\n• Done.".into(),
        calls: Vec::new(),
    };
    let output = route_agent_output_request_with_runtime(
        &context,
        "GET",
        "/agents/output?sessionId=codex-1&startLine=-9999&mode=full&purpose=initial",
        None,
        &mut runtime,
    )
    .expect("agent output route");
    assert_eq!(output.status, 200);
    assert_eq!(output.body["ok"], true);
    assert_eq!(output.body["sessionId"], "codex-1");
    assert_eq!(output.body["startLine"], -2000);
    assert_eq!(output.body["requestedStartLine"], -9999);
    assert_eq!(output.body["captureLineLimit"], 2000);
    assert_eq!(output.body["outputTailOnly"], true);
    assert_eq!(output.body["outputStartLineClamped"], true);
    assert_eq!(output.body["activity"], "running");
    assert_eq!(output.body["activityText"], "Working (12s)");
    assert_eq!(output.body["attention"], "needs_input");
    assert_eq!(output.body["parsed"]["parser"]["tool"], "codex");
    assert_eq!(output.body["parsed"]["blocks"][0]["type"], "prompt");
    assert_eq!(output.body["messages"][0]["role"], "user");
    assert_eq!(output.body["messages"][0]["text"], "Build the GUI contract");
    assert_eq!(output.body["messages"][1]["role"], "assistant");
    assert_eq!(output.body["messages"][1]["text"], "Done.");
    assert_eq!(
        runtime.calls,
        vec![(
            "@1".to_owned(),
            CapturePaneOptions {
                start_line: Some(-2000),
                end_line: None,
                include_escapes: true,
            },
        )]
    );

    let events = route_project_service_request(
        &context,
        "GET",
        "/events?sessionId=codex-1&startLine=5&intervalMs=250&mode=chat&purpose=stream",
        None,
    );
    assert_eq!(events.status, 200);
    assert_eq!(events.content_type.as_deref(), Some("text/event-stream"));
    let ready = sse_data(events.bytes.as_ref().expect("ready frame"), "ready");
    assert_eq!(ready["sessionId"], "codex-1");
    assert_eq!(ready["startLine"], 5);
    assert_eq!(ready["requestedStartLine"], 5);
    assert_eq!(ready["endLine"], 2004);
    assert_eq!(ready["captureLineLimit"], 2000);
    assert_eq!(ready["outputTailOnly"], false);
    assert_eq!(ready["outputStartLineClamped"], false);
    assert_eq!(ready["intervalMs"], 250);

    let uploaded = route_project_service_request(
        &context,
        "POST",
        routes::ATTACHMENTS,
        Some(&json!({
            "filename": "notes.txt",
            "mimeType": "text/plain",
            "dataBase64": "R1VJIGNvbnRyYWN0",
            "sessionId": "codex-1"
        })),
    );
    assert_eq!(uploaded.status, 200);
    assert_eq!(uploaded.body["ok"], true);
    assert_eq!(uploaded.body["attachment"]["kind"], "text");
    assert_eq!(uploaded.body["attachment"]["filename"], "notes.txt");
    assert_eq!(uploaded.body["attachment"]["mimeType"], "text/plain");
    assert_eq!(uploaded.body["attachment"]["sizeBytes"], 12);
    assert_eq!(uploaded.body["attachment"]["source"], "upload");
    assert_eq!(uploaded.body["attachment"]["sessionId"], "codex-1");
    let content_url = uploaded.body["attachment"]["contentUrl"]
        .as_str()
        .expect("content URL");
    let content = route_project_service_request(&context, "GET", content_url, None);
    assert_eq!(content.status, 200);
    assert_eq!(content.content_type.as_deref(), Some("text/plain"));
    assert_eq!(content.bytes, Some(b"GUI contract".to_vec()));

    cleanup(project);
}

fn seed_running_agent(state_dir: &PathBuf) {
    create_dir_all(state_dir).unwrap();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-1", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-1", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write(runtime_topology_path(state_dir), serde_yaml::to_string(&topology).unwrap()).unwrap();
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-1".into(),
                json!({
                    "derived": {
                        "activity": "running",
                        "attention": "needs_input"
                    },
                    "updatedAt": "2026-09-05T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
}

fn sse_data(bytes: &[u8], expected_event: &str) -> Value {
    let body = String::from_utf8(bytes.to_vec()).expect("utf8 sse");
    let mut event = None;
    let mut data = None;
    for line in body.lines() {
        if let Some(value) = line.strip_prefix("event: ") {
            event = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("data: ") {
            data = Some(value.to_owned());
        }
    }
    assert_eq!(event.as_deref(), Some(expected_event));
    serde_json::from_str(&data.expect("sse data")).expect("json data")
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-gui-contract-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    create_dir_all(&path).expect("project dir");
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
