use anyhow::{Context, Result, bail};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::fs;
use std::io::{self, Read};
use std::net::{TcpListener, TcpStream};
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
use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};
use crate::expose_socket::{
    EXPOSE_SOCKET_HEADER_TIMEOUT_MS, clear_expose_socket_path, expose_socket_path,
    publish_expose_socket_path, read_expose_socket_header,
};
use crate::paths::{PathResolver, compute_project_id};
use crate::plugin_api::NativePluginStatus;
use crate::plugin_project_service_host::{
    builtin_plugin_tick_tasks, native_plugin_statuses_for_context,
};
use crate::project_service::agent_input_delivery::agent_input_delivery_task;
use crate::project_service::agent_restore_task::agent_restore_snapshot_task;
use crate::project_service::builtin_metadata_task::builtin_metadata_task;
use crate::project_service::loop_watcher_task::loop_watcher_task;
use crate::project_service::scheduler::{ProjectSchedulerHandle, spawn_project_service_scheduler};
use crate::project_service::scribe_watcher_task::scribe_watcher_task;
use crate::project_service::transcript_reconciler_task::transcript_reconciler_task;
use crate::runtime_lifecycle_methods::write_instruction_files;
use crate::tmux_expose::{
    ExposeHttpClient, ExposeHttpRequest, ExposeInputEvent, ExposeInputSource,
    SystemExposeHttpClient, run_tmux_expose_with_input_source,
    tmux_expose_options_from_socket_header,
};

use super::agent_output::{
    AgentOutputCaptureRuntime, AgentOutputResponseMode, SystemAgentOutputCaptureRuntime,
    read_agent_output_payload,
};
use super::dispatcher::ProjectServiceStreamKind;
use super::event_streams::{encode_sse_event, encode_sse_keepalive};
use super::http::PreparedProjectServiceResponse;
use super::interactions::register_interaction_watcher;
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
    log_lifecycle_always(
        "project service starting",
        "project-service",
        Some(json!({
            "projectId": startup.project_id.clone(),
            "projectRoot": startup.project_root.to_string_lossy(),
            "desiredPort": startup.desired_port,
        })),
    );
    if std::env::current_dir().ok().as_deref() != Some(startup.project_root.as_path()) {
        std::env::set_current_dir(&startup.project_root)
            .with_context(|| format!("chdir {}", startup.project_root.display()))?;
    }
    let _signal_guard = crate::process_signals::install_shutdown_signal_flag(
        crate::process_signals::DAEMON_TERMINATION_SIGNALS,
    )
    .context("install project-service shutdown signal handlers")?;
    let listener = bind_project_service_listener(startup.desired_port)?;
    let port = listener
        .local_addr()
        .context("read project-service listener address")?
        .port();
    publish_project_service_endpoint(&startup.project_state_dir, port)?;
    log_lifecycle_always(
        "project service listener published",
        "project-service",
        Some(json!({
            "projectId": startup.project_id.clone(),
            "projectRoot": startup.project_root.to_string_lossy(),
            "port": port,
        })),
    );
    let _endpoint_guard = ProjectServiceEndpointGuard {
        project_state_dir: startup.project_state_dir.clone(),
    };
    #[cfg(unix)]
    let _expose_socket_guard = start_project_expose_socket_for_service(&startup)?;
    let mut lifecycle_runtime = SystemProjectLifecycleRuntime;
    let startup_context = ProjectServiceRequestContext::with_project_state_dir(
        startup.project_root.clone(),
        startup.project_state_dir.clone(),
    );
    let plugin_statuses = native_plugin_statuses_for_context(&startup_context);
    let startup_context = startup_context.with_plugin_statuses(plugin_statuses.clone());
    run_project_service_startup_tasks(&startup, &startup_context, &mut lifecycle_runtime);
    log_at(
        LogLevel::Debug,
        "project service startup tasks finished",
        "project-service",
        Some(json!({
            "projectId": startup.project_id.clone(),
            "projectRoot": startup.project_root.to_string_lossy(),
            "pluginCount": plugin_statuses.len(),
        })),
    );
    serve_project_service_listener_until(listener, startup, plugin_statuses, || {
        crate::process_signals::received_shutdown_signal().is_some()
    });
    if let Some(signal_name) = crate::process_signals::received_shutdown_signal_name() {
        log_lifecycle_always(
            "project service signal shutdown returning through guards",
            "project-service",
            Some(json!({
                "signal": signal_name,
            })),
        );
    }
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
    let resolver = PathResolver::from_env();
    prepare_project_service_startup_with_resolver(options, resolver)
}

fn prepare_project_service_startup_with_resolver(
    options: ProjectServiceInternalOptions,
    resolver: PathResolver,
) -> Result<ProjectServiceStartup> {
    prepare_project_service_startup_with_resolver_and_process_context(
        options,
        resolver,
        crate::runtime_safety_guard::is_cargo_test_process_context(),
    )
}

fn prepare_project_service_startup_with_resolver_and_process_context(
    options: ProjectServiceInternalOptions,
    mut resolver: PathResolver,
    is_cargo_test_process: bool,
) -> Result<ProjectServiceStartup> {
    let requested_root = options
        .project_root
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let project_root = resolver.resolve_repo_root(requested_root);
    let project_id = options
        .project_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| compute_project_id(&project_root));
    let aimux_home = resolver.global_aimux_dir();
    if let Some(reason) =
        crate::runtime_safety_guard::project_materialization_refusal_reason_for_process(
            &project_root,
            &aimux_home,
            is_cargo_test_process,
        )
    {
        log_at(
            LogLevel::Debug,
            "project service startup refused",
            "runtime-safety",
            Some(json!({
                "projectId": project_id.clone(),
                "projectRoot": project_root.to_string_lossy(),
                "reason": reason,
                "source": "project-service-internal",
            })),
        );
        bail!(
            "refusing to materialize {reason}: {}",
            project_root.display()
        );
    }
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
    handle_project_service_connection_with_remote(stream, context, None)
}

fn handle_project_service_tcp_connection(
    stream: &mut TcpStream,
    context: &ProjectServiceRequestContext,
) -> Result<(), DaemonListenerError> {
    let remote_address = stream
        .peer_addr()
        .ok()
        .map(|address| address.ip().to_string());
    handle_project_service_connection_with_remote(stream, context, remote_address)
}

fn handle_project_service_connection_with_remote<Stream>(
    stream: &mut Stream,
    context: &ProjectServiceRequestContext,
    remote_address: Option<String>,
) -> Result<(), DaemonListenerError>
where
    Stream: std::io::Read + std::io::Write,
{
    let bytes = read_http_request(stream)?;
    let request = parse_daemon_http_request(&bytes)?;
    let request = project_request_from_daemon(request);
    let mut request_context = context
        .clone()
        .with_request_headers(request.headers.clone());
    if let Some(remote_address) = remote_address {
        request_context = request_context.with_remote_address(remote_address);
    }
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
    let _interaction_watcher = response
        .stream
        .as_ref()
        .filter(|stream| stream.kind == ProjectServiceStreamKind::AgentInteraction)
        .and_then(|_| {
            context.map(|context| register_interaction_watcher(context.project_state_dir()))
        });
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

fn serve_project_service_listener_until<Stop>(
    listener: TcpListener,
    startup: ProjectServiceStartup,
    plugin_statuses: Vec<NativePluginStatus>,
    should_stop: Stop,
) where
    Stop: Fn() -> bool,
{
    let scheduler = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(
            startup.project_root,
            startup.project_state_dir,
        )
        .with_scheduler(scheduler.clone())
        .with_osc_output_tap()
        .with_plugin_statuses(plugin_statuses)
        .with_hot_snapshot_background_refresh(),
    );
    let mut periodic_tasks = builtin_plugin_tick_tasks();
    // Order matters: the rail runs co-due tasks in sequence, and the two
    // watchers below may each hold it for 20s. The reconciler's 4s cadence is
    // the tightest on the rail, so it goes ahead of them — behind the metadata
    // watchers only, whose events it wants to read after, not settle over.
    periodic_tasks.push(builtin_metadata_task(&context));
    periodic_tasks.push(agent_restore_snapshot_task(&context));
    periodic_tasks.push(transcript_reconciler_task(&context));
    periodic_tasks.push(agent_input_delivery_task(&context));
    periodic_tasks.push(loop_watcher_task(&context));
    periodic_tasks.push(scribe_watcher_task(&context));
    log_lifecycle_always(
        "project service watcher rail starting",
        "watcher",
        Some(json!({
            "taskCount": periodic_tasks.len(),
            "projectRoot": context.project_root().to_string_lossy(),
            "projectStateDir": context.project_state_dir().to_string_lossy(),
        })),
    );
    spawn_project_service_scheduler(Arc::clone(&context), periodic_tasks, scheduler);
    log_lifecycle_always(
        "project service serving",
        "project-service",
        Some(json!({
            "projectRoot": context.project_root().to_string_lossy(),
            "projectStateDir": context.project_state_dir().to_string_lossy(),
        })),
    );
    if listener.set_nonblocking(true).is_err() {
        log_lifecycle_always(
            "project service listener could not enter signal-aware mode",
            "project-service",
            Some(json!({
                "projectRoot": context.project_root().to_string_lossy(),
            })),
        );
    }
    loop {
        if should_stop() {
            return;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let context = Arc::clone(&context);
                thread::spawn(move || {
                    let _ = handle_project_service_tcp_connection(&mut stream, &context);
                });
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(25));
            }
        }
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
fn start_project_expose_socket_for_service(
    startup: &ProjectServiceStartup,
) -> Result<ProjectExposeSocketGuard> {
    start_project_expose_socket(startup).context("start project expose socket")
}

#[cfg(unix)]
#[derive(Debug)]
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn unique_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-project-service-startup-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn resolver_for(root: &Path, aimux_home: &Path) -> PathResolver {
        PathResolver::new(
            root,
            root.join("home"),
            Some(aimux_home.to_string_lossy().into_owned()),
        )
    }

    fn create_git_checkout(path: &Path) {
        fs::create_dir_all(path.join(".git")).expect("create git checkout");
    }

    #[test]
    fn project_service_startup_refuses_temp_fixture_root_with_real_home_before_state_dir() {
        let root = unique_test_root("refuse-real-home");
        let project_root = root
            .join("aimux-rust-project-service-notifications-leak")
            .join("repo");
        create_git_checkout(&project_root);
        let aimux_home = root.join("real-aimux-home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        let resolver = resolver_for(&root, &aimux_home);

        let error = prepare_project_service_startup_with_resolver(
            ProjectServiceInternalOptions {
                project_root: Some(project_root.clone()),
                project_id: None,
            },
            resolver,
        )
        .expect_err("fixture temp project should not start against real aimux home");

        assert!(
            format!("{error:#}").contains("refusing to materialize cargo test harness"),
            "unexpected error: {error:#}"
        );
        assert!(
            !aimux_home.join("projects").exists(),
            "refused startup must not create a real-home project state dir"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_service_startup_allows_temp_aimux_named_checkout_for_non_test_process() {
        let root = unique_test_root("allow-temp-aimux-checkout");
        let project_root = root.join("aimux-real-temp-checkout");
        create_git_checkout(&project_root);
        let aimux_home = root.join("real-aimux-home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        let resolver = resolver_for(&root, &aimux_home);

        let startup = prepare_project_service_startup_with_resolver_and_process_context(
            ProjectServiceInternalOptions {
                project_root: Some(project_root.clone()),
                project_id: None,
            },
            resolver,
            false,
        )
        .expect("real temp git checkout should start for a non-test process");

        assert_eq!(startup.project_root, project_root);
        assert!(
            startup
                .project_state_dir
                .starts_with(aimux_home.join("projects"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_service_startup_allows_temp_git_checkout_with_isolated_home() {
        let root = unique_test_root("allow-isolated-home");
        let project_root = root.join("aimux-legitimate-temp-checkout");
        create_git_checkout(&project_root);
        let aimux_home = root.join("isolated-aimux-home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        fs::write(
            aimux_home.join(crate::runtime_safety_guard::TEST_ISOLATION_MARKER),
            r#"{"ownerPid":1,"kind":"cargo-test"}"#,
        )
        .expect("write isolation marker");
        let resolver = resolver_for(&root, &aimux_home);

        let startup = prepare_project_service_startup_with_resolver(
            ProjectServiceInternalOptions {
                project_root: Some(project_root.clone()),
                project_id: None,
            },
            resolver,
        )
        .expect("isolated temp git checkout should start");

        assert_eq!(startup.project_root, project_root);
        assert!(
            startup
                .project_state_dir
                .starts_with(aimux_home.join("projects"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expose_socket_startup_failure_is_returned_with_context() {
        let root = std::env::temp_dir().join(format!(
            "aimux-project-expose-socket-error-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let state_path = root.join("state-as-file");
        fs::create_dir_all(&root).expect("root");
        fs::write(&state_path, "not a directory").expect("state file");
        let startup = ProjectServiceStartup {
            project_id: "project".to_owned(),
            project_root: root.join("repo"),
            project_state_dir: state_path,
            desired_port: 0,
        };

        let error = start_project_expose_socket_for_service(&startup)
            .expect_err("socket startup should fail");

        assert!(
            format!("{error:#}").contains("start project expose socket"),
            "unexpected error: {error:#}"
        );
        let _ = fs::remove_dir_all(root);
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
    let context = ProjectServiceRequestContext::with_project_state_dir(
        fallback_project_root,
        fallback_project_state_dir,
    );
    let mut client = ProjectServiceExposeHttpClient {
        context,
        fallback: SystemExposeHttpClient,
    };
    let mut capture = crate::tmux_expose::SystemExposeTmuxCapture::default();
    let code = run_tmux_expose_with_input_source(
        options,
        &mut input,
        &mut stream,
        &mut client,
        &mut capture,
    );
    if let Some(status_path) = status_path {
        let _ = fs::write(status_path, format!("{code}\n"));
    }
    Ok(())
}

#[cfg(unix)]
struct ProjectServiceExposeHttpClient {
    context: ProjectServiceRequestContext,
    fallback: SystemExposeHttpClient,
}

#[cfg(unix)]
impl ExposeHttpClient for ProjectServiceExposeHttpClient {
    fn request_json(
        &mut self,
        url: &str,
        request: ExposeHttpRequest,
    ) -> Result<serde_json::Value, String> {
        let Some(path) = local_project_service_request_path(url) else {
            return self.fallback.request_json(url, request);
        };
        let response = route_project_service_request(
            &self.context,
            request.method.as_str(),
            &path,
            request.body.as_ref(),
        );
        if response.status >= 400 {
            return Err(response
                .body
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("project service expose request failed")
                .to_owned());
        }
        Ok(response.body)
    }
}

#[cfg(unix)]
fn local_project_service_request_path(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let slash = after_scheme.find('/')?;
    let path = &after_scheme[slash..];
    if path.starts_with(crate::project_api_contract::routes::controls::SWITCHABLE_AGENTS)
        || path.starts_with(crate::project_api_contract::routes::controls::FOCUS_WINDOW)
    {
        return Some(path.to_owned());
    }
    None
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

#[cfg(unix)]
impl ExposeInputSource for PrefixedRead<UnixStream> {
    fn read_timeout(&mut self, buffer: &mut [u8], timeout: Duration) -> ExposeInputEvent {
        if self.offset < self.prefix.len() {
            let available = self.prefix.len() - self.offset;
            let count = available.min(buffer.len());
            buffer[..count].copy_from_slice(&self.prefix[self.offset..self.offset + count]);
            self.offset += count;
            return ExposeInputEvent::Data(count);
        }
        let _ = self.inner.set_read_timeout(Some(timeout));
        let event = match self.inner.read(buffer) {
            Ok(0) => ExposeInputEvent::End,
            Ok(count) => ExposeInputEvent::Data(count),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                ExposeInputEvent::Timeout
            }
            Err(_) => ExposeInputEvent::Error,
        };
        let _ = self.inner.set_read_timeout(None);
        event
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
