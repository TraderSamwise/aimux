//! The check that names a wedged project service.
//!
//! A service wedged for 4d19h with its process alive, its port held and every
//! `/health` probe failing, and the only thing anyone could see was a 30s
//! timeout. Finding it took a thread sample. Each verdict here is driven
//! through the real report builder with no socket, so the three outcomes the
//! old message could not express are pinned apart -- and so are the two that
//! must NOT read as a wedge.

use aimux::daemon::services_doctor::{
    ServiceProbeFailure, ServiceVerdict, ServicesDoctorRuntime, build_services_doctor_report,
    render_services_doctor_report,
};
use aimux::daemon_state::MetadataApiEndpoint;

struct FakeServices {
    roots: Result<Vec<String>, String>,
    endpoint: Option<Result<Option<MetadataApiEndpoint>, String>>,
    alive: bool,
    probe: Option<Result<(), ServiceProbeFailure>>,
}

impl Default for FakeServices {
    fn default() -> Self {
        Self {
            roots: Ok(Vec::new()),
            endpoint: None,
            alive: false,
            probe: None,
        }
    }
}

impl ServicesDoctorRuntime for FakeServices {
    fn registered_project_roots(&mut self) -> Result<Vec<String>, String> {
        self.roots.clone()
    }

    fn endpoint_for(&mut self, _project_root: &str) -> Result<Option<MetadataApiEndpoint>, String> {
        self.endpoint
            .clone()
            .unwrap_or(Ok(Some(endpoint_at(43_444, 78_486))))
    }

    fn is_pid_alive(&mut self, _pid: i32) -> bool {
        self.alive
    }

    fn probe_patiently(
        &mut self,
        _endpoint: &MetadataApiEndpoint,
    ) -> Result<(), ServiceProbeFailure> {
        self.probe.clone().unwrap_or(Ok(()))
    }
}

fn endpoint_at(port: u16, pid: i32) -> MetadataApiEndpoint {
    MetadataApiEndpoint {
        host: "127.0.0.1".to_owned(),
        port,
        pid,
        updated_at: "now".to_owned(),
    }
}

fn one_project() -> Result<Vec<String>, String> {
    Ok(vec!["/Users/sam/cs/tealstreet-next".to_owned()])
}

fn silent_but_held() -> Option<Result<(), ServiceProbeFailure>> {
    Some(Err(ServiceProbeFailure {
        reason: "the service closed the connection without answering (no bytes read)".to_owned(),
        port_accepted: true,
    }))
}

/// The incident: alive, holding the port, answering nothing.
#[test]
fn a_live_process_holding_a_silent_port_is_reported_as_wedged() {
    let mut runtime = FakeServices {
        roots: one_project(),
        alive: true,
        probe: silent_but_held(),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.wedged, 1);
    assert_eq!(report.totals.answered, 0);
    assert_eq!(
        report.services[0].verdict,
        ServiceVerdict::Wedged { pid: 78_486 }
    );
    let text = render_services_doctor_report(&report);
    assert!(text.contains("WEDGED"), "{text}");
    assert!(
        text.contains("killing pid 78486 is the fix"),
        "the one thing the old message could not say: {text}"
    );
}

/// A port nobody accepted on is not being held, however alive the pid is.
#[test]
fn a_live_process_with_a_refused_port_is_not_wedged() {
    let mut runtime = FakeServices {
        roots: one_project(),
        alive: true,
        probe: Some(Err(ServiceProbeFailure {
            reason: "nothing is listening on that port (connection refused)".to_owned(),
            port_accepted: false,
        })),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.wedged, 0);
    assert_eq!(report.totals.not_listening, 1);
    let text = render_services_doctor_report(&report);
    assert!(
        text.contains("restarting the service is the fix"),
        "a dead listener is restarted, not killed: {text}"
    );
    assert!(!text.contains("WEDGED"), "{text}");
}

/// A silent port whose process is gone is a stale endpoint, not a wedge.
#[test]
fn a_dead_process_is_never_wedged() {
    let mut runtime = FakeServices {
        roots: one_project(),
        alive: false,
        probe: silent_but_held(),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.wedged, 0);
    assert_eq!(report.totals.not_listening, 1);
    let text = render_services_doctor_report(&report);
    assert!(text.contains("no longer running"), "{text}");
}

/// The inverse that matters most: a healthy service must never be named.
#[test]
fn a_service_that_answers_is_reported_as_answered() {
    let mut runtime = FakeServices {
        roots: one_project(),
        alive: true,
        probe: Some(Ok(())),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.answered, 1);
    assert_eq!(report.totals.wedged, 0);
    assert_eq!(report.services[0].verdict, ServiceVerdict::Answered);
    assert!(
        report.services[0].detail.is_empty(),
        "a healthy service has nothing to explain"
    );
    let text = render_services_doctor_report(&report);
    assert!(!text.contains("is the fix"), "nothing to fix here: {text}");
}

/// An unreadable registry is not an empty fleet.
#[test]
fn an_unreadable_registry_is_not_reported_as_no_projects() {
    let mut runtime = FakeServices {
        roots: Err("projects.json is not valid JSON".to_owned()),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.unknown, 1);
    assert_eq!(report.totals.answered, 0);
    let text = render_services_doctor_report(&report);
    assert!(text.contains("registry could not be read"), "{text}");
    assert!(
        !text.contains("no projects are registered"),
        "silence about a broken registry is the lie this avoids: {text}"
    );
}

/// An unreadable endpoint is not a missing one.
#[test]
fn an_unreadable_endpoint_is_not_reported_as_absent() {
    let mut runtime = FakeServices {
        roots: one_project(),
        endpoint: Some(Err("endpoint.json is truncated".to_owned())),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.unknown, 1);
    assert_eq!(report.totals.not_listening, 0);
    assert!(
        render_services_doctor_report(&report).contains("could not be read"),
        "{}",
        render_services_doctor_report(&report)
    );
}

/// A project with no endpoint recorded has no service, which is an answer.
#[test]
fn a_project_with_no_endpoint_is_reported_as_not_listening() {
    let mut runtime = FakeServices {
        roots: one_project(),
        endpoint: Some(Ok(None)),
        ..FakeServices::default()
    };

    let report = build_services_doctor_report(&mut runtime);

    assert_eq!(report.totals.not_listening, 1);
    assert_eq!(report.totals.unknown, 0);
    assert_eq!(
        report.services[0].verdict,
        ServiceVerdict::NotListening { recorded_pid: None }
    );
}

/// The fleet is the point: one wedged service beside healthy ones must still
/// be named, and the counts must add up.
#[test]
fn a_wedged_service_is_named_among_healthy_ones() {
    struct Fleet {
        seen: usize,
    }

    impl ServicesDoctorRuntime for Fleet {
        fn registered_project_roots(&mut self) -> Result<Vec<String>, String> {
            Ok(vec!["/a".to_owned(), "/wedged".to_owned(), "/c".to_owned()])
        }

        fn endpoint_for(
            &mut self,
            _project_root: &str,
        ) -> Result<Option<MetadataApiEndpoint>, String> {
            self.seen += 1;
            Ok(Some(endpoint_at(
                43_440 + self.seen as u16,
                1_000 + self.seen as i32,
            )))
        }

        fn is_pid_alive(&mut self, _pid: i32) -> bool {
            true
        }

        fn probe_patiently(
            &mut self,
            endpoint: &MetadataApiEndpoint,
        ) -> Result<(), ServiceProbeFailure> {
            if endpoint.pid == 1_002 {
                return Err(ServiceProbeFailure {
                    reason: "the connection was accepted and nothing was answered within 5000ms"
                        .to_owned(),
                    port_accepted: true,
                });
            }
            Ok(())
        }
    }

    let report = build_services_doctor_report(&mut Fleet { seen: 0 });

    assert_eq!(report.totals.answered, 2);
    assert_eq!(report.totals.wedged, 1);
    assert_eq!(report.services.len(), 3);
    let text = render_services_doctor_report(&report);
    assert!(text.contains("/wedged"), "{text}");
    assert!(
        text.contains("answered: 2 wedged: 1"),
        "the summary line is what someone reads first: {text}"
    );
}
