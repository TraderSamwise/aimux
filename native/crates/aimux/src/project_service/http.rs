use serde_json::{Map, Number, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub const MAX_BODY_BYTES: usize = 1024 * 1024;

const CORS_ALLOWED_ORIGINS: &[&str] = &[
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:8091",
    "http://127.0.0.1:8091",
    "http://localhost:43192",
    "http://127.0.0.1:43192",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyTooLarge {
    pub limit: usize,
}

impl Display for BodyTooLarge {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "body exceeds {} bytes", self.limit)
    }
}

impl Error for BodyTooLarge {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectServiceBodyError {
    TooLarge(BodyTooLarge),
    InvalidUtf8(String),
    InvalidJson(String),
}

impl Display for ProjectServiceBodyError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge(error) => Display::fmt(error, formatter),
            Self::InvalidUtf8(error) | Self::InvalidJson(error) => formatter.write_str(error),
        }
    }
}

impl Error for ProjectServiceBodyError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderValue<'a> {
    Single(&'a str),
    Many(&'a [&'a str]),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectServiceResponseBody {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedProjectServiceResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub fn read_json_body_limited(
    chunks: impl IntoIterator<Item = impl AsRef<[u8]>>,
    limit: usize,
) -> Result<Value, ProjectServiceBodyError> {
    let mut body = Vec::new();
    for chunk in chunks {
        let chunk = chunk.as_ref();
        if body.len() + chunk.len() > limit {
            return Err(ProjectServiceBodyError::TooLarge(BodyTooLarge { limit }));
        }
        body.extend_from_slice(chunk);
    }
    let text = String::from_utf8(body)
        .map_err(|error| ProjectServiceBodyError::InvalidUtf8(error.to_string()))?
        .trim()
        .to_owned();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text)
        .map_err(|error| ProjectServiceBodyError::InvalidJson(error.to_string()))
}

pub fn project_service_request_headers<'a>(
    headers: impl IntoIterator<Item = (&'a str, HeaderValue<'a>)>,
) -> BTreeMap<String, String> {
    headers
        .into_iter()
        .filter_map(|(name, value)| match value {
            HeaderValue::Single(value) => Some((name.to_ascii_lowercase(), value.to_owned())),
            HeaderValue::Many(values) if !values.is_empty() => {
                Some((name.to_ascii_lowercase(), values.join(", ")))
            }
            HeaderValue::Many(_) => None,
        })
        .collect()
}

pub fn is_allowed_cors_origin(origin: &str) -> bool {
    CORS_ALLOWED_ORIGINS.contains(&origin) || is_local_http_origin(origin)
}

pub fn project_service_cors_headers(
    request_headers: &BTreeMap<String, String>,
) -> Option<BTreeMap<String, String>> {
    let origin = header_value(request_headers, "origin");
    if let Some(origin) = origin
        && !is_allowed_cors_origin(origin)
    {
        return None;
    }

    let mut headers = BTreeMap::from([
        (
            "Access-Control-Allow-Origin".to_owned(),
            origin.unwrap_or("*").to_owned(),
        ),
        (
            "Access-Control-Allow-Methods".to_owned(),
            "GET, POST, PUT, OPTIONS".to_owned(),
        ),
        (
            "Access-Control-Allow-Headers".to_owned(),
            "Content-Type, Authorization".to_owned(),
        ),
    ]);
    if origin.is_some() {
        headers.insert("Vary".to_owned(), "Origin".to_owned());
    }
    if origin.is_some()
        && header_value(request_headers, "access-control-request-private-network") == Some("true")
    {
        headers.insert(
            "Access-Control-Allow-Private-Network".to_owned(),
            "true".to_owned(),
        );
    }
    Some(headers)
}

pub fn reject_project_service_cors_response() -> PreparedProjectServiceResponse {
    prepare_project_service_json_response(
        403,
        serde_json::json!({ "ok": false, "error": "origin not allowed" }),
        BTreeMap::new(),
    )
}

pub fn prepare_project_service_json_response(
    status: u16,
    body: Value,
    mut headers: BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    prepare_project_service_response(
        status,
        ProjectServiceResponseBody::Json(body),
        "application/json",
        &mut headers,
    )
}

pub fn prepare_project_service_bytes_response(
    status: u16,
    body: Vec<u8>,
    mime_type: &str,
    mut headers: BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    headers.insert(
        "cache-control".to_owned(),
        "private, max-age=31536000, immutable".to_owned(),
    );
    headers.insert("x-content-type-options".to_owned(), "nosniff".to_owned());
    prepare_project_service_response(
        status,
        ProjectServiceResponseBody::Bytes(body),
        mime_type,
        &mut headers,
    )
}

pub fn prepare_project_service_sse_response(
    status: u16,
    body: Vec<u8>,
    mut headers: BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    headers.insert("content-type".to_owned(), "text/event-stream".to_owned());
    headers.insert(
        "cache-control".to_owned(),
        "no-cache, no-transform".to_owned(),
    );
    headers.insert("connection".to_owned(), "keep-alive".to_owned());
    headers.insert("x-accel-buffering".to_owned(), "no".to_owned());
    PreparedProjectServiceResponse {
        status,
        headers,
        body,
    }
}

pub fn prepare_project_service_empty_response(
    status: u16,
    mut headers: BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    headers.insert("connection".to_owned(), "close".to_owned());
    PreparedProjectServiceResponse {
        status,
        headers,
        body: Vec::new(),
    }
}

pub fn parse_optional_integer(raw: Option<&str>, field: &str) -> Result<Option<i64>, String> {
    match raw {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => parse_integer_str(value, field).map(Some),
    }
}

pub fn parse_integer_value(value: &Value, field: &str) -> Result<i64, String> {
    match value {
        Value::Number(number) => parse_integer_number(number, field),
        Value::String(value) => parse_integer_str(value, field),
        _ => Err(format!("{field} must be an integer")),
    }
}

pub fn parse_positive_integer_value(value: &Value, field: &str) -> Result<i64, String> {
    let parsed = parse_integer_value(value, field)?;
    if parsed < 1 {
        return Err(format!("{field} must be an integer >= 1"));
    }
    Ok(parsed)
}

pub fn parse_bounded_limit(
    raw: Option<&str>,
    field: &str,
    default_value: i64,
    max_value: i64,
) -> Result<i64, String> {
    let Some(raw) = raw else {
        return Ok(default_value);
    };
    if raw.trim().is_empty() {
        return Ok(default_value);
    }
    let parsed = parse_integer_str(raw, field)?;
    if parsed < 1 {
        return Err(format!("{field} must be an integer >= 1"));
    }
    Ok(parsed.min(max_value))
}

pub fn query_params(path: &str) -> BTreeMap<String, String> {
    let Some((_, query)) = path.split_once('?') else {
        return BTreeMap::new();
    };
    let mut params = BTreeMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode_form_lossy(key);
        if key.is_empty() {
            continue;
        }
        params.insert(key, percent_decode_form_lossy(value));
    }
    params
}

pub fn trimmed_query(params: &BTreeMap<String, String>, key: &str) -> Option<String> {
    params
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn prepare_project_service_response(
    status: u16,
    body: ProjectServiceResponseBody,
    content_type: &str,
    headers: &mut BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    let body = match body {
        ProjectServiceResponseBody::Json(value) => {
            serde_json::to_vec(&value).expect("JSON response body must serialize")
        }
        ProjectServiceResponseBody::Bytes(value) => value,
    };
    headers.insert("content-type".to_owned(), content_type.to_owned());
    headers.insert("content-length".to_owned(), body.len().to_string());
    headers.insert("connection".to_owned(), "close".to_owned());
    if !has_header_ignore_ascii_case(headers, "access-control-allow-origin") {
        headers.insert("access-control-allow-origin".to_owned(), "*".to_owned());
    }
    PreparedProjectServiceResponse {
        status,
        headers: headers.clone(),
        body,
    }
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .get(&name.to_ascii_lowercase())
        .or_else(|| headers.get(name))
        .map(String::as_str)
}

fn has_header_ignore_ascii_case(headers: &BTreeMap<String, String>, name: &str) -> bool {
    headers.keys().any(|key| key.eq_ignore_ascii_case(name))
}

fn parse_integer_number(number: &Number, field: &str) -> Result<i64, String> {
    let Some(value) = number.as_i64() else {
        return Err(format!("{field} must be an integer"));
    };
    if !is_js_safe_integer(value) {
        return Err(format!("{field} must be a safe integer"));
    }
    Ok(value)
}

fn parse_integer_str(value: &str, field: &str) -> Result<i64, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !is_integer_text(trimmed) {
        return Err(format!("{field} must be an integer"));
    }
    let parsed = trimmed
        .parse::<i64>()
        .map_err(|_| format!("{field} must be a safe integer"))?;
    if !is_js_safe_integer(parsed) {
        return Err(format!("{field} must be a safe integer"));
    }
    Ok(parsed)
}

fn percent_decode_form_lossy(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]).unwrap_or("");
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    bytes.push(value);
                    index += 3;
                } else {
                    bytes.push(raw[index]);
                    index += 1;
                }
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn is_integer_text(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_js_safe_integer(value: i64) -> bool {
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)
}

fn is_local_http_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if !port.is_empty() && !port.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1"
    )
}
