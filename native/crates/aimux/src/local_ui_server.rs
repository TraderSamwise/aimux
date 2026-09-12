use crate::async_subprocess::AsyncCommand;
use serde::Serialize;
use std::env;
use std::fs;
use std::io;
use std::net::TcpStream as StdTcpStream;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub const DEFAULT_LOCAL_UI_HOST: &str = "127.0.0.1";
pub const DEFAULT_LOCAL_UI_PORT: u16 = 43192;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalUiConfig {
    pub connection_mode: String,
    pub daemon_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUiServerOptions {
    pub host: String,
    pub port: u16,
    pub ui_root: PathBuf,
    pub config: LocalUiConfig,
}

pub struct LocalUiServerHandle {
    pub host: String,
    pub port: u16,
    pub url: String,
    pub ui_root: PathBuf,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LocalUiServerHandle {
    pub fn close(mut self) -> io::Result<()> {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = StdTcpStream::connect((self.host.as_str(), self.port));
        if let Some(task) = self.thread.take() {
            task.abort();
        }
        Ok(())
    }
}

impl Drop for LocalUiServerHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = StdTcpStream::connect((self.host.as_str(), self.port));
        if let Some(task) = self.thread.take() {
            task.abort();
        }
    }
}

pub fn resolve_default_local_ui_root() -> PathBuf {
    if let Some(root) = env::var_os("AIMUX_ROOT") {
        return PathBuf::from(root).join("dist-ui");
    }
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().and_then(Path::parent).map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dist-ui")
}

pub fn start_local_ui_server(options: LocalUiServerOptions) -> io::Result<LocalUiServerHandle> {
    crate::async_runtime::init_process_runtime()
        .map_err(|error| io::Error::other(error.to_string()))?;
    if !is_loopback_host(&options.host) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Local UI host must be loopback (127.0.0.1, localhost, or ::1), got {}",
                options.host
            ),
        ));
    }
    let ui_root = absolute_path(options.ui_root)?;
    if !ui_root.join("index.html").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Local UI build not found at {}. Run yarn build:ui:local first.",
                ui_root.display()
            ),
        ));
    }
    let ui_root = ui_root.canonicalize()?;
    let listener = std::net::TcpListener::bind((options.host.as_str(), options.port))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let thread_ui_root = ui_root.clone();
    let thread_config = options.config.clone();
    let thread = crate::async_runtime::spawn_named(
        crate::async_runtime::task_name("local-ui", "listener"),
        async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("aimux local UI listener failed to enter tokio runtime: {error}");
                    return;
                }
            };
            loop {
                if thread_shutdown.load(Ordering::Relaxed) {
                    break;
                }
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                if thread_shutdown.load(Ordering::Relaxed) {
                    break;
                }
                let ui_root = thread_ui_root.clone();
                let config = thread_config.clone();
                crate::async_runtime::spawn_named(
                    crate::async_runtime::task_name("local-ui", "connection"),
                    async move {
                        if let Err(error) = handle_connection(stream, &ui_root, &config).await {
                            eprintln!("aimux local UI connection failed: {error}");
                        }
                    },
                );
            }
        },
    );
    let url = format!("http://{}:{port}", format_host_for_url(&options.host));
    Ok(LocalUiServerHandle {
        host: options.host,
        port,
        url,
        ui_root,
        shutdown,
        thread: Some(thread),
    })
}

pub fn local_config_javascript(config: &LocalUiConfig) -> String {
    format!(
        "window.__AIMUX_LOCAL_CONFIG__={};\n",
        serde_json::to_string(config).expect("local UI config must serialize")
    )
}

pub fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "127.0.0.1"
}

pub fn open_url_in_browser(url: &str) -> io::Result<()> {
    let (command, args): (&str, Vec<&str>) = match env::consts::OS {
        "macos" => ("open", vec![url]),
        "windows" => ("cmd", vec!["/c", "start", "", url]),
        _ => ("xdg-open", vec![url]),
    };
    let mut process = AsyncCommand::new(command);
    process
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    process
        .spawn_detached(crate::async_subprocess::command_task_name(
            "local-ui-server",
            command,
        ))
        .map_err(|error| io::Error::other(error.to_string()))
        .map(|_| ())
}

async fn handle_connection(
    mut stream: TcpStream,
    ui_root: &Path,
    config: &LocalUiConfig,
) -> io::Result<()> {
    let request_line = read_request_head(&mut stream).await?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let uri = parts.next().unwrap_or("/");
    let head = method == "HEAD";
    if method != "GET" && method != "HEAD" {
        return write_text(&mut stream, 405, "Method not allowed").await;
    }
    let path = uri_path(uri);
    if path == Some("/aimux-local-config.js") {
        return write_response(
            &mut stream,
            200,
            "OK",
            "text/javascript; charset=utf-8",
            "no-store",
            if head {
                Vec::new()
            } else {
                local_config_javascript(config).into_bytes()
            },
        )
        .await;
    }
    let Some(target) = resolve_request_path(ui_root, uri) else {
        return write_text(&mut stream, 403, "Forbidden").await;
    };
    if target.is_file() {
        return serve_file(&mut stream, &target, head).await;
    }
    if uri_path(uri).is_some_and(|path| Path::new(path).extension().is_none()) {
        let index_path = ui_root.join("index.html");
        if index_path.is_file() {
            return serve_file(&mut stream, &index_path, head).await;
        }
    }
    write_text(&mut stream, 404, "Not found").await
}

async fn read_request_head(stream: &mut TcpStream) -> io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1];
    while bytes.len() < 8192 {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        bytes.push(buffer[0]);
        if bytes.ends_with(b"\r\n\r\n") || bytes.ends_with(b"\n\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn resolve_request_path(ui_root: &Path, uri: &str) -> Option<PathBuf> {
    let raw_path = uri_path(uri)?;
    let decoded = percent_decode(raw_path).ok()?;
    if decoded.contains('\0') {
        return None;
    }
    let path = if decoded == "/" {
        "/index.html"
    } else {
        decoded.as_str()
    };
    let relative = Path::new(path.strip_prefix('/').unwrap_or(path));
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let target = ui_root.join(relative);
    is_inside_root(ui_root, &target).then_some(target)
}

fn uri_path(uri: &str) -> Option<&str> {
    let path = uri.split(['?', '#']).next().unwrap_or(uri);
    path.starts_with('/').then_some(path)
}

fn percent_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1).ok_or(())?;
            let low = *bytes.get(index + 2).ok_or(())?;
            output.push((hex_value(high)? << 4) | hex_value(low)?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| ())
}

fn hex_value(value: u8) -> Result<u8, ()> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(()),
    }
}

fn is_inside_root(root: &Path, target: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    target == root || target.starts_with(root)
}

fn absolute_path(path: PathBuf) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

async fn serve_file(stream: &mut TcpStream, path: &Path, head: bool) -> io::Result<()> {
    let body = if head { Vec::new() } else { fs::read(path)? };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = mime_type(&extension);
    let cache_control = if extension == "html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    write_response(stream, 200, "OK", content_type, cache_control, body).await
}

async fn write_text(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    write_response(
        stream,
        status,
        reason_phrase(status),
        "text/plain; charset=utf-8",
        "no-store",
        body.as_bytes().to_vec(),
    )
    .await
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    cache_control: &str,
    body: Vec<u8>,
) -> io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nCache-Control: {cache_control}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    }
}

fn mime_type(extension: &str) -> &'static str {
    match extension {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "js" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn format_host_for_url(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}
