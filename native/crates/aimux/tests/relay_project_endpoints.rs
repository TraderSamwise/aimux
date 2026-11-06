//! A share must follow its project service onto a new port.
//!
//! The share stored the endpoint it was created with, and a project service
//! binds a fresh port on every start. So the first restart after a share was
//! made left it proxying to a port nothing was listening on: the daemon
//! connected, the agent working, every request from the share refused, and the
//! only repair was issuing another invite, which emails somebody.

use aimux::async_runtime::block_on_named;
use aimux::daemon::scheduler::RelayEndpointReporter;
use aimux::daemon::scheduler::{DaemonPeriodicTask, DaemonSchedulerContext};
use aimux::daemon_projects::ProjectEndpoint;
use aimux::daemon_state::AimuxDaemonInfo;
use aimux::paths::PathResolver;
use aimux::remote::relay_endpoints::{
    RELAY_PROJECT_ENDPOINTS_INTERVAL_MS, RELAY_PROJECT_ENDPOINTS_TASK_NAME, REMINDER_TICKS,
    RelayProjectEndpointsTask, read_project_endpoints,
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

    /// The registry after every project has been removed from it.
    fn clear_registry(&self) {
        fs::write(
            self.resolver.projects_registry_path(),
            serde_json::to_string(&json!({ "version": 1, "projects": [] })).expect("serialize"),
        )
        .expect("write registry");
    }

    /// What a project service writes when it binds.
    fn bind_service(&self, id: &str, port: u16) {
        self.bind_service_at(id, port, "2099-01-01T00:00:00.000Z");
    }

    fn bind_service_at(&self, id: &str, port: u16, bound_at: &str) {
        let dir = self.resolver.global_aimux_dir().join("projects").join(id);
        fs::create_dir_all(&dir).expect("project state dir");
        fs::write(
            dir.join("metadata-api.json"),
            json!({
                "host": "127.0.0.1",
                "port": port,
                "pid": 4242,
                "updatedAt": bound_at,
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

/// A relay that records what it was handed and answers as told.
struct FakeRelay {
    reports: Reports,
    answer: Answer,
    connected: Arc<Mutex<bool>>,
}

impl RelayEndpointReporter for FakeRelay {
    fn ready(&self) -> bool {
        *self.connected.lock().expect("connected lock")
    }

    fn report(&self, projects: &[ProjectEndpoint]) -> Result<(), String> {
        self.reports
            .lock()
            .expect("reports lock")
            .push(projects.to_vec());
        match self.answer.lock().expect("answer lock").clone() {
            None => Ok(()),
            Some(error) => Err(error),
        }
    }
}

/// Records what the task handed the relay, and whether the relay took it.
fn recording_reporter(context: &DaemonSchedulerContext, answer: Answer) -> Reports {
    connected_reporter(context, answer, Arc::new(Mutex::new(true)))
}

fn connected_reporter(
    context: &DaemonSchedulerContext,
    answer: Answer,
    connected: Arc<Mutex<bool>>,
) -> Reports {
    let reports: Reports = Arc::new(Mutex::new(Vec::new()));
    context
        .set_relay_project_endpoints_push(Arc::new(FakeRelay {
            reports: Arc::clone(&reports),
            answer,
            connected,
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
    // (Up to the reminder tick, which the next test covers.)
    for _ in 0..5 {
        run(&mut task, &context);
    }
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

/// The task is useless without the one call that gives it a relay, and
/// deleting that call left every test in this file passing: they all register
/// a reporter themselves. Proving it from the daemon's own startup would mean
/// starting a daemon, so this reads the source instead and says so -- it
/// catches the deletion and the reordering, and nothing more.
#[test]
fn daemon_startup_registers_the_reporter_before_the_scheduler_runs() {
    let source = include_str!("../src/daemon/runtime.rs");
    let register = source
        .find("register_relay_project_endpoints_push(&scheduler_context)")
        .expect("daemon startup must register the relay endpoint reporter");
    let spawn = source
        .find("spawn_daemon_scheduler(")
        .expect("daemon startup must spawn the scheduler");
    assert!(
        register < spawn,
        "the reporter has to be registered before the scheduler can run the task"
    );
}

#[test]
fn does_not_read_the_registry_while_no_relay_is_connected() {
    // The reporter is registered at daemon startup whether or not anyone has
    // ever logged in, so "is a reporter registered" answered the wrong
    // question: a logged-out machine read the registry every tick for ever --
    // and `load_registry` saves a normalized copy, so that read can rewrite
    // the registry too.
    //
    // A registry this task cannot read proves it never looked: reading it
    // would fail the tick.
    let fixture = Fixture::new("no-relay");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let connected = Arc::new(Mutex::new(false));
    let reports = connected_reporter(&context, taken(), Arc::clone(&connected));
    fs::write(
        fixture.resolver.projects_registry_path(),
        "{\"projects\":5}",
    )
    .expect("bad registry");
    let mut task = RelayProjectEndpointsTask::new();

    for _ in 0..REMINDER_TICKS + 2 {
        run(&mut task, &context);
    }
    assert!(reports.lock().expect("reports").is_empty());

    // And once a relay is connected it does look -- which is what makes the
    // assertion above about the read, and not about a task that never runs.
    *connected.lock().expect("connected") = true;
    // aimux-async-seam: test - sync test drives the periodic task body
    let result = block_on_named("test:relay-endpoints", async { task.run(&context).await });
    assert!(result.is_err(), "{result:?}");
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
fn a_poisoned_supervisor_fails_the_tick() {
    // `relay_unavailable` is a poisoned supervisor mutex. It sat in the list
    // of ordinary absences beside `relay_off`, so a broken daemon answered Ok
    // for ever with a green scheduler -- the opposite of what the code said it
    // did.
    let fixture = Fixture::new("unavailable");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let _reports = recording_reporter(
        &context,
        Arc::new(Mutex::new(Some("relay_unavailable".to_owned()))),
    );
    let mut task = RelayProjectEndpointsTask::new();

    // aimux-async-seam: test - sync test drives the periodic task body
    let result = block_on_named("test:relay-endpoints", async { task.run(&context).await });

    assert_eq!(result, Err("relay_unavailable".to_owned()));
}

#[test]
fn an_endpoint_that_exists_but_cannot_be_read_is_an_error() {
    // Only NotFound is an absence. A path that is there but unreadable -- a
    // directory where the file should be, a mode nobody can open -- used to
    // read as "this project never had a service", against what the reader
    // says it does.
    let fixture = Fixture::new("unreadable-path");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    let dir = fixture
        .resolver
        .global_aimux_dir()
        .join("projects")
        .join("next-1")
        .join("metadata-api.json");
    fs::create_dir_all(&dir).expect("directory where the endpoint file belongs");

    let (endpoints, read_errors) =
        read_project_endpoints(&fixture.resolver).expect("read endpoints");

    assert!(endpoints.is_empty());
    assert_eq!(read_errors.len(), 1, "{read_errors:?}");
    assert!(
        read_errors[0].contains("metadata-api.json"),
        "{read_errors:?}"
    );
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
fn the_duplicate_whose_service_bound_most_recently_wins() {
    // Taking the last by project id was stable but arbitrary, and arbitrary
    // here means the share can be pinned to the duplicate whose service is
    // long gone -- the stale port this whole change exists to move off.
    let fixture = Fixture::new("newest-bind");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.register_project("next-2", "/cs/tealstreet-next");
    // `next-2` sorts last but bound first.
    fixture.bind_service_at("next-2", 44659, "2099-01-01T00:00:00.000Z");
    fixture.bind_service_at("next-1", 49226, "2099-06-01T00:00:00.000Z");

    let (endpoints, read_errors) =
        read_project_endpoints(&fixture.resolver).expect("read endpoints");

    assert!(read_errors.is_empty());
    assert_eq!(endpoints, vec![endpoint("/cs/tealstreet-next", 49226)]);
}

#[test]
fn two_registry_entries_for_one_root_do_not_report_for_ever() {
    // Registry normalization dedupes on the project id and never recomputes
    // the id from the root, so two entries can share a `repo_root` -- each
    // with its own endpoint file. Diffing a list against a map keyed by root
    // then reported one of them on every single tick, alternating the share's
    // port and pushing every guest each time.
    let fixture = Fixture::new("same-root");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.register_project("next-2", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 44659);
    fixture.bind_service("next-2", 49226);
    let context = fixture.context();
    let reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    for _ in 0..REMINDER_TICKS - 1 {
        run(&mut task, &context);
    }

    let reports = reports.lock().expect("reports").clone();
    assert_eq!(
        reports.len(),
        1,
        "one report, not one per tick: {reports:?}"
    );
    assert_eq!(
        reports[0].len(),
        1,
        "one endpoint for the root: {reports:?}"
    );
}

#[test]
fn a_project_removed_from_the_registry_is_forgotten() {
    // `last_reported` is the memory of what the relay accepted. Keeping a row
    // for a project that no longer exists is a leak for the daemon's life --
    // and worse, if that project comes back on the port it used to have, the
    // stale memory suppresses the very report that tells the relay so.
    let fixture = Fixture::new("forgotten");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    run(&mut task, &context);
    assert_eq!(reports.lock().expect("reports").len(), 1);

    // The project leaves the registry, and later comes back on the same port.
    fixture.clear_registry();
    run(&mut task, &context);
    fixture.register_project("next-1", "/cs/tealstreet-next");
    run(&mut task, &context);

    let reports = reports.lock().expect("reports").clone();
    assert_eq!(
        reports.len(),
        2,
        "the returning project is reported again: {reports:?}"
    );
    assert_eq!(reports[1], vec![endpoint("/cs/tealstreet-next", 49226)]);
}

#[test]
fn an_equal_timestamp_keeps_the_first_entry_in_registry_order() {
    // Documented rather than left to chance: two duplicates that bound in the
    // same millisecond have no newest, and the answer has to be the same on
    // every read or the share's port would alternate.
    let fixture = Fixture::new("equal-bind");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.register_project("next-2", "/cs/tealstreet-next");
    fixture.bind_service_at("next-1", 44659, "2099-06-01T00:00:00.000Z");
    fixture.bind_service_at("next-2", 49226, "2099-06-01T00:00:00.000Z");

    for _ in 0..3 {
        let (endpoints, _) = read_project_endpoints(&fixture.resolver).expect("read endpoints");
        assert_eq!(endpoints, vec![endpoint("/cs/tealstreet-next", 44659)]);
    }
}

#[test]
fn a_logged_out_relay_is_an_ordinary_state_and_not_a_failed_tick() {
    // `relay_off` is what the reporter answers when the relay supervisor is
    // gone. Treating it as a failure would name a task failure every thirty
    // seconds on every machine that is simply not logged in.
    let fixture = Fixture::new("relay-off");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let _reports = recording_reporter(&context, Arc::new(Mutex::new(Some("relay_off".to_owned()))));
    let mut task = RelayProjectEndpointsTask::new();

    // aimux-async-seam: test - sync test drives the periodic task body
    let result = block_on_named("test:relay-endpoints", async { task.run(&context).await });

    assert_eq!(result, Ok(()));
}

#[test]
fn the_task_declares_the_cadence_the_fix_depends_on() {
    // A daemon that has just started is the case most likely to be holding a
    // stale endpoint, because the services came up with it -- so running
    // immediately is the only thing that heals a divergence at startup, and a
    // cadence quietly changed to hours would widen the window a share spends
    // on a dead port without failing anything.
    let task = RelayProjectEndpointsTask::new();

    assert!(task.run_immediately(), "a fresh daemon must report at once");
    assert_eq!(task.interval_ms(), RELAY_PROJECT_ENDPOINTS_INTERVAL_MS);
    assert_eq!(RELAY_PROJECT_ENDPOINTS_INTERVAL_MS, 30 * 1_000);
    assert!(
        task.timeout() >= std::time::Duration::from_secs(5),
        "the body reads a file per project"
    );
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

#[test]
fn the_whole_set_is_reported_again_on_the_reminder_tick() {
    // `queue()` answering Ok means the frame reached the daemon's outbox, not
    // the relay. A socket that closes before the drain loses it, and it is
    // recorded as reported -- so without a reminder nothing would correct the
    // share until its port happened to change again.
    let fixture = Fixture::new("reminder");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let reports = recording_reporter(&context, taken());
    let mut task = RelayProjectEndpointsTask::new();

    for _ in 0..REMINDER_TICKS {
        run(&mut task, &context);
    }

    let reports = reports.lock().expect("reports").clone();
    assert_eq!(
        reports.len(),
        2,
        "the first tick and the reminder, nothing in between: {reports:?}"
    );
    assert_eq!(reports[1], vec![endpoint("/cs/tealstreet-next", 49226)]);
}

#[test]
fn a_reminder_that_fell_while_logged_out_is_not_spent() {
    // A tick with no relay to report to used to answer "taken, nothing moved",
    // which reset the reminder counter -- so the reminder was consumed without
    // a frame ever leaving, and the next one was another five minutes away.
    // That is the window in which a share sits on a dead port.
    let fixture = Fixture::new("reminder-logged-out");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let connected = Arc::new(Mutex::new(true));
    let reports = connected_reporter(&context, taken(), Arc::clone(&connected));
    let mut task = RelayProjectEndpointsTask::new();

    // Reported once, then the machine goes offline for a whole window.
    run(&mut task, &context);
    assert_eq!(reports.lock().expect("reports").len(), 1);
    *connected.lock().expect("connected") = false;
    for _ in 0..REMINDER_TICKS * 2 {
        run(&mut task, &context);
    }
    assert_eq!(
        reports.lock().expect("reports").len(),
        1,
        "nothing can be reported with no relay"
    );

    // Back online: the reminder is still owed, so it goes out now rather than
    // five more minutes from now.
    *connected.lock().expect("connected") = true;
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").len(),
        2,
        "the owed reminder goes out on the first tick with a relay"
    );
}

#[test]
fn a_refused_reminder_is_tried_again_on_the_next_tick() {
    // Not in another five minutes. The reminder exists because a frame can be
    // lost, and a lost reminder is the same problem.
    let fixture = Fixture::new("reminder-refused");
    fixture.register_project("next-1", "/cs/tealstreet-next");
    fixture.bind_service("next-1", 49226);
    let context = fixture.context();
    let answer: Answer = Arc::new(Mutex::new(None));
    let reports = recording_reporter(&context, Arc::clone(&answer));
    let mut task = RelayProjectEndpointsTask::new();

    // First tick reports and is taken; then the relay goes away.
    run(&mut task, &context);
    *answer.lock().expect("answer") = Some("relay_disconnected".to_owned());
    for _ in 1..REMINDER_TICKS {
        run(&mut task, &context);
    }
    assert_eq!(
        reports.lock().expect("reports").len(),
        2,
        "the reminder was attempted and refused"
    );

    *answer.lock().expect("answer") = None;
    run(&mut task, &context);
    assert_eq!(
        reports.lock().expect("reports").len(),
        3,
        "and is retried on the very next tick, not five minutes later"
    );
}
