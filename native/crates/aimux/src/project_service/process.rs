use anyhow::{Context, Result};
use sha1::{Digest, Sha1};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::listener::{DaemonListenerError, handle_daemon_stream};
use crate::daemon::server::DaemonHttpRequest;
use crate::daemon_state::{MetadataApiEndpoint, remove_metadata_endpoint, save_metadata_endpoint};
use crate::paths::{PathResolver, compute_project_id};

use super::http::PreparedProjectServiceResponse;
use super::router::{ProjectServiceRequestContext, route_project_service_request};
use super::server::{ProjectServiceHttpRequest, handle_project_service_http_request};

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
    serve_project_service_listener(listener, startup);
    Ok(())
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
    handle_daemon_stream(stream, &mut |request| {
        prepared_project_response_to_daemon(handle_project_service_http_request(
            project_request_from_daemon(request),
            |method, path, body| route_project_service_request(context, method, path, body),
        ))
    })
}

fn serve_project_service_listener(listener: TcpListener, startup: ProjectServiceStartup) {
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        startup.project_root,
        startup.project_state_dir,
    ));
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

fn project_request_from_daemon(request: DaemonHttpRequest) -> ProjectServiceHttpRequest {
    ProjectServiceHttpRequest {
        method: request.method,
        path: request.path,
        headers: request.headers,
        body_chunks: request.body_chunks,
    }
}

fn prepared_project_response_to_daemon(
    response: PreparedProjectServiceResponse,
) -> PreparedDaemonResponse {
    PreparedDaemonResponse {
        status: response.status,
        headers: response.headers,
        body: response.body,
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
