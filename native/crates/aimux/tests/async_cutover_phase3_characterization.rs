#![cfg(unix)]

use aimux::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use aimux::daemon::json::ProjectEventStreamTarget;
use aimux::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, ProxyBinaryResponse, ProxyJsonResponse,
};
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon::stream::{
    HostAgentStreamError, HostAgentStreamRequestOptions, pipe_host_agent_stream_from_url,
    pipe_project_event_stream_from_url_async,
};
use aimux::daemon::text::agents::{DaemonAgentTextRuntime, ProjectServicePostOptions};
use aimux::daemon::text::auth::{
    AuthAction, AuthFlowError, AuthFlowResult, AuthFlowStart, AuthTextError, DaemonAuthTextRuntime,
};
use aimux::daemon::text::collaboration::DaemonCollaborationTextRuntime;
use aimux::daemon::text::host_agent::DaemonHostAgentTextRuntime;
use aimux::daemon::text::metadata::DaemonMetadataTextRuntime;
use aimux::daemon::text::notifications::DaemonNotificationTextRuntime;
use aimux::daemon::text::operations::{
    DaemonOperationsTextRuntime, DashboardOpenRequest, RestartControlPlaneTextResult,
};
use aimux::daemon::text::overseer::DaemonOverseerTextRuntime;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::project_content::DaemonProjectContentTextRuntime;
use aimux::daemon::text::scribe::DaemonScribeTextRuntime;
use aimux::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use aimux::daemon::text::team::DaemonTeamTextRuntime;
use aimux::daemon::text::worktrees::DaemonWorktreeTextRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, MetadataState, save_metadata_state,
};
use aimux::hosted_audit::HostedAuditStore;
use aimux::hosted_config::HostedConfig;
use aimux::hosted_principals::{HostedGrant, HostedPrincipalsStore};
use aimux::hosted_server::{
    HostedServerState, HostedStreamLimits, handle_hosted_daemon_stream_async,
};
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_input_delivery::AgentInputWindowActivity;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
};
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::relay_runner::{
    DaemonRelayBridge, DaemonRouteResponse, ProjectEventStream, ProjectEventStreamItem, RelayRunner,
};
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::{CapturePaneOptions, TmuxTarget};
use aimux::websocket::{
    BoxFuture, WebSocketConnectionParts, WebSocketConnector, WebSocketError, WebSocketEvent,
    WebSocketReader, WebSocketWriter,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, mpsc};
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

const FIXTURE_PATH: &str = "../../../testdata/contracts/v1/async-cutover/phase3-surfaces.json";
const RECORD_ENV: &str = "AIMUX_RECORD_ASYNC_CUTOVER_PHASE3_FIXTURES";

#[test]
fn async_cutover_phase3_surfaces_match_pre_conversion_fixture() {
    let observed = observe_phase3_surfaces();
    let path = fixture_path();
    if std::env::var_os(RECORD_ENV).is_some() {
        let fixture = CharacterizationFixture {
            version: 1,
            source: "pre-Phase 3 daemon stream proxy, relay client, and hosted stream Rust behaviour".into(),
            recorded_from_commit: git_head_short(),
            normalization: vec![
                "loopback ports are replaced with <upstream-port>".into(),
                "stream proxy response bytes and upstream request bytes are compared literally after normalization".into(),
                "disconnect cases compare whether the upstream socket observes EOF rather than retaining a leaked connection".into(),
                "relay websocket frames are parsed as JSON and sorted to stable key order before comparison".into(),
                "hosted stream temp roots, tokens, principal ids and audit timestamps are normalized".into(),
            ],
            cases: observed,
        };
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture dir");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&fixture).expect("fixture json")
            ),
        )
        .expect("write fixture");
        return;
    }

    let fixture: CharacterizationFixture =
        serde_json::from_str(&fs::read_to_string(&path).expect("read phase3 fixture"))
            .expect("parse phase3 fixture");
    assert_characterization_cases_match(&observed, &fixture.cases);
}

#[derive(Debug, Serialize, Deserialize)]
struct CharacterizationFixture {
    version: u32,
    source: String,
    recorded_from_commit: String,
    normalization: Vec<String>,
    cases: Vec<CharacterizationCase>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct CharacterizationCase {
    name: String,
    surface: String,
    catches: String,
    observed: Value,
    #[serde(default, skip_serializing_if = "is_false")]
    pending_intended: bool,
}

fn observe_phase3_surfaces() -> Vec<CharacterizationCase> {
    vec![
        host_agent_text_transform_case(),
        project_event_stream_proxy_case(),
        project_event_stream_downstream_disconnect_case(),
        relay_project_events_subscription_case(),
        hosted_operator_stream_revocation_case(),
        project_lifecycle_kill_failure_case(),
        project_agent_input_half_delivery_case(),
        hosted_non_stream_proxy_client_reset_case(),
    ]
}

fn host_agent_text_transform_case() -> CharacterizationCase {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        let body = b"event: output\ndata: {\"output\":\"hello\"}\n\nevent: output\ndata: {\"output\":\"hello world\\n\"}\n\n";
        stream
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes())
            .expect("write upstream headers");
        stream.write_all(body).expect("write upstream");
        request
    });
    let mut output = Vec::new();

    pipe_host_agent_stream_from_url(
        &mut output,
        "claude-1",
        &format!("{url}/agents/output/stream?sessionId=claude-1"),
        HostAgentStreamRequestOptions {
            timeout_ms: Some(1_000),
        },
    )
    .expect("pipe host agent stream");
    let request = join.join().expect("upstream");

    CharacterizationCase {
        name: "daemon-stream-proxy-host-agent-text-transform".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "Host-agent output streams keep the pre-conversion plain-text response contract while preserving upstream SSE request headers.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "response": normalize_response_bytes(&output),
        }),
        pending_intended: false,
    }
}

fn project_event_stream_proxy_case() -> CharacterizationCase {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        let body = b"event: ready\ndata: {\"ok\":true}\n\n";
        stream
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes())
            .expect("write upstream headers");
        stream.write_all(body).expect("write upstream");
        request
    });
    let mut output = Vec::new();
    let mut headers = BTreeMap::new();
    headers.insert("x-aimux-actor-role".into(), "owner".into());

    // aimux-async-seam: test - characterization test drives async stream helper
    aimux::async_runtime::block_on_named(
        "phase3-characterization:project-event-stream",
        pipe_project_event_stream_from_url_async(
            &mut output,
            &ProjectEventStreamTarget {
                url: format!("{url}/events?since=1"),
                headers,
            },
            HostAgentStreamRequestOptions {
                timeout_ms: Some(1_000),
            },
        ),
    )
    .expect("pipe project event stream");
    let request = join.join().expect("upstream");

    CharacterizationCase {
        name: "daemon-stream-proxy-project-events-raw-sse".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "Project event stream proxying keeps raw SSE bytes, stream headers, and forwarded authorization headers stable.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "response": normalize_response_bytes(&output),
        }),
        pending_intended: false,
    }
}

fn project_event_stream_downstream_disconnect_case() -> CharacterizationCase {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let (observed_tx, observed_rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept upstream");
        let request = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n17\r\nevent: ready\ndata: {}\n\n\r\n",
            )
            .expect("write upstream response");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let mut byte = [0_u8; 1];
        let upstream_eof = stream.read(&mut byte).expect("read upstream close") == 0;
        observed_tx
            .send((request, upstream_eof))
            .expect("send close observation");
    });
    let mut writer = FailAfterAsyncWrites::new(1);
    let target = ProjectEventStreamTarget {
        url: format!("http://127.0.0.1:{}/events", address.port()),
        headers: BTreeMap::new(),
    };

    // aimux-async-seam: test - characterization test drives async stream helper
    let error = aimux::async_runtime::block_on_named(
        "phase3-characterization:project-event-disconnect",
        pipe_project_event_stream_from_url_async(
            &mut writer,
            &target,
            HostAgentStreamRequestOptions {
                timeout_ms: Some(1_000),
            },
        ),
    )
    .expect_err("downstream write fails");
    let (request, upstream_eof) = observed_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("upstream close observed");
    join.join().expect("upstream thread");

    CharacterizationCase {
        name: "daemon-stream-proxy-downstream-disconnect-drops-upstream".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "A downstream client disconnecting mid-proxy must drop the upstream project-service stream instead of leaking it.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "error": normalize_stream_error(&error),
            "upstreamObservedEof": upstream_eof,
        }),
        pending_intended: false,
    }
}

fn relay_project_events_subscription_case() -> CharacterizationCase {
    let recorder = Arc::new(RelayRecorder::default());
    let bridge = Arc::new(FakeRelayBridge {
        recorder: Arc::clone(&recorder),
    });
    let runner = RelayRunner::new("wss://relay.aimux.app", "tok", bridge);
    let subscribe = json!({
        "type": "project_events_subscribe",
        "id": "sub-1",
        "path": "/projects/repo/events?intervalMs=100",
        "headers": { "x-aimux-actor-role": "owner" }
    })
    .to_string();
    let mut connector = RelayFakeConnector {
        recorder: Arc::clone(&recorder),
        events: vec![
            WebSocketEvent::Text(subscribe),
            WebSocketEvent::Closed {
                code: Some(1008),
                reason: String::new(),
            },
        ],
        connected: false,
    };
    let mut sleep = |_| Box::pin(async {}) as BoxFuture<'static, ()>;

    // aimux-async-seam: test - characterization test drives async stream helper
    aimux::async_runtime::block_on_named("phase3-characterization:relay-subscription", async {
        runner.run_with_sleep(&mut connector, &mut sleep).await;
    });
    let status = runner.handle().status();

    CharacterizationCase {
        name: "relay-client-project-event-subscription-delivery".into(),
        surface: "relay-client".into(),
        catches: "A relay project-event subscription opened from a websocket frame must send the subscribe ack, project event, and upstream-closed error before later socket close handling.".into(),
        observed: json!({
            "connects": recorder.connects(),
            "subscriptions": recorder.subscriptions(),
            "sent": recorder.sent_json(),
            "closedWrites": recorder.closed_writes(),
            "authLost": recorder.auth_lost(),
            "status": {
                "status": status.status.map(|status| status.as_str()),
                "relayUrl": status.relay_url,
                "lastConnectedAt": status.last_connected_at.map(|_| "<timestamp>"),
                "lastError": status.last_error,
            },
        }),
        pending_intended: false,
    }
}

fn hosted_operator_stream_revocation_case() -> CharacterizationCase {
    let fixture = HostedFixture::new("phase3-hosted-stream-revoked");
    let upstream = HeldSseServer::spawn();
    let store = HostedPrincipalsStore::with_resolver(fixture.resolver.clone());
    let (principal, token) = store.create_principal("grand").expect("create principal");
    store
        .grant_session(
            &principal.id,
            HostedGrant {
                project_root: "/repo".into(),
                session_id: "s".into(),
            },
        )
        .expect("grant principal");
    let mut runtime = FakeRuntime::empty();
    runtime.projects = vec![hosted_project("/repo", upstream.port as u64, true)];
    let runtime = Arc::new(Mutex::new(runtime));
    let state = Arc::new(HostedServerState::with_resolver_and_stream_limits(
        HostedConfig {
            enabled: true,
            ..HostedConfig::default()
        },
        fixture.resolver.clone(),
        HostedStreamLimits {
            max_per_principal: 2,
            max_lifetime_ms: 10_000,
            idle_timeout_ms: 10_000,
            max_bytes: 1024 * 1024,
            reauth_interval_ms: 250,
        },
    ));
    let request = format!(
        "GET /proxy/127.0.0.1/{}/agents/output/stream?sessionId=s HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\r\n",
        upstream.port
    );
    let (done_tx, done_rx) = mpsc::channel();
    let (mut client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
    let client =
        aimux::async_runtime::spawn_named("phase3-characterization:hosted-client", async move {
            tokio::io::AsyncWriteExt::write_all(&mut client_stream, request.as_bytes())
                .await
                .expect("write hosted request");
            let mut output = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut client_stream, &mut output)
                .await
                .expect("read hosted response");
            done_tx.send(output).expect("send hosted output");
        });
    let handle_runtime = Arc::clone(&runtime);
    let handle_state = Arc::clone(&state);
    let intercept_runtime = Arc::clone(&runtime);
    let intercept_state = Arc::clone(&state);
    let hosted =
        aimux::async_runtime::spawn_named("phase3-characterization:hosted-stream", async move {
            handle_hosted_daemon_stream_async(
                &handle_runtime,
                &handle_state,
                &intercept_runtime,
                &intercept_state,
                &mut server_stream,
                aimux::daemon::listener::DaemonRequestMetadata {
                    issued_at: "issued".into(),
                    stopping: false,
                },
                None,
            )
            .await
            .expect("hosted stream handled");
        });

    upstream.wait_until_open();
    store
        .revoke_principal(&principal.id)
        .expect("revoke principal");
    let output = match done_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(output) => output,
        Err(error) => {
            upstream.stop();
            panic!("hosted stream did not stop after revocation: {error}");
        }
    };
    upstream.stop();
    aimux::async_runtime::process_runtime()
        // aimux-async-seam: test - hosted characterization awaits paired async exchange
        .block_on(hosted)
        .expect("hosted async task");
    aimux::async_runtime::process_runtime()
        // aimux-async-seam: test - hosted characterization awaits paired async exchange
        .block_on(client)
        .expect("hosted client task");
    let response = String::from_utf8(output).expect("hosted response utf8");
    let audit = HostedAuditStore::with_resolver(fixture.resolver.clone()).tail_audit(10);
    let stream_audit = audit
        .into_iter()
        .filter_map(|entry| {
            let event = entry.event?;
            if !event.starts_with("hosted_stream_") {
                return None;
            }
            Some(json!({
                "event": event,
                "sessionId": entry.session_id.unwrap_or_default(),
                "path": normalize_hosted_proxy_path(&entry.path),
                "status": entry.status,
            }))
        })
        .collect::<Vec<_>>();

    CharacterizationCase {
        name: "hosted-operator-stream-closes-on-principal-revocation".into(),
        surface: "hosted-stream".into(),
        catches: "Hosted operator streams must re-authenticate while open and close with a revoked audit event when the principal is revoked mid-stream.".into(),
        observed: json!({
            "response": normalize_hosted_response(&response),
            "containsFirstEvent": response.contains("data: first\n\n"),
            "streamAudit": stream_audit,
        }),
        pending_intended: false,
    }
}

fn project_lifecycle_kill_failure_case() -> CharacterizationCase {
    let fixture = RouteFixture::new("lifecycle-kill-failure");
    let state_dir = fixture.root.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&fixture.root, &state_dir);
    let mut runtime = FixtureLifecycleRuntime {
        kill_window_result: Some(Err("tmux kill-window failed for @agent".into())),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::KILL,
        Some(&json!({ "sessionId": "codex-live", "reason": "done" })),
        &mut runtime,
    )
    .expect("kill route");
    let topology = read_runtime_topology(runtime_topology_path(&state_dir))
        .expect("topology after kill failure");
    let session_status = topology["sessions"]
        .as_array()
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session["id"] == "codex-live")
        })
        .and_then(|session| session["status"].as_str())
        .unwrap_or("<missing>")
        .to_owned();

    CharacterizationCase {
        name: "project-lifecycle-kill-failure-is-error".into(),
        surface: "project-service-lifecycle".into(),
        catches: "Recording current corrected behavior: a tmux kill-window failure must return an explicit error and leave the session out of the graveyard.".into(),
        observed: json!({
            "status": response.status,
            "body": response.body,
            "killedWindows": runtime.killed,
            "sessionStatusAfterFailure": session_status,
        }),
        pending_intended: false,
    }
}

fn project_agent_input_half_delivery_case() -> CharacterizationCase {
    let fixture = RouteFixture::new("agent-input-half-delivery");
    let state_dir = fixture.root.join("state");
    write_agent_input_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&fixture.root, &state_dir);
    let mut runtime = FixtureAgentInputRuntime {
        submit_outcome: FixtureSubmitOutcome::Dropped,
        input_activity: VecDeque::from([Ok(AgentInputWindowActivity::Unattended)]),
        ..Default::default()
    };

    let response = route_agent_output_request_with_runtime(
        &context,
        "POST",
        routes::agents::INPUT,
        Some(&json!({ "sessionId": "codex-1", "text": "deliver now" })),
        &mut runtime,
    )
    .expect("input route");

    CharacterizationCase {
        name: "project-agent-input-half-delivery-is-error".into(),
        surface: "project-service-agent-input".into(),
        catches: "Recording current corrected behavior: a prompt whose submit carriage return was dropped must return an explicit error instead of accepted:true.".into(),
        observed: json!({
            "status": response.status,
            "body": response.body,
            "actions": runtime.actions,
        }),
        pending_intended: false,
    }
}

fn hosted_non_stream_proxy_client_reset_case() -> CharacterizationCase {
    let fixture = HostedFixture::new("phase3-hosted-non-stream-reset");
    let token = grant_hosted_operator(&fixture.resolver, "grand", "/repo", "s");
    let mut runtime = FakeRuntime::empty();
    runtime.projects = vec![hosted_project("/repo", 43210, true)];
    runtime.proxy_json = ProxyJsonResponse {
        status: 200,
        json: json!({ "ok": true, "value": "response that will be truncated" }),
    };
    let runtime = Arc::new(Mutex::new(runtime));
    let state = Arc::new(HostedServerState::with_resolver(
        HostedConfig {
            enabled: true,
            ..HostedConfig::default()
        },
        fixture.resolver.clone(),
    ));
    let request = format!(
        "GET /proxy/127.0.0.1/43210/agents/output?sessionId=s HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\r\n"
    );
    let mut stream = ResettingAsyncHttpStream::new(request.as_bytes(), "HTTP/1.1 200 OK".len());

    let result = aimux::async_runtime::process_runtime()
        // aimux-async-seam: fixture - hosted reset characterization drives async stream handler directly
        .block_on(handle_hosted_daemon_stream_async(
            &runtime,
            &state,
            &runtime,
            &state,
            &mut stream,
            aimux::daemon::listener::DaemonRequestMetadata {
                issued_at: "issued".into(),
                stopping: false,
            },
            None,
        ));

    CharacterizationCase {
        name: "hosted-non-stream-proxy-client-reset-is-close".into(),
        surface: "hosted-non-stream-proxy".into(),
        catches: "Asserting intended behavior pending the production fix: a downstream client reset during a non-stream hosted proxy response is handled as connection close after the response begins, not as a proxy success lie or handler crash.".into(),
        observed: json!({
            "handlerResult": match result {
                Ok(()) => "ok".to_owned(),
                Err(error) => format!("error: {error}"),
            },
            "partialResponse": normalize_hosted_response(&String::from_utf8_lossy(&stream.output)),
        }),
        pending_intended: false,
    }
}

fn assert_characterization_cases_match(
    observed: &[CharacterizationCase],
    expected: &[CharacterizationCase],
) {
    if observed.len() != expected.len() {
        panic!(
            "phase3 fixture case count mismatch: observed {} cases [{}], expected {} cases [{}]",
            observed.len(),
            case_names(observed),
            expected.len(),
            case_names(expected)
        );
    }

    for (index, (observed_case, expected_case)) in observed.iter().zip(expected).enumerate() {
        if expected_case.pending_intended {
            if observed_case.name != expected_case.name
                || observed_case.surface != expected_case.surface
                || observed_case.catches != expected_case.catches
            {
                panic!(
                    "phase3 pending fixture metadata mismatch at case #{index}: observed '{}', expected '{}'\nobserved:\n{}\nexpected:\n{}",
                    observed_case.name,
                    expected_case.name,
                    pretty_case(observed_case),
                    pretty_case(expected_case)
                );
            }
            if observed_case.observed == expected_case.observed {
                panic!(
                    "phase3 pending intended fixture now matches current behavior at case #{index} ('{}'); remove pending_intended and record it as current corrected behavior",
                    expected_case.name
                );
            }
            continue;
        }
        if observed_case != expected_case {
            panic!(
                "phase3 fixture mismatch at case #{index}: observed '{}', expected '{}'\nobserved:\n{}\nexpected:\n{}",
                observed_case.name,
                expected_case.name,
                pretty_case(observed_case),
                pretty_case(expected_case)
            );
        }
    }
}

fn case_names(cases: &[CharacterizationCase]) -> String {
    cases
        .iter()
        .map(|case| case.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn pretty_case(case: &CharacterizationCase) -> String {
    serde_json::to_string_pretty(case).expect("serialize characterization case")
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Default)]
struct RelayRecorder {
    connects: Mutex<Vec<Value>>,
    subscriptions: Mutex<Vec<Value>>,
    sent: Mutex<Vec<Value>>,
    auth_lost: Mutex<Vec<String>>,
    closed_writes: Mutex<usize>,
}

impl RelayRecorder {
    fn connects(&self) -> Vec<Value> {
        self.connects.lock().expect("connects").clone()
    }

    fn subscriptions(&self) -> Vec<Value> {
        self.subscriptions.lock().expect("subscriptions").clone()
    }

    fn sent_json(&self) -> Vec<Value> {
        self.sent.lock().expect("sent").clone()
    }

    fn auth_lost(&self) -> Vec<String> {
        self.auth_lost.lock().expect("auth lost").clone()
    }

    fn closed_writes(&self) -> usize {
        *self.closed_writes.lock().expect("closed writes")
    }
}

struct FakeRelayBridge {
    recorder: Arc<RelayRecorder>,
}

impl DaemonRelayBridge for FakeRelayBridge {
    fn route_request<'a>(
        &'a self,
        _method: &'a str,
        _path: &'a str,
        _body: &'a Value,
        _headers: &'a Value,
    ) -> BoxFuture<'a, DaemonRouteResponse> {
        Box::pin(async {
            DaemonRouteResponse {
                status: 200,
                body: Value::Null,
            }
        })
    }

    fn subscribe_project_events(
        self: Arc<Self>,
        subscription_id: String,
        path: String,
        headers: Value,
    ) -> BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>> {
        self.recorder
            .subscriptions
            .lock()
            .expect("subscriptions")
            .push(json!({
                "subscriptionId": subscription_id,
                "path": path,
                "headers": headers,
            }));
        Box::pin(async {
            Ok(Box::new(ScriptedProjectEventStream {
                items: vec![
                    ProjectEventStreamItem::Frame(
                        json!({
                            "id": "sub-1",
                            "type": "project_event",
                            "event": "message",
                            "data": { "seq": 1 }
                        })
                        .to_string(),
                    ),
                    ProjectEventStreamItem::Closed,
                ],
            }) as Box<dyn ProjectEventStream>)
        })
    }

    fn notify_auth_lost<'a>(&'a self, message: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.recorder
                .auth_lost
                .lock()
                .expect("auth lost")
                .push(message.to_owned());
        })
    }
}

struct ScriptedProjectEventStream {
    items: Vec<ProjectEventStreamItem>,
}

impl ProjectEventStream for ScriptedProjectEventStream {
    fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
        Poll::Ready(self.items.remove(0))
    }
}

struct RelayFakeConnector {
    recorder: Arc<RelayRecorder>,
    events: Vec<WebSocketEvent>,
    connected: bool,
}

impl WebSocketConnector for RelayFakeConnector {
    fn connect<'a>(
        &'a mut self,
        url: &'a str,
        subprotocols: &'a [String],
    ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
        Box::pin(async move {
            if self.connected {
                return Err(WebSocketError::Transport("unexpected reconnect".into()));
            }
            self.connected = true;
            self.recorder
                .connects
                .lock()
                .expect("connects")
                .push(json!({
                    "url": url,
                    "subprotocols": subprotocols,
                }));
            Ok(WebSocketConnectionParts {
                reader: Box::new(RelayFakeReader {
                    events: self.events.clone(),
                }),
                writer: Box::new(RelayFakeWriter {
                    recorder: Arc::clone(&self.recorder),
                }),
            })
        })
    }
}

struct RelayFakeReader {
    events: Vec<WebSocketEvent>,
}

impl WebSocketReader for RelayFakeReader {
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>> {
        Box::pin(async move {
            if self.events.is_empty() {
                return Ok(WebSocketEvent::Closed {
                    code: Some(1000),
                    reason: String::new(),
                });
            }
            Ok(self.events.remove(0))
        })
    }
}

struct RelayFakeWriter {
    recorder: Arc<RelayRecorder>,
}

impl WebSocketWriter for RelayFakeWriter {
    fn send_text<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async move {
            let parsed = serde_json::from_str::<Value>(text).expect("relay sent json");
            self.recorder.sent.lock().expect("sent").push(parsed);
            Ok(())
        })
    }

    fn send_pong<'a>(&'a mut self, _payload: Vec<u8>) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async { Ok(()) })
    }

    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            *self.recorder.closed_writes.lock().expect("closed writes") += 1;
        })
    }
}

#[derive(Debug, Clone)]
struct FakeRuntime {
    calls: Vec<String>,
    projects: Vec<ProjectsRouteProject>,
    proxy_json: ProxyJsonResponse,
    proxy_binary: ProxyBinaryResponse,
}

impl FakeRuntime {
    fn empty() -> Self {
        Self {
            calls: Vec::new(),
            projects: Vec::new(),
            proxy_json: ProxyJsonResponse {
                status: 200,
                json: json!({ "ok": true }),
            },
            proxy_binary: ProxyBinaryResponse {
                status: 200,
                body: Vec::new(),
                content_type: Some("image/png".into()),
            },
        }
    }

    fn unsupported_json_result() -> ProjectServiceJsonResult {
        ProjectServiceJsonResult::error(aimux::daemon::routing::DaemonRouteResponse::text(
            404,
            "not found\n",
        ))
    }
}

impl DaemonStatusRuntime for FakeRuntime {
    fn current_daemon_info(&self, issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 123,
            port: 43191,
            started_at: "started".into(),
            updated_at: issued_at.into(),
        }
    }

    fn project_service_info(&self) -> Value {
        json!({ "apiVersion": 1, "buildStamp": "test" })
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        self.projects.clone()
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: Some(json!("updated")),
            projects: Map::new(),
        }
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        cwd.into()
    }
}

impl DaemonCoreCommandRuntime for FakeRuntime {
    fn next_core_command_id(&self) -> String {
        "cmd_1".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn stop_project(&mut self, project_root: &str, _force: bool) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        _serve_only: bool,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn overseer_watch(
        &mut self,
        _project_root: &str,
        _session_id: &str,
        _goal: Option<&str>,
        _instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        Ok(json!({ "ok": true }))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }

    fn has_remote_credentials(&self) -> bool {
        false
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn disable_relay(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }
}

impl DaemonJsonRouteRuntime for FakeRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value {
        self.calls.push(format!("push:{payload}"));
        json!({ "ok": true })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true })
    }

    fn expose_items(&mut self, _path: &str) -> Result<Value, String> {
        Ok(json!({ "ok": true, "items": [] }))
    }

    fn expose_focus(&mut self, _request: ExposeFocusRequest) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        _timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        self.calls.push(format!(
            "proxy-json:{method}:{target_url}:{}",
            body.cloned().unwrap_or(Value::Null)
        ));
        Ok(self.proxy_json.clone())
    }

    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        _timeout_ms: u64,
        _max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String> {
        self.calls
            .push(format!("proxy-binary:{method}:{target_url}"));
        Ok(self.proxy_binary.clone())
    }
}

impl DaemonSystemTextRuntime for FakeRuntime {
    fn selected_log_path(
        &mut self,
        _daemon: bool,
        _project: Option<&str>,
    ) -> Result<PathBuf, String> {
        Ok(PathBuf::from("/tmp/aimux.log"))
    }

    fn read_last_log_lines(&self, _path: &Path, _lines: usize) -> Result<String, String> {
        Ok(String::new())
    }

    fn clear_log_file(&mut self, _path: &Path) -> Result<(), String> {
        Ok(())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn stop_project(&mut self, project_root: &str, _force: bool) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn remove_project(&mut self, project_root: &str, _force: bool) -> Result<Value, String> {
        Ok(json!({
            "projectId": "repo-id",
            "projectRoot": project_root,
            "project": { "projectRoot": project_root, "pid": 0, "status": "stopped" },
            "tmuxSessionsKilled": []
        }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        _serve_only: bool,
        _open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }
}

impl DaemonHostAgentTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        None
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonMetadataTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        None
    }

    fn post_project_service_json(
        &mut self,
        _project_root: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonAgentTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonCollaborationTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonNotificationTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonProjectContentTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonTeamTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonWorktreeTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonOverseerTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn default_tool(&self, _project_root: &str) -> String {
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonScribeTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn default_tool(&self, _project_root: &str) -> String {
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonOperationsTextRuntime for FakeRuntime {
    fn now_iso(&self) -> String {
        "now".into()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        Vec::new()
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        true
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn doctor_disk_report(
        &mut self,
        _project_roots: Vec<String>,
        _include_active_measurement: bool,
        _skipped_stale_project_roots: Vec<String>,
        _generated_at: String,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn doctor_tmux_report(
        &mut self,
        _project_root: &str,
        _session_name: Option<&str>,
        _window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn repair_tmux_runtime(
        &mut self,
        _project_root: &str,
        _open: bool,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn get_project_service_json(
        &mut self,
        project_root: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        ProjectServiceJsonResult::ok(project_root, json!({ "ok": true }))
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        ProjectServiceJsonResult::ok(project_root, json!({ "ok": true }))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        Ok(RestartControlPlaneTextResult {
            restart: json!({ "ok": true }),
            text: "ok\n".into(),
        })
    }

    fn dashboard_reload(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }

    fn runtime_restart(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }
}

impl DaemonAuthTextRuntime for FakeRuntime {
    fn remote_status_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn whoami_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        Err(AuthTextError {
            status: 401,
            error: "Not logged in. Run `aimux login` first.".into(),
        })
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }

    fn disable_relay(&mut self) {}

    fn clear_credentials(&mut self) -> String {
        "Logged out\n".into()
    }

    fn run_auth_flow(&mut self, _action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        Err(AuthFlowError {
            error: "unavailable".into(),
            messages: Vec::new(),
        })
    }

    fn start_auth_flow(&mut self, _action: AuthAction) -> AuthFlowStart {
        AuthFlowStart {
            id: "flow_1".into(),
            messages: Vec::new(),
        }
    }

    fn wait_auth_flow(
        &mut self,
        _id: &str,
        _action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        Err(AuthTextError {
            status: 400,
            error: "unavailable".into(),
        })
    }
}

struct RouteFixture {
    root: PathBuf,
}

impl RouteFixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-phase3-route-{name}-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("route fixture root");
        Self { root }
    }
}

impl Drop for RouteFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct FixtureLifecycleRuntime {
    killed: Vec<String>,
    kill_window_result: Option<Result<(), String>>,
}

impl ProjectLifecycleRuntime for FixtureLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }

    fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }

    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String> {
        Ok(cwd.to_owned())
    }

    fn create_worktree(
        &mut self,
        _main_repo: &str,
        _name: &str,
        _target_path: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        _cwd: &str,
        _command: &str,
        _args: &[String],
        _detached: bool,
    ) -> Result<TmuxTarget, String> {
        Ok(TmuxTarget {
            session_name: session_name.to_owned(),
            window_id: format!("@{name}"),
            window_index: 1,
            window_name: name.to_owned(),
            pane_dead: None,
        })
    }

    fn set_window_metadata(&mut self, _window_id: &str, _metadata: &Value) -> Result<(), String> {
        Ok(())
    }

    fn set_window_option(
        &mut self,
        _window_id: &str,
        _key: &str,
        _value: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn clear_history(&mut self, _window_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn has_window(&mut self, _target: &TmuxTarget) -> bool {
        true
    }

    fn codex_backend_session_ids_for_cwd(
        &mut self,
        _cwd: &str,
    ) -> Result<BTreeSet<String>, String> {
        Ok(BTreeSet::new())
    }

    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        self.killed.push(window_id.to_owned());
        self.kill_window_result.clone().unwrap_or(Ok(()))
    }

    fn rename_window(&mut self, _window_id: &str, _name: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct FixtureAgentInputRuntime {
    submit_outcome: FixtureSubmitOutcome,
    input_activity: VecDeque<Result<AgentInputWindowActivity, String>>,
    actions: Vec<FixtureInputAction>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum FixtureSubmitOutcome {
    #[default]
    Landed,
    Dropped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FixtureInputAction {
    Text { window_id: String, text: String },
    Key { window_id: String, key: String },
    CarriageReturn { window_id: String },
    SubmitDropped { window_id: String },
}

impl AgentOutputCaptureRuntime for FixtureAgentInputRuntime {
    fn capture_pane(
        &mut self,
        _window_id: &str,
        _options: CapturePaneOptions,
    ) -> Result<String, String> {
        Ok(String::new())
    }

    fn send_text(&mut self, window_id: &str, text: &str) -> Result<(), String> {
        self.actions.push(FixtureInputAction::Text {
            window_id: window_id.to_owned(),
            text: text.to_owned(),
        });
        Ok(())
    }

    fn send_key(&mut self, window_id: &str, key: &str) -> Result<(), String> {
        self.actions.push(FixtureInputAction::Key {
            window_id: window_id.to_owned(),
            key: key.to_owned(),
        });
        Ok(())
    }

    fn send_carriage_return(&mut self, window_id: &str) -> Result<(), String> {
        self.actions.push(FixtureInputAction::CarriageReturn {
            window_id: window_id.to_owned(),
        });
        Ok(())
    }

    fn submit_prompt(&mut self, window_id: &str, _draft: &str) -> Result<(), String> {
        self.send_carriage_return(window_id)?;
        match self.submit_outcome {
            FixtureSubmitOutcome::Landed => Ok(()),
            FixtureSubmitOutcome::Dropped => {
                self.actions.push(FixtureInputAction::SubmitDropped {
                    window_id: window_id.to_owned(),
                });
                Err("agent input submit did not land: carriage return dropped".into())
            }
        }
    }

    fn agent_input_window_activity(
        &mut self,
        _window_id: &str,
    ) -> Result<AgentInputWindowActivity, String> {
        self.input_activity
            .pop_front()
            .unwrap_or(Ok(AgentInputWindowActivity::Unattended))
    }
}

fn write_lifecycle_topology(state_dir: &Path) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "tmux:codex-live", "nodeId": "node-agent", "tmuxSession": "aimux", "tmuxWindowId": "@agent", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [{
            "id": "codex-live",
            "nodeId": "node-agent",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("coerce lifecycle topology");
    write_runtime_topology(runtime_topology_path(state_dir), &topology)
        .expect("write lifecycle topology");
}

fn write_agent_input_topology(state_dir: &Path) {
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
            { "id": "codex-1", "nodeId": "node-live", "status": "running", "command": "codex", "args": [], "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("coerce input topology");
    write_runtime_topology(runtime_topology_path(state_dir), &topology)
        .expect("write input topology");
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .expect("write metadata state");
}

struct HostedFixture {
    root: PathBuf,
    resolver: PathResolver,
}

impl HostedFixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-phase3-hosted-{name}-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self { root, resolver }
    }
}

impl Drop for HostedFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct HeldSseServer {
    port: u16,
    opened: mpsc::Receiver<()>,
    stop: mpsc::Sender<()>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl HeldSseServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind upstream");
        listener
            .set_nonblocking(true)
            .expect("nonblocking upstream");
        let port = listener.local_addr().expect("upstream addr").port();
        let (opened_tx, opened_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop_rx.try_recv().is_ok() {
                            return;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept upstream stream: {error}"),
                }
            };
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-type: text/event-stream\r\n\r\nd\r\ndata: first\n\n\r\n",
                )
                .expect("write first event");
            opened_tx.send(()).expect("signal opened");
            while stop_rx.recv_timeout(Duration::from_millis(25)).is_err() {}
        });
        Self {
            port,
            opened: opened_rx,
            stop: stop_tx,
            worker: Mutex::new(Some(worker)),
        }
    }

    fn wait_until_open(&self) {
        self.opened
            .recv_timeout(Duration::from_secs(2))
            .expect("upstream opened");
    }

    fn stop(&self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.lock().expect("worker lock").take() {
            worker.join().expect("upstream worker");
        }
    }
}

impl Drop for HeldSseServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn hosted_project(path: &str, port: u64, live: bool) -> ProjectsRouteProject {
    ProjectsRouteProject {
        id: path.replace('/', "-"),
        name: path.into(),
        path: path.into(),
        last_seen: None,
        dashboard_session_name: "aimux-test".into(),
        service: None,
        service_alive: live,
        service_endpoint: Some(json!({ "host": "127.0.0.1", "port": port })),
        online_agent_count: None,
    }
}

fn grant_hosted_operator(
    resolver: &PathResolver,
    label: &str,
    project_root: &str,
    session_id: &str,
) -> String {
    let store = HostedPrincipalsStore::with_resolver(resolver.clone());
    let (principal, token) = store.create_principal(label).expect("create principal");
    store
        .grant_session(
            &principal.id,
            HostedGrant {
                project_root: project_root.to_owned(),
                session_id: session_id.to_owned(),
            },
        )
        .expect("grant principal");
    token
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn serve_once(
    handle: impl FnOnce(TcpStream) -> String + Send + 'static,
) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
    let address = listener.local_addr().expect("address");
    let join = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        handle(stream)
    });
    (format!("http://127.0.0.1:{}", address.port()), join)
}

fn read_request_text(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let count = stream.read(&mut buffer).expect("read request");
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(bytes).expect("request utf8")
}

fn normalize_response_bytes(bytes: &[u8]) -> String {
    let text = String::from_utf8(bytes.to_vec()).expect("response utf8");
    normalize_upstream_port(&text)
}

fn normalize_hosted_response(response: &str) -> String {
    response.replace("\r\n", "\n")
}

fn normalize_hosted_proxy_path(path: &str) -> String {
    let Some(rest) = path.strip_prefix("/proxy/127.0.0.1/") else {
        return path.to_owned();
    };
    let Some((port, suffix)) = rest.split_once('/') else {
        return path.to_owned();
    };
    if port.chars().all(|ch| ch.is_ascii_digit()) {
        format!("/proxy/127.0.0.1/<upstream-port>/{suffix}")
    } else {
        path.to_owned()
    }
}

fn normalize_upstream_port(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with("Host: 127.0.0.1:") {
                "Host: 127.0.0.1:<upstream-port>".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_stream_error(error: &HostAgentStreamError) -> Value {
    match error {
        HostAgentStreamError::Io(message) if message.contains("broken pipe") => {
            json!({ "kind": "io", "message": "broken pipe" })
        }
        HostAgentStreamError::Io(message) => json!({ "kind": "io", "message": message }),
        HostAgentStreamError::InvalidUrl(message) => {
            json!({ "kind": "invalid-url", "message": message })
        }
        HostAgentStreamError::InvalidResponse(message) => {
            json!({ "kind": "invalid-response", "message": message })
        }
        HostAgentStreamError::Upstream(message) => {
            json!({ "kind": "upstream", "message": message })
        }
        HostAgentStreamError::Transform(message) => {
            json!({ "kind": "transform", "message": message })
        }
    }
}

struct ResettingAsyncHttpStream {
    input: Vec<u8>,
    offset: usize,
    output: Vec<u8>,
    reset_after_written: usize,
}

impl ResettingAsyncHttpStream {
    fn new(input: &[u8], reset_after_written: usize) -> Self {
        Self {
            input: input.to_vec(),
            offset: 0,
            output: Vec::new(),
            reset_after_written,
        }
    }
}

impl AsyncRead for ResettingAsyncHttpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.offset >= self.input.len() {
            return Poll::Ready(Ok(()));
        }
        let remaining = &self.input[self.offset..];
        let count = remaining.len().min(buffer.remaining());
        buffer.put_slice(&remaining[..count]);
        self.offset += count;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for ResettingAsyncHttpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.output.len() >= self.reset_after_written {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "injected client reset",
            )));
        }
        let writable = (self.reset_after_written - self.output.len()).min(buffer.len());
        self.output.extend_from_slice(&buffer[..writable]);
        Poll::Ready(Ok(writable))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct FailAfterAsyncWrites {
    ok_writes_remaining: usize,
}

impl FailAfterAsyncWrites {
    fn new(ok_writes: usize) -> Self {
        Self {
            ok_writes_remaining: ok_writes,
        }
    }
}

impl AsyncWrite for FailAfterAsyncWrites {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.ok_writes_remaining == 0 {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "broken pipe",
            )));
        }
        self.ok_writes_remaining -= 1;
        Poll::Ready(Ok(buffer.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH)
}

fn git_head_short() -> String {
    std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|head| !head.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
