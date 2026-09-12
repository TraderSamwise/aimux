use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::{self, Read};
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener as TokioTcpListener, TcpStream as TokioTcpStream};

use crate::backend_session_ids::reconcile_offline_backend_session_ids;
use crate::backlog_metrics::{
    BacklogMetric, SSE_AGENT_INTERACTION_BACKLOG, SSE_AGENT_OUTPUT_BACKLOG,
    SSE_PROJECT_EVENTS_BACKLOG, backlog_metric,
};
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
use crate::project_api_contract::{project_api_views_for_mutation_route, routes};
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
    read_agent_output_payload, read_agent_output_payload_async, route_agent_output_request_async,
};
use super::agents::route_agent_read_request_async;
use super::attachments::{is_attachment_route, route_attachment_request_async};
use super::controls::route_control_request_async;
use super::desktop_state::route_desktop_state_request_async;
use super::dispatcher::{
    ProjectServiceDispatchResponse, ProjectServiceStreamKind,
    route_unimplemented_project_service_request,
};
use super::event_streams::{encode_sse_event, encode_sse_keepalive};
use super::http::{
    MAX_BODY_BYTES, PreparedProjectServiceResponse, ProjectServiceBodyError,
    prepare_project_service_empty_response, prepare_project_service_json_response,
    project_service_cors_headers, read_json_body_limited, reject_project_service_cors_response,
};
use super::interactions::register_interaction_watcher;
use super::lifecycle::{
    LifecycleMutationProgress, ProjectLifecycleRuntime, SystemProjectLifecycleRuntime,
    async_lifecycle_progress_for_request, ensure_default_scribe_agent,
    route_lifecycle_request_async,
};
use super::output_metrics::AgentOutputReadRecord;
use super::router::{ProjectServiceRequestContext, route_project_service_request};
use super::server::{
    ProjectServiceHttpRequest, handle_project_service_http_request, method_reads_json_body,
    prepare_dispatch_response,
};
use super::statusline::route_statusline_refresh_request_async;
use super::switchable_agents::route_switchable_agent_request_async;

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
    crate::async_runtime::init_process_runtime()
        .context("initialize project-service async runtime")?;
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
    // aimux-async-seam: permanent - process entry starts async project-service listener
    crate::async_runtime::process_runtime().block_on(serve_project_service_listener_until(
        listener,
        startup,
        plugin_statuses,
        || crate::process_signals::received_shutdown_signal().is_some(),
    ));
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

async fn handle_project_service_tcp_connection_async(
    mut stream: TokioTcpStream,
    context: Arc<ProjectServiceRequestContext>,
    remote_address: Option<String>,
) -> Result<(), DaemonListenerError> {
    handle_project_service_connection_with_remote_async(&mut stream, context, remote_address).await
}

async fn handle_project_service_connection_with_remote_async<Stream>(
    stream: &mut Stream,
    context: Arc<ProjectServiceRequestContext>,
    remote_address: Option<String>,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let bytes = read_http_request_async(&mut reader).await?;
    let request = parse_daemon_http_request(&bytes)?;
    let request = project_request_from_daemon(request);
    let mut request_context = (*context)
        .clone()
        .with_request_headers(request.headers.clone());
    if let Some(remote_address) = remote_address {
        request_context = request_context.with_remote_address(remote_address);
    }
    let request_context = Arc::new(request_context);
    let response = handle_project_service_http_request_transport_async(
        request,
        Arc::clone(&request_context),
        &mut reader,
    )
    .await?;
    write_project_service_response_async(
        &mut writer,
        response.response,
        Some(request_context),
        response.lifecycle_progress,
    )
    .await
}

struct ProjectServiceTransportResponse {
    response: PreparedProjectServiceResponse,
    lifecycle_progress: Option<LifecycleMutationProgress>,
}

#[cfg(test)]
async fn handle_project_service_connection_with_remote_async_and_route<Stream, Route>(
    stream: &mut Stream,
    context: Arc<ProjectServiceRequestContext>,
    remote_address: Option<String>,
    route: Route,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    Route: FnOnce(
            ProjectServiceHttpRequest,
            Arc<ProjectServiceRequestContext>,
        ) -> PreparedProjectServiceResponse
        + Send
        + 'static,
{
    let bytes = read_http_request_async(stream).await?;
    let request = parse_daemon_http_request(&bytes)?;
    let request = project_request_from_daemon(request);
    let mut request_context = (*context)
        .clone()
        .with_request_headers(request.headers.clone());
    if let Some(remote_address) = remote_address {
        request_context = request_context.with_remote_address(remote_address);
    }
    let request_context = Arc::new(request_context);
    let response =
        route_project_service_request_blocking(request, Arc::clone(&request_context), route)
            .await?;
    write_project_service_response_async(stream, response, Some(request_context), None).await
}

#[cfg(test)]
async fn route_project_service_request_blocking<Route>(
    request: ProjectServiceHttpRequest,
    context: Arc<ProjectServiceRequestContext>,
    route: Route,
) -> Result<PreparedProjectServiceResponse, DaemonListenerError>
where
    Route: FnOnce(
            ProjectServiceHttpRequest,
            Arc<ProjectServiceRequestContext>,
        ) -> PreparedProjectServiceResponse
        + Send
        + 'static,
{
    let task_name = crate::async_runtime::scoped_task_name(
        "project-service",
        "route",
        &format!("{} {}", request.method, request.path),
    );
    crate::async_runtime::spawn_blocking_named(task_name, move || route(request, context))
        .await
        .map_err(|error| {
            DaemonListenerError::InvalidRequest(format!(
                "project service route task failed: {error}"
            ))
        })
}

async fn handle_project_service_http_request_transport_async<Reader>(
    request: ProjectServiceHttpRequest,
    context: Arc<ProjectServiceRequestContext>,
    reader: &mut Reader,
) -> Result<ProjectServiceTransportResponse, DaemonListenerError>
where
    Reader: AsyncRead + Unpin,
{
    let cors = match project_service_cors_headers(&request.headers) {
        Some(headers) => headers,
        None => {
            return Ok(ProjectServiceTransportResponse {
                response: reject_project_service_cors_response(),
                lifecycle_progress: None,
            });
        }
    };

    if request.method.eq_ignore_ascii_case("OPTIONS") {
        return Ok(ProjectServiceTransportResponse {
            response: prepare_project_service_empty_response(204, cors),
            lifecycle_progress: None,
        });
    }

    let body = if method_reads_json_body(&request.method) {
        match read_json_body_limited(
            request.body_chunks.iter().map(Vec::as_slice),
            MAX_BODY_BYTES,
        ) {
            Ok(value) => Some(value),
            Err(ProjectServiceBodyError::TooLarge(error)) => {
                return Ok(ProjectServiceTransportResponse {
                    response: prepare_project_service_json_response(
                        413,
                        json!({ "ok": false, "error": error.to_string() }),
                        cors,
                    ),
                    lifecycle_progress: None,
                });
            }
            Err(_) => {
                return Ok(ProjectServiceTransportResponse {
                    response: prepare_project_service_json_response(
                        400,
                        json!({ "ok": false, "error": "body is not JSON" }),
                        cors,
                    ),
                    lifecycle_progress: None,
                });
            }
        }
    } else {
        None
    };

    if let Some(progress) =
        async_lifecycle_progress_for_request(&request.method, &request.path, body.as_ref())
    {
        let response = route_async_lifecycle_with_disconnect(
            Arc::clone(&context),
            request.method,
            request.path,
            body,
            progress.clone(),
            reader,
        )
        .await?;
        return Ok(ProjectServiceTransportResponse {
            response: prepare_dispatch_response(response, cors),
            lifecycle_progress: Some(progress),
        });
    }

    if async_agent_output_route(&request.method, &request.path) {
        let method = request.method;
        let path = request.path;
        let response = route_async_agent_output_with_disconnect(
            Arc::clone(&context),
            method,
            path,
            body,
            reader,
        )
        .await?;
        return Ok(ProjectServiceTransportResponse {
            response: prepare_dispatch_response(response, cors),
            lifecycle_progress: None,
        });
    }

    if is_attachment_route(&request.method, &request.path) {
        let method = request.method;
        let path = request.path;
        let response = route_attachment_request_async(
            Arc::clone(&context),
            method.clone(),
            path.clone(),
            body,
        )
        .await
        .unwrap_or_else(|| route_project_service_request(&context, &method, &path, None));
        return Ok(ProjectServiceTransportResponse {
            response: prepare_dispatch_response(response, cors),
            lifecycle_progress: None,
        });
    }

    if async_read_control_route(&request.method, &request.path) {
        let method = request.method;
        let path = request.path;
        let response =
            route_async_read_control(Arc::clone(&context), method.clone(), path.clone(), body)
                .await?;
        publish_async_route_project_update(&context, &method, &path, &response);
        return Ok(ProjectServiceTransportResponse {
            response: prepare_dispatch_response(response, cors),
            lifecycle_progress: None,
        });
    }

    let method = request.method;
    let path = request.path;
    let response = route_project_service_dispatch_blocking(
        method,
        path,
        body,
        Arc::clone(&context),
        |method, path, body, context| {
            route_project_service_request(&context, &method, &path, body.as_ref())
        },
    )
    .await?;
    Ok(ProjectServiceTransportResponse {
        response: prepare_dispatch_response(response, cors),
        lifecycle_progress: None,
    })
}

async fn route_project_service_dispatch_blocking<Route>(
    method: String,
    path: String,
    body: Option<Value>,
    context: Arc<ProjectServiceRequestContext>,
    route: Route,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError>
where
    Route: FnOnce(
            String,
            String,
            Option<Value>,
            Arc<ProjectServiceRequestContext>,
        ) -> ProjectServiceDispatchResponse
        + Send
        + 'static,
{
    let task_name = crate::async_runtime::scoped_task_name(
        "project-service",
        "route",
        &format!("{method} {path}"),
    );
    crate::async_runtime::spawn_blocking_named(task_name, move || {
        route(method, path, body, context)
    })
    .await
    .map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("project service route task failed: {error}"))
    })
}

fn async_agent_output_route(method: &str, path: &str) -> bool {
    let pathname = super::dispatcher::project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") {
        return matches!(pathname, routes::agents::OUTPUT | routes::live_pane::OUTPUT);
    }
    if !method.eq_ignore_ascii_case("POST") {
        return false;
    }
    matches!(
        pathname,
        routes::agents::INPUT
            | routes::live_pane::INPUT
            | routes::live_pane::ATTACH
            | routes::live_pane::RESIZE
            | routes::agents::INTERRUPT
            | routes::live_pane::INTERRUPT
    )
}

fn async_read_control_route(method: &str, path: &str) -> bool {
    let pathname = super::dispatcher::project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") {
        return matches!(
            pathname,
            routes::agents::LIST
                | routes::agents::TEAMMATES
                | routes::DESKTOP_STATE
                | routes::controls::SWITCHABLE_AGENTS
                | routes::controls::OPEN_DASHBOARD
                | routes::controls::OPEN_NOTIFICATION_TARGET
                | routes::controls::FOCUS_WINDOW
                | routes::controls::ACTIVE_WINDOW
                | routes::controls::SWITCH_NEXT
                | routes::controls::SWITCH_PREV
                | routes::controls::SWITCH_ATTENTION
        );
    }
    if method.eq_ignore_ascii_case("POST") {
        return matches!(
            pathname,
            routes::controls::OPEN_DASHBOARD
                | routes::controls::OPEN_NOTIFICATION_TARGET
                | routes::controls::FOCUS_WINDOW
                | routes::controls::ACTIVE_WINDOW
                | routes::controls::SWITCH_NEXT
                | routes::controls::SWITCH_PREV
                | routes::controls::SWITCH_ATTENTION
                | routes::STATUSLINE_REFRESH
        );
    }
    false
}

async fn route_async_read_control(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError> {
    if let Some(response) = route_agent_read_request_async(&context, &method, &path).await {
        return Ok(response);
    }
    if let Some(response) = route_desktop_state_request_async(&context, &method, &path).await {
        return Ok(response);
    }
    if let Some(response) = route_switchable_agent_request_async(&context, &method, &path).await {
        return Ok(response);
    }
    if let Some(response) =
        route_control_request_async(&context, &method, &path, body.as_ref()).await
    {
        return Ok(response);
    }
    if let Some(response) =
        route_statusline_refresh_request_async(&context, &method, &path, body.as_ref()).await
    {
        return Ok(response);
    }
    Ok(route_unimplemented_project_service_request(&method, &path))
}

async fn route_async_agent_output_with_disconnect<Reader>(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
    reader: &mut Reader,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError>
where
    Reader: AsyncRead + Unpin,
{
    route_async_agent_output_with_disconnect_and_route(
        context,
        method,
        path,
        body,
        reader,
        |context, method, path, body, irreversible_input| async move {
            route_agent_output_request_async(
                &context,
                &method,
                &path,
                body.as_ref(),
                Some(&irreversible_input),
            )
            .await
        },
    )
    .await
}

async fn route_async_agent_output_with_disconnect_and_route<Reader, Route, Fut>(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
    reader: &mut Reader,
    route: Route,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError>
where
    Reader: AsyncRead + Unpin,
    Route: FnOnce(
        Arc<ProjectServiceRequestContext>,
        String,
        String,
        Option<Value>,
        Arc<AtomicBool>,
    ) -> Fut,
    Fut: std::future::Future<Output = Option<ProjectServiceDispatchResponse>>,
{
    let irreversible_input = Arc::new(AtomicBool::new(false));
    let route_context = Arc::clone(&context);
    let route = route(
        route_context,
        method.clone(),
        path.clone(),
        body.clone(),
        Arc::clone(&irreversible_input),
    );
    tokio::pin!(route);
    tokio::select! {
        response = &mut route => {
            let response = response.unwrap_or_else(|| {
                route_project_service_request(&context, &method, &path, body.as_ref())
            });
            publish_async_route_project_update(&context, &method, &path, &response);
            Ok(response)
        },
        disconnect = wait_for_client_disconnect(reader) => {
            disconnect?;
            if irreversible_input.load(Ordering::SeqCst) {
                let response = route.await.unwrap_or_else(|| {
                    route_project_service_request(&context, &method, &path, body.as_ref())
                });
                publish_async_route_project_update(&context, &method, &path, &response);
                Ok(response)
            } else {
                Err(DaemonListenerError::InvalidRequest(format!(
                    "client disconnected before {} {} completed",
                    method,
                    super::dispatcher::project_service_pathname(&path)
                )))
            }
        }
    }
}

fn publish_async_route_project_update(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    response: &ProjectServiceDispatchResponse,
) {
    if !(200..300).contains(&response.status) {
        return;
    }
    let pathname = super::dispatcher::project_service_pathname(path);
    if project_api_views_for_mutation_route(method, pathname).is_none() {
        return;
    }
    context.project_events.publish_project_update_for_route(
        context.project_root(),
        method,
        pathname,
        None,
        None,
    );
}

async fn route_async_lifecycle_with_disconnect<Reader>(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
    progress: LifecycleMutationProgress,
    reader: &mut Reader,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError>
where
    Reader: AsyncRead + Unpin,
{
    route_async_lifecycle_with_disconnect_and_route(
        context,
        method,
        path,
        body,
        progress,
        reader,
        |context, method, path, body, progress| async move {
            route_lifecycle_request_async(&context, &method, &path, body.as_ref(), &progress).await
        },
    )
    .await
}

async fn route_async_lifecycle_with_disconnect_and_route<Reader, Route, Fut>(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
    progress: LifecycleMutationProgress,
    reader: &mut Reader,
    route: Route,
) -> Result<ProjectServiceDispatchResponse, DaemonListenerError>
where
    Reader: AsyncRead + Unpin,
    Route: FnOnce(
        Arc<ProjectServiceRequestContext>,
        String,
        String,
        Option<Value>,
        LifecycleMutationProgress,
    ) -> Fut,
    Fut: std::future::Future<Output = Option<ProjectServiceDispatchResponse>>,
{
    let route_context = Arc::clone(&context);
    let route_progress = progress.clone();
    let route = route(
        route_context,
        method.clone(),
        path.clone(),
        body.clone(),
        route_progress,
    );
    tokio::pin!(route);
    tokio::select! {
        response = &mut route => Ok(response.unwrap_or_else(|| {
            route_project_service_request(&context, &method, &path, body.as_ref())
        })),
        disconnect = wait_for_client_disconnect(reader) => {
            disconnect?;
            if progress.is_irreversible() {
                let record_result = record_lifecycle_response_abandoned(&context, &progress);
                let response = route.await.unwrap_or_else(|| {
                    route_project_service_request(&context, &method, &path, body.as_ref())
                });
                record_result?;
                Ok(response)
            } else {
                Err(DaemonListenerError::InvalidRequest(format!(
                    "client disconnected before {} mutation completed",
                    progress.operation()
                )))
            }
        }
    }
}

async fn wait_for_client_disconnect(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<(), DaemonListenerError> {
    let mut buffer = [0_u8; 1];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(error) => return Err(DaemonListenerError::Io(error)),
        }
    }
}

fn record_lifecycle_response_abandoned(
    context: &ProjectServiceRequestContext,
    progress: &LifecycleMutationProgress,
) -> Result<(), DaemonListenerError> {
    if !progress.mark_abandoned_recorded() {
        return Ok(());
    }
    log_lifecycle_always(
        "lifecycle mutation completed after caller disconnected",
        "project-service",
        Some(json!({
            "operation": progress.operation(),
            "targetKind": progress.target_kind(),
            "targetId": progress.target_id(),
            "projectRoot": context.project_root().display().to_string(),
        })),
    );
    if let Err((error, _failure)) =
        crate::project_service::operation_failures::try_add_dashboard_operation_failure(
            context.project_state_dir(),
            crate::project_service::operation_failures::OperationFailureInput {
                target_kind: progress.target_kind().to_owned(),
                operation: progress.operation().to_owned(),
                title: "Lifecycle response was not delivered".into(),
                message: format!(
                    "{} completed after the caller disconnected; refresh before retrying.",
                    progress.operation()
                ),
                target_id: progress.target_id().map(str::to_owned),
                worktree_path: None,
                worktree_name: None,
                created_at: None,
            },
        )
    {
        progress.reset_abandoned_recorded();
        log_lifecycle_always(
            "failed to record abandoned lifecycle response",
            "project-service",
            Some(json!({
                "operation": progress.operation(),
                "targetKind": progress.target_kind(),
                "targetId": progress.target_id(),
                "projectRoot": context.project_root().display().to_string(),
                "error": error.to_string(),
            })),
        );
        return Err(DaemonListenerError::Io(io::Error::other(format!(
            "failed to record abandoned lifecycle response for {}: {error}",
            progress.operation()
        ))));
    }
    Ok(())
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
        let _subscriber_guard = enter_sse_subscriber(stream.kind);
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

async fn write_project_service_response_async<Writer>(
    writer: &mut Writer,
    response: PreparedProjectServiceResponse,
    context: Option<Arc<ProjectServiceRequestContext>>,
    lifecycle_progress: Option<LifecycleMutationProgress>,
) -> Result<(), DaemonListenerError>
where
    Writer: AsyncWrite + Unpin + Send,
{
    let _interaction_watcher = response
        .stream
        .as_ref()
        .filter(|stream| stream.kind == ProjectServiceStreamKind::AgentInteraction)
        .and_then(|_| {
            context
                .as_ref()
                .map(|context| register_interaction_watcher(context.project_state_dir()))
        });
    if let Err(error) = writer
        .write_all(&prepared_response_bytes(
            &prepared_project_response_to_daemon(&response),
        ))
        .await
    {
        record_abandoned_lifecycle_response_on_write_error(&context, &lifecycle_progress, &error)?;
        return Err(DaemonListenerError::Io(error));
    }
    if let Err(error) = writer.flush().await {
        record_abandoned_lifecycle_response_on_write_error(&context, &lifecycle_progress, &error)?;
        return Err(DaemonListenerError::Io(error));
    }
    let Some(stream) = response.stream else {
        return Ok(());
    };
    let _subscriber_guard = enter_sse_subscriber(stream.kind);
    let interval_ms = u64::try_from(stream.interval_ms).unwrap_or(500).max(100);
    let mut state = ProjectServiceStreamState {
        last_output_fingerprint: None,
        last_project_event_sequence: stream.event_cursor.unwrap_or_default(),
        last_stream_write: Instant::now(),
    };
    loop {
        wait_for_next_stream_tick_async(
            &stream,
            context.as_deref(),
            state.last_project_event_sequence,
            interval_ms,
            state.last_stream_write,
        )
        .await;
        let (next_state, frame) =
            encode_stream_frame_async(stream.clone(), context.clone(), state).await?;
        state = next_state;
        if frame.is_empty() {
            continue;
        }
        writer.write_all(&frame).await?;
        writer.flush().await?;
        if stream.kind != ProjectServiceStreamKind::AgentOutput {
            state.last_stream_write = Instant::now();
        }
    }
}

struct SseSubscriberGuard {
    metric: BacklogMetric,
}

impl Drop for SseSubscriberGuard {
    fn drop(&mut self) {
        self.metric.decrement();
    }
}

fn enter_sse_subscriber(kind: ProjectServiceStreamKind) -> SseSubscriberGuard {
    let metric = backlog_metric(sse_subscriber_metric_name(kind), None);
    metric.increment();
    SseSubscriberGuard { metric }
}

fn sse_subscriber_metric_name(kind: ProjectServiceStreamKind) -> &'static str {
    match kind {
        ProjectServiceStreamKind::ProjectEvents => SSE_PROJECT_EVENTS_BACKLOG,
        ProjectServiceStreamKind::AgentOutput => SSE_AGENT_OUTPUT_BACKLOG,
        ProjectServiceStreamKind::AgentInteraction => SSE_AGENT_INTERACTION_BACKLOG,
    }
}

fn record_abandoned_lifecycle_response_on_write_error(
    context: &Option<Arc<ProjectServiceRequestContext>>,
    progress: &Option<LifecycleMutationProgress>,
    write_error: &io::Error,
) -> Result<(), DaemonListenerError> {
    let (Some(context), Some(progress)) = (context.as_ref(), progress.as_ref()) else {
        return Ok(());
    };
    if progress.is_irreversible() {
        record_lifecycle_response_abandoned(context, progress).map_err(|record_error| {
            DaemonListenerError::Io(io::Error::other(format!(
                "{write_error}; additionally failed to record abandoned lifecycle response: {record_error}"
            )))
        })?;
    }
    Ok(())
}

#[derive(Debug)]
struct ProjectServiceStreamState {
    last_output_fingerprint: Option<String>,
    last_project_event_sequence: u64,
    last_stream_write: Instant,
}

async fn wait_for_next_stream_tick_async(
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
            .wait_for_events_since_async(after_sequence, None, wait)
            .await;
        return;
    }
    tokio::time::sleep(Duration::from_millis(interval_ms)).await;
}

async fn encode_stream_frame_async(
    stream: super::dispatcher::ProjectServiceStreamPlan,
    context: Option<Arc<ProjectServiceRequestContext>>,
    state: ProjectServiceStreamState,
) -> Result<(ProjectServiceStreamState, Vec<u8>), DaemonListenerError> {
    let mut state = state;
    let frame = match stream.kind {
        ProjectServiceStreamKind::ProjectEvents => {
            let frame = encode_project_event_stream_frame_async(
                &stream,
                context.as_deref(),
                &mut state.last_project_event_sequence,
                &mut state.last_output_fingerprint,
            )
            .await;
            if frame.is_empty() && stream_keepalive_due(&stream, state.last_stream_write) {
                encode_sse_keepalive()
            } else {
                frame
            }
        }
        ProjectServiceStreamKind::AgentOutput => {
            encode_agent_output_stream_frame_async(
                &stream,
                context.as_deref(),
                &mut state.last_output_fingerprint,
            )
            .await
        }
        ProjectServiceStreamKind::AgentInteraction => {
            if stream_keepalive_due(&stream, state.last_stream_write) {
                encode_sse_keepalive()
            } else {
                Vec::new()
            }
        }
    };
    Ok((state, frame))
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

async fn encode_project_event_stream_frame_async(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: Option<&ProjectServiceRequestContext>,
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
        bytes.extend(
            encode_project_event_output_frame_async(
                stream,
                context,
                session_id,
                last_output_fingerprint,
            )
            .await,
        );
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

async fn encode_project_event_output_frame_async(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: &ProjectServiceRequestContext,
    session_id: &str,
    last_output_fingerprint: &mut Option<String>,
) -> Vec<u8> {
    let mode = match stream.mode.as_deref() {
        Some("chat") => AgentOutputResponseMode::Chat,
        _ => AgentOutputResponseMode::Full,
    };
    match read_agent_output_payload_async(
        context,
        session_id,
        stream.start_line,
        mode,
        Duration::from_secs(2),
    )
    .await
    {
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

async fn encode_agent_output_stream_frame_async(
    stream: &super::dispatcher::ProjectServiceStreamPlan,
    context: Option<&ProjectServiceRequestContext>,
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
    match read_agent_output_payload_async(
        context,
        session_id,
        stream.start_line,
        mode,
        Duration::from_secs(2),
    )
    .await
    {
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

async fn serve_project_service_listener_until<Stop>(
    listener: StdTcpListener,
    startup: ProjectServiceStartup,
    plugin_statuses: Vec<NativePluginStatus>,
    should_stop: Stop,
) where
    Stop: Fn() -> bool + Send + 'static,
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
    // Order matters: the tick loop runs co-due tasks in sequence, and the two
    // watchers below may each hold it for 20s. The reconciler's 4s cadence is
    // the tightest on the tick loop, so it goes ahead of them — behind the metadata
    // watchers only, whose events it wants to read after, not settle over.
    periodic_tasks.push(builtin_metadata_task(&context));
    periodic_tasks.push(agent_restore_snapshot_task(&context));
    periodic_tasks.push(transcript_reconciler_task(&context));
    periodic_tasks.push(agent_input_delivery_task(&context));
    periodic_tasks.push(loop_watcher_task(&context));
    periodic_tasks.push(scribe_watcher_task(&context));
    log_lifecycle_always(
        "project service watcher tick loop starting",
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
    serve_project_service_connections_until(listener, context, should_stop).await;
}

async fn serve_project_service_connections_until<Stop>(
    listener: StdTcpListener,
    context: Arc<ProjectServiceRequestContext>,
    should_stop: Stop,
) where
    Stop: Fn() -> bool + Send + 'static,
{
    if listener.set_nonblocking(true).is_err() {
        log_lifecycle_always(
            "project service listener could not enter signal-aware mode",
            "project-service",
            Some(json!({
                "projectRoot": context.project_root().to_string_lossy(),
            })),
        );
    }
    let listener = match TokioTcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            log_lifecycle_always(
                "project service listener could not enter async mode",
                "project-service",
                Some(json!({
                    "projectRoot": context.project_root().to_string_lossy(),
                    "error": error.to_string(),
                })),
            );
            return;
        }
    };
    loop {
        if should_stop() {
            return;
        }
        match tokio::time::timeout(Duration::from_millis(25), listener.accept()).await {
            Ok(Ok((stream, remote_address))) => {
                let context = Arc::clone(&context);
                let remote_address = Some(remote_address.ip().to_string());
                let task_name = crate::async_runtime::scoped_task_name(
                    "project-service",
                    "http-connection",
                    remote_address.as_deref().unwrap_or("unknown"),
                );
                crate::async_runtime::spawn_named(task_name, async move {
                    if let Err(error) =
                        handle_project_service_tcp_connection_async(stream, context, remote_address)
                            .await
                    {
                        log_at(
                            LogLevel::Debug,
                            "project service connection failed",
                            "project-service",
                            Some(json!({
                                "error": error.to_string(),
                            })),
                        );
                    }
                });
            }
            Ok(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Ok(Err(error)) => {
                log_at(
                    LogLevel::Debug,
                    "project service listener accept failed",
                    "project-service",
                    Some(json!({
                        "error": error.to_string(),
                    })),
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(_) => {}
        }
    }
}

fn bind_project_service_listener(desired_port: u16) -> Result<StdTcpListener> {
    StdTcpListener::bind(("127.0.0.1", desired_port))
        .or_else(|_| StdTcpListener::bind(("127.0.0.1", 0)))
        .context("bind project-service listener")
}

async fn read_http_request_async(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<Vec<u8>, DaemonListenerError> {
    const MAX_HEADER_BYTES: usize = 64 * 1024;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_http_request_len(&bytes)? {
            bytes.truncate(length);
            return Ok(bytes);
        }
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            if bytes.is_empty() {
                return Err(DaemonListenerError::InvalidRequest(
                    "empty HTTP request".into(),
                ));
            }
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if find_bytes(&bytes, b"\r\n\r\n").is_none() && bytes.len() > MAX_HEADER_BYTES {
            return Err(DaemonListenerError::InvalidRequest(
                "HTTP request headers are too large".into(),
            ));
        }
    }
}

fn complete_http_request_len(bytes: &[u8]) -> Result<Option<usize>, DaemonListenerError> {
    let Some(header_end) = find_bytes(bytes, b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    if transfer_encoding_chunked(headers) {
        return Ok(complete_chunked_body_len(&bytes[header_end + 4..])
            .map(|length| header_end + 4 + length));
    }
    let content_length = content_length(headers)?;
    let body_start = header_end + 4;
    let total = body_start.checked_add(content_length).ok_or_else(|| {
        DaemonListenerError::InvalidRequest("request body length overflows usize".into())
    })?;
    Ok((bytes.len() >= total).then_some(total))
}

fn content_length(headers: &str) -> Result<usize, DaemonListenerError> {
    let mut length = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            if line.is_empty() {
                continue;
            }
            return Err(DaemonListenerError::InvalidRequest(format!(
                "invalid HTTP header: {line}"
            )));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let parsed = value.trim().parse::<usize>().map_err(|_| {
                DaemonListenerError::InvalidRequest(format!(
                    "invalid content-length: {}",
                    value.trim()
                ))
            })?;
            length = Some(parsed);
        }
    }
    Ok(length.unwrap_or(0))
}

fn transfer_encoding_chunked(headers: &str) -> bool {
    headers
        .split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
        })
}

fn complete_chunked_body_len(bytes: &[u8]) -> Option<usize> {
    let mut index = 0;
    loop {
        let line_end = find_bytes(&bytes[index..], b"\r\n")? + index;
        let line = std::str::from_utf8(&bytes[index..line_end]).ok()?;
        let size = chunk_size(line).ok()?;
        index = line_end + 2;
        if size == 0 {
            let trailer_end =
                find_bytes(&bytes[index..], b"\r\n\r\n").map(|offset| index + offset + 4);
            return trailer_end.or_else(|| {
                bytes
                    .get(index..index + 2)
                    .filter(|value| *value == b"\r\n")
                    .map(|_| index + 2)
            });
        }
        index = index.checked_add(size)?.checked_add(2)?;
        if bytes.get(index - 2..index)? != b"\r\n" {
            return None;
        }
    }
}

fn chunk_size(line: &str) -> Result<usize, DaemonListenerError> {
    let size = line
        .split_once(';')
        .map(|(size, _)| size)
        .unwrap_or(line)
        .trim();
    usize::from_str_radix(size, 16)
        .map_err(|_| DaemonListenerError::InvalidRequest(format!("invalid chunk size: {size}")))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
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
    use crate::project_api_contract::routes;
    use crate::project_service::dispatcher::ProjectServiceStreamPlan;
    use crate::project_service::http::{
        prepare_project_service_json_response, prepare_project_service_sse_response,
    };
    use crate::project_service::lifecycle::{
        AsyncProjectLifecycleRuntime, route_lifecycle_request_async_with_runtime,
    };
    use crate::runtime_topology::{
        read_runtime_topology, runtime_topology_path, write_runtime_topology,
    };
    use crate::tmux::TmuxTarget;
    use std::collections::BTreeSet;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

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

    fn write_running_agent_topology(state_dir: &Path, project_root: &Path) {
        let project_root = project_root.to_string_lossy();
        write_runtime_topology(
            runtime_topology_path(state_dir),
            &json!({
                "version": 1,
                "generatedAt": "2026-01-01T00:00:00.000Z",
                "rigs": [{
                    "id": "rig",
                    "name": "repo",
                    "projectRoot": project_root,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                }],
                "nodes": [{
                    "id": "node-agent",
                    "rigId": "rig",
                    "logicalId": "codex-live",
                    "runtime": "codex",
                    "toolConfigKey": "codex",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                }],
                "bindings": [{
                    "id": "binding-agent",
                    "nodeId": "node-agent",
                    "tmuxWindowId": "@agent",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                }],
                "sessions": [{
                    "id": "codex-live",
                    "nodeId": "node-agent",
                    "status": "running",
                    "command": "codex",
                    "toolConfigKey": "codex",
                    "args": [],
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                }],
                "services": [],
                "worktrees": [],
                "worktreeGraveyard": [],
                "teamRoles": [],
                "remoteClients": [],
                "lifecycleOperations": [],
                "exchangeRefs": [],
            }),
        )
        .expect("write topology");
    }

    #[test]
    fn async_read_control_routes_bypass_blocking_dispatcher() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-read-control");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            fs::create_dir_all(&state_dir).expect("create state dir");
            write_running_agent_topology(&state_dir, &project_root);
            let context = Arc::new(
                ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
                    .with_live_window_ids_error("tmux socket busy"),
            );
            let mut reader = tokio::io::empty();
            let request = ProjectServiceHttpRequest {
                method: "GET".to_owned(),
                path: routes::agents::LIST.to_owned(),
                headers: Default::default(),
                body_chunks: Vec::new(),
            };

            let response =
                handle_project_service_http_request_transport_async(request, context, &mut reader)
                    .await
                    .expect("async read route returns");
            assert_eq!(response.response.status, 200);
            let body: Value =
                serde_json::from_slice(&response.response.body).expect("JSON response body");
            assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
            assert_eq!(
                body.pointer("/tmuxLiveWindowQuery/ok"),
                Some(&Value::Bool(false))
            );
            assert_eq!(
                body.pointer("/tmuxLiveWindowQuery/error"),
                Some(&Value::String("tmux socket busy".to_owned()))
            );
            let sessions = body
                .get("agents")
                .and_then(Value::as_array)
                .expect("agents array");
            assert_eq!(sessions.len(), 1);
            let _ = fs::remove_dir_all(root);
        });
    }

    struct PendingKillLifecycleRuntime {
        killed: Arc<Mutex<Vec<String>>>,
        kill_started: mpsc::Sender<()>,
        kill_release: Option<oneshot::Receiver<()>>,
        kill_error: Option<String>,
    }

    impl PendingKillLifecycleRuntime {
        fn new(
            killed: Arc<Mutex<Vec<String>>>,
            kill_started: mpsc::Sender<()>,
            kill_release: oneshot::Receiver<()>,
        ) -> Self {
            Self {
                killed,
                kill_started,
                kill_release: Some(kill_release),
                kill_error: None,
            }
        }

        fn with_error(
            killed: Arc<Mutex<Vec<String>>>,
            kill_started: mpsc::Sender<()>,
            kill_error: impl Into<String>,
        ) -> Self {
            Self {
                killed,
                kill_started,
                kill_release: None,
                kill_error: Some(kill_error.into()),
            }
        }
    }

    impl AsyncProjectLifecycleRuntime for PendingKillLifecycleRuntime {
        async fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
            Ok(())
        }

        async fn create_window(
            &mut self,
            session_name: &str,
            name: &str,
            _cwd: &str,
            _command: &str,
            _args: &[String],
            _detached: bool,
        ) -> Result<TmuxTarget, String> {
            Ok(TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: format!("@{name}"),
                window_index: 1,
                window_name: name.to_owned(),
                pane_dead: None,
            })
        }

        async fn set_window_metadata(
            &mut self,
            _window_id: &str,
            _metadata: &Value,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn set_window_option(
            &mut self,
            _window_id: &str,
            _key: &str,
            _value: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn clear_history(&mut self, _window_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn wait_for_window_after_launch(
            &mut self,
            _target: &TmuxTarget,
            _timeout: Duration,
        ) -> bool {
            true
        }

        fn codex_backend_session_ids_for_cwd(
            &mut self,
            _cwd: &str,
        ) -> Result<BTreeSet<String>, String> {
            Ok(BTreeSet::new())
        }

        async fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
            self.kill_started.send(()).expect("signal kill started");
            if let Some(release) = self.kill_release.take() {
                let _ = release.await;
            }
            self.killed
                .lock()
                .expect("killed lock")
                .push(window_id.to_owned());
            match &self.kill_error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }
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

    #[test]
    fn async_connection_routes_http_to_rust_project_router() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-connection");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(
                ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
                    .with_live_window_ids(["@1"]),
            );
            let (mut client, mut server) = tokio::io::duplex(4096);
            let task = tokio::spawn(async move {
                handle_project_service_connection_with_remote_async(&mut server, context, None)
                    .await
            });

            client
                .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .await
                .expect("write request");
            let response = read_until_contains(&mut client, "\"ok\":true").await;

            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(response.contains("content-type: application/json\r\n"));
            task.await
                .expect("connection task joins")
                .expect("connection succeeds");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_listener_serves_complete_request_while_slowloris_waits() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-slowloris");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            fs::create_dir_all(&state_dir).expect("create state dir");
            let listener = StdTcpListener::bind(("127.0.0.1", 0)).expect("bind listener");
            let port = listener.local_addr().expect("read listener address").port();
            let should_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let should_stop_listener = Arc::clone(&should_stop);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let listener_task = crate::async_runtime::spawn_named(
                "project-service-test:async-slowloris-listener",
                async move {
                    serve_project_service_connections_until(listener, context, move || {
                        should_stop_listener.load(Ordering::SeqCst)
                    })
                    .await;
                },
            );

            let mut slow = TokioTcpStream::connect(("127.0.0.1", port))
                .await
                .expect("connect slow client");
            slow.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1")
                .await
                .expect("write partial request");
            tokio::time::sleep(Duration::from_millis(50)).await;

            let mut fast = TokioTcpStream::connect(("127.0.0.1", port))
                .await
                .expect("connect fast client");
            fast.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .await
                .expect("write complete request");
            let response = read_until_contains(&mut fast, "\"ok\":true").await;

            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            drop(slow);
            should_stop.store(true, Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(2), listener_task)
                .await
                .expect("listener should stop")
                .expect("listener task should join");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_connection_cancelled_during_blocking_route_writes_no_partial_response() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-cancel-blocking");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let (mut client, mut server) = tokio::io::duplex(4096);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-cancel-blocking-route",
                async move {
                    handle_project_service_connection_with_remote_async_and_route(
                        &mut server,
                        context,
                        None,
                        move |_request, _context| {
                            started_tx.send(()).expect("signal route started");
                            release_rx.recv().expect("release blocking route");
                            prepare_project_service_json_response(
                                200,
                                json!({ "ok": true }),
                                Default::default(),
                            )
                        },
                    )
                    .await
                },
            );

            client
                .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .await
                .expect("write request");
            wait_for_signal(&started_rx, "route started").await;
            task.abort();
            let mut buffer = [0_u8; 64];
            let read =
                tokio::time::timeout(Duration::from_millis(150), client.read(&mut buffer)).await;
            match read {
                Err(_) => {}
                Ok(Ok(0)) => {}
                Ok(Ok(count)) => panic!(
                    "connection wrote response bytes before the blocking route completed: {:?}",
                    String::from_utf8_lossy(&buffer[..count])
                ),
                Ok(Err(error)) => panic!("read failed before cancellation settled: {error}"),
            }
            release_tx.send(()).expect("release blocking route");
            let _ = task.await;
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_lifecycle_transport_covers_destructive_agent_routes_only() {
        let body = json!({ "sessionId": "codex-live", "tool": "codex" });
        for path in [
            routes::agents::SPAWN,
            routes::agents::STOP,
            routes::agents::KILL,
        ] {
            assert!(
                async_lifecycle_progress_for_request("POST", path, Some(&body)).is_some(),
                "{path} should use the cancellable lifecycle transport"
            );
        }
        for path in [
            routes::agents::FORK,
            routes::agents::RENAME,
            routes::agents::RESUME,
        ] {
            assert!(
                async_lifecycle_progress_for_request("POST", path, Some(&body)).is_none(),
                "{path} should stay on the sync dispatcher in this phase"
            );
        }
    }

    #[test]
    fn async_agent_output_transport_covers_live_pane_hot_routes_only() {
        for path in [routes::agents::OUTPUT, routes::live_pane::OUTPUT] {
            assert!(
                async_agent_output_route("GET", path),
                "{path} should use the cancellable output transport"
            );
        }
        for path in [
            routes::agents::INPUT,
            routes::live_pane::INPUT,
            routes::live_pane::ATTACH,
            routes::live_pane::RESIZE,
            routes::agents::INTERRUPT,
            routes::live_pane::INTERRUPT,
        ] {
            assert!(
                async_agent_output_route("POST", path),
                "{path} should use the cancellable output transport"
            );
        }
        for (method, path) in [
            ("GET", routes::HEALTH),
            ("GET", routes::agents::OUTPUT_STREAM),
            ("POST", routes::agents::STOP),
            ("POST", routes::agents::SPAWN),
            ("POST", routes::threads::SEND),
        ] {
            assert!(
                !async_agent_output_route(method, path),
                "{method} {path} should stay on its existing route family"
            );
        }
    }

    #[test]
    fn async_agent_output_disconnect_before_irreversible_write_cancels_route() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-output-disconnect");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let (client, mut server) = tokio::io::duplex(4096);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-output-disconnect",
                async move {
                    route_async_agent_output_with_disconnect_and_route(
                        context,
                        "GET".to_owned(),
                        format!("{}?sessionId=codex-live", routes::agents::OUTPUT),
                        None,
                        &mut server,
                        move |_context, _method, _path, _body, _irreversible| async move {
                            started_tx.send(()).expect("signal output route started");
                            let _ = release_rx.await;
                            Some(ProjectServiceDispatchResponse::json(
                                200,
                                json!({ "ok": true }),
                            ))
                        },
                    )
                    .await
                },
            );
            wait_for_signal(&started_rx, "output route started").await;
            drop(client);
            let error = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("route cancellation should finish")
                .expect("route task should join")
                .expect_err("disconnect before output route completes should cancel route");
            assert!(
                error
                    .to_string()
                    .contains("client disconnected before GET /agents/output completed"),
                "unexpected error: {error}"
            );
            assert!(
                release_tx.send(()).is_err(),
                "output future should have been dropped before release"
            );
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_agent_input_disconnect_after_irreversible_write_waits_for_route() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-input-irreversible");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let (client, mut server) = tokio::io::duplex(4096);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-input-irreversible",
                async move {
                    route_async_agent_output_with_disconnect_and_route(
                        context,
                        "POST".to_owned(),
                        routes::agents::INPUT.to_owned(),
                        Some(json!({ "sessionId": "codex-live", "text": "hello" })),
                        &mut server,
                        move |_context, _method, _path, _body, irreversible| async move {
                            irreversible.store(true, Ordering::SeqCst);
                            started_tx.send(()).expect("signal input route started");
                            release_rx.await.expect("release input route");
                            Some(ProjectServiceDispatchResponse::json(
                                200,
                                json!({ "ok": true, "accepted": true }),
                            ))
                        },
                    )
                    .await
                },
            );
            wait_for_signal(&started_rx, "input route started").await;
            drop(client);
            release_tx
                .send(())
                .expect("input route should still be live");
            let response = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("irreversible route should finish")
                .expect("route task should join")
                .expect("disconnect after irreversible write should not cancel route");
            assert_eq!(response.status, 200);
            assert_eq!(response.body["accepted"], true);
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_agent_input_disconnect_after_first_write_finishes_remaining_writes() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-input-no-half-delivery");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let writes = Arc::new(Mutex::new(Vec::new()));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let (client, mut server) = tokio::io::duplex(4096);
            let route_writes = Arc::clone(&writes);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-input-no-half-delivery",
                async move {
                    route_async_agent_output_with_disconnect_and_route(
                        context,
                        "POST".to_owned(),
                        routes::agents::INPUT.to_owned(),
                        Some(json!({ "sessionId": "codex-live", "text": "abc" })),
                        &mut server,
                        move |_context, _method, _path, _body, irreversible| async move {
                            irreversible.store(true, Ordering::SeqCst);
                            route_writes
                                .lock()
                                .expect("writes lock")
                                .push("first tmux write".to_owned());
                            started_tx.send(()).expect("signal first input write");
                            release_rx.await.expect("release remaining input writes");
                            route_writes
                                .lock()
                                .expect("writes lock")
                                .push("remaining tmux write".to_owned());
                            Some(ProjectServiceDispatchResponse::json(
                                200,
                                json!({ "ok": true, "accepted": true }),
                            ))
                        },
                    )
                    .await
                },
            );
            wait_for_signal(&started_rx, "first input write").await;
            drop(client);
            release_tx
                .send(())
                .expect("input route should finish after the first write");
            let response = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("irreversible route should finish")
                .expect("route task should join")
                .expect("disconnect after first write should not cancel route");
            assert_eq!(response.status, 200);
            assert_eq!(
                writes.lock().expect("writes lock").as_slice(),
                ["first tmux write", "remaining tmux write"],
                "disconnect after the first tmux write must not half-deliver an input sequence"
            );
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_lifecycle_stop_reports_tmux_kill_failure_without_taking_session_offline() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-stop-kill-failure");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            fs::create_dir_all(&state_dir).expect("create state dir");
            write_running_agent_topology(&state_dir, &project_root);
            let context =
                ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir);
            let progress = async_lifecycle_progress_for_request(
                "POST",
                routes::agents::STOP,
                Some(&json!({ "sessionId": "codex-live" })),
            )
            .expect("async lifecycle progress");
            let killed = Arc::new(Mutex::new(Vec::new()));
            let (started_tx, _started_rx) = mpsc::channel();
            let mut runtime = PendingKillLifecycleRuntime::with_error(
                Arc::clone(&killed),
                started_tx,
                "tmux refused kill-window",
            );

            let response = route_lifecycle_request_async_with_runtime(
                &context,
                "POST",
                routes::agents::STOP,
                Some(&json!({ "sessionId": "codex-live" })),
                &progress,
                &mut runtime,
            )
            .await
            .expect("async lifecycle response");

            assert_eq!(response.status, 500);
            assert!(
                response.body["error"]
                    .as_str()
                    .unwrap()
                    .contains("tmux kill-window failed for session \"codex-live\"")
            );
            assert_eq!(killed.lock().expect("killed lock").as_slice(), ["@agent"]);
            let topology =
                read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
            assert_eq!(topology["sessions"][0]["status"], "running");
            let failures =
                crate::project_service::operation_failures::list_dashboard_operation_failures(
                    &state_dir,
                );
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0]["operation"], "agent.stop");
            assert_eq!(failures[0]["targetId"], "codex-live");
            assert_eq!(failures[0]["title"], "Failed to stop agent");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_lifecycle_kill_reports_tmux_kill_failure_without_graveyarding_session() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-kill-kill-failure");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            fs::create_dir_all(&state_dir).expect("create state dir");
            write_running_agent_topology(&state_dir, &project_root);
            let context =
                ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir);
            let progress = async_lifecycle_progress_for_request(
                "POST",
                routes::agents::KILL,
                Some(&json!({ "sessionId": "codex-live" })),
            )
            .expect("async lifecycle progress");
            let killed = Arc::new(Mutex::new(Vec::new()));
            let (started_tx, _started_rx) = mpsc::channel();
            let mut runtime = PendingKillLifecycleRuntime::with_error(
                Arc::clone(&killed),
                started_tx,
                "tmux refused kill-window",
            );

            let response = route_lifecycle_request_async_with_runtime(
                &context,
                "POST",
                routes::agents::KILL,
                Some(&json!({ "sessionId": "codex-live" })),
                &progress,
                &mut runtime,
            )
            .await
            .expect("async lifecycle response");

            assert_eq!(response.status, 500);
            assert!(
                response.body["error"]
                    .as_str()
                    .unwrap()
                    .contains("tmux kill-window failed for session \"codex-live\"")
            );
            assert_eq!(killed.lock().expect("killed lock").as_slice(), ["@agent"]);
            let topology =
                read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
            assert_eq!(topology["sessions"][0]["status"], "running");
            assert!(
                topology
                    .get("graveyard")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
            );
            let failures =
                crate::project_service::operation_failures::list_dashboard_operation_failures(
                    &state_dir,
                );
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0]["operation"], "agent.kill");
            assert_eq!(failures[0]["targetId"], "codex-live");
            assert_eq!(failures[0]["title"], "Failed to kill agent");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_lifecycle_stop_disconnect_after_tmux_kill_started_records_abandoned_response() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-lifecycle-stop-abandoned");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            write_running_agent_topology(&state_dir, &project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let body = json!({ "sessionId": "codex-live" });
            let progress =
                async_lifecycle_progress_for_request("POST", routes::agents::STOP, Some(&body))
                    .expect("async lifecycle progress");
            let killed = Arc::new(Mutex::new(Vec::new()));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let (client, mut server) = tokio::io::duplex(4096);
            let runtime =
                PendingKillLifecycleRuntime::new(Arc::clone(&killed), started_tx, release_rx);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-lifecycle-stop-disconnect",
                async move {
                    route_async_lifecycle_with_disconnect_and_route(
                        context,
                        "POST".to_owned(),
                        routes::agents::STOP.to_owned(),
                        Some(body),
                        progress,
                        &mut server,
                        move |context, method, path, body, progress| async move {
                            let mut runtime = runtime;
                            route_lifecycle_request_async_with_runtime(
                                &context,
                                &method,
                                &path,
                                body.as_ref(),
                                &progress,
                                &mut runtime,
                            )
                            .await
                        },
                    )
                    .await
                },
            );
            wait_for_signal(&started_rx, "kill started").await;
            drop(client);
            let failures = wait_for_operation_failure(&state_dir, "agent.stop", "codex-live").await;
            assert_eq!(failures[0]["title"], "Lifecycle response was not delivered");
            release_tx.send(()).expect("release kill route");
            let response = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("route should finish")
                .expect("route task should join")
                .expect("disconnect after tmux kill starts should wait for route");
            assert_eq!(response.status, 200);
            assert_eq!(killed.lock().expect("killed lock").as_slice(), ["@agent"]);
            let topology =
                read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
            assert_eq!(topology["sessions"][0]["status"], "offline");
            let _ = fs::remove_dir_all(root);
        });
    }

    struct PendingCreateLifecycleRuntime {
        create_started: mpsc::Sender<()>,
        create_release: Option<oneshot::Receiver<()>>,
        created: Arc<Mutex<Vec<String>>>,
    }

    impl PendingCreateLifecycleRuntime {
        fn new(
            created: Arc<Mutex<Vec<String>>>,
            create_started: mpsc::Sender<()>,
            create_release: oneshot::Receiver<()>,
        ) -> Self {
            Self {
                create_started,
                create_release: Some(create_release),
                created,
            }
        }
    }

    impl AsyncProjectLifecycleRuntime for PendingCreateLifecycleRuntime {
        async fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
            Ok(())
        }

        async fn create_window(
            &mut self,
            session_name: &str,
            name: &str,
            _cwd: &str,
            _command: &str,
            _args: &[String],
            _detached: bool,
        ) -> Result<TmuxTarget, String> {
            self.create_started.send(()).expect("signal create started");
            if let Some(release) = self.create_release.take() {
                let _ = release.await;
            }
            self.created
                .lock()
                .expect("created lock")
                .push(name.to_owned());
            Ok(TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: "@spawned".to_owned(),
                window_index: 1,
                window_name: name.to_owned(),
                pane_dead: None,
            })
        }

        async fn set_window_metadata(
            &mut self,
            _window_id: &str,
            _metadata: &Value,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn set_window_option(
            &mut self,
            _window_id: &str,
            _key: &str,
            _value: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn clear_history(&mut self, _window_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn wait_for_window_after_launch(
            &mut self,
            _target: &TmuxTarget,
            _timeout: Duration,
        ) -> bool {
            true
        }

        fn codex_backend_session_ids_for_cwd(
            &mut self,
            _cwd: &str,
        ) -> Result<BTreeSet<String>, String> {
            Ok(BTreeSet::new())
        }

        async fn kill_window(&mut self, _window_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn async_lifecycle_spawn_disconnect_after_create_started_records_abandoned_response() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-lifecycle-spawn-abandoned");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            fs::create_dir_all(&state_dir).expect("create state dir");
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let body = json!({ "tool": "codex", "sessionId": "codex-new", "open": false });
            let progress =
                async_lifecycle_progress_for_request("POST", routes::agents::SPAWN, Some(&body))
                    .expect("async lifecycle progress");
            let created = Arc::new(Mutex::new(Vec::new()));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let (client, mut server) = tokio::io::duplex(4096);
            let runtime =
                PendingCreateLifecycleRuntime::new(Arc::clone(&created), started_tx, release_rx);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-lifecycle-spawn-abandoned",
                async move {
                    route_async_lifecycle_with_disconnect_and_route(
                        context,
                        "POST".to_owned(),
                        routes::agents::SPAWN.to_owned(),
                        Some(body),
                        progress,
                        &mut server,
                        move |context, method, path, body, progress| async move {
                            let mut runtime = runtime;
                            route_lifecycle_request_async_with_runtime(
                                &context,
                                &method,
                                &path,
                                body.as_ref(),
                                &progress,
                                &mut runtime,
                            )
                            .await
                        },
                    )
                    .await
                },
            );
            wait_for_signal(&started_rx, "create started").await;
            drop(client);
            let failures = wait_for_operation_failure(&state_dir, "agent.spawn", "codex-new").await;
            assert_eq!(failures[0]["title"], "Lifecycle response was not delivered");
            release_tx.send(()).expect("release create route");
            let response = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("route should finish")
                .expect("route task should join")
                .expect("disconnect after create starts should wait for route");
            assert_eq!(response.status, 200);
            assert_eq!(created.lock().expect("created lock").as_slice(), ["codex"]);
            let topology =
                read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
            assert_eq!(topology["sessions"][0]["status"], "running");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_lifecycle_write_failure_after_irreversible_step_records_abandoned_response() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-lifecycle-abandoned-response");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let body = json!({ "sessionId": "codex-live" });
            let progress =
                async_lifecycle_progress_for_request("POST", routes::agents::STOP, Some(&body))
                    .expect("async lifecycle progress");
            progress.mark_irreversible();
            let response = prepare_dispatch_response(
                ProjectServiceDispatchResponse::json(200, json!({ "ok": true })),
                Default::default(),
            );
            let (client, mut server) = tokio::io::duplex(4096);
            drop(client);
            let error = tokio::time::timeout(
                Duration::from_secs(2),
                write_project_service_response_async(
                    &mut server,
                    response,
                    Some(Arc::clone(&context)),
                    Some(progress),
                ),
            )
            .await
            .expect("write should finish")
            .expect_err("closed client should reject lifecycle response");
            assert!(matches!(error, DaemonListenerError::Io(_)));
            let failures =
                crate::project_service::operation_failures::list_dashboard_operation_failures(
                    &state_dir,
                );
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0]["operation"], "agent.stop");
            assert_eq!(failures[0]["targetKind"], "agent");
            assert_eq!(failures[0]["targetId"], "codex-live");
            assert_eq!(failures[0]["title"], "Lifecycle response was not delivered");
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_project_event_stream_wakes_on_publish_before_poll_interval() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let root = unique_test_root("async-event-stream");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            create_git_checkout(&project_root);
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let response = prepare_project_service_sse_response(
                200,
                b"event: ready\ndata: {\"ok\":true}\n\n".to_vec(),
                Some(ProjectServiceStreamPlan {
                    kind: ProjectServiceStreamKind::ProjectEvents,
                    session_id: None,
                    start_line: None,
                    interval_ms: 5_000,
                    keepalive_interval_ms: Some(5_000),
                    mode: None,
                    event_cursor: Some(0),
                }),
                Default::default(),
            );
            let (mut client, mut server) = tokio::io::duplex(8192);
            let writer_context = Arc::clone(&context);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-event-stream",
                async move {
                    write_project_service_response_async(
                        &mut server,
                        response,
                        Some(writer_context),
                        None,
                    )
                    .await
                },
            );

            let ready = read_until_contains(&mut client, "event: ready\n").await;
            assert!(ready.contains("event: ready\ndata: {\"ok\":true}\n\n"));
            let started = Instant::now();
            context.project_events.publish(json!({
                "type": "project_update",
                "projectId": "project",
                "ts": "2026-01-01T00:00:00.000Z",
                "views": ["desktop-state"],
                "reason": "async-wakeup"
            }));
            let output = read_until_contains(&mut client, "async-wakeup").await;

            assert!(
                started.elapsed() < Duration::from_millis(500),
                "event stream waited for the poll interval instead of the event edge"
            );
            assert!(output.contains("event: project_update\n"));
            drop(client);
            task.abort();
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn async_sse_disconnect_returns_io_error() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - transport and lifecycle cancellation tests drive async handlers
        crate::async_runtime::process_runtime().block_on(async {
            let response = prepare_project_service_sse_response(
                200,
                b"event: ready\ndata: {\"ok\":true}\n\n".to_vec(),
                Some(ProjectServiceStreamPlan {
                    kind: ProjectServiceStreamKind::ProjectEvents,
                    session_id: None,
                    start_line: None,
                    interval_ms: 100,
                    keepalive_interval_ms: Some(100),
                    mode: None,
                    event_cursor: None,
                }),
                Default::default(),
            );
            let (mut client, mut server) = tokio::io::duplex(4096);
            let task = crate::async_runtime::spawn_named(
                "project-service-test:async-sse-disconnect",
                async move {
                    write_project_service_response_async(&mut server, response, None, None).await
                },
            );

            let output = read_until_contains(&mut client, "event: ready\n").await;
            assert!(output.contains("event: ready\ndata: {\"ok\":true}\n\n"));
            drop(client);
            let error = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("disconnect should end stream task")
                .expect("stream task joins")
                .expect_err("stream should return disconnect error");

            assert!(matches!(error, DaemonListenerError::Io(_)));
        });
    }

    async fn wait_for_signal(receiver: &mpsc::Receiver<()>, label: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match receiver.try_recv() {
                    Ok(()) => return,
                    Err(mpsc::TryRecvError::Empty) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        panic!("{label} sender disconnected")
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"));
    }

    async fn wait_for_operation_failure(
        state_dir: &Path,
        operation: &str,
        target_id: &str,
    ) -> Vec<Value> {
        let started = Instant::now();
        loop {
            let failures =
                crate::project_service::operation_failures::list_dashboard_operation_failures(
                    state_dir,
                );
            if failures.iter().any(|failure| {
                failure["operation"] == operation && failure["targetId"] == target_id
            }) {
                return failures;
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "timed out waiting for operation failure {operation} {target_id}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn read_until_contains(reader: &mut (impl AsyncRead + Unpin), needle: &str) -> String {
        let started = Instant::now();
        let mut output = Vec::new();
        loop {
            let text = String::from_utf8_lossy(&output);
            if text.contains(needle) {
                return text.into_owned();
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "timed out waiting for {needle:?}; output: {text}"
            );
            let mut buffer = [0_u8; 512];
            let count = tokio::time::timeout(Duration::from_secs(2), reader.read(&mut buffer))
                .await
                .expect("read timed out")
                .expect("read stream");
            assert_ne!(count, 0, "stream closed before {needle:?}");
            output.extend_from_slice(&buffer[..count]);
        }
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
    let mut client = ProjectServiceExposeHttpClient {
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
        let _ = path;
        self.fallback.request_json(url, request)
    }
}

#[cfg(unix)]
fn local_project_service_request_path(_url: &str) -> Option<String> {
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
