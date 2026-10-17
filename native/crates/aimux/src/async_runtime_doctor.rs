//! The async-runtime doctor report, assembled with every backlog this build
//! can see -- including the hosted half's, which `aimux-core` cannot reach.

use aimux_core::async_runtime::{AsyncRuntimeDoctorReport, doctor_tasks_report_with};

pub fn doctor_tasks_report() -> AsyncRuntimeDoctorReport {
    doctor_tasks_report_with(crate::remote_control_edge::hosted_backlog_snapshots())
}
