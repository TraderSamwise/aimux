use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::jobs::{
    DaemonJobRouteRuntime, JobEventStreamOptions,
    maybe_handle_job_event_stream_request_with_runtime_mutex, route_jobs_json_request,
    write_job_event_stream,
};
use aimux::daemon::server::DaemonHttpRequest;
use aimux::jobs::{JobEventInput, JobScope, JobStatus, JobStore};
use aimux::paths::{PathResolver, ProjectEntry, ProjectsRegistry, compute_project_id};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const JOBS_ROUTE_CONTRACT: &str =
    include_str!("../../../../testdata/contracts/v1/daemon/jobs-route-contract.json");

#[derive(Clone)]
struct FakeJobRuntime {
    store: JobStore,
    resolver: PathResolver,
}

impl DaemonJobRouteRuntime for FakeJobRuntime {
    fn job_store(&self) -> JobStore {
        self.store.clone()
    }

    fn job_path_resolver(&self) -> PathResolver {
        self.resolver.clone()
    }
}

struct Fixture {
    runtime: FakeJobRuntime,
    address: String,
}

fn fixture(label: &str) -> Fixture {
    let root =
        std::env::temp_dir().join(format!("aimux-daemon-jobs-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let home = root.join("home");
    let project = root.join("projects").join("tealstreet-next");
    fs::create_dir_all(project.join(".git")).expect("project git marker");
    let resolver = PathResolver::new(&project, &home, None);
    resolver
        .save_registry(&ProjectsRegistry {
            version: aimux::paths::PROJECTS_REGISTRY_VERSION,
            projects: vec![ProjectEntry {
                id: compute_project_id(&project),
                name: "tealstreet-next".to_owned(),
                repo_root: project.to_string_lossy().into_owned(),
                last_seen: "2026-09-21T00:00:00.000Z".to_owned(),
            }],
        })
        .expect("registry write");
    Fixture {
        runtime: FakeJobRuntime {
            store: JobStore::new(home.join("jobs")),
            resolver,
        },
        address: "tealstreet-next/main/review-pr".to_owned(),
    }
}

fn json_body(response: aimux::daemon::routing::DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected JSON body, got {other:?}"),
    }
}

fn route(
    runtime: &mut FakeJobRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
    actor_present: bool,
) -> Value {
    let response =
        route_jobs_json_request(runtime, method, path, body, actor_present).expect("handled");
    json_body(response)
}

#[test]
fn jobs_route_contract_fixture_names_the_registered_routes() {
    let fixture: Value = serde_json::from_str(JOBS_ROUTE_CONTRACT).expect("fixture JSON");
    let routes = fixture["routes"].as_array().expect("routes");
    assert!(routes.iter().any(|route| {
        route[0] == "POST" && route[1] == CORE_API_ROUTES.jobs && route[2] == "create-or-join"
    }));
    assert!(routes.iter().any(|route| {
        route[0] == "GET"
            && route[1]
                .as_str()
                .unwrap()
                .starts_with(CORE_API_ROUTES.jobs_events)
    }));
    assert!(
        routes
            .iter()
            .any(|route| { route[0] == "POST" && route[1] == CORE_API_ROUTES.jobs_cancel })
    );
}

#[test]
fn post_jobs_is_idempotent_over_http_and_address_handle_resolves_same_job() {
    let mut fixture = fixture("idempotent");
    let body = json!({
        "address": fixture.address,
        "tool": "codex",
        "args": ["--pr", "123"],
        "cwd": "/repo/main",
        "env": { "AIMUX_TEST": "1" }
    });

    let first = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&body),
        false,
    );
    let second = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&body),
        false,
    );

    assert_eq!(first["ok"], true);
    assert_eq!(second["ok"], true);
    assert_eq!(first["outcome"], "created");
    assert_eq!(second["outcome"], "joined");
    assert_eq!(first["job"]["id"], second["job"]["id"]);

    let by_id = route(
        &mut fixture.runtime,
        "GET",
        &format!(
            "{}?handle={}",
            CORE_API_ROUTES.jobs,
            first["job"]["id"].as_str().unwrap()
        ),
        None,
        false,
    );
    let by_address = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?handle={}", CORE_API_ROUTES.jobs, fixture.address),
        None,
        false,
    );
    assert_eq!(by_id["job"]["id"], first["job"]["id"]);
    assert_eq!(by_address["job"]["id"], first["job"]["id"]);
    assert_eq!(by_id["handleKind"], "id");
    assert_eq!(by_address["handleKind"], "address");
}

#[test]
fn post_job_mutations_reject_remote_actor_headers() {
    let mut fixture = fixture("auth");
    let create_body = json!({
        "address": fixture.address,
        "tool": "codex",
        "args": []
    });
    let create = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&create_body),
        true,
    )
    .expect("create handled");
    assert_eq!(create.status, 403);
    assert!(
        json_body(create)["error"]
            .as_str()
            .unwrap()
            .contains("loopback-only")
    );

    let cancel_body = json!({ "handle": "job-any" });
    let cancel = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_cancel,
        Some(&cancel_body),
        true,
    )
    .expect("cancel handled");
    assert_eq!(cancel.status, 403);
    assert!(
        json_body(cancel)["error"]
            .as_str()
            .unwrap()
            .contains("loopback-only")
    );
}

#[test]
fn cancel_terminal_job_is_http_noop_and_does_not_rewrite_status() {
    let mut fixture = fixture("cancel-terminal");
    let scope = JobScope::Global;
    let (record, _) = fixture
        .runtime
        .store
        .create_or_join(&aimux::jobs::JobSpec {
            scope,
            skill: "review-pr".to_owned(),
            tool: Some("codex".to_owned()),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
        })
        .expect("created");
    fixture
        .runtime
        .store
        .set_status(&record.id, JobStatus::Succeeded)
        .expect("succeeded");

    let body = json!({ "handle": record.id });
    let response = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_cancel,
        Some(&body),
        false,
    );
    assert_eq!(response["ok"], true);
    assert_eq!(response["outcome"], "noop");
    assert_eq!(response["job"]["status"], "succeeded");
    assert_eq!(
        fixture
            .runtime
            .store
            .load(response["job"]["id"].as_str().unwrap())
            .unwrap()
            .status,
        JobStatus::Succeeded
    );
}

#[test]
fn list_jobs_filters_by_scope_without_treating_empty_as_error() {
    let mut fixture = fixture("list-scope");
    let body = json!({
        "address": fixture.address,
        "tool": "codex",
        "args": []
    });
    let created = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&body),
        false,
    );
    let listed = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?scope=tealstreet-next/main", CORE_API_ROUTES.jobs),
        None,
        false,
    );
    assert_eq!(listed["ok"], true);
    assert_eq!(listed["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["jobs"][0]["id"], created["job"]["id"]);
}

#[tokio::test]
async fn missing_job_stream_is_http_error_not_empty_sse() {
    let fixture = fixture("missing-stream");
    let runtime = Arc::new(Mutex::new(fixture.runtime));
    let request = DaemonHttpRequest {
        method: "GET".to_owned(),
        path: format!("{}?handle=job-missing", CORE_API_ROUTES.jobs_events),
        headers: BTreeMap::new(),
        body_chunks: Vec::new(),
        stopping: false,
        issued_at: "now".to_owned(),
    };
    let output = capture_intercepted_stream(runtime, request).await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 404 Not Found\r\n"));
    assert!(text.contains("job not found"));
    assert!(!text.contains("text/event-stream"));
}

#[tokio::test]
async fn resolved_job_streams_events_from_requested_sequence() {
    let fixture = fixture("event-stream");
    let spec = aimux::jobs::JobSpec {
        scope: JobScope::Global,
        skill: "review-pr".to_owned(),
        tool: Some("codex".to_owned()),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
    };
    let (record, _) = fixture.runtime.store.create_or_join(&spec).expect("job");
    fixture
        .runtime
        .store
        .append_event(
            &record.id,
            JobEventInput {
                kind: "stdout".to_owned(),
                data: json!({ "line": "first" }),
            },
        )
        .expect("first event");
    fixture
        .runtime
        .store
        .append_event(
            &record.id,
            JobEventInput {
                kind: "stdout".to_owned(),
                data: json!({ "line": "second" }),
            },
        )
        .expect("second event");

    let output = capture_job_event_stream(
        fixture.runtime.store.clone(),
        record.id.clone(),
        1,
        JobEventStreamOptions {
            keepalive_ms: 1,
            poll_ms: 1,
            max_keepalives: Some(1),
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains("content-type: text/event-stream\r\n"));
    assert!(!text.contains("\"line\":\"first\""));
    assert!(text.contains("\"line\":\"second\""));
    assert!(text.contains(": keepalive\n\n"));
}

#[tokio::test]
async fn drained_job_stream_keeps_connection_alive_with_keepalive() {
    let fixture = fixture("drained-stream");
    let spec = aimux::jobs::JobSpec {
        scope: JobScope::Global,
        skill: "review-pr".to_owned(),
        tool: Some("codex".to_owned()),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
    };
    let (record, _) = fixture.runtime.store.create_or_join(&spec).expect("job");
    let output = capture_job_event_stream(
        fixture.runtime.store.clone(),
        record.id.clone(),
        0,
        JobEventStreamOptions {
            keepalive_ms: 1,
            poll_ms: 1,
            max_keepalives: Some(1),
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains(": keepalive\n\n"));
    assert!(!text.contains("event: error"));
}

async fn capture_intercepted_stream(
    runtime: Arc<Mutex<FakeJobRuntime>>,
    request: DaemonHttpRequest,
) -> Vec<u8> {
    let (mut client, mut server) = tokio::io::duplex(16 * 1024);
    let writer = async {
        let _ = maybe_handle_job_event_stream_request_with_runtime_mutex(
            &runtime,
            &request,
            &mut server,
        )
        .await
        .expect("stream route");
        server.shutdown().await.expect("shutdown");
    };
    let reader = async {
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).await.expect("read");
        bytes
    };
    let (_, bytes) = tokio::join!(writer, reader);
    bytes
}

async fn capture_job_event_stream(
    store: JobStore,
    id: String,
    seq: u64,
    options: JobEventStreamOptions,
) -> Vec<u8> {
    let (mut client, mut server) = tokio::io::duplex(16 * 1024);
    let writer = async {
        write_job_event_stream(&store, &id, seq, &mut server, options)
            .await
            .expect("stream write");
        server.shutdown().await.expect("shutdown");
    };
    let reader = async {
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).await.expect("read");
        bytes
    };
    let (_, bytes) = tokio::join!(writer, reader);
    bytes
}
