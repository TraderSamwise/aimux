use serde_json::{Value, json};

pub fn run_transport_security_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "resolveSharedChatActor" => {
            resolve_shared_chat_actor(input.get("value").unwrap_or(&Value::Null))
        }
        "deviceProofMessage" => json!(format!(
            "aimux-device-proof-v1\n{}\n{}\n{}",
            str_field(input, "deviceId"),
            str_field(input, "timestamp"),
            str_field(input, "nonce")
        )),
        "encodeDevicePublicKey" => json!(base64_url_encode(
            public_key_jwk_json(input.get("publicKeyJwk").unwrap_or(&Value::Null)).as_bytes()
        )),
        _ => panic!("unknown transport security contract api: {api}"),
    }
}

fn resolve_shared_chat_actor(input: &Value) -> Value {
    if !bool_field(input, "isSharedConversation") {
        return Value::Null;
    }
    let current_participant = input.get("currentParticipant").unwrap_or(&Value::Null);
    let participant_role = current_participant.get("role").and_then(Value::as_str);
    let route_owner_user_id = str_field(input, "routeOwnerUserId");
    let user_id = str_field(input, "userId");
    let role = participant_role.or_else(|| {
        if !route_owner_user_id.is_empty() && user_id == route_owner_user_id {
            Some("owner")
        } else {
            None
        }
    });

    if bool_field(input, "isCanonicalSharedRoute") {
        json!({
            "role": if role == Some("owner") { "owner" } else { "guest" },
            "displayName": display_name(current_participant, input, "shared guest"),
            "email": email(current_participant, input),
        })
    } else {
        json!({
            "role": if role == Some("guest") { "guest" } else { "owner" },
            "displayName": display_name(current_participant, input, "chat owner"),
            "email": email(current_participant, input),
        })
    }
}

fn display_name<'a>(participant: &'a Value, input: &'a Value, fallback: &'a str) -> &'a str {
    participant
        .get("displayName")
        .and_then(Value::as_str)
        .or_else(|| input.get("displayName").and_then(Value::as_str))
        .unwrap_or(fallback)
}

fn email<'a>(participant: &'a Value, input: &'a Value) -> Option<&'a str> {
    participant
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| input.get("email").and_then(Value::as_str))
}

fn public_key_jwk_json(jwk: &Value) -> String {
    format!(
        "{{\"kty\":\"{}\",\"crv\":\"{}\",\"x\":\"{}\",\"y\":\"{}\",\"ext\":{},\"key_ops\":[{}]}}",
        str_field(jwk, "kty"),
        str_field(jwk, "crv"),
        str_field(jwk, "x"),
        str_field(jwk, "y"),
        bool_field(jwk, "ext"),
        array_field(jwk, "key_ops")
            .iter()
            .filter_map(Value::as_str)
            .map(|value| format!("\"{value}\""))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn base64_url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(chunk & 0x3f) as usize] as char);
        index += 3;
    }
    match bytes.len() - index {
        1 => {
            let chunk = (bytes[index] as u32) << 16;
            out.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        }
        2 => {
            let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
            out.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
            out.push(TABLE[((chunk >> 6) & 0x3f) as usize] as char);
        }
        _ => {}
    }
    out
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}
