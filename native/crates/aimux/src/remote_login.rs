use crate::launcher_env::DEFAULT_WEB_APP_URL;
use crate::paths::PathResolver;
use crate::remote_credentials::{AimuxCredentials, save_credentials_at};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOGIN_TIMEOUT_MS: u128 = 5 * 60 * 1000;
const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";
const PROD_RELAY_URL: &str = "wss://relay.aimux.app";
const DEV_WEB_APP_URL: &str = "http://localhost:8081";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginAction {
    Login,
    SecurityUnlock,
}

impl LoginAction {
    fn query_value(self) -> Option<&'static str> {
        match self {
            Self::Login => None,
            Self::SecurityUnlock => Some("security-unlock"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginFlowResult {
    pub user_id: String,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginCallbackResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
    pub user_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct LoginFlowWaiter {
    result: Arc<Mutex<Option<Result<LoginFlowResult, String>>>>,
}

impl LoginFlowWaiter {
    pub fn ready_error(error: String) -> Self {
        Self {
            result: Arc::new(Mutex::new(Some(Err(error)))),
        }
    }

    pub fn wait(self) -> Result<LoginFlowResult, String> {
        loop {
            let result = self.result.lock().expect("login result mutex").take();
            if let Some(result) = result {
                return result;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

pub fn run_login_flow(
    resolver: &PathResolver,
    action: LoginAction,
) -> Result<LoginFlowResult, String> {
    let prepared = prepare_login_flow(resolver, action)?;
    wait_for_login_callback(prepared)
}

pub fn start_login_flow(
    resolver: &PathResolver,
    action: LoginAction,
) -> Result<(Vec<String>, LoginFlowWaiter), String> {
    let prepared = prepare_login_flow(resolver, action)?;
    let messages = prepared.messages.clone();
    let result = Arc::new(Mutex::new(None));
    let thread_result = Arc::clone(&result);
    thread::spawn(move || {
        let flow_result = wait_for_login_callback(prepared);
        *thread_result.lock().expect("login result mutex") = Some(flow_result);
    });
    Ok((messages, LoginFlowWaiter { result }))
}

#[derive(Debug)]
struct PreparedLoginFlow {
    listener: TcpListener,
    state: String,
    relay_url: String,
    auth_path: std::path::PathBuf,
    messages: Vec<String>,
}

fn prepare_login_flow(
    resolver: &PathResolver,
    action: LoginAction,
) -> Result<PreparedLoginFlow, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let callback = format!("http://127.0.0.1:{port}/callback");
    let state = random_state().map_err(|error| error.to_string())?;
    let web_app_url = resolve_web_app_url(None);
    let relay_url = resolve_relay_url();
    let auth_url = build_auth_url(&web_app_url, &callback, &state, action);
    let messages = vec![
        "Opening your browser to sign in...".to_owned(),
        format!("If it doesn't open, visit:\n  {auth_url}\n"),
    ];
    open_browser(&auth_url);
    Ok(PreparedLoginFlow {
        listener,
        state,
        relay_url,
        auth_path: resolver.auth_path(),
        messages,
    })
}

fn wait_for_login_callback(prepared: PreparedLoginFlow) -> Result<LoginFlowResult, String> {
    let deadline = current_unix_millis() + LOGIN_TIMEOUT_MS;
    loop {
        match prepared.listener.accept() {
            Ok((stream, _)) => {
                let response = handle_login_stream(
                    stream,
                    &prepared.state,
                    &prepared.relay_url,
                    &prepared.auth_path,
                    now_iso(),
                )
                .map_err(|error| error.to_string())?;
                if let Some(user_id) = response.user_id {
                    return Ok(LoginFlowResult {
                        user_id,
                        messages: prepared.messages,
                    });
                }
                return Err(response.error.unwrap_or_else(|| "Login failed".to_owned()));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if current_unix_millis() >= deadline {
                    return Err("Login timed out after 5 minutes".into());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

pub fn build_auth_url(
    web_app_url: &str,
    callback: &str,
    state: &str,
    action: LoginAction,
) -> String {
    let mut query = vec![
        format!("callback={}", encode_uri_component(callback)),
        format!("state={}", encode_uri_component(state)),
    ];
    if let Some(action) = action.query_value() {
        query.push(format!("action={}", encode_uri_component(action)));
    }
    format!("{}/cli-auth?{}", clean_url(web_app_url), query.join("&"))
}

pub fn handle_login_callback(
    path: &str,
    state: &str,
    relay_url: &str,
    auth_path: impl AsRef<Path>,
    created_at: &str,
) -> LoginCallbackResponse {
    let (pathname, query) = path.split_once('?').unwrap_or((path, ""));
    if pathname != "/callback" {
        return LoginCallbackResponse {
            status: 404,
            content_type: "text/plain",
            body: "Not found".into(),
            user_id: None,
            error: None,
        };
    }
    let params = parse_query(query);
    if params.get("state").map(String::as_str) != Some(state) {
        return LoginCallbackResponse {
            status: 403,
            content_type: HTML_CONTENT_TYPE,
            body: login_failed_html(
                "State mismatch - this callback was not initiated by this login session.",
            ),
            user_id: None,
            error: Some("State mismatch".into()),
        };
    }
    if let Some(error) = params.get("error") {
        return LoginCallbackResponse {
            status: 400,
            content_type: HTML_CONTENT_TYPE,
            body: login_failed_html(error),
            user_id: None,
            error: Some(error.clone()),
        };
    }
    let token = params.get("token").cloned().unwrap_or_default();
    let user_id = params.get("userId").cloned().unwrap_or_default();
    if token.is_empty() || user_id.is_empty() {
        let message = "Callback missing token or userId";
        return LoginCallbackResponse {
            status: 400,
            content_type: HTML_CONTENT_TYPE,
            body: login_failed_html(message),
            user_id: None,
            error: Some(message.into()),
        };
    }
    let credentials = AimuxCredentials {
        version: 1,
        relay_url: clean_url(relay_url),
        token,
        user_id: user_id.clone(),
        created_at: created_at.into(),
        remote_enabled: true,
    };
    if let Err(error) = save_credentials_at(auth_path, &credentials) {
        let message = format!("Could not save credentials: {error}");
        return LoginCallbackResponse {
            status: 500,
            content_type: HTML_CONTENT_TYPE,
            body: login_failed_html(&message),
            user_id: None,
            error: Some(message),
        };
    }
    LoginCallbackResponse {
        status: 200,
        content_type: HTML_CONTENT_TYPE,
        body: "<html><body style=\"font-family:system-ui;text-align:center;padding-top:80px\"><h2>Logged in to aimux</h2><p>You can close this tab and return to the terminal.</p></body></html>".into(),
        user_id: Some(user_id),
        error: None,
    }
}

fn handle_login_stream(
    mut stream: TcpStream,
    state: &str,
    relay_url: &str,
    auth_path: impl AsRef<Path>,
    created_at: String,
) -> io::Result<LoginCallbackResponse> {
    let mut buffer = [0_u8; 8192];
    let count = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let response = handle_login_callback(path, state, relay_url, auth_path, &created_at);
    write_http_response(&mut stream, &response)?;
    Ok(response)
}

fn write_http_response(stream: &mut TcpStream, response: &LoginCallbackResponse) -> io::Result<()> {
    let body = response.body.as_bytes();
    write!(
        stream,
        "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        response.status,
        response.content_type,
        body.len()
    )?;
    stream.write_all(body)
}

fn open_browser(url: &str) {
    let (command, args): (&str, Vec<String>) = if cfg!(target_os = "macos") {
        ("open", vec![url.to_owned()])
    } else if cfg!(target_os = "windows") {
        (
            "cmd",
            vec!["/c".into(), "start".into(), "".into(), url.into()],
        )
    } else {
        ("xdg-open", vec![url.to_owned()])
    };
    let Ok(null) = File::open(if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    }) else {
        return;
    };
    let _ = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(null.try_clone().unwrap_or(null)))
        .stderr(Stdio::null())
        .spawn();
}

fn random_state() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn resolve_web_app_url(override_url: Option<&str>) -> String {
    let value = override_url
        .and_then(optional_env)
        .or_else(|| {
            std::env::var("AIMUX_WEB_APP_URL")
                .ok()
                .and_then(|value| optional_env(&value))
        })
        .unwrap_or_else(|| {
            if std::env::var("AIMUX_ENV").ok().as_deref().map(str::trim) == Some("development") {
                DEV_WEB_APP_URL.into()
            } else {
                DEFAULT_WEB_APP_URL.into()
            }
        });
    clean_url(&value)
}

fn resolve_relay_url() -> String {
    clean_url(
        &std::env::var("AIMUX_RELAY_URL")
            .ok()
            .and_then(|value| optional_env(&value))
            .unwrap_or_else(|| PROD_RELAY_URL.into()),
    )
}

fn optional_env(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn clean_url(value: &str) -> String {
    value.trim_end_matches('/').to_owned()
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            Some((decode_uri_component(key)?, decode_uri_component(value)?))
        })
        .collect()
}

fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => output.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                output.push(u8::from_str_radix(hex, 16).ok()?);
                index += 2;
            }
            b'%' => return None,
            byte => output.push(byte),
        }
        index += 1;
    }
    String::from_utf8(output).ok()
}

fn login_failed_html(message: &str) -> String {
    format!(
        "<html><body style=\"font-family:system-ui;text-align:center;padding-top:80px\"><h2>Login failed</h2><p>{}</p><p>You can close this tab and try again.</p></body></html>",
        escape_html(message)
    )
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
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

fn current_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
