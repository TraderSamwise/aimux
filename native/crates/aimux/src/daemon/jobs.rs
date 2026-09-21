use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use crate::daemon::listener::prepared_response_bytes;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::scheduler::{
    DaemonPeriodicTask, DaemonSchedulerContext, PeriodicTaskFuture, scheduler_now_ms,
};
use crate::jobs::{
    CancelOutcome, CreateOrJoin, DEFAULT_JOB_RETENTION, JobAddress, JobCancelReport, JobEvent,
    JobListFilter, JobRecord, JobScope, JobSpec, JobStatus, JobStore, JobStoreError,
    parse_job_address,
};
use crate::paths::PathResolver;
use crate::project_service::event_streams::{encode_sse_event, encode_sse_keepalive};
use crate::request_actor::parse_remote_actor;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::{Instant, sleep};

pub const JOB_EVENT_STREAM_KEEPALIVE_MS: u64 = 15_000;
const JOB_EVENT_STREAM_POLL_MS: u64 = 500;
const JOB_PRUNE_INTERVAL_MS: i64 = 6 * 60 * 60 * 1_000;

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
    project: Option<String>,
    tool: Option<String>,
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
                DaemonRouteResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "job": record,
                        "outcome": create_or_join_name(outcome),
                    }),
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
                    Ok(resolved) => DaemonRouteResponse::json(
                        200,
                        json!({
                            "ok": true,
                            "job": resolved.record,
                            "handleKind": handle_kind_name(resolved.kind),
                        }),
                    ),
                    Err(error) => store_error_response(error),
                },
            );
        }
        let scope = match route_url.search_param("scope") {
            Some(scope) => match parse_job_scope_handle(scope, &mut resolver) {
                Ok(scope) => Some(scope),
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
                scope,
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
                let job = store.load(&record.id).unwrap_or(record);
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
                match seq {
                    Ok(seq) => match resolve_job_handle(&store, &mut resolver, handle, None) {
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
        StreamResolution::Err(response) => {
            write_route_response_async(writer, &response).await?;
        }
    }
    Ok(true)
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
        match store.read_events_from(id, next_seq) {
            Ok(events) => {
                wrote_events = !events.is_empty();
                next_seq = write_job_events(writer, &events, next_seq).await?;
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
) -> Result<u64, std::io::Error> {
    for event in events {
        writer
            .write_all(&encode_sse_event("job-event", &json!(event)))
            .await?;
        next_seq = event.seq.saturating_add(1);
    }
    Ok(next_seq)
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
            scope: Some(address.scope.clone()),
            status: None,
        })?
        .into_iter()
        .filter(|record| record.skill == address.skill)
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
            id: format!("address:{}", address.skill),
        })?;
    Ok(ResolvedJobHandle {
        record,
        kind: JobHandleKind::Address,
    })
}

fn parse_job_scope_handle(scope: &str, resolver: &mut PathResolver) -> Result<JobScope, String> {
    let trimmed = scope.trim();
    if trimmed == "global" {
        return Ok(JobScope::Global);
    }
    let sentinel_skill = "__aimux_scope_filter__";
    let address = parse_job_address(&format!("{trimmed}/{sentinel_skill}"), resolver, None)?;
    Ok(address.scope)
}

fn loopback_only_response() -> DaemonRouteResponse {
    DaemonRouteResponse::json(
        403,
        json!({ "ok": false, "error": "job routes are loopback-only" }),
    )
}

fn validate_job_id_handle(id: &str) -> Result<(), JobStoreError> {
    let valid = id.strip_prefix("job-").is_some_and(|rest| !rest.is_empty())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(JobStoreError::InvalidSpec(
            "job id handle contains invalid characters".to_owned(),
        ))
    }
}

impl CreateJobRequest {
    fn into_spec(self, resolver: &mut PathResolver) -> Result<JobSpec, String> {
        let explicit_project = self.project.as_deref().map(PathBuf::from);
        let (scope, skill) = match (self.address, self.scope, self.skill) {
            (Some(address), None, None) => {
                let parsed = parse_job_address(&address, resolver, explicit_project.as_deref())?;
                (parsed.scope, parsed.skill)
            }
            (None, Some(scope), Some(skill)) => (scope, skill),
            (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                return Err("address cannot be combined with scope or skill".to_owned());
            }
            (None, _, _) => {
                return Err("address or scope+skill is required".to_owned());
            }
        };
        Ok(JobSpec {
            scope,
            skill,
            tool: self.tool,
            args: self.args,
            cwd: self.cwd,
            env: self.env,
        })
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
        1_000
    }

    fn run_immediately(&self) -> bool {
        true
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

fn store_error_response(error: JobStoreError) -> DaemonRouteResponse {
    let status = match &error {
        JobStoreError::MissingJob { .. } | JobStoreError::EmptyEventLog { .. } => 404,
        JobStoreError::InvalidSpec(_) => 400,
        JobStoreError::InvalidStatusTransition { .. } => 409,
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
