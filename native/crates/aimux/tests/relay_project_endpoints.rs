//! A share must follow its project service onto a new port.
//!
//! The share stored the endpoint it was created with, and a project service
//! binds a fresh port on every start. So the first restart after a share was
//! made left it proxying to a port nothing was listening on: the daemon
//! connected, the agent working, every request from the share refused, and the
//! only repair was issuing another invite, which emails somebody.

use aimux::async_runtime::block_on_named;
use aimux::daemon::scheduler::{DaemonPeriodicTask, DaemonSchedulerContext};
use aimux::daemon_projects::ProjectEndpoint;
use aimux::daemon_state::AimuxDaemonInfo;
use aimux::paths::PathResolver;
use aimux::remote::relay_endpoints::{
    RELAY_PROJECT_ENDPOINTS_TASK_NAME, RelayProjectEndpointsTask, read_project_endpoints,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Fixture {
    root: PathBuf,
    resolver: PathResolver,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-relay-endpoints-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self { root, resolver }
    }

    fn register_project(&self, id: &str, repo_root: &str) {
        let path = self.resolver.projects_registry_path();
        fs::create_dir_all(path.parent().expect("registry parent")).expect("registry dir");
        let mut registry = if path.exists() {
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&path).expect("read"))
                .expect("parse")
        } else {
            json!({ "version": 1, "projects": [] })
        };
        registry["projects"]
            .as_array_mut()
            .expect("projects array")
            .push(json!({
                "id": id,
                "name": id,
                "repoRoot": repo_root,
                "lastSeen": "2099-01-01T00:00:00.000Z",
            }));
        fs::write(&path, serde_json::to_string(&registry).expect("serialize")).expect("write");
    }

    /// What a project service writes when it binds.
    fn bind_service(&self, id: &str, port: u16) {
        let dir = self.resolver.global_aimux_dir().join("projects").join(id);
        fs::create_dir_all(&dir).expect("project state dir");
        fs::write(
            dir.join("metadata-api.json"),
            json!({
                "host": "127.0.0.1",
                "port": port,
                "pid": 4242,
                "updatedAt": "2099-01-01T00:00:00.000Z",
            })
            .to_string(),
        )
        .expect("write endpoint");
    }

    fn context(&self) -> Arc<DaemonSchedulerContext> {
        Arc::new(DaemonSchedulerContext::new(
            self.resolver.clone(),
            AimuxDaemonInfo {
                pid: 1,
                port: 43190,
                started_at: "2099-01-01T00:00:00.000Z".to_owned(),
                updated_at: "2099-01-01T00:00:00.000Z".to_owned(),
            },
        ))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

type Reports = Arc<Mutex<Vec<Vec<ProjectEndpoint>>>>;
/// What the relay answers: `None` for taken, `Some(error)` for refused.
type Answer = Arc<Mutex<Option<String>>>;

/// Records what the task handed the relay, and whether the relay took it.
fn recording_reporter(context: &DaemonSchedulerContext, answer: Answer) -> Reports {
    let reports: Reports = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&reports);
    context
        .set_relay_project_endpoints_push(Arc::new(move |projects| {
            recorded
                .lock()
                .expect("reports lock")
                .push(projects.to_vec());
            match answer.lock().expect("answer lock").clone() {
                None => Ok(()),
                Some(error) => Err(error),
            }
        }))
        .expect("register reporter");
    reports
}

fn taken() -> Answer {
    Arc::new(Mutex::new(None))
}

fn run(task: &mut RelayProjectEndpointsTask, context: &DaemonSchedulerContext) {
    // aimux-async-seam: test - sync test drives the periodic task body
    block_on_named("test:relay-endpoints", async {
        task.run(context).await.expect("task run");
    });
}

fn endpoint(root: &str, port: u16) -> ProjectEndpoint {
    ProjectEndpoint {
        project_root: root.to_owned(),
        host: "127.0.0.1".to_owned(),
        port,
    }
}

#[test]
fn task_name_matches_the_scheduler_contract() {
    assert_eq!(
        RelayProjectEndpointsTask::new().name(),
        RELAY_PROJECT_ENDPOINTS_TASK_NAME
    );
}

#[test]
fn reports_a_service_that_rebound_and_stays_quiet_until_it_moves_again() {
    let fixture = Fixture::new("rebound");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 44659);
    let context = fixture.context();
    let reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    // First run: the relay has never been told where this service is.
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").clone(),
        vec![vec![endpoint("/cs/tealstreet-next", 44659)]]
    );

    // Nothing moved, so nothing is reported. This runs on a timer, and the
    // relay writes durable storage and pushes every guest for each report.
    run(&mut task, &context);
    assert_eq!(reports.lock().expect("reports").len(), 1);

    // The service restarts onto a new port -- the case that broke the share.
    fixture.bind_service("next-1", 49226);
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").clone(),
        vec![
            vec![endpoint("/cs/tealstreet-next", 44659)],
            vec![endpoint("/cs/tealstreet-next", 49226)],
        ]
    );
}

#[test]
fn a_report_the_relay_refused_is_sent_again() {
    // Recording a report that never left would leave the share on the dead
    // port until the next time the port happened to change.
    let fixture = Fixture::new("refused");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let answer: Answer = Arc::new(Mutex::new(Some("relay_disconnected".to_owned())));
    let reports = recording_reporter(&context, Arc::clone(&answer));
    let mut task = RelayProjectEndpointsTask::new();

    run(&mut task, &context);
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").len(),
        2,
        "a refused report is retried on the next tick"
    );

    *answer.lock().expect("answer") = None;
    run(&mut task, &context);
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").len(),
        3,
        "and is only recorded once the relay took it"
    );
}

#[test]
fn does_not_read_the_registry_before_a_relay_has_been_dialled() {
    // No reporter means no relay in this build, or none dialled yet. Reading
    // the registry to find that out would be a disk read per tick on a machine
    // that has never logged in -- so a registry this task cannot read must
    // not reach it, and must not fail its tick.
    let fixture = Fixture::new("no-relay");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    fs::write(
        fixture.resolver.projects_registry_path(),
        "{\"projects\":5}",
    )
    .expect("bad registry");
    let context = fixture.context();
    let mut task = RelayProjectEndpointsTask::new();

    run(&mut task, &context);

    assert!(context.relay_project_endpoints_push().is_none());
}

#[test]
fn a_registry_that_cannot_be_read_fails_the_tick() {
    // The other direction. A read that failed is not an empty fleet, and
    // reporting nothing because of it would leave every share where it was
    // with nothing saying why.
    let fixture = Fixture::new("bad-registry");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fs::write(
        fixture.resolver.projects_registry_path(),
        "{\"projects\":5}",
    )
    .expect("bad registry");
    let context = fixture.context();
    let _reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    // aimux-async-seam: test - sync test drives the periodic task body
    let result = block_on_named("test:relay-endpoints", async { task.run(&context).await });

    assert!(result.is_err(), "{result:?}");
}

#[test]
fn a_relay_that_failed_for_another_reason_fails_the_tick() {
    // Logged out or between sockets is an ordinary state. A full outbox or a
    // poisoned lock is not, and a task that answered Ok to both would leave a
    // share on a dead port with a green scheduler.
    let fixture = Fixture::new("outbox");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let _reports = recording_reporter(
        &context,
        Arc::new(Mutex::new(Some("relay_outbox_full".to_owned()))),
    );
    let mut task = RelayProjectEndpointsTask::new();

    // aimux-async-seam: test - sync test drives the periodic task body
    let result = block_on_named("test:relay-endpoints", async { task.run(&context).await });

    assert_eq!(result, Err("relay_outbox_full".to_owned()));
}

#[test]
fn only_the_project_whose_service_moved_is_reported() {
    let fixture = Fixture::new("one-of-two");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.register_project("aimux-1", "/cs/aimux");
    fixture.bind_service("next-1", 44659);
    fixture.bind_service("aimux-1", 43444);
    let context = fixture.context();
    let reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    run(&mut task, &context);
    fixture.bind_service("next-1", 49226);
    run(&mut task, &context);

    let reports = reports.lock().expect("reports").clone();
    assert_eq!(reports.len(), 2);
    assert_eq!(reports[1], vec![endpoint("/cs/tealstreet-next", 49226)]);
}

#[test]
fn a_project_with_no_service_is_not_an_endpoint() {
    let fixture = Fixture::new("no-service");
    fixture.register_project("next-1", "/cs/tealstreet-next");

    let (endpoints, read_errors) =
        read_project_endpoints(&fixture.resolver).expect("read endpoints");

    assert!(endpoints.is_empty());
    assert!(read_errors.is_empty());
}

#[test]
fn an_unreadable_endpoint_is_reported_rather_than_read_as_absent() {
    // "Cannot tell" is not "no service". Dropping it would leave a share
    // pinned to a port with nothing saying why.
    let fixture = Fixture::new("unreadable");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    let dir = fixture
        .resolver
        .global_aimux_dir()
        .join("projects")
        .join("next-1");
    fs::create_dir_all(&dir).expect("project state dir");
    fs::write(dir.join("metadata-api.json"), "{ not json").expect("write");

    let (endpoints, read_errors) =
        read_project_endpoints(&fixture.resolver).expect("read endpoints");

    assert!(endpoints.is_empty());
    assert_eq!(read_errors.len(), 1, "{read_errors:?}");
    assert!(
        read_errors[0].contains("metadata-api.json"),
        "{read_errors:?}"
    );
}
