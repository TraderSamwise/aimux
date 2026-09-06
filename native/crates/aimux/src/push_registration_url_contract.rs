use serde_json::{Value, json};

pub fn run_push_registration_url_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    let pathname = match api {
        "buildSecurityPushRegistrationUrl" => "/security/push-token",
        "buildSecurityPushTestUrl" => "/security/test-push",
        _ => panic!("unknown push registration URL contract api: {api}"),
    };
    match build_security_push_url(
        input
            .get("relayUrl")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        pathname,
        input.get("options").unwrap_or(&Value::Null),
    ) {
        Ok(url) => json!({ "ok": true, "url": url }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn build_security_push_url(
    relay_url: &str,
    pathname: &str,
    options: &Value,
) -> Result<String, String> {
    let owner_user_id = trimmed_option(options, "ownerUserId");
    let share_id = trimmed_option(options, "shareId");
    if owner_user_id.is_some() != share_id.is_some() {
        return Err("ownerUserId and shareId must be provided together".to_owned());
    }

    let base = relay_url
        .replacen("ws", "http", 1)
        .trim_end_matches('/')
        .to_owned();
    let mut url = format!("{base}{pathname}");
    if let (Some(owner_user_id), Some(share_id)) = (owner_user_id, share_id) {
        url.push_str(&format!(
            "?ownerUserId={}&shareId={}",
            encode_query_component(&owner_user_id),
            encode_query_component(&share_id)
        ));
    }
    Ok(url)
}

fn trimmed_option(options: &Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
