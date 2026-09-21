use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::access::build_daemon_route_context;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::jobs::{
    DaemonJobRouteRuntime, JobEventStreamOptions, drain_due_job_callbacks_with,
    maybe_handle_job_event_stream_request_with_runtime_mutex, route_jobs_json_request,
    write_job_event_stream, write_job_list_stream,
};
use aimux::daemon::listener::parse_daemon_http_request;
use aimux::daemon::server::DaemonHttpRequest;
use aimux::daemon::server::handle_daemon_http_request;
use aimux::desktop_notifier::{
    DesktopNotificationDeliveryResult, DesktopNotificationPayload, DesktopNotificationTransport,
};
use aimux::jobs::{
    JobAddress, JobCancelReport, JobEventInput, JobRecord, JobScope, JobSpec, JobStatus, JobStore,
    JobStoreError, JobTmuxTarget,
};
use aimux::paths::{PathResolver, ProjectEntry, ProjectsRegistry, compute_project_id};
use aimux::remote::daemon_relay::build_request_head;
use aimux::request_actor::RELAY_FORWARDED_HEADER;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const JOBS_ROUTE_CONTRACT: &str =
    include_str!("../../../../testdata/contracts/v1/daemon/jobs-route-contract.json");

#[derive(Clone)]
struct FakeJobRuntime {
    store: JobStore,
    resolver: PathResolver,
    forced_callbacks: Arc<AtomicUsize>,
}

impl DaemonJobRouteRuntime for FakeJobRuntime {
    fn job_store(&self) -> JobStore {
        self.store.clone()
    }

    fn job_path_resolver(&self) -> PathResolver {
        self.resolver.clone()
    }

    fn start_created_job(
        &mut self,
        store: &JobStore,
        record: JobRecord,
        _spec: &JobSpec,
    ) -> Result<JobRecord, JobStoreError> {
        store.mark_running(
            &record.id,
            JobTmuxTarget {
                session_name: "aimux-test".to_owned(),
                window_id: format!("@{}", record.id.len()),
                window_index: 1,
                window_name: "job-test".to_owned(),
            },
            store.output_tap_path(&record.id).to_string_lossy(),
        )
    }

    fn cancel_running_job(
        &mut self,
        store: &JobStore,
        record: &JobRecord,
    ) -> Result<JobCancelReport, JobStoreError> {
        store.finish(
            &record.id,
            JobStatus::Cancelled,
            None,
            "cancelled by SIGTERM",
            Some("SIGTERM".to_owned()),
        )?;
        Ok(JobCancelReport {
            signal: "SIGTERM".to_owned(),
            pid: Some(1234),
        })
    }

    fn force_job_callbacks_next_tick(&self) {
        self.forced_callbacks.fetch_add(1, Ordering::SeqCst);
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
    init_git_repo(&project);
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
            forced_callbacks: Arc::new(AtomicUsize::new(0)),
        },
        address: "tealstreet-next/main/review-pr".to_owned(),
    }
}

fn init_git_repo(path: &std::path::Path) {
    fs::create_dir_all(path).expect("repo dir");
    let status = std::process::Command::new("git")
        .arg("init")
        .arg("-q")
        .arg(path)
        .status()
        .expect("git init");
    assert!(status.success(), "git init failed for {}", path.display());
}

fn job_spec(slot: &str) -> JobSpec {
    JobSpec {
        address: JobAddress {
            scope: JobScope::Global,
            slot: vec![slot.to_owned()],
        },
        scope: JobScope::Global,
        skill: "review-pr".to_owned(),
        prompt: None,
        tool: Some("codex".to_owned()),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
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
    let contract: Value = serde_json::from_str(JOBS_ROUTE_CONTRACT).expect("fixture JSON");
    let routes = contract["routes"].as_array().expect("routes");
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
    assert!(
        routes
            .iter()
            .any(|route| { route[0] == "POST" && route[1] == CORE_API_ROUTES.jobs_notify })
    );
    assert!(
        routes
            .iter()
            .any(|route| { route[0] == "POST" && route[1] == CORE_API_ROUTES.jobs_callbacks_kick })
    );

    let mut fixture = fixture("route-contract");
    let create_remote = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&json!({ "address": fixture.address, "args": [], "skill": "review-pr" })),
        true,
    )
    .expect("create route handled");
    assert_eq!(create_remote.status, 403);
    let list_remote = route_jobs_json_request(
        &mut fixture.runtime,
        "GET",
        CORE_API_ROUTES.jobs,
        None,
        true,
    )
    .expect("list route handled");
    assert_eq!(list_remote.status, 403);
    let cancel_remote = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_cancel,
        Some(&json!({ "handle": "job-any" })),
        true,
    )
    .expect("cancel route handled");
    assert_eq!(cancel_remote.status, 403);
    let notify_remote = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_notify,
        Some(&json!({ "handle": "job-any" })),
        true,
    )
    .expect("notify route handled");
    assert_eq!(notify_remote.status, 403);
    let kick_remote = route_jobs_json_request(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_callbacks_kick,
        Some(&json!({})),
        true,
    )
    .expect("kick route handled");
    assert_eq!(kick_remote.status, 403);
}

#[test]
fn post_jobs_is_idempotent_over_http_and_address_handle_resolves_same_job() {
    let mut fixture = fixture("idempotent");
    let body = json!({
        "address": fixture.address,
        "tool": "codex",
            "skill": "review-pr",
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
            "skill": "review-pr",
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
fn relay_forwarded_job_create_without_actor_headers_is_still_remote() {
    let mut fixture = fixture("relay-auth");
    let body = json!({
        "address": fixture.address,
        "tool": "codex",
            "skill": "review-pr",
        "args": ["--from-relay"]
    })
    .to_string();
    let wire = build_request_head(
        "POST",
        CORE_API_ROUTES.jobs,
        &json!({
            RELAY_FORWARDED_HEADER: "peer-supplied-value-that-must-be-replaced"
        }),
        Some(&body),
        "43190",
    );
    assert!(wire.contains(&format!("\r\n{RELAY_FORWARDED_HEADER}: 1\r\n")));
    assert!(!wire.contains("peer-supplied-value-that-must-be-replaced"));

    let request = parse_daemon_http_request(wire.as_bytes()).expect("relay HTTP request");
    let response = handle_daemon_http_request(
        request,
        |method, path, body, headers| {
            build_daemon_route_context(method, path, body, headers.clone(), &[])
        },
        |method, path, body, context, _issued_at| {
            route_jobs_json_request(
                &mut fixture.runtime,
                method,
                path,
                body,
                context.actor_present,
            )
            .expect("jobs route")
        },
    );
    assert_eq!(response.status, 403);
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert!(body["error"].as_str().unwrap().contains("loopback-only"));
    let local_list = route(
        &mut fixture.runtime,
        "GET",
        CORE_API_ROUTES.jobs,
        None,
        false,
    );
    assert_eq!(local_list["jobs"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn get_job_routes_reject_remote_actor_headers() {
    let mut fixture = fixture("get-auth");
    let list = route_jobs_json_request(
        &mut fixture.runtime,
        "GET",
        CORE_API_ROUTES.jobs,
        None,
        true,
    )
    .expect("list handled");
    assert_eq!(list.status, 403);

    let runtime = Arc::new(Mutex::new(fixture.runtime));
    let request = DaemonHttpRequest {
        method: "GET".to_owned(),
        path: format!("{}?handle=job-missing", CORE_API_ROUTES.jobs_events),
        headers: BTreeMap::from([(RELAY_FORWARDED_HEADER.to_owned(), "1".to_owned())]),
        body_chunks: Vec::new(),
        stopping: false,
        issued_at: "now".to_owned(),
    };
    let output = capture_intercepted_stream(runtime, request).await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 403 Forbidden\r\n"));
    assert!(text.contains("loopback-only"));
    assert!(!text.contains("text/event-stream"));
}

#[test]
fn job_id_handle_rejects_path_traversal() {
    let mut fixture = fixture("bad-job-id");
    let response = route_jobs_json_request(
        &mut fixture.runtime,
        "GET",
        &format!("{}?handle=job-real/../../../x", CORE_API_ROUTES.jobs),
        None,
        false,
    )
    .expect("route handled");
    assert_eq!(response.status, 400);
    let body = json_body(response);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("invalid characters")
    );
}

#[test]
fn cancel_terminal_job_is_http_noop_and_does_not_rewrite_status() {
    let mut fixture = fixture("cancel-terminal");
    let (record, _) = fixture
        .runtime
        .store
        .create_or_join(&job_spec("review-pr"))
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
            "skill": "review-pr",
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

#[test]
fn list_jobs_scope_is_recursive_by_default_and_depth_limited_by_segments() {
    let mut fixture = fixture("list-depth");
    let sibling =
        std::env::temp_dir().join(format!("aimux-daemon-jobs-sibling-{}", std::process::id()));
    init_git_repo(&sibling);
    let project = std::env::temp_dir().join(format!(
        "aimux-daemon-jobs-list-depth-project-{}",
        std::process::id()
    ));
    init_git_repo(&project);
    fixture
        .runtime
        .resolver
        .save_registry(&ProjectsRegistry {
            version: aimux::paths::PROJECTS_REGISTRY_VERSION,
            projects: vec![
                ProjectEntry {
                    id: compute_project_id(&project),
                    name: "tealstreet-next".to_owned(),
                    repo_root: project.to_string_lossy().into_owned(),
                    last_seen: "2026-09-21T00:00:00.000Z".to_owned(),
                },
                ProjectEntry {
                    id: compute_project_id(&sibling),
                    name: "tealstreet-next-2".to_owned(),
                    repo_root: sibling.to_string_lossy().into_owned(),
                    last_seen: "2026-09-21T00:00:00.000Z".to_owned(),
                },
            ],
        })
        .expect("registry write");
    for address in [
        "tealstreet-next",
        "tealstreet-next/main",
        "tealstreet-next/main/foo",
        "tealstreet-next-2",
    ] {
        let response = route(
            &mut fixture.runtime,
            "POST",
            CORE_API_ROUTES.jobs,
            Some(&json!({
                "address": address,
                "tool": "codex",
                "skill": "review-pr",
                "args": []
            })),
            false,
        );
        assert_eq!(response["ok"], true, "{address}");
    }
    let recursive = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?scope=tealstreet-next", CORE_API_ROUTES.jobs),
        None,
        false,
    );
    assert_eq!(recursive["jobs"].as_array().unwrap().len(), 3);
    let exact = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?scope=tealstreet-next&depth=0", CORE_API_ROUTES.jobs),
        None,
        false,
    );
    assert_eq!(exact["jobs"].as_array().unwrap().len(), 1);
    let direct = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?scope=tealstreet-next&depth=1", CORE_API_ROUTES.jobs),
        None,
        false,
    );
    assert_eq!(direct["jobs"].as_array().unwrap().len(), 2);
}

#[test]
fn notify_route_registers_callback_and_forces_delivery_tick() {
    let mut fixture = fixture("notify-route");
    let created = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs,
        Some(&json!({
            "address": fixture.address,
            "tool": "codex",
            "skill": "review-pr",
            "args": []
        })),
        false,
    );
    let job_id = created["job"]["id"].as_str().unwrap().to_owned();
    let response = route(
        &mut fixture.runtime,
        "POST",
        CORE_API_ROUTES.jobs_notify,
        Some(&json!({
            "handle": job_id,
            "watcherId": "sam",
        })),
        false,
    );
    assert_eq!(response["ok"], true);
    assert_eq!(response["callback"]["watcherId"], "sam");
    assert_eq!(response["desktopNotification"]["available"], false);
    assert_eq!(
        response["callback"]["suppressedReason"],
        "cargo test harness"
    );
    assert_eq!(fixture.runtime.forced_callbacks.load(Ordering::SeqCst), 0);
}

#[test]
fn callback_drain_delivers_two_watchers_once_across_store_restart() {
    let fixture = fixture("callback-drain");
    let store = fixture.runtime.store.clone();
    let root = store.root().to_path_buf();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    store
        .register_desktop_callback(&record.id, "sam")
        .expect("sam callback");
    store
        .register_desktop_callback(&record.id, "ci")
        .expect("ci callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");

    let restarted = JobStore::new(root);
    let sent = Arc::new(Mutex::new(Vec::<DesktopNotificationPayload>::new()));
    let sent_for_sender = Arc::clone(&sent);
    let report = drain_due_job_callbacks_with(
        &restarted,
        u128::MAX,
        |_| None,
        move |payload| {
            sent_for_sender.lock().unwrap().push(payload.clone());
            ok_delivery()
        },
    )
    .expect("drain");
    assert_eq!(report.attempted, 2);
    assert_eq!(report.delivered, 2);
    assert_eq!(sent.lock().unwrap().len(), 2);

    let sent_again = Arc::new(Mutex::new(Vec::<DesktopNotificationPayload>::new()));
    let sent_again_sender = Arc::clone(&sent_again);
    let report = drain_due_job_callbacks_with(
        &restarted,
        u128::MAX,
        |_| None,
        move |payload| {
            sent_again_sender.lock().unwrap().push(payload.clone());
            ok_delivery()
        },
    )
    .expect("second drain");
    assert_eq!(report.attempted, 0);
    assert!(sent_again.lock().unwrap().is_empty());
}

#[test]
fn callback_guard_suppresses_without_sending() {
    let fixture = fixture("callback-suppressed");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    store
        .register_desktop_callback(&record.id, "sam")
        .expect("callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");
    let sends = Arc::new(AtomicUsize::new(0));
    let sends_for_sender = Arc::clone(&sends);
    let report = drain_due_job_callbacks_with(
        &store,
        u128::MAX,
        |_| Some("cargo test harness".to_owned()),
        move |_| {
            sends_for_sender.fetch_add(1, Ordering::SeqCst);
            ok_delivery()
        },
    )
    .expect("drain");
    assert_eq!(report.suppressed, 1);
    assert_eq!(sends.load(Ordering::SeqCst), 0);
    let callbacks = store.load_callbacks(&record.id).expect("callbacks");
    assert_eq!(
        callbacks.watchers["sam"].suppressed_reason.as_deref(),
        Some("cargo test harness")
    );
}

#[test]
fn disabled_desktop_delivery_is_suppressed_once_without_retrying() {
    let fixture = fixture("callback-disabled");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    store
        .register_desktop_callback(&record.id, "sam")
        .expect("callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");

    let sends = Arc::new(AtomicUsize::new(0));
    let sends_for_sender = Arc::clone(&sends);
    let report = drain_due_job_callbacks_with(
        &store,
        u128::MAX,
        |_| None,
        move |_| {
            sends_for_sender.fetch_add(1, Ordering::SeqCst);
            disabled_delivery("desktop notifications are disabled")
        },
    )
    .expect("drain");
    assert_eq!(report.attempted, 1);
    assert_eq!(report.suppressed, 1);
    assert_eq!(report.failed, 0);
    assert_eq!(report.abandoned, 0);
    assert_eq!(sends.load(Ordering::SeqCst), 1);

    let report = drain_due_job_callbacks_with(
        &store,
        u128::MAX,
        |_| None,
        |_| panic!("disabled callback should not retry"),
    )
    .expect("second drain");
    assert_eq!(report.attempted, 0);
    let callbacks = store.load_callbacks(&record.id).expect("callbacks");
    assert_eq!(callbacks.watchers["sam"].attempts, 0);
    assert_eq!(
        callbacks.watchers["sam"].suppressed_reason.as_deref(),
        Some("desktop notifications are disabled")
    );
}

#[cfg(unix)]
#[test]
fn fifo_callback_writes_one_terminal_line_exactly_once() {
    use std::os::unix::fs::OpenOptionsExt;

    let fixture = fixture("callback-fifo");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    let fifo_path = store.root().join("notify.fifo");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .expect("mkfifo");
    assert!(status.success(), "mkfifo failed");
    let mut reader = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo_path)
        .expect("open fifo reader");
    store
        .register_fifo_callback(&record.id, "fifo-test", fifo_path.to_str().unwrap())
        .expect("fifo callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");
    let report =
        aimux::daemon::jobs::drain_due_job_callbacks(&store, u128::MAX).expect("fifo drain");
    assert_eq!(report.delivered, 1);
    let mut text = String::new();
    reader.read_to_string(&mut text).expect("read fifo");
    assert!(text.contains(&record.id));
    assert!(text.contains("\"status\":\"succeeded\""));
    let second =
        aimux::daemon::jobs::drain_due_job_callbacks(&store, u128::MAX).expect("second drain");
    assert_eq!(second.attempted, 0);
}

#[cfg(unix)]
#[test]
fn fifo_callback_without_reader_does_not_block_daemon() {
    let fixture = fixture("callback-fifo-no-reader");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    let fifo_path = store.root().join("notify.fifo");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .expect("mkfifo");
    assert!(status.success(), "mkfifo failed");
    store
        .register_fifo_callback(&record.id, "fifo-test", fifo_path.to_str().unwrap())
        .expect("fifo callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");
    let started = Instant::now();
    let report =
        aimux::daemon::jobs::drain_due_job_callbacks(&store, u128::MAX).expect("fifo drain");
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(report.failed, 1);
}

#[cfg(unix)]
#[test]
fn fifo_callback_revalidates_open_fd_after_path_swap() {
    use std::os::unix::fs::symlink;

    let fixture = fixture("callback-fifo-symlink-swap");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    let fifo_path = store.root().join("notify.fifo");
    let target_path = store.root().join("not-a-fifo.txt");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .expect("mkfifo");
    assert!(status.success(), "mkfifo failed");
    fs::write(&target_path, "before").expect("target file");
    store
        .register_fifo_callback(&record.id, "fifo-test", fifo_path.to_str().unwrap())
        .expect("fifo callback");
    fs::remove_file(&fifo_path).expect("remove fifo");
    symlink(&target_path, &fifo_path).expect("swap symlink");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");

    let report =
        aimux::daemon::jobs::drain_due_job_callbacks(&store, u128::MAX).expect("fifo drain");

    assert_eq!(report.failed, 1);
    assert_eq!(
        fs::read_to_string(&target_path).expect("target unchanged"),
        "before"
    );
}

#[test]
fn callback_send_before_delivery_record_is_replayed_after_restart_once() {
    let fixture = fixture("callback-send-record-crash");
    let store = fixture.runtime.store.clone();
    let root = store.root().to_path_buf();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    store
        .register_desktop_callback(&record.id, "sam")
        .expect("callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");

    let due_before_crash = store.due_callbacks(u128::MAX).expect("due");
    assert_eq!(due_before_crash.len(), 1);
    assert_eq!(due_before_crash[0].record.status, JobStatus::Succeeded);

    let restarted = JobStore::new(root);
    let sends = Arc::new(AtomicUsize::new(0));
    let sends_for_sender = Arc::clone(&sends);
    let report = drain_due_job_callbacks_with(
        &restarted,
        u128::MAX,
        |_| None,
        move |_| {
            sends_for_sender.fetch_add(1, Ordering::SeqCst);
            ok_delivery()
        },
    )
    .expect("restarted drain");
    assert_eq!(report.attempted, 1);
    assert_eq!(report.delivered, 1);
    assert_eq!(sends.load(Ordering::SeqCst), 1);

    let report = drain_due_job_callbacks_with(
        &restarted,
        u128::MAX,
        |_| None,
        |_| panic!("delivered callback should not replay again"),
    )
    .expect("second drain");
    assert_eq!(report.attempted, 0);
}

#[test]
fn corrupt_callback_record_does_not_block_other_due_notifications() {
    let fixture = fixture("callback-head-of-line");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (poisoned, _) = store.create_or_join(&spec).expect("poisoned job");
    store
        .register_desktop_callback(&poisoned.id, "poisoned")
        .expect("poisoned callback");
    store
        .finish(&poisoned.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish poisoned");
    fs::write(
        store
            .root()
            .join("records")
            .join(&poisoned.id)
            .join("callbacks.json"),
        "{not-json}\n",
    )
    .expect("corrupt callbacks");

    let mut second_spec = job_spec("review-pr-second");
    second_spec.args.push("--second".to_owned());
    let (healthy, _) = store.create_or_join(&second_spec).expect("healthy job");
    store
        .register_desktop_callback(&healthy.id, "sam")
        .expect("healthy callback");
    store
        .finish(&healthy.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish healthy");

    let sends = Arc::new(AtomicUsize::new(0));
    let sends_for_sender = Arc::clone(&sends);
    let report = drain_due_job_callbacks_with(
        &store,
        u128::MAX,
        |_| None,
        move |_| {
            sends_for_sender.fetch_add(1, Ordering::SeqCst);
            ok_delivery()
        },
    )
    .expect("drain should skip poisoned record and continue");
    assert_eq!(report.attempted, 1);
    assert_eq!(report.delivered, 1);
    assert_eq!(sends.load(Ordering::SeqCst), 1);
}

#[test]
fn callback_failures_eventually_abandon_and_release_prune() {
    let fixture = fixture("callback-give-up");
    let store = fixture.runtime.store.clone();
    let spec = job_spec("review-pr");
    let (record, _) = store.create_or_join(&spec).expect("job");
    store
        .register_desktop_callback(&record.id, "sam")
        .expect("callback");
    store
        .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
        .expect("finish");

    let first_due = store
        .load_callbacks(&record.id)
        .expect("callbacks")
        .watchers["sam"]
        .next_attempt_ms;
    let mut abandoned = 0;
    let mut now = first_due;
    for attempt in 0..aimux::jobs::JOB_CALLBACK_MAX_ATTEMPTS {
        let report = drain_due_job_callbacks_with(
            &store,
            now,
            |_| None,
            |_| failed_delivery("helper missing"),
        )
        .expect("failed drain");
        abandoned += report.abandoned;
        if attempt + 1 < aimux::jobs::JOB_CALLBACK_MAX_ATTEMPTS {
            let before_next = store
                .load_callbacks(&record.id)
                .expect("callbacks")
                .watchers["sam"]
                .next_attempt_ms
                .saturating_sub(1);
            let early = drain_due_job_callbacks_with(
                &store,
                before_next,
                |_| None,
                |_| panic!("callback retried before its backoff elapsed"),
            )
            .expect("early drain");
            assert_eq!(early.attempted, 0);
            now = before_next.saturating_add(1);
        }
    }
    assert_eq!(abandoned, 1);
    let report = store
        .prune(
            aimux::jobs::JobRetention {
                max_jobs: 0,
                max_events_per_job: 1,
                terminal_job_retention_ms: 0,
            },
            u128::MAX,
        )
        .expect("prune");
    assert_eq!(report.removed_jobs, 1);
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
    let spec = job_spec("review-pr");
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
            max_keepalives: None,
            max_polls: Some(1),
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains("content-type: text/event-stream\r\n"));
    assert!(!text.contains("\"line\":\"first\""));
    assert!(text.contains("\"line\":\"second\""));
    assert!(!text.contains(": keepalive\n\n"));
}

#[tokio::test]
async fn terminal_job_stream_emits_final_status_and_closes() {
    let fixture = fixture("terminal-stream");
    let spec = job_spec("review-pr");
    let (record, _) = fixture.runtime.store.create_or_join(&spec).expect("job");
    fixture
        .runtime
        .store
        .append_event(
            &record.id,
            JobEventInput {
                kind: "output".to_owned(),
                data: json!({ "text": "done\n" }),
            },
        )
        .expect("output event");
    fixture
        .runtime
        .store
        .finish(
            &record.id,
            JobStatus::Succeeded,
            Some(0),
            "tool exited with 0",
            None,
        )
        .expect("finish");

    let output = capture_job_event_stream(
        fixture.runtime.store.clone(),
        record.id.clone(),
        0,
        JobEventStreamOptions {
            keepalive_ms: 1_000,
            poll_ms: 1,
            max_keepalives: None,
            max_polls: None,
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.contains("event: job-event\n"));
    assert!(text.contains("\"text\":\"done\\n\""));
    assert!(text.contains("\"kind\":\"terminal-status\""));
    assert!(text.contains("event: terminal-status\n"));
    assert!(text.contains("\"status\":\"succeeded\""));
    assert!(text.contains("\"exitCode\":0"));
    assert!(!text.contains(": keepalive\n\n"));
}

#[tokio::test]
async fn job_stream_delivers_new_events_at_poll_interval_before_keepalive() {
    let fixture = fixture("event-stream-poll");
    let spec = job_spec("review-pr");
    let (record, _) = fixture.runtime.store.create_or_join(&spec).expect("job");
    let store = fixture.runtime.store.clone();
    let writer_store = store.clone();
    let id = record.id.clone();
    let writer_id = id.clone();

    let append = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        writer_store
            .append_event(
                &writer_id,
                JobEventInput {
                    kind: "stdout".to_owned(),
                    data: json!({ "line": "poll-speed" }),
                },
            )
            .expect("append");
        writer_store
            .finish(
                &writer_id,
                JobStatus::Succeeded,
                Some(0),
                "tool exited with 0",
                None,
            )
            .expect("finish");
    });
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(1_000),
        capture_job_event_stream(
            store,
            id,
            0,
            JobEventStreamOptions {
                keepalive_ms: 5_000,
                poll_ms: 5,
                max_keepalives: None,
                max_polls: None,
            },
        ),
    )
    .await
    .expect("stream should poll before keepalive");
    append.await.expect("append task");
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.contains("\"line\":\"poll-speed\""));
    assert!(!text.contains(": keepalive\n\n"));
}

#[tokio::test]
async fn drained_job_stream_keeps_connection_alive_with_keepalive() {
    let fixture = fixture("drained-stream");
    let spec = job_spec("review-pr");
    let (record, _) = fixture.runtime.store.create_or_join(&spec).expect("job");
    let output = capture_job_event_stream(
        fixture.runtime.store.clone(),
        record.id.clone(),
        0,
        JobEventStreamOptions {
            keepalive_ms: 1,
            poll_ms: 1,
            max_keepalives: Some(1),
            max_polls: None,
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains(": keepalive\n\n"));
    assert!(!text.contains("event: error"));
}

#[tokio::test]
async fn job_list_stream_uses_same_recursive_prefix_semantics_as_list_route() {
    let mut fixture = fixture("list-stream");
    let store = fixture.runtime.store.clone();
    let mut parent = job_spec("parent");
    parent.address = JobAddress {
        scope: JobScope::Global,
        slot: Vec::new(),
    };
    let mut child = job_spec("parent-child");
    child.address = JobAddress {
        scope: JobScope::Global,
        slot: vec!["child".to_owned()],
    };
    let mut grandchild = job_spec("parent-grandchild");
    grandchild.address = JobAddress {
        scope: JobScope::Global,
        slot: vec!["child".to_owned(), "deep".to_owned()],
    };
    let mut project = job_spec("project");
    project.address = JobAddress {
        scope: JobScope::Project {
            project_id: "project-1".to_owned(),
        },
        slot: Vec::new(),
    };
    project.scope = project.address.scope.clone();
    let (parent_record, _) = store.create_or_join(&parent).expect("parent");
    let (child_record, _) = store.create_or_join(&child).expect("child");
    let (grandchild_record, _) = store.create_or_join(&grandchild).expect("grandchild");
    let (project_record, _) = store.create_or_join(&project).expect("project");
    let list = route(
        &mut fixture.runtime,
        "GET",
        &format!("{}?scope=global&depth=1", CORE_API_ROUTES.jobs),
        None,
        false,
    );
    let list_text = serde_json::to_string(&list["jobs"]).expect("list json");
    assert!(list_text.contains(&parent_record.id));
    assert!(list_text.contains(&child_record.id));
    assert!(!list_text.contains(&grandchild_record.id));
    assert!(!list_text.contains(&project_record.id));
    let output = capture_job_list_stream(
        store,
        Some(JobAddress {
            scope: JobScope::Global,
            slot: Vec::new(),
        }),
        Some(1),
        JobEventStreamOptions {
            keepalive_ms: 1_000,
            poll_ms: 1,
            max_keepalives: None,
            max_polls: Some(1),
        },
    )
    .await;
    let text = String::from_utf8(output).expect("utf8");
    assert!(text.contains("event: jobs-snapshot"));
    assert!(text.contains(&parent_record.id));
    assert!(text.contains(&child_record.id));
    assert!(!text.contains(&grandchild_record.id));
    assert!(!text.contains(&project_record.id));
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

fn ok_delivery() -> DesktopNotificationDeliveryResult {
    DesktopNotificationDeliveryResult {
        transport: DesktopNotificationTransport::MacHelper,
        helper_path: None,
        ok: true,
        exit_code: Some(0),
        stdout: None,
        stderr: None,
        error: None,
    }
}

fn failed_delivery(error: &str) -> DesktopNotificationDeliveryResult {
    DesktopNotificationDeliveryResult {
        transport: DesktopNotificationTransport::MacHelper,
        helper_path: None,
        ok: false,
        exit_code: Some(1),
        stdout: None,
        stderr: None,
        error: Some(error.to_owned()),
    }
}

fn disabled_delivery(error: &str) -> DesktopNotificationDeliveryResult {
    DesktopNotificationDeliveryResult {
        transport: DesktopNotificationTransport::Disabled,
        helper_path: None,
        ok: false,
        exit_code: None,
        stdout: None,
        stderr: None,
        error: Some(error.to_owned()),
    }
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

async fn capture_job_list_stream(
    store: JobStore,
    address_prefix: Option<JobAddress>,
    depth: Option<usize>,
    options: JobEventStreamOptions,
) -> Vec<u8> {
    let (mut client, mut server) = tokio::io::duplex(16 * 1024);
    let writer = async {
        write_job_list_stream(&store, address_prefix, depth, &mut server, options)
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
