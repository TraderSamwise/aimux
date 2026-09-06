use serde_json::{Value, json};

pub fn run_monitor_capture_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "monitorFrameFilename" => json!(monitor_frame_filename(
            input
                .get("capturedAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "stripDataUrlBase64" => json!(strip_data_url_base64(
            input
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "estimateBase64DecodedBytes" => json!(estimate_base64_decoded_bytes(
            input
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "formatMonitorSampleText" => json!(format_monitor_sample_text(
            input.get("value").unwrap_or(&Value::Null)
        )),
        _ => panic!("unknown monitor capture contract api: {api}"),
    }
}

fn monitor_frame_filename(captured_at: &str) -> String {
    let stamp = if is_iso_timestamp(captured_at) {
        captured_at.to_owned()
    } else {
        "1970-01-01T00:00:00.000Z".to_owned()
    };
    format!("monitor-{}.jpg", stamp.replace([':', '.'], "-"))
}

fn strip_data_url_base64(value: &str) -> String {
    let marker = ";base64,";
    value
        .find(marker)
        .map(|index| value[index + marker.len()..].to_owned())
        .unwrap_or_else(|| value.to_owned())
}

fn estimate_base64_decoded_bytes(value: &str) -> usize {
    let base64: String = strip_data_url_base64(value)
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if base64.is_empty() {
        return 0;
    }
    let padding = if base64.ends_with("==") {
        2
    } else if base64.ends_with('=') {
        1
    } else {
        0
    };
    ((base64.len() * 3) / 4).saturating_sub(padding)
}

fn format_monitor_sample_text(input: &Value) -> String {
    let mut parts = vec![format!(
        "Monitor sample captured at {}.",
        input
            .get("capturedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
    )];
    if input
        .get("frameAttached")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        parts.push("A camera frame is attached.".to_owned());
    }
    if let Some(reason) = input
        .get("frameSkippedReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
    {
        parts.push(format!("Camera frame not attached: {reason}."));
    }
    if input
        .get("captureMode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode != "camera")
        && let Some(sample_rate) = input.get("audioSampleRate").and_then(Value::as_i64)
    {
        parts.push(format!("Audio sample rate: {sample_rate} Hz."));
    }
    if let Some(transcript) = input
        .get("transcript")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|transcript| !transcript.is_empty())
    {
        parts.push(format!("Speech transcript: {transcript}"));
    }
    parts.join(" ")
}

fn is_iso_timestamp(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes().get(16) == Some(&b':')
        && value.as_bytes().get(19) == Some(&b'.')
        && value.ends_with('Z')
}
