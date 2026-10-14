//! Which project services are answering, and which are holding a port without
//! answering.
//!
//! A service wedged for 4d19h: the process alive, the port held, every
//! `/health` probe failing, and `aimux` in that repo failing forever with a
//! 30-second timeout. Finding it took a thread sample, because no diagnostic
//! enumerated project services at all -- `stability_doctor` reads
//! `runtime-health.jsonl` off disk, which is the signal that lied, and
//! `process_inventory` only inventories daemons.
//!
//! The three outcomes the old failure message could not express are kept
//! apart here: answered, nothing listening, and a live pid holding the port
//! that will not answer. The third is the wedge.

use crate::daemon::runtime::PROJECT_SERVICE_PATIENT_PROBE_TIMEOUT_MS;
use crate::daemon_state::MetadataApiEndpoint;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServicesDoctorReport {
    pub services: Vec<ServiceHealth>,
    pub totals: ServicesDoctorTotals,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServicesDoctorTotals {
    pub answered: usize,
    /// The wedge: a live process holding the port and not answering.
    pub wedged: usize,
    pub not_listening: usize,
    pub unknown: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub project_root: String,
    pub endpoint: Option<MetadataApiEndpoint>,
    pub verdict: ServiceVerdict,
    /// What the probe said, kept verbatim. An empty reason is reserved for a
    /// service that answered.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum ServiceVerdict {
    Answered,
    /// A live process holds the port and will not answer a patient probe.
    /// Killing that pid is the fix.
    Wedged {
        pid: i32,
    },
    /// Nothing is listening, whether or not the recorded pid is still alive.
    NotListening {
        recorded_pid: Option<i32>,
    },
    /// The registry or the endpoint file could not be read. Not an absence:
    /// nobody asked the service anything.
    Unknown,
}

/// Everything the check needs from the machine, so each verdict is reachable
/// in a test without a socket, a daemon or a project.
pub trait ServicesDoctorRuntime {
    fn registered_project_roots(&mut self) -> Result<Vec<String>, String>;
    /// `Ok(None)` means the service has no endpoint recorded; `Err` means the
    /// record could not be read, which is a different answer.
    fn endpoint_for(&mut self, project_root: &str) -> Result<Option<MetadataApiEndpoint>, String>;
    /// Whether this pid is still running AND still looks like THIS project's
    /// aimux service.
    ///
    /// Liveness alone is not enough to advise a kill. A recorded endpoint
    /// outlives its process, pids are recycled, and the daemon's own
    /// escalation already refuses to signal anything it cannot identify --
    /// `belongs_to_aimux_home` plus the service's own argv. Naming a kill
    /// against an unidentified pid would point someone at an unrelated
    /// program.
    fn pid_is_this_projects_service(&mut self, pid: i32, project_root: &str) -> bool;
    /// `Ok(())` when `/health` answered for this endpoint's pid within the
    /// patient budget, otherwise why not and whether anything accepted the
    /// connection. Patient on purpose: `/health` builds scheduler
    /// diagnostics, so its latency tracks contention, and a short probe
    /// cannot tell a wedged service from one starved of CPU.
    fn probe_patiently(
        &mut self,
        endpoint: &MetadataApiEndpoint,
    ) -> Result<(), ServiceProbeFailure>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceProbeFailure {
    pub reason: String,
    pub port_accepted: bool,
}

pub fn build_services_doctor_report(
    runtime: &mut impl ServicesDoctorRuntime,
) -> ServicesDoctorReport {
    let mut services = Vec::new();
    match runtime.registered_project_roots() {
        Ok(project_roots) => {
            for project_root in project_roots {
                services.push(inspect_service(runtime, project_root));
            }
        }
        // A registry that cannot be read is not an empty fleet.
        Err(error) => services.push(ServiceHealth {
            project_root: String::new(),
            endpoint: None,
            verdict: ServiceVerdict::Unknown,
            detail: format!("the project registry could not be read: {error}"),
        }),
    }
    let mut totals = ServicesDoctorTotals::default();
    for service in &services {
        match service.verdict {
            ServiceVerdict::Answered => totals.answered += 1,
            ServiceVerdict::Wedged { .. } => totals.wedged += 1,
            ServiceVerdict::NotListening { .. } => totals.not_listening += 1,
            ServiceVerdict::Unknown => totals.unknown += 1,
        }
    }
    ServicesDoctorReport { services, totals }
}

fn inspect_service(
    runtime: &mut impl ServicesDoctorRuntime,
    project_root: String,
) -> ServiceHealth {
    let endpoint = match runtime.endpoint_for(&project_root) {
        Ok(Some(endpoint)) => endpoint,
        Ok(None) => {
            return ServiceHealth {
                project_root,
                endpoint: None,
                verdict: ServiceVerdict::NotListening { recorded_pid: None },
                detail: "no service endpoint is recorded for this project".to_owned(),
            };
        }
        Err(error) => {
            return ServiceHealth {
                project_root,
                endpoint: None,
                verdict: ServiceVerdict::Unknown,
                detail: format!("the service endpoint could not be read: {error}"),
            };
        }
    };
    let failure = match runtime.probe_patiently(&endpoint) {
        Ok(()) => {
            return ServiceHealth {
                project_root,
                endpoint: Some(endpoint),
                verdict: ServiceVerdict::Answered,
                detail: String::new(),
            };
        }
        Err(failure) => failure,
    };
    let pid = endpoint.pid;
    let identified = runtime.pid_is_this_projects_service(pid, &project_root);
    // All three have to hold before anyone is told to kill something: the
    // process must still be there, it must still be THIS project's service,
    // and something must have accepted the connection.
    let verdict = if identified && failure.port_accepted {
        ServiceVerdict::Wedged { pid }
    } else {
        ServiceVerdict::NotListening {
            recorded_pid: Some(pid),
        }
    };
    let detail = match &verdict {
        ServiceVerdict::Wedged { pid } => format!(
            "pid {pid} is this project's service, is holding that port, and did not answer a {PROJECT_SERVICE_PATIENT_PROBE_TIMEOUT_MS}ms probe: {}; killing pid {pid} is the fix",
            failure.reason
        ),
        _ if identified => format!(
            "pid {pid} is this project's service but nothing accepted a connection on that port: {}; its listener is gone, so restarting the service is the fix",
            failure.reason
        ),
        _ => format!(
            "pid {pid} is not running as this project's service any more: {}; the recorded endpoint is stale, so restarting the service is the fix",
            failure.reason
        ),
    };
    ServiceHealth {
        project_root,
        endpoint: Some(endpoint),
        verdict,
        detail,
    }
}

pub fn render_services_doctor_report(report: &ServicesDoctorReport) -> String {
    let mut lines = vec![
        "Project Services".to_owned(),
        format!(
            "  answered: {} wedged: {} not listening: {} unknown: {}",
            report.totals.answered,
            report.totals.wedged,
            report.totals.not_listening,
            report.totals.unknown
        ),
    ];
    if report.services.is_empty() {
        lines.push("  no projects are registered".to_owned());
    }
    for service in &report.services {
        let where_at = service
            .endpoint
            .as_ref()
            .map(|endpoint| format!(" http://{}:{}", endpoint.host, endpoint.port))
            .unwrap_or_default();
        lines.push(format!(
            "  {label}{where_at} {root}",
            label = service.verdict.label(),
            root = service.project_root
        ));
        if !service.detail.is_empty() {
            lines.push(format!("    {}", service.detail));
        }
    }
    lines.join("\n")
}

impl ServiceVerdict {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Wedged { .. } => "WEDGED",
            Self::NotListening { .. } => "not listening",
            Self::Unknown => "unknown",
        }
    }
}
