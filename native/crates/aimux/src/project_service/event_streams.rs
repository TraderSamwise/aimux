use serde_json::Value;

pub fn encode_sse_event(event: &str, data: &Value) -> Vec<u8> {
    format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(data).unwrap_or_else(|_| "null".to_owned())
    )
    .into_bytes()
}

pub fn encode_sse_keepalive() -> Vec<u8> {
    b": keepalive\n\n".to_vec()
}
