use serde_json::json;

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;

use super::dispatcher::{
    ProjectServiceDispatchResponse, project_service_pathname,
    route_unimplemented_project_service_request,
};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{inspect_runtime_exchange_store, runtime_exchange_path};

pub fn route_read_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }

    if pathname == routes::HEALTH {
        let service_info = match get_project_service_manifest() {
            Ok(manifest) => serde_json::to_value(manifest).unwrap_or_else(|_| json!({})),
            Err(error) => json!({ "error": error.to_string() }),
        };
        return Some(ProjectServiceDispatchResponse::json(
            200,
            json!({
                "ok": true,
                "projectStateDir": context.project_state_dir_string(),
                "pid": std::process::id(),
                "serviceInfo": service_info,
            }),
        ));
    }

    if pathname == routes::STATE {
        let state = load_metadata_state(context.project_state_dir());
        return Some(ProjectServiceDispatchResponse::json(
            200,
            serde_json::to_value(state).unwrap_or_else(|_| json!({ "version": 1, "sessions": {} })),
        ));
    }

    if pathname == routes::DIAGNOSTICS {
        return Some(ProjectServiceDispatchResponse::json(
            200,
            json!({
                "ok": true,
                "projectStateDir": context.project_state_dir_string(),
                "pid": std::process::id(),
                "serviceInfo": service_info_json(),
                "resources": resource_snapshot(),
                "recentSlowRequests": [],
                "plugins": [],
                "previews": {},
                "agentOutputReads": {
                    "total": { "count": 0 },
                    "bySource": {},
                    "recent": [],
                },
                "runtimeExchange": inspect_runtime_exchange_store(runtime_exchange_path(context.project_state_dir())),
            }),
        ));
    }

    if pathname == routes::DIAGNOSTICS_LIFECYCLE {
        return Some(ProjectServiceDispatchResponse::json(
            200,
            json!({
                "ok": true,
                "pid": std::process::id(),
                "projectRoot": context.project_root().to_string_lossy(),
                "queuedCount": 0,
                "queueLimit": 0,
                "runningCount": 0,
                "pending": [],
                "running": [],
                "telemetry": {
                    "enqueued": 0,
                    "completed": 0,
                    "failed": 0,
                    "rejected": 0,
                    "maxQueuedCount": 0,
                    "maxRunningCount": 0,
                },
            }),
        ));
    }

    if pathname == routes::DESKTOP_STATE
        || pathname == routes::COORDINATION_WORKLIST
        || pathname == routes::PROJECT_OBSERVABILITY
        || pathname == routes::TOPOLOGY
        || pathname == routes::WORKTREES
        || pathname == routes::GRAVEYARD
        || pathname == routes::agents::LIST
        || pathname == routes::agents::TEAMMATES
        || pathname == routes::agents::HISTORY
        || pathname == routes::team::CONFIG
        || pathname == routes::controls::SWITCHABLE_AGENTS
    {
        return Some(route_unimplemented_project_service_request(method, path));
    }

    None
}

fn service_info_json() -> serde_json::Value {
    match get_project_service_manifest() {
        Ok(manifest) => serde_json::to_value(manifest).unwrap_or_else(|_| json!({})),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn resource_snapshot() -> serde_json::Value {
    json!({
        "uptimeMs": 0,
        "memoryRssBytes": resident_memory_bytes(),
        "memoryHeapUsedBytes": 0,
        "activeHandles": 0,
        "activeRequests": 0,
        "openFileDescriptors": open_file_descriptors(),
    })
}

fn resident_memory_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0;
    if !ok {
        return 0;
    }
    let usage = unsafe { usage.assume_init() };
    #[cfg(target_os = "macos")]
    {
        usage.ru_maxrss.try_into().unwrap_or(0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        u64::try_from(usage.ru_maxrss)
            .unwrap_or(0)
            .saturating_mul(1024)
    }
}

fn open_file_descriptors() -> Option<usize> {
    std::fs::read_dir("/dev/fd")
        .ok()
        .map(|entries| entries.filter_map(Result::ok).count())
}
