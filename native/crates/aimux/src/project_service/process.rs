use anyhow::{Context, Result};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::{self, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::backend_session_ids::reconcile_offline_backend_session_ids;
use crate::config::load_config_for_project;
use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::listener::{
    DaemonListenerError, parse_daemon_http_request, prepared_response_bytes, read_http_request,
};
use crate::daemon::server::DaemonHttpRequest;
use crate::daemon_state::{MetadataApiEndpoint, remove_metadata_endpoint, save_metadata_endpoint};
use crate::expose_socket::{
    EXPOSE_SOCKET_HEADER_TIMEOUT_MS, clear_expose_socket_path, expose_socket_path,
    publish_expose_socket_path, read_expose_socket_header,
};
use crate::paths::{PathResolver, compute_project_id};
use crate::plugin_api::NativePluginStatus;
use crate::plugin_project_service_host::native_plugin_statuses_for_context;
use crate::runtime_lifecycle_methods::write_instruction_files;
use crate::tmux_expose::{
    SystemExposeHttpClient, run_tmux_expose_with_client, tmux_expose_options_from_socket_header,
};

use super::agent_output::{
    AgentOutputCaptureRuntime, AgentOutputResponseMode, SystemAgentOutputCaptureRuntime,
    read_agent_output_payload,
};
use super::dispatcher::ProjectServiceStreamKind;
use super::event_streams::{encode_sse_event, encode_sse_keepalive};
use super::http::PreparedProjectServiceResponse;
use super::lifecycle::{
    ProjectLifecycleRuntime, SystemProjectLifecycleRuntime, ensure_default_scribe_agent,
};
use super::output_metrics::AgentOutputReadRecord;
use super::router::{ProjectServiceRequestContext, route_project_service_request};
use super::server::{ProjectServiceHttpRequest, handle_project_service_http_request};

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectServiceInternalOptions {
    pub project_id: Option<String>,
    pub project_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceStartup {
    pub project_id: String,
    pub project_root: PathBuf,
    pub project_state_dir: PathBuf,
    pub desired_port: u16,
}

pub fn run_project_service_internal(options: ProjectServiceInternalOptions) -> Result<()> {
    let startup = prepare_project_service_startup(options)?;
    if std::env::current_dir().ok().as_deref() != Some(startup.project_root.as_path()) {
        std::env::set_current_dir(&startup.project_root)
            .with_context(|| format!("chdir {}", startup.project_root.display()))?;
    }
    let listener = bind_project_service_listener(startup.desired_port)?;
    let port = listener
        .local_addr()
        .context("read project-service listener address")?
        .port();
    publish_project_service_endpoint(&startup.project_state_dir, port)?;
    let _endpoint_guard = ProjectServiceEndpointGuard {
        project_state_dir: startup.project_state_dir.clone(),
    };
    #[cfg(unix)]
    let _expose_socket_guard = start_project_expose_socket(&startup).ok();
    let mut lifecycle_runtime = SystemProjectLifecycleRuntime;
    let startup_context = ProjectServiceRequestContext::with_project_state_dir(
        startup.project_root.clone(),
        startup.project_state_dir.clone(),
    );
    let plugin_statuses = native_plugin_statuses_for_context(&startup_context);
    let startup_context = startup_context.with_plugin_statuses(plugin_statuses.clone());
    run_project_service_startup_tasks(&startup, &startup_context, &mut lifecycle_runtime);
    serve_project_service_listener(listener, startup, plugin_statuses);
    Ok(())
}

pub fn run_project_service_startup_tasks(
    startup: &ProjectServiceStartup,
    context: &ProjectServiceRequestContext,
    runtime: &mut impl ProjectLifecycleRuntime,
) {
    let _ = runtime.repair_legacy_project_session_names(&startup.project_root);
    let _ =
        reconcile_offline_backend_session_ids(&startup.project_root, &startup.project_state_dir);
    let config = load_config_for_project(&startup.project_root);
    write_instruction_files(&startup.project_root, &config);
    let _ = ensure_default_scribe_agent(context, runtime);
}

pub fn prepare_project_service_startup(
    options: ProjectServiceInternalOptions,
) -> Result<ProjectServiceStartup> {
    let requested_root = options
        .project_root
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let mut resolver = PathResolver::from_env();
    let project_root = resolver.resolve_repo_root(requested_root);
    let project_id = options
        .project_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| compute_project_id(&project_root));
    let project_state_dir = resolver.project_state_dir_for(&project_root);
    Ok(ProjectServiceStartup {
        desired_port: desired_project_service_port(&project_id),
        project_id,
        project_root,
        project_state_dir,
    })
}

pub fn desired_project_service_port(project_id: &str) -> u16 {
    let mut hash = Sha1::new();
    hash.update(project_id.as_bytes());
    let digest = format!("{:x}", hash.finalize());
    let lead = u32::from_str_radix(&digest[..6], 16).unwrap_or(0);
    43_000 + u16::try_from(lead % 10_000).unwrap_or(0)
}

pub fn publish_project_service_endpoint(
    project_state_dir: impl AsRef<Path>,
    port: u16,
) -> Result<MetadataApiEndpoint> {
    let endpoint = MetadataApiEndpoint {
        host: "127.0.0.1".into(),
        port,
        pid: std::process::id() as i32,
        updated_at: now_iso(),
    };
    save_metadata_endpoint(project_state_dir, &endpoint).context("save metadata endpoint")?;
    Ok(endpoint)
}

pub fn handle_project_service_connection<Stream>(
    stream: &mut Stream,
    context: &ProjectServiceRequestContext,
) -> Result<(), DaemonListenerError>
where
    Stream: std::io::Read + std::io::Write,
{
    let bytes = read_http_request(stream)?;
    let request = parse_daemon_http_request(&bytes)?;
    let request = project_request_from_daemon(request);
    let request_context = context
        .clone()
        .with_request_headers(request.headers.clone());
    let response = handle_project_service_http_request(request, |method, path, body| {
        route_project_service_request(&request_context, method, path, body)
    });
    let mut runtime = SystemAgentOutputCaptureRuntime;
    write_project_service_response_with_runtime(
        stream,
        &response,
        Some(&request_context),
        &mut runtime,
    )
}

pub fn write_project_service_response(
    writer: &mut impl std::io::Write,
    response: &PreparedProjectServiceResponse,
) -> Result<(), DaemonListenerError> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    write_project_service_response_with_runtime(writer, response, None, &mut runtime)
}

pub fn write_project_service_response_with_runtime(
    writer: &mut impl std::io::Write,
    response: &PreparedProjectServiceResponse,
    context: Option<&ProjectServiceRequestContext>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Result<(), DaemonListenerError> {
    writer.write_all(&prepared_response_bytes(
        &prepared_project_response_to_daemon(response),
    ))?;
    writer.flush()?;
    if let Some(stream) = response.stream.as_ref() {
        let interval_ms = u64::try_from(stream.interval_ms).unwrap_or(500).max(100);
        let mut last_output_fingerprint = None;
        let mut last_project_event_sequence = stream.event_cursor.unwrap_or_default();
        let mut last_stream_write = Instant::now();
        loop {
            wait_for_next_stream_tick(
                stream,
                context,
                last_project_event_sequence,
                interval_ms,
                last_stream_write,
            );
            let frame = match stream.kind {
                ProjectServiceStreamKind::ProjectEvents => {
                    let frame = encode_project_event_stream_frame(
                        stream,
                        context,
                        runtime,
                        &mut last_project_event_sequence,
                        &mut last_output_fingerprint,
                    );
                    if frame.is_empty() && stream_keepalive_due(stream, last_stream_write) {
                        encode_sse_keepalive()
                    } else {
                        frame
                    }
                }
                ProjectServiceStreamKind::AgentOutput => encode_agent_output_stream_frame(
                    stream,
                    context,
                    runtime,
                    &mut last_output_fingerprint,
                ),
                ProjectServiceStreamKind::AgentInteraction => {
                    if stream_keepalive_due(stream, last_stream_write) {
                        encode_sse_keepalive()
                    } else {
                        Vec::new()
                    }
                }
            };
            if frame.is_empty() {
                continue;
            }
            writer.write_all(&frame)?;
            writer.flush()?;
            if stream.kind != ProjectServiceStreamKind::AgentOutput {
                last_stream_write = Instant::now();
            }
        }
    }
    Ok(())
}

fn wait_for_next_stream_tick(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: Option<&ProjectServiceRequestContext>,
    after_sequence: u64,
    interval_ms: u64,
    last_write: Instant,
) {
    if stream.kind == ProjectServiceStreamKind::ProjectEvents
        && stream.session_id.is_none()
        && let Some(context) = context
    {
        let wait = duration_until_stream_keepalive(stream, last_write)
            .unwrap_or_else(|| Duration::from_millis(interval_ms));
        let _ = context
            .project_events
            .wait_for_events_since(after_sequence, None, wait);
        return;
    }
    thread::sleep(Duration::from_millis(interval_ms));
}

fn stream_keepalive_due(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    last_write: Instant,
) -> bool {
    let Some(interval_ms) = stream.keepalive_interval_ms else {
        return false;
    };
    let interval_ms = u64::try_from(interval_ms).unwrap_or(15_000).max(100);
    last_write.elapsed() >= Duration::from_millis(interval_ms)
}

fn duration_until_stream_keepalive(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    last_write: Instant,
) -> Option<Duration> {
    let interval_ms = u64::try_from(stream.keepalive_interval_ms?).ok()?.max(100);
    let interval = Duration::from_millis(interval_ms);
    Some(interval.saturating_sub(last_write.elapsed()))
}

fn encode_project_event_stream_frame(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: Option<&ProjectServiceRequestContext>,
    runtime: &mut impl AgentOutputCaptureRuntime,
    last_sequence: &mut u64,
    last_output_fingerprint: &mut Option<String>,
) -> Vec<u8> {
    let Some(context) = context else {
        return encode_sse_keepalive();
    };
    let mut bytes = Vec::new();
    let records = context
        .project_events
        .events_since(*last_sequence, stream.session_id.as_deref());
    for record in records {
        *last_sequence = (*last_sequence).max(record.sequence);
        let event_name = record
            .event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("project_update");
        bytes.extend(encode_sse_event(event_name, &record.event));
    }
    if let Some(session_id) = stream.session_id.as_deref() {
        bytes.extend(encode_project_event_output_frame(
            stream,
            context,
            runtime,
            session_id,
            last_output_fingerprint,
        ));
    }
    bytes
}

fn encode_project_event_output_frame(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: &ProjectServiceRequestContext,
    runtime: &mut impl AgentOutputCaptureRuntime,
    session_id: &str,
    last_output_fingerprint: &mut Option<String>,
) -> Vec<u8> {
    let mode = match stream.mode.as_deref() {
        Some("chat") => AgentOutputResponseMode::Chat,
        _ => AgentOutputResponseMode::Full,
    };
    match read_agent_output_payload(context, session_id, stream.start_line, mode, runtime) {
        Ok(result) => {
            let fingerprint = agent_output_stream_fingerprint(&result.payload);
            if last_output_fingerprint.as_deref() == Some(fingerprint.as_str()) {
                context.output_metrics.record(AgentOutputReadRecord {
                    source: "events".to_owned(),
                    session_id: session_id.to_owned(),
                    changed: Some(false),
                    coalesced: result.coalesced,
                    error: false,
                });
                return Vec::new();
            }
            *last_output_fingerprint = Some(fingerprint);
            context.output_metrics.record(AgentOutputReadRecord {
                source: "events".to_owned(),
                session_id: session_id.to_owned(),
                changed: Some(true),
                coalesced: result.coalesced,
                error: false,
            });
            encode_sse_event("agent_output", &result.payload)
        }
        Err(response) => {
            context.output_metrics.record(AgentOutputReadRecord {
                source: "events".to_owned(),
                session_id: session_id.to_owned(),
                changed: None,
                coalesced: false,
                error: true,
            });
            encode_sse_event("error", &response.body)
        }
    }
}

fn encode_agent_output_stream_frame(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: Option<&ProjectServiceRequestContext>,
    runtime: &mut impl AgentOutputCaptureRuntime,
    last_output_fingerprint: &mut Option<String>,
) -> Vec<u8> {
    let Some(context) = context else {
        return encode_sse_keepalive();
    };
    let Some(session_id) = stream.session_id.as_deref() else {
        return encode_sse_keepalive();
    };
    let mode = match stream.mode.as_deref() {
        Some("chat") => AgentOutputResponseMode::Chat,
        _ => AgentOutputResponseMode::Full,
    };
    match read_agent_output_payload(context, session_id, stream.start_line, mode, runtime) {
        Ok(result) => {
            let fingerprint = agent_output_stream_fingerprint(&result.payload);
            if last_output_fingerprint.as_deref() == Some(fingerprint.as_str()) {
                context.output_metrics.record(AgentOutputReadRecord {
                    source: "output-stream".to_owned(),
                    session_id: session_id.to_owned(),
                    changed: Some(false),
                    coalesced: result.coalesced,
                    error: false,
                });
                return encode_sse_keepalive();
            }
            *last_output_fingerprint = Some(fingerprint);
            context.output_metrics.record(AgentOutputReadRecord {
                source: "output-stream".to_owned(),
                session_id: session_id.to_owned(),
                changed: Some(true),
                coalesced: result.coalesced,
                error: false,
            });
            encode_sse_event("output", &result.payload)
        }
        Err(response) => {
            context.output_metrics.record(AgentOutputReadRecord {
                source: "output-stream".to_owned(),
                session_id: session_id.to_owned(),
                changed: None,
                coalesced: false,
                error: true,
            });
            encode_sse_event("error", &response.body)
        }
    }
}

fn agent_output_stream_fingerprint(payload: &serde_json::Value) -> String {
    serde_json::to_string(&serde_json::json!({
        "sessionId": payload.get("sessionId"),
        "startLine": payload.get("startLine"),
        "endLine": payload.get("endLine"),
        "output": payload.get("output"),
        "outputAnsi": payload.get("outputAnsi"),
        "messages": payload.get("messages"),
        "activity": payload.get("activity"),
        "activityText": payload.get("activityText"),
        "attention": payload.get("attention"),
    }))
    .unwrap_or_default()
}

fn serve_project_service_listener(
    listener: TcpListener,
    startup: ProjectServiceStartup,
    plugin_statuses: Vec<NativePluginStatus>,
) {
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(
            startup.project_root,
            startup.project_state_dir,
        )
        .with_plugin_statuses(plugin_statuses)
        .with_hot_snapshot_background_refresh(),
    );
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else {
            continue;
        };
        let context = Arc::clone(&context);
        thread::spawn(move || {
            let _ = handle_project_service_connection(&mut stream, &context);
        });
    }
}

fn bind_project_service_listener(desired_port: u16) -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", desired_port))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .context("bind project-service listener")
}

#[cfg(unix)]
pub fn start_project_expose_socket(
    startup: &ProjectServiceStartup,
) -> io::Result<ProjectExposeSocketGuard> {
    fs::create_dir_all(&startup.project_state_dir)?;
    let socket_path = expose_socket_path(&startup.project_state_dir);
    clear_expose_socket_path(&startup.project_state_dir, &socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    publish_expose_socket_path(&startup.project_state_dir, &socket_path)?;
    let project_root = startup.project_root.clone();
    let project_state_dir = startup.project_state_dir.clone();
    thread::spawn(move || serve_expose_socket(listener, project_root, project_state_dir));
    Ok(ProjectExposeSocketGuard {
        project_state_dir: startup.project_state_dir.clone(),
        socket_path,
    })
}

#[cfg(unix)]
pub struct ProjectExposeSocketGuard {
    project_state_dir: PathBuf,
    socket_path: PathBuf,
}

#[cfg(unix)]
impl Drop for ProjectExposeSocketGuard {
    fn drop(&mut self) {
        clear_expose_socket_path(&self.project_state_dir, &self.socket_path);
    }
}

#[cfg(unix)]
fn serve_expose_socket(listener: UnixListener, project_root: PathBuf, project_state_dir: PathBuf) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            continue;
        };
        let project_root = project_root.clone();
        let project_state_dir = project_state_dir.clone();
        thread::spawn(move || {
            let _ = handle_expose_socket_stream(stream, &project_root, &project_state_dir);
        });
    }
}

#[cfg(unix)]
fn handle_expose_socket_stream(
    mut stream: UnixStream,
    fallback_project_root: &Path,
    fallback_project_state_dir: &Path,
) -> io::Result<()> {
    let mut input = stream.try_clone()?;
    input.set_read_timeout(Some(Duration::from_millis(EXPOSE_SOCKET_HEADER_TIMEOUT_MS)))?;
    let parsed = read_expose_socket_header(&mut input)?;
    input.set_read_timeout(None)?;
    let status_path = parsed
        .header
        .get(10)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let options = tmux_expose_options_from_socket_header(
        &parsed.header,
        fallback_project_root,
        fallback_project_state_dir,
    );
    let mut input = PrefixedRead::new(parsed.rest, input);
    let mut client = SystemExposeHttpClient;
    let code = run_tmux_expose_with_client(options, &mut input, &mut stream, &mut client);
    if let Some(status_path) = status_path {
        let _ = fs::write(status_path, format!("{code}\n"));
    }
    Ok(())
}

#[cfg(unix)]
struct PrefixedRead<R> {
    prefix: Vec<u8>,
    offset: usize,
    inner: R,
}

#[cfg(unix)]
impl<R> PrefixedRead<R> {
    fn new(prefix: Vec<u8>, inner: R) -> Self {
        Self {
            prefix,
            offset: 0,
            inner,
        }
    }
}

#[cfg(unix)]
impl<R: Read> Read for PrefixedRead<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.offset < self.prefix.len() {
            let count = buffer.len().min(self.prefix.len() - self.offset);
            buffer[..count].copy_from_slice(&self.prefix[self.offset..self.offset + count]);
            self.offset += count;
            return Ok(count);
        }
        self.inner.read(buffer)
    }
}

fn project_request_from_daemon(request: DaemonHttpRequest) -> ProjectServiceHttpRequest {
    ProjectServiceHttpRequest {
        method: request.method,
        path: request.path,
        headers: request.headers,
        body_chunks: request.body_chunks,
    }
}

fn prepared_project_response_to_daemon(
    response: &PreparedProjectServiceResponse,
) -> PreparedDaemonResponse {
    PreparedDaemonResponse {
        status: response.status,
        headers: response.headers.clone(),
        body: response.body.clone(),
    }
}

struct ProjectServiceEndpointGuard {
    project_state_dir: PathBuf,
}

impl Drop for ProjectServiceEndpointGuard {
    fn drop(&mut self) {
        remove_metadata_endpoint(&self.project_state_dir);
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
