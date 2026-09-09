pub fn mime_type_for_published_attachment(file_path: &str) -> &'static str {
    let extension = file_path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "aac" => "audio/aac",
        "csv" => "text/csv",
        "flac" => "audio/flac",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "json" => "application/json",
        "m4a" => "audio/m4a",
        "md" => "text/markdown",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "txt" => "text/plain",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

pub fn relay_http_url(relay_url: &str) -> String {
    let converted = relay_url
        .strip_prefix("wss:")
        .map(|rest| format!("https:{rest}"))
        .or_else(|| {
            relay_url
                .strip_prefix("ws:")
                .map(|rest| format!("http:{rest}"))
        })
        .unwrap_or_else(|| relay_url.to_owned());
    converted.trim_end_matches('/').to_owned()
}
