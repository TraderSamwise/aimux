use crate::daemon::http::DaemonResponseBody;
use crate::daemon::text::params::ProjectServiceJsonResult;
use serde::Serialize;
use serde_json::Value;

const INVALID_CLEANUP_RESPONSE: &str =
    "project service returned invalid worktree cache cleanup response";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskDoctorProjectReport {
    project_root: String,
    inactive_reclaimable_bytes: u64,
    inactive_target_count: usize,
    protected_active_bytes: u64,
    protected_active_target_count: usize,
    protected_active_measured: bool,
    skipped_active_worktrees: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskDoctorTotals {
    inactive_reclaimable_bytes: u64,
    inactive_target_count: usize,
    protected_active_bytes: u64,
    protected_active_target_count: usize,
    protected_active_measured_projects: usize,
    protected_active_unmeasured_projects: usize,
    skipped_active_worktrees: usize,
    failures: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskDoctorReport {
    generated_at: String,
    projects: Vec<DiskDoctorProjectReport>,
    skipped_stale_project_roots: Vec<String>,
    totals: DiskDoctorTotals,
}

#[derive(Debug, Clone, Copy)]
struct CleanupPlanSummary {
    reclaimable_bytes: u64,
    target_count: usize,
    skipped_active_worktrees: usize,
}

pub fn build_disk_doctor_report(
    project_roots: Vec<String>,
    include_active_measurement: bool,
    skipped_stale_project_roots: Vec<String>,
    generated_at: String,
    mut request_cleanup: impl FnMut(&str, bool) -> ProjectServiceJsonResult,
) -> Result<(Value, String), String> {
    let projects = project_roots
        .into_iter()
        .map(|project_root| {
            project_report(
                project_root,
                include_active_measurement,
                &mut request_cleanup,
            )
        })
        .collect::<Vec<_>>();
    let totals = projects.iter().fold(
        DiskDoctorTotals {
            inactive_reclaimable_bytes: 0,
            inactive_target_count: 0,
            protected_active_bytes: 0,
            protected_active_target_count: 0,
            protected_active_measured_projects: 0,
            protected_active_unmeasured_projects: 0,
            skipped_active_worktrees: 0,
            failures: 0,
        },
        |mut totals, project| {
            totals.inactive_reclaimable_bytes = totals
                .inactive_reclaimable_bytes
                .saturating_add(project.inactive_reclaimable_bytes);
            totals.inactive_target_count += project.inactive_target_count;
            totals.protected_active_bytes = totals
                .protected_active_bytes
                .saturating_add(project.protected_active_bytes);
            totals.protected_active_target_count += project.protected_active_target_count;
            totals.protected_active_measured_projects +=
                usize::from(project.protected_active_measured);
            totals.protected_active_unmeasured_projects += usize::from(
                !project.protected_active_measured
                    && project.error.is_none()
                    && project.skipped_active_worktrees > 0,
            );
            totals.skipped_active_worktrees += project.skipped_active_worktrees;
            totals.failures += usize::from(project.error.is_some());
            totals
        },
    );
    let report = DiskDoctorReport {
        generated_at,
        projects,
        skipped_stale_project_roots,
        totals,
    };
    let text = render_disk_doctor_report(&report);
    let json = serde_json::to_value(report).map_err(|error| error.to_string())?;
    Ok((json, text))
}

fn project_report(
    project_root: String,
    include_active_measurement: bool,
    request_cleanup: &mut impl FnMut(&str, bool) -> ProjectServiceJsonResult,
) -> DiskDoctorProjectReport {
    let inactive = match cleanup_summary(request_cleanup(&project_root, false)) {
        Ok(inactive) => inactive,
        Err(error) => return failed_project(project_root, include_active_measurement, error),
    };
    if !include_active_measurement {
        return DiskDoctorProjectReport {
            project_root,
            inactive_reclaimable_bytes: inactive.reclaimable_bytes,
            inactive_target_count: inactive.target_count,
            protected_active_bytes: 0,
            protected_active_target_count: 0,
            protected_active_measured: false,
            skipped_active_worktrees: inactive.skipped_active_worktrees,
            error: None,
        };
    }
    let all = match cleanup_summary(request_cleanup(&project_root, true)) {
        Ok(all) => all,
        Err(error) => return failed_project(project_root, true, error),
    };
    DiskDoctorProjectReport {
        project_root,
        inactive_reclaimable_bytes: inactive.reclaimable_bytes,
        inactive_target_count: inactive.target_count,
        protected_active_bytes: all
            .reclaimable_bytes
            .saturating_sub(inactive.reclaimable_bytes),
        protected_active_target_count: all.target_count.saturating_sub(inactive.target_count),
        protected_active_measured: true,
        skipped_active_worktrees: inactive.skipped_active_worktrees,
        error: None,
    }
}

fn failed_project(
    project_root: String,
    protected_active_measured: bool,
    error: String,
) -> DiskDoctorProjectReport {
    DiskDoctorProjectReport {
        project_root,
        inactive_reclaimable_bytes: 0,
        inactive_target_count: 0,
        protected_active_bytes: 0,
        protected_active_target_count: 0,
        protected_active_measured,
        skipped_active_worktrees: 0,
        error: Some(error),
    }
}

fn cleanup_summary(result: ProjectServiceJsonResult) -> Result<CleanupPlanSummary, String> {
    let json = match result {
        ProjectServiceJsonResult::Ok { json, .. } => json,
        ProjectServiceJsonResult::Err { response } => return Err(response_message(response.body)),
    };
    let result = json
        .get("result")
        .filter(|result| !result.is_null())
        .unwrap_or(&json);
    let plan = result
        .as_object()
        .and_then(|result| result.get("plan"))
        .and_then(Value::as_object)
        .ok_or_else(|| INVALID_CLEANUP_RESPONSE.to_owned())?;
    let reclaimable_bytes = plan
        .get("reclaimableBytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| INVALID_CLEANUP_RESPONSE.to_owned())?;
    let targets = plan
        .get("targets")
        .and_then(Value::as_array)
        .ok_or_else(|| INVALID_CLEANUP_RESPONSE.to_owned())?;
    let skipped = plan
        .get("skipped")
        .and_then(Value::as_array)
        .ok_or_else(|| INVALID_CLEANUP_RESPONSE.to_owned())?;
    Ok(CleanupPlanSummary {
        reclaimable_bytes,
        target_count: targets.len(),
        skipped_active_worktrees: skipped
            .iter()
            .filter(|entry| entry.get("reason").and_then(Value::as_str) == Some("active-runtime"))
            .count(),
    })
}

fn response_message(body: DaemonResponseBody) -> String {
    let message = match body {
        DaemonResponseBody::Text(text) => text,
        DaemonResponseBody::Json(json) => json.to_string(),
        DaemonResponseBody::Bytes(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
    };
    let message = message.trim();
    if message.is_empty() {
        "project service request failed".to_owned()
    } else {
        message.to_owned()
    }
}

fn render_disk_doctor_report(report: &DiskDoctorReport) -> String {
    let protected = if report.totals.protected_active_unmeasured_projects > 0 {
        format!(
            "  protected active caches: not measured ({} active worktree(s)); pass --include-active to measure",
            report.totals.skipped_active_worktrees
        )
    } else {
        format!(
            "  protected active caches: {} ({} item(s), {} active worktree(s))",
            format_cache_bytes(report.totals.protected_active_bytes),
            report.totals.protected_active_target_count,
            report.totals.skipped_active_worktrees
        )
    };
    let mut lines = vec![
        "Aimux Disk".to_owned(),
        format!(
            "  inactive generated caches: {} ({} item(s))",
            format_cache_bytes(report.totals.inactive_reclaimable_bytes),
            report.totals.inactive_target_count
        ),
        protected,
        format!("  failures: {}", report.totals.failures),
    ];
    if !report.skipped_stale_project_roots.is_empty() {
        lines.push(format!(
            "  skipped stale projects: {}",
            report.skipped_stale_project_roots.len()
        ));
    }
    let mut sorted = report.projects.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|project| std::cmp::Reverse(project_bytes(project)));
    for project in &sorted {
        if project_is_empty(project) {
            continue;
        }
        lines.push(format!("  {}", project.project_root));
        lines.push(format!(
            "    inactive: {} ({} item(s))",
            format_cache_bytes(project.inactive_reclaimable_bytes),
            project.inactive_target_count
        ));
        if project.protected_active_measured {
            lines.push(format!(
                "    protected: {} ({} item(s), {} active worktree(s))",
                format_cache_bytes(project.protected_active_bytes),
                project.protected_active_target_count,
                project.skipped_active_worktrees
            ));
        } else {
            lines.push(format!(
                "    protected: not measured ({} active worktree(s)); pass --include-active to measure",
                project.skipped_active_worktrees
            ));
        }
        if let Some(error) = &project.error {
            lines.push(format!("    error: {error}"));
        }
    }
    if sorted.iter().all(|project| project_is_empty(project)) {
        lines.push("  no generated worktree caches found".to_owned());
    }
    lines.join("\n")
}

fn project_bytes(project: &DiskDoctorProjectReport) -> u64 {
    project
        .inactive_reclaimable_bytes
        .saturating_add(project.protected_active_bytes)
}

fn project_is_empty(project: &DiskDoctorProjectReport) -> bool {
    project.error.is_none()
        && project.inactive_reclaimable_bytes == 0
        && project.protected_active_bytes == 0
        && project.skipped_active_worktrees == 0
}

fn format_cache_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0B".to_owned();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0;
    while value >= 1024.0 && unit_index < units.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    if value >= 10.0 || unit_index == 0 {
        format!("{value:.0}{}", units[unit_index])
    } else {
        format!("{value:.1}{}", units[unit_index])
    }
}
