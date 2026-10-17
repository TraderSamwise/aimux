use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const CORS_ALLOWED_ORIGINS: &[&str] = &[
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:8091",
    "http://127.0.0.1:8091",
    "http://localhost:43192",
    "http://127.0.0.1:43192",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyParseError {
    message: String,
}

impl BodyParseError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for BodyParseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for BodyParseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonResponseBody {
    Json(Value),
    Text(String),
    Bytes(Vec<u8>),
}

impl DaemonResponseBody {
    pub fn bytes(&self, content_type: &str) -> Vec<u8> {
        match self {
            Self::Json(value) if !content_type.starts_with("text/") => {
                serde_json::to_vec(value).expect("JSON response body must serialize")
            }
            Self::Json(value) => value.to_string().into_bytes(),
            Self::Text(value) => value.as_bytes().to_vec(),
            Self::Bytes(value) => value.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedDaemonResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub fn read_json_body(
    content_type: Option<&str>,
    chunks: impl IntoIterator<Item = impl AsRef<[u8]>>,
) -> Result<Value, BodyParseError> {
    let mut body = Vec::new();
    for chunk in chunks {
        body.extend_from_slice(chunk.as_ref());
    }
    let text = String::from_utf8(body)
        .map_err(|error| BodyParseError::new(error.to_string()))?
        .trim()
        .to_owned();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    if content_type
        .unwrap_or_default()
        .starts_with("application/x-www-form-urlencoded")
    {
        return Ok(Value::Object(parse_urlencoded_form(&text)?));
    }
    serde_json::from_str(&text).map_err(|error| BodyParseError::new(error.to_string()))
}

pub fn request_headers<'a>(
    headers: impl IntoIterator<Item = (&'a str, HeaderValue<'a>)>,
) -> BTreeMap<String, String> {
    headers
        .into_iter()
        .filter_map(|(name, value)| match value {
            HeaderValue::Single(value) => Some((name.to_ascii_lowercase(), value.to_owned())),
            HeaderValue::Many(_) => None,
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderValue<'a> {
    Single(&'a str),
    Many(&'a [&'a str]),
}

pub fn prepare_daemon_response(
    status: u16,
    body: DaemonResponseBody,
    content_type: Option<&str>,
) -> PreparedDaemonResponse {
    let content_type = content_type.unwrap_or("application/json").to_owned();
    let body = body.bytes(&content_type);
    let headers = BTreeMap::from([
        ("connection".to_owned(), "close".to_owned()),
        ("content-length".to_owned(), body.len().to_string()),
        ("content-type".to_owned(), content_type),
    ]);
    PreparedDaemonResponse {
        status,
        headers,
        body,
    }
}

pub fn cors_headers(
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
            "Access-Control-Allow-Methods".to_owned(),
            "GET, POST, OPTIONS".to_owned(),
        ),
        (
            "Access-Control-Allow-Headers".to_owned(),
            "Content-Type, Authorization".to_owned(),
        ),
    ]);
    if let Some(origin) = origin {
        headers.insert("Access-Control-Allow-Origin".to_owned(), origin.to_owned());
        headers.insert("Vary".to_owned(), "Origin".to_owned());
    }
    if header_value(request_headers, "access-control-request-private-network") == Some("true") {
        headers.insert(
            "Access-Control-Allow-Private-Network".to_owned(),
            "true".to_owned(),
        );
    }
    Some(headers)
}

pub fn reject_cors_response() -> PreparedDaemonResponse {
    prepare_daemon_response(
        403,
        DaemonResponseBody::Json(serde_json::json!({ "ok": false, "error": "origin not allowed" })),
        None,
    )
}

pub fn is_allowed_cors_origin(origin: &str) -> bool {
    CORS_ALLOWED_ORIGINS.contains(&origin) || is_local_http_origin(origin)
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .or_else(|| headers.get(&canonical_header_name(name)))
        .map(String::as_str)
}

fn canonical_header_name(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut chars = part.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            format!(
                "{}{}",
                first.to_ascii_uppercase(),
                chars.as_str().to_ascii_lowercase()
            )
        })
        .collect::<Vec<_>>()
        .join("-")
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

fn parse_urlencoded_form(input: &str) -> Result<Map<String, Value>, BodyParseError> {
    let mut output = Map::new();
    for pair in input.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        output.insert(
            percent_decode_form(key)?,
            Value::String(percent_decode_form(value)?),
        );
    }
    Ok(output)
}

fn percent_decode_form(input: &str) -> Result<String, BodyParseError> {
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
                let hex = std::str::from_utf8(&raw[index + 1..index + 3])
                    .map_err(|error| BodyParseError::new(error.to_string()))?;
                let value = u8::from_str_radix(hex, 16)
                    .map_err(|_| BodyParseError::new("invalid percent escape"))?;
                bytes.push(value);
                index += 3;
            }
            b'%' => return Err(BodyParseError::new("invalid percent escape")),
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(bytes).map_err(|error| BodyParseError::new(error.to_string()))
}
