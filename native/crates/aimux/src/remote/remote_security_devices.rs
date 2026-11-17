use crate::remote::relay_http::{relay_request, response_error};
use serde_json::Value;

pub fn list_remote_security_devices(pending: bool) -> Result<Vec<Value>, String> {
    let path = if pending {
        "/security/devices/pending"
    } else {
        "/security/devices"
    };
    let response = relay_request(path, "GET", None)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(
            &response,
            if pending {
                "Could not list pending remote devices"
            } else {
                "Could not list remote devices"
            },
        ));
    }
    response
        .get("devices")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            if pending {
                "Could not list pending remote devices".into()
            } else {
                "Could not list remote devices".into()
            }
        })
}

pub fn update_remote_security_device(
    device_id: &str,
    action: &str,
    approval_code: Option<&str>,
) -> Result<Value, String> {
    let path = format!(
        "/security/devices/{}/{}",
        encode_path_component(device_id),
        action
    );
    let body =
        approval_code.map(|approval_code| serde_json::json!({ "approvalCode": approval_code }));
    let response = relay_request(&path, "POST", body)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(
            &response,
            &format!("Could not {action} remote device"),
        ));
    }
    response
        .get("device")
        .cloned()
        .ok_or_else(|| format!("Could not {action} remote device"))
}

fn encode_path_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
