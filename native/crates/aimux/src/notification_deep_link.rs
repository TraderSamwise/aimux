pub struct AimuxNotificationDeepLinkTarget<'a> {
    pub project_root: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub notification_id: Option<&'a str>,
}

pub fn build_aimux_notification_deep_link(
    target: AimuxNotificationDeepLinkTarget<'_>,
) -> Option<String> {
    let project_root = target
        .project_root
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let session_id = target
        .session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let notification_id = target
        .notification_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    Some(format!(
        "aimux:///agent/{}/chat?project={}&notificationId={}&focusToken={}",
        percent_encode(session_id),
        form_encode(project_root),
        form_encode(notification_id),
        form_encode(notification_id)
    ))
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn form_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte == b' ' {
            encoded.push('+');
        } else if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'*') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
