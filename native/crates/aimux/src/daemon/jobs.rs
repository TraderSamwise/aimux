use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use crate::daemon::listener::prepared_response_bytes;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::scheduler::{
    DaemonPeriodicTask, DaemonSchedulerContext, PeriodicTaskFuture, scheduler_now_ms,
};
use crate::desktop_notifier::{
    DesktopNotificationDeliveryResult, DesktopNotificationPayload, DesktopNotificationTransport,
    desktop_notification_unavailable_reason, send_desktop_notification_and_wait,
};
use crate::jobs::{
    CancelOutcome, CreateOrJoin, DEFAULT_JOB_RETENTION, JOB_TERMINAL_EVENT_KIND, JobAddress,
    JobCancelReport, JobEvent, JobListFilter, JobRecord, JobScope, JobSpec, JobStatus, JobStore,
    JobStoreError, parse_job_address, validate_job_id,
};
use crate::notification_delivery_guard::external_notification_refusal_reason_for_event;
use crate::paths::PathResolver;
use crate::project_service::event_streams::{encode_sse_event, encode_sse_keepalive};
use crate::request_actor::parse_remote_actor;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::{Instant, sleep};

pub const JOB_EVENT_STREAM_KEEPALIVE_MS: u64 = 15_000;
const JOB_EVENT_STREAM_POLL_MS: u64 = 500;
const JOB_PRUNE_INTERVAL_MS: i64 = 6 * 60 * 60 * 1_000;
const JOB_CALLBACK_BACKSTOP_INTERVAL_MS: i64 = 60_000;
const JOB_FIFO_NOTIFY_MAX_BYTES: usize = 512;
pub const DAEMON_JOB_CALLBACKS_TASK_NAME: &str = "daemon-job-callbacks";

pub trait DaemonJobRouteRuntime {
    fn job_store(&self) -> JobStore;

    fn job_path_resolver(&self) -> PathResolver;

    fn start_created_job(
        &mut self,
        _store: &JobStore,
        record: JobRecord,
        _spec: &JobSpec,
    ) -> Result<JobRecord, JobStoreError>;

    fn cancel_running_job(
        &mut self,
        _store: &JobStore,
        _record: &JobRecord,
    ) -> Result<JobCancelReport, JobStoreError>;

    fn force_job_callbacks_next_tick(&self) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobHandleKind {
    Id,
    Address,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedJobHandle {
    pub record: JobRecord,
    pub kind: JobHandleKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobEventStreamOptions {
    pub keepalive_ms: u64,
    pub poll_ms: u64,
    pub max_keepalives: Option<usize>,
    pub max_polls: Option<usize>,
}

impl Default for JobEventStreamOptions {
    fn default() -> Self {
        Self {
            keepalive_ms: JOB_EVENT_STREAM_KEEPALIVE_MS,
            poll_ms: JOB_EVENT_STREAM_POLL_MS,
            max_keepalives: None,
            max_polls: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateJobRequest {
    address: Option<String>,
    scope: Option<JobScope>,
    skill: Option<String>,
    prompt: Option<String>,
    project: Option<String>,
    tool: Option<String>,
    notify_fifo: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelJobRequest {
    handle: String,
    project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyJobRequest {
    handle: String,
    project: Option<String>,
    watcher_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCallbackDrainReport {
    pub attempted: usize,
    pub delivered: usize,
    pub suppressed: usize,
    pub failed: usize,
    pub abandoned: usize,
}

pub fn route_jobs_json_request(
    runtime: &mut impl DaemonJobRouteRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
    actor_present: bool,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "POST" && pathname == CORE_API_ROUTES.jobs {
        if actor_present {
            return Some(loopback_only_response());
        }
        let request = match parse_create_request(body) {
            Ok(request) => request,
            Err(response) => return Some(response),
        };
        let notify_fifo_raw = request.notify_fifo.clone();
        let store = runtime.job_store();
        let mut resolver = runtime.job_path_resolver();
        let spec = match request.into_spec(&mut resolver) {
            Ok(spec) => spec,
            Err(error) => {
                return Some(DaemonRouteResponse::json(
                    400,
                    json!({ "ok": false, "error": error }),
                ));
            }
        };
        let notify_fifo = match notify_fifo_raw.as_deref() {
            Some(path) => match validate_notify_fifo_path(path) {
                Ok(path) => Some(path),
                Err(error) => {
                    return Some(DaemonRouteResponse::json(
                        400,
                        json!({ "ok": false, "error": error }),
                    ));
                }
            },
            None => None,
        };
        return Some(match store.create_or_join(&spec) {
            Ok((record, outcome)) => {
                let record = if outcome == CreateOrJoin::Created {
                    match runtime.start_created_job(&store, record, &spec) {
                        Ok(record) => record,
                        Err(error) => return Some(store_error_response(error)),
                    }
                } else {
                    record
                };
                let fifo_callback = if let Some(path) = notify_fifo.as_deref() {
                    match store.register_fifo_callback(
                        &record.id,
                        &fifo_watcher_id(path),
                        path.to_string_lossy().as_ref(),
                    ) {
                        Ok(registration) => {
                            runtime.force_job_callbacks_next_tick();
                            Some(json!({
                                "callback": registration.callback,
                                "outcome": registration.outcome,
                            }))
                        }
                        Err(error) => return Some(store_error_response(error)),
                    }
                } else {
                    None
                };
                DaemonRouteResponse::json(
                    200,
                    json_without_null_fields(json!({
                        "ok": true,
                        "job": record,
                        "outcome": create_or_join_name(outcome),
                        "notifyFifo": fifo_callback,
                    })),
                )
            }
            Err(error) => store_error_response(error),
        });
    }

    if method == "GET" && pathname == CORE_API_ROUTES.jobs {
        if actor_present {
            return Some(loopback_only_response());
        }
        let store = runtime.job_store();
        let mut resolver = runtime.job_path_resolver();
        if let Some(handle) = route_url.search_param("handle") {
            return Some(
                match resolve_job_handle(&store, &mut resolver, handle, None) {
                    Ok(resolved) => match store.load_callbacks(&resolved.record.id) {
                        Ok(callbacks) => DaemonRouteResponse::json(
                            200,
                            json!({
                                "ok": true,
                                "job": resolved.record,
                                "handleKind": handle_kind_name(resolved.kind),
                                "callbacks": callbacks,
                            }),
                        ),
                        Err(error) => store_error_response(error),
                    },
                    Err(error) => store_error_response(error),
                },
            );
        }
        let depth = match route_url.search_param("depth") {
            Some(raw) => match raw.parse::<usize>() {
                Ok(depth) => Some(depth),
                Err(_) => {
                    return Some(DaemonRouteResponse::json(
                        400,
                        json!({ "ok": false, "error": "depth must be an unsigned integer" }),
                    ));
                }
            },
            None => None,
        };
        let address_prefix = match route_url.search_param("scope") {
            Some(scope) => match parse_job_scope_handle(scope, &mut resolver) {
                Ok(address) => Some(address),
                Err(error) => {
                    return Some(DaemonRouteResponse::json(
                        400,
                        json!({ "ok": false, "error": error }),
                    ));
                }
            },
            None => None,
        };
        return Some(
            match store.list(JobListFilter {
                scope: None,
                address_prefix,
                depth,
                status: None,
            }) {
                Ok(jobs) => DaemonRouteResponse::json(200, json!({ "ok": true, "jobs": jobs })),
                Err(error) => store_error_response(error),
            },
        );
    }

    if method == "POST" && pathname == CORE_API_ROUTES.jobs_cancel {
        if actor_present {
            return Some(loopback_only_response());
        }
        let request = match parse_cancel_request(body) {
            Ok(request) => request,
            Err(response) => return Some(response),
        };
        let store = runtime.job_store();
        let mut resolver = runtime.job_path_resolver();
        let explicit_project = request.project.as_deref().map(PathBuf::from);
        let resolved = match resolve_job_handle(
            &store,
            &mut resolver,
            &request.handle,
            explicit_project.as_deref(),
        ) {
            Ok(resolved) => resolved,
            Err(error) => return Some(store_error_response(error)),
        };
        return Some(match store.cancel(&resolved.record.id) {
            Ok((record, outcome)) => {
                let cancel = if outcome == CancelOutcome::CancelRequested {
                    match runtime.cancel_running_job(&store, &record) {
                        Ok(report) => Some(report),
                        Err(error) => return Some(store_error_response(error)),
                    }
                } else {
                    None
                };
                if outcome != CancelOutcome::Noop {
                    runtime.force_job_callbacks_next_tick();
                }
                let job = match store.load(&record.id) {
                    Ok(job) => job,
                    Err(error) => return Some(store_error_response(error)),
                };
                DaemonRouteResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "job": job,
                        "outcome": outcome,
                        "cancel": cancel,
                    }),
                )
            }
            Err(error) => store_error_response(error),
        });
    }

    if method == "POST" && pathname == CORE_API_ROUTES.jobs_notify {
        if actor_present {
            return Some(loopback_only_response());
        }
        let request = match parse_notify_request(body) {
            Ok(request) => request,
            Err(response) => return Some(response),
        };
        let store = runtime.job_store();
        let mut resolver = runtime.job_path_resolver();
        let explicit_project = request.project.as_deref().map(PathBuf::from);
        let resolved = match resolve_job_handle(
            &store,
            &mut resolver,
            &request.handle,
            explicit_project.as_deref(),
        ) {
            Ok(resolved) => resolved,
            Err(error) => return Some(store_error_response(error)),
        };
        let watcher_id = request.watcher_id.as_deref().unwrap_or("local-desktop");
        return Some(
            match store.register_desktop_callback(&resolved.record.id, watcher_id) {
                Ok(registration) => {
                    let mut callback = registration.callback;
                    let unavailable_reason = desktop_notification_unavailable_reason();
                    if let Some(reason) = unavailable_reason.as_deref() {
                        match store.record_callback_unavailable(
                            &resolved.record.id,
                            &callback.watcher_id,
                            reason,
                        ) {
                            Ok(updated) => callback = updated,
                            Err(error) => return Some(store_error_response(error)),
                        }
                    } else {
                        runtime.force_job_callbacks_next_tick();
                    }
                    DaemonRouteResponse::json(
                        200,
                        json!({
                            "ok": true,
                            "job": resolved.record,
                            "callback": callback,
                            "outcome": registration.outcome,
                            "desktopNotification": {
                                "available": unavailable_reason.is_none(),
                                "reason": unavailable_reason,
                            },
                        }),
                    )
                }
                Err(error) => store_error_response(error),
            },
        );
    }

    if method == "POST" && pathname == CORE_API_ROUTES.jobs_callbacks_kick {
        if actor_present {
            return Some(loopback_only_response());
        }
        runtime.force_job_callbacks_next_tick();
        return Some(DaemonRouteResponse::json(200, json!({ "ok": true })));
    }

    None
}

pub async fn maybe_handle_job_event_stream_request_with_runtime_mutex<Runtime, Writer>(
    runtime: &Arc<Mutex<Runtime>>,
    request: &crate::daemon::server::DaemonHttpRequest,
    writer: &mut Writer,
) -> Result<bool, std::io::Error>
where
    Runtime: DaemonJobRouteRuntime,
    Writer: AsyncWrite + Unpin + Send,
{
    let route_url = DaemonRouteUrl::parse(&request.path);
    if request.method != "GET" || route_url.pathname() != CORE_API_ROUTES.jobs_events {
        return Ok(false);
    }
    if parse_remote_actor(&request.headers).is_some() {
        write_route_response_async(writer, &loopback_only_response()).await?;
        return Ok(true);
    }

    enum StreamResolution {
        Ok {
            store: JobStore,
            id: String,
            seq: u64,
        },
        List {
            store: JobStore,
            prefix: Option<JobAddress>,
            depth: Option<usize>,
        },
        Err(DaemonRouteResponse),
    }

    let resolution = {
        let runtime = runtime.lock().expect("daemon runtime mutex poisoned");
        let store = runtime.job_store();
        let mut resolver = runtime.job_path_resolver();
        match route_url.search_param("handle") {
            Some(handle) => {
                let seq = match route_url.search_param("seq") {
                    Some(raw) => match raw.parse::<u64>() {
                        Ok(seq) => Ok(seq),
                        Err(_) => Err(DaemonRouteResponse::json(
                            400,
                            json!({ "ok": false, "error": "seq must be an unsigned integer" }),
                        )),
                    },
                    None => Ok(0),
                };
                let explicit_project = route_url.search_param("project").map(PathBuf::from);
                match seq {
                    Ok(seq) => match resolve_job_handle(
                        &store,
                        &mut resolver,
                        handle,
                        explicit_project.as_deref(),
                    ) {
                        Ok(resolved) => StreamResolution::Ok {
                            store,
                            id: resolved.record.id,
                            seq,
                        },
                        Err(error) => StreamResolution::Err(store_error_response(error)),
                    },
                    Err(response) => StreamResolution::Err(response),
                }
            }
            None if route_url.search_param("scope").is_some() => {
                let scope = route_url.search_param("scope").unwrap_or_default();
                match route_url
                    .search_param("depth")
                    .map(|raw| raw.parse::<usize>())
                {
                    Some(Err(_)) => StreamResolution::Err(DaemonRouteResponse::json(
                        400,
                        json!({ "ok": false, "error": "depth must be an unsigned integer" }),
                    )),
                    depth_result => {
                        let depth = depth_result.and_then(Result::ok);
                        match parse_job_scope_handle(scope, &mut resolver) {
                            Ok(prefix) => StreamResolution::List {
                                store,
                                prefix: Some(prefix),
                                depth,
                            },
                            Err(error) => StreamResolution::Err(DaemonRouteResponse::json(
                                400,
                                json!({ "ok": false, "error": error }),
                            )),
                        }
                    }
                }
            }
            None if route_url.search_param("all").is_some() => StreamResolution::List {
                store,
                prefix: None,
                depth: None,
            },
            None => StreamResolution::Err(DaemonRouteResponse::json(
                400,
                json!({ "ok": false, "error": "handle is required" }),
            )),
        }
    };

    match resolution {
        StreamResolution::Ok { store, id, seq } => {
            write_job_event_stream(&store, &id, seq, writer, JobEventStreamOptions::default())
                .await?;
        }
        StreamResolution::List {
            store,
            prefix,
            depth,
        } => {
            write_job_list_stream(
                &store,
                prefix,
                depth,
                writer,
                JobEventStreamOptions::default(),
            )
            .await?;
        }
        StreamResolution::Err(response) => {
            write_route_response_async(writer, &response).await?;
        }
    }
    Ok(true)
}

pub async fn write_job_list_stream(
    store: &JobStore,
    address_prefix: Option<JobAddress>,
    depth: Option<usize>,
    writer: &mut (impl AsyncWrite + Unpin),
    options: JobEventStreamOptions,
) -> Result<(), std::io::Error> {
    writer.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache, no-transform\r\nconnection: close\r\n\r\n").await?;
    let mut keepalives = 0_usize;
    let mut polls = 0_usize;
    let keepalive_interval = Duration::from_millis(options.keepalive_ms);
    let poll_interval = Duration::from_millis(options.poll_ms);
    let mut last_keepalive = Instant::now();
    let mut last_snapshot = None;
    loop {
        match store.list(JobListFilter {
            scope: None,
            address_prefix: address_prefix.clone(),
            depth,
            status: None,
        }) {
            Ok(jobs) => {
                let snapshot = json!({ "ok": true, "jobs": jobs });
                let encoded = match serde_json::to_string(&snapshot) {
                    Ok(encoded) => encoded,
                    Err(error) => {
                        writer
                            .write_all(&encode_sse_event(
                                "error",
                                &json!({ "ok": false, "error": error.to_string() }),
                            ))
                            .await?;
                        return Ok(());
                    }
                };
                if last_snapshot.as_deref() != Some(encoded.as_str()) {
                    writer
                        .write_all(&encode_sse_event("jobs-snapshot", &snapshot))
                        .await?;
                    last_snapshot = Some(encoded);
                    last_keepalive = Instant::now();
                } else if last_keepalive.elapsed() >= keepalive_interval {
                    writer.write_all(&encode_sse_keepalive()).await?;
                    keepalives += 1;
                    last_keepalive = Instant::now();
                }
            }
            Err(error) => {
                writer
                    .write_all(&encode_sse_event(
                        "error",
                        &json!({ "ok": false, "error": error.to_string() }),
                    ))
                    .await?;
                return Ok(());
            }
        }
        polls += 1;
        if options
            .max_keepalives
            .is_some_and(|max_keepalives| keepalives >= max_keepalives)
            || options
                .max_polls
                .is_some_and(|max_polls| polls >= max_polls)
        {
            return Ok(());
        }
        sleep(poll_interval).await;
    }
}

pub async fn write_job_event_stream(
    store: &JobStore,
    id: &str,
    seq: u64,
    writer: &mut (impl AsyncWrite + Unpin),
    options: JobEventStreamOptions,
) -> Result<(), std::io::Error> {
    writer.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache, no-transform\r\nconnection: close\r\n\r\n").await?;
    let mut next_seq = seq;
    let mut keepalives = 0_usize;
    let mut polls = 0_usize;
    let keepalive_interval = Duration::from_millis(options.keepalive_ms);
    let poll_interval = Duration::from_millis(options.poll_ms);
    let mut last_keepalive = Instant::now();
    loop {
        let mut wrote_events = false;
        match store.load(id) {
            Ok(record) if record.status == JobStatus::Running => {
                if let Err(error) = crate::jobs::capture_job_output_once(store, &record) {
                    writer
                        .write_all(&encode_sse_event(
                            "error",
                            &json!({ "ok": false, "error": error.to_string() }),
                        ))
                        .await?;
                    return Ok(());
                }
            }
            Ok(_) => {}
            Err(error) => {
                writer
                    .write_all(&encode_sse_event(
                        "error",
                        &json!({ "ok": false, "error": error.to_string() }),
                    ))
                    .await?;
                return Ok(());
            }
        }
        match store.read_events_from(id, next_seq) {
            Ok(events) => {
                wrote_events = !events.is_empty();
                let (updated_seq, saw_terminal) =
                    write_job_events(writer, &events, next_seq).await?;
                next_seq = updated_seq;
                if saw_terminal {
                    return Ok(());
                }
            }
            Err(JobStoreError::EmptyEventLog { .. }) => {}
            Err(error) => {
                writer
                    .write_all(&encode_sse_event(
                        "error",
                        &json!({ "ok": false, "error": error.to_string() }),
                    ))
                    .await?;
                return Ok(());
            }
        }
        match store.load(id) {
            Ok(record) if record.status.is_terminal() && !wrote_events => return Ok(()),
            Ok(_) => {}
            Err(error) => {
                writer
                    .write_all(&encode_sse_event(
                        "error",
                        &json!({ "ok": false, "error": error.to_string() }),
                    ))
                    .await?;
                return Ok(());
            }
        }
        if !wrote_events && last_keepalive.elapsed() >= keepalive_interval {
            writer.write_all(&encode_sse_keepalive()).await?;
            keepalives += 1;
            last_keepalive = Instant::now();
        }
        polls += 1;
        if options
            .max_keepalives
            .is_some_and(|max_keepalives| keepalives >= max_keepalives)
            || options
                .max_polls
                .is_some_and(|max_polls| polls >= max_polls)
        {
            return Ok(());
        }
        sleep(poll_interval).await;
    }
}

async fn write_job_events(
    writer: &mut (impl AsyncWrite + Unpin),
    events: &[JobEvent],
    mut next_seq: u64,
) -> Result<(u64, bool), std::io::Error> {
    let mut saw_terminal = false;
    for event in events {
        let event_name = if event.kind == JOB_TERMINAL_EVENT_KIND {
            saw_terminal = true;
            "terminal-status"
        } else {
            "job-event"
        };
        writer
            .write_all(&encode_sse_event(event_name, &json!(event)))
            .await?;
        next_seq = event.seq.saturating_add(1);
    }
    Ok((next_seq, saw_terminal))
}

pub fn drain_due_job_callbacks(
    store: &JobStore,
    now_ms: u128,
) -> Result<JobCallbackDrainReport, JobStoreError> {
    drain_due_job_callbacks_with(
        store,
        now_ms,
        |event| {
            external_notification_refusal_reason_for_event(
                None,
                job_project_state_dir_from_event(store, event).as_deref(),
                event,
            )
            .map(str::to_owned)
        },
        send_desktop_notification_and_wait,
    )
}

pub fn drain_due_job_callbacks_with(
    store: &JobStore,
    now_ms: u128,
    guard: impl Fn(&Value) -> Option<String>,
    sender: impl Fn(&DesktopNotificationPayload) -> DesktopNotificationDeliveryResult,
) -> Result<JobCallbackDrainReport, JobStoreError> {
    let mut report = JobCallbackDrainReport::default();
    for due in store.due_callbacks(now_ms)? {
        report.attempted += 1;
        let result = match due.callback.kind {
            crate::jobs::JobCallbackKind::DesktopNotification => {
                let guard_event = json!({
                    "kind": "job-completion",
                    "notificationClass": "progress-or-summary",
                    "jobId": due.record.id,
                    "watcherId": due.callback.watcher_id,
                    "status": due.record.status,
                    "scope": due.record.scope,
                });
                if let Some(reason) = guard(&guard_event) {
                    if store
                        .record_callback_suppressed(
                            &due.record.id,
                            &due.callback.watcher_id,
                            due.terminal_event.seq,
                            reason,
                            now_ms,
                        )
                        .is_ok()
                    {
                        report.suppressed += 1;
                    } else {
                        report.failed += 1;
                    }
                    continue;
                }
                sender(&notification_payload_for_job(&due.record))
            }
            crate::jobs::JobCallbackKind::Fifo => write_fifo_notification(&due),
        };
        if notification_delivery_is_unavailable(&result) {
            if store
                .record_callback_suppressed(
                    &due.record.id,
                    &due.callback.watcher_id,
                    due.terminal_event.seq,
                    notification_delivery_error(&result),
                    now_ms,
                )
                .is_ok()
            {
                report.suppressed += 1;
            } else {
                report.failed += 1;
            }
            continue;
        }
        if result.ok {
            if store
                .record_callback_delivered(
                    &due.record.id,
                    &due.callback.watcher_id,
                    due.terminal_event.seq,
                    now_ms,
                )
                .is_ok()
            {
                report.delivered += 1;
            } else {
                report.failed += 1;
            }
            continue;
        }
        let callback = match store.record_callback_failed(
            &due.record.id,
            &due.callback.watcher_id,
            notification_delivery_error(&result),
            now_ms,
        ) {
            Ok(callback) => callback,
            Err(_) => {
                report.failed += 1;
                continue;
            }
        };
        if callback.abandoned_at_ms.is_some() {
            report.abandoned += 1;
        } else {
            report.failed += 1;
        }
    }
    Ok(report)
}

fn notification_delivery_is_unavailable(result: &DesktopNotificationDeliveryResult) -> bool {
    matches!(
        result.transport,
        DesktopNotificationTransport::Disabled | DesktopNotificationTransport::PlatformUnsupported
    )
}

fn write_fifo_notification(due: &crate::jobs::DueJobCallback) -> DesktopNotificationDeliveryResult {
    let Some(path) = due.callback.fifo_path.as_deref() else {
        return DesktopNotificationDeliveryResult {
            ok: false,
            transport: DesktopNotificationTransport::Disabled,
            helper_path: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            error: Some("fifo callback path is missing".to_owned()),
        };
    };
    let payload = json!({
        "jobId": due.record.id,
        "status": due.record.status,
        "exitCode": due.record.exit_code,
        "terminalReason": due.record.terminal_reason,
        "seq": due.terminal_event.seq,
    });
    let mut line = match serde_json::to_string(&payload) {
        Ok(line) => line,
        Err(error) => {
            return DesktopNotificationDeliveryResult {
                ok: false,
                transport: DesktopNotificationTransport::Fifo,
                helper_path: None,
                exit_code: None,
                stdout: None,
                stderr: None,
                error: Some(error.to_string()),
            };
        }
    };
    line.push('\n');
    if line.len() > JOB_FIFO_NOTIFY_MAX_BYTES {
        return DesktopNotificationDeliveryResult {
            ok: false,
            transport: DesktopNotificationTransport::Fifo,
            helper_path: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            error: Some(format!(
                "fifo notification exceeds {JOB_FIFO_NOTIFY_MAX_BYTES} byte atomic write budget"
            )),
        };
    }
    match open_fifo_notification_writer(path) {
        Ok(mut file) => match file.write(line.as_bytes()) {
            Ok(count) if count == line.len() => DesktopNotificationDeliveryResult {
                ok: true,
                transport: DesktopNotificationTransport::Fifo,
                helper_path: None,
                exit_code: Some(0),
                stdout: None,
                stderr: None,
                error: None,
            },
            Ok(count) => DesktopNotificationDeliveryResult {
                ok: false,
                transport: DesktopNotificationTransport::Fifo,
                helper_path: None,
                exit_code: None,
                stdout: None,
                stderr: None,
                error: Some(format!(
                    "fifo notification partial write: wrote {count} of {} bytes",
                    line.len()
                )),
            },
            Err(error) => DesktopNotificationDeliveryResult {
                ok: false,
                transport: DesktopNotificationTransport::Fifo,
                helper_path: None,
                exit_code: None,
                stdout: None,
                stderr: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => DesktopNotificationDeliveryResult {
            ok: false,
            transport: DesktopNotificationTransport::Fifo,
            helper_path: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            error: Some(error.to_string()),
        },
    }
}

#[cfg(unix)]
fn open_fifo_notification_writer(path: &str) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};

    let mut options = OpenOptions::new();
    options
        .write(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_fifo() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("notify fifo {path} is not a FIFO"),
        ));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_fifo_notification_writer(_path: &str) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "notify fifo is supported only on Unix hosts",
    ))
}

fn job_project_state_dir_from_event(store: &JobStore, event: &Value) -> Option<PathBuf> {
    let scope = event.get("scope")?;
    let kind = scope.get("kind").and_then(Value::as_str)?;
    let project_id = match kind {
        "project" | "worktree" => scope.get("projectId").and_then(Value::as_str)?,
        _ => return None,
    };
    store
        .root()
        .parent()
        .map(|aimux_home| aimux_home.join("projects").join(project_id))
}

fn notification_payload_for_job(record: &JobRecord) -> DesktopNotificationPayload {
    let status = format!("{:?}", record.status).to_lowercase();
    let reason = record
        .terminal_reason
        .as_deref()
        .filter(|reason| !reason.is_empty())
        .unwrap_or("job finished");
    DesktopNotificationPayload {
        title: format!("aimux job {status}"),
        message: format!("{}: {reason}", record.skill),
        sound: false,
        deep_link_url: None,
    }
}

fn notification_delivery_error(result: &DesktopNotificationDeliveryResult) -> String {
    result
        .error
        .as_deref()
        .or(result.stderr.as_deref())
        .or(result.stdout.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("desktop notification delivery failed")
        .to_owned()
}

pub fn resolve_job_handle(
    store: &JobStore,
    resolver: &mut PathResolver,
    handle: &str,
    explicit_project: Option<&std::path::Path>,
) -> Result<ResolvedJobHandle, JobStoreError> {
    let trimmed = handle.trim();
    if trimmed.starts_with("job-") {
        validate_job_id_handle(trimmed)?;
        return store.load(trimmed).map(|record| ResolvedJobHandle {
            record,
            kind: JobHandleKind::Id,
        });
    }
    let address = parse_job_address(trimmed, resolver, explicit_project)
        .map_err(JobStoreError::InvalidSpec)?;
    resolve_job_address(store, address)
}

fn resolve_job_address(
    store: &JobStore,
    address: JobAddress,
) -> Result<ResolvedJobHandle, JobStoreError> {
    let mut matches = store
        .list(JobListFilter {
            scope: None,
            address_prefix: Some(address.clone()),
            depth: Some(0),
            status: None,
        })?
        .into_iter()
        .collect::<Vec<_>>();
    matches.sort_by_key(|record| record.created_at_ms);
    let record = matches
        .iter()
        .rev()
        .find(|record| {
            !matches!(
                record.status,
                JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
            )
        })
        .cloned()
        .or_else(|| matches.pop())
        .ok_or_else(|| JobStoreError::MissingJob {
            id: format!("address:{}", address.display()),
        })?;
    Ok(ResolvedJobHandle {
        record,
        kind: JobHandleKind::Address,
    })
}

fn parse_job_scope_handle(scope: &str, resolver: &mut PathResolver) -> Result<JobAddress, String> {
    let trimmed = scope.trim();
    parse_job_address(trimmed, resolver, None)
}

fn loopback_only_response() -> DaemonRouteResponse {
    DaemonRouteResponse::json(
        403,
        json!({ "ok": false, "error": "job routes are loopback-only" }),
    )
}

fn validate_job_id_handle(id: &str) -> Result<(), JobStoreError> {
    validate_job_id(id)
}

fn validate_notify_fifo_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("notify fifo {} is not readable: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if !metadata.file_type().is_fifo() {
            return Err(format!(
                "notify fifo {} is not a FIFO; create it with mkfifo and retry",
                path.display()
            ));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        return Err("notify fifo is supported only on Unix hosts".to_owned());
    }
    Ok(path)
}

fn fifo_watcher_id(path: &std::path::Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    format!("fifo-{:x}", hasher.finalize())
}

fn json_without_null_fields(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .filter(|(_, value)| !value.is_null())
                .collect(),
        ),
        other => other,
    }
}

impl CreateJobRequest {
    fn into_spec(self, resolver: &mut PathResolver) -> Result<JobSpec, String> {
        let explicit_project = self.project.as_deref().map(PathBuf::from);
        let address = match (self.address, self.scope) {
            (Some(address), None) => {
                parse_job_address(&address, resolver, explicit_project.as_deref())?
            }
            (None, Some(scope)) => JobAddress {
                scope,
                slot: Vec::new(),
            },
            (Some(_), Some(_)) => {
                return Err("address cannot be combined with scope".to_owned());
            }
            (None, None) => {
                return Err("address is required".to_owned());
            }
        };
        let spec = JobSpec {
            scope: address.scope.clone(),
            address,
            skill: self.skill.unwrap_or_default(),
            prompt: self.prompt,
            tool: self.tool,
            args: self.args,
            cwd: self.cwd,
            env: self.env,
        };
        spec.validate_payload().map_err(|error| error.to_string())?;
        Ok(spec)
    }
}

pub struct DaemonJobsPruneTask;

impl DaemonPeriodicTask for DaemonJobsPruneTask {
    fn name(&self) -> &str {
        "daemon-jobs-prune"
    }

    fn interval_ms(&self) -> i64 {
        JOB_PRUNE_INTERVAL_MS
    }

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let store = JobStore::new(context.resolver.jobs_dir());
            store
                .prune(DEFAULT_JOB_RETENTION, scheduler_now_ms().max(0) as u128)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

pub struct DaemonJobsReconcileTask;

impl DaemonPeriodicTask for DaemonJobsReconcileTask {
    fn name(&self) -> &str {
        "daemon-jobs-reconcile"
    }

    fn interval_ms(&self) -> i64 {
        30_000
    }

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let store = JobStore::new(context.resolver.jobs_dir());
            let mut tmux = crate::tmux::TmuxRuntimeManager::new();
            crate::jobs::reconcile_running_jobs(&store, &mut tmux)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

pub struct DaemonJobCallbacksTask;

impl DaemonPeriodicTask for DaemonJobCallbacksTask {
    fn name(&self) -> &str {
        DAEMON_JOB_CALLBACKS_TASK_NAME
    }

    fn interval_ms(&self) -> i64 {
        JOB_CALLBACK_BACKSTOP_INTERVAL_MS
    }

    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let jobs_dir = context.resolver.jobs_dir();
            tokio::task::spawn_blocking(move || {
                let store = JobStore::new(jobs_dir);
                drain_due_job_callbacks(&store, scheduler_now_ms().max(0) as u128)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())?
        })
    }
}

fn parse_create_request(body: Option<&Value>) -> Result<CreateJobRequest, DaemonRouteResponse> {
    let Some(body) = body else {
        return Err(DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "job spec body is required" }),
        ));
    };
    serde_json::from_value(body.clone()).map_err(|error| {
        DaemonRouteResponse::json(400, json!({ "ok": false, "error": error.to_string() }))
    })
}

fn parse_cancel_request(body: Option<&Value>) -> Result<CancelJobRequest, DaemonRouteResponse> {
    let Some(body) = body else {
        return Err(DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "cancel body is required" }),
        ));
    };
    serde_json::from_value(body.clone()).map_err(|error| {
        DaemonRouteResponse::json(400, json!({ "ok": false, "error": error.to_string() }))
    })
}

fn parse_notify_request(body: Option<&Value>) -> Result<NotifyJobRequest, DaemonRouteResponse> {
    let Some(body) = body else {
        return Err(DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "notify body is required" }),
        ));
    };
    serde_json::from_value(body.clone()).map_err(|error| {
        DaemonRouteResponse::json(400, json!({ "ok": false, "error": error.to_string() }))
    })
}

fn store_error_response(error: JobStoreError) -> DaemonRouteResponse {
    let status = match &error {
        JobStoreError::MissingJob { .. } | JobStoreError::EmptyEventLog { .. } => 404,
        JobStoreError::InvalidSpec(_) => 400,
        JobStoreError::InvalidStatusTransition { .. }
        | JobStoreError::JobAddressConflict { .. } => 409,
        JobStoreError::StoreUnavailable { .. } | JobStoreError::CorruptStore { .. } => 500,
    };
    DaemonRouteResponse::json(status, json!({ "ok": false, "error": error.to_string() }))
}

async fn write_route_response_async(
    writer: &mut (impl AsyncWrite + Unpin),
    response: &DaemonRouteResponse,
) -> Result<(), std::io::Error> {
    let prepared = prepare_daemon_response(
        response.status,
        match &response.body {
            DaemonResponseBody::Json(value) => DaemonResponseBody::Json(value.clone()),
            DaemonResponseBody::Text(value) => DaemonResponseBody::Text(value.clone()),
            DaemonResponseBody::Bytes(value) => DaemonResponseBody::Bytes(value.clone()),
        },
        response.content_type.as_deref(),
    );
    writer.write_all(&prepared_response_bytes(&prepared)).await
}

fn create_or_join_name(outcome: CreateOrJoin) -> &'static str {
    match outcome {
        CreateOrJoin::Created => "created",
        CreateOrJoin::Joined => "joined",
    }
}

fn handle_kind_name(kind: JobHandleKind) -> &'static str {
    match kind {
        JobHandleKind::Id => "id",
        JobHandleKind::Address => "address",
    }
}
