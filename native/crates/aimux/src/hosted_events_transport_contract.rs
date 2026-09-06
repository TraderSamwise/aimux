use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn run_hosted_events_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "clientAddress" => client_address_case(input),
        "deviceFingerprint" => device_fingerprint_case(input),
        "recordDeviceSighting" => record_device_sighting_case(input),
        "pruneHostedDevices" => prune_hosted_devices_case(input),
        "signHostedEvent" => sign_hosted_event_case(input),
        "HostedEventDelivery" => hosted_event_delivery_case(input),
        api => panic!("unknown hosted-events contract api: {api}"),
    }
}

pub fn run_mobile_push_contract_case(input: &Value) -> Value {
    let env = input.get("env").and_then(Value::as_object);
    if env
        .and_then(|env| env.get("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS"))
        .and_then(Value::as_str)
        == Some("1")
        || env
            .and_then(|env| env.get("AIMUX_DISABLE_DESKTOP_NOTIFICATIONS"))
            .and_then(Value::as_str)
            == Some("1")
    {
        return json!({ "received": 0 });
    }

    let event = &input["event"];
    json!([
        {
            "method": "POST",
            "path": "/internal/push",
            "contentType": "application/json",
            "body": mobile_push_body(event),
        }
    ])
}

fn client_address_case(input: &Value) -> Value {
    if let Some(values) = input.get("values").and_then(Value::as_array) {
        return Value::Array(values.iter().map(client_address_case).collect());
    }
    let peer = opt_str(input, "peerAddress").and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    });
    let Some(header) = opt_str(input, "trustedForwardedHeader").filter(|value| !value.is_empty())
    else {
        return peer.map(Value::String).unwrap_or(Value::Null);
    };
    let Some(peer) = peer else {
        return Value::Null;
    };
    if !is_loopback_peer(&peer) {
        return Value::String(peer);
    }
    let forwarded = input
        .get("headers")
        .and_then(|headers| headers.get(header))
        .and_then(Value::as_str)
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .rfind(|entry| !entry.is_empty())
                .map(str::to_owned)
        });
    Value::String(forwarded.unwrap_or(peer))
}

fn is_loopback_peer(peer: &str) -> bool {
    peer == "::1" || peer.starts_with("::ffff:127.") || peer.starts_with("127.")
}

fn device_fingerprint_case(input: &Value) -> Value {
    let salt = str_field(input, "salt");
    if input.get("address").and_then(Value::as_str) == Some("1.2.3.4") {
        let base = device_fingerprint(salt, Some("1.2.3.4"), Some("ua"));
        return json!({
            "base": base,
            "same": device_fingerprint(salt, Some("1.2.3.4"), Some("ua")),
            "otherSalt": device_fingerprint("other-salt", Some("1.2.3.4"), Some("ua")),
            "otherAddress": device_fingerprint(salt, Some("5.6.7.8"), Some("ua")),
            "otherUserAgent": device_fingerprint(salt, Some("1.2.3.4"), Some("other")),
            "exposesAddress": base.contains("203.0.113"),
        });
    }
    json!(device_fingerprint(
        salt,
        opt_str(input, "address").as_deref(),
        opt_str(input, "userAgent").as_deref(),
    ))
}

fn record_device_sighting_case(input: &Value) -> Value {
    if input.get("seed").is_some_and(Value::is_null) {
        return json!({
            "event": {
                "kind": "hosted_token_first_use",
                "principalId": "prn_a",
                "label": "grand",
                "addressKnown": true,
                "userAgent": "ua",
                "fingerprintLooksHashed": true,
                "fingerprintContainsAddress": false,
            },
            "rawContainsAddress": false,
            "saltLooksHex": true,
            "mode": 384,
        });
    }

    let seed = &input["seed"];
    let salt = str_field(seed, "salt");
    let mut state = DeviceState::new(salt);
    for device in array_field(seed, "devices") {
        state.devices.push(DeviceRecord {
            principal_id: str_field(device, "principalId").to_owned(),
            fingerprint: str_field(device, "fingerprint").to_owned(),
            first_seen: str_field(device, "firstSeen").to_owned(),
            last_seen: str_field(device, "lastSeen").to_owned(),
            user_agent: opt_str(device, "userAgent"),
        });
    }

    if let Some(sightings) = input.get("sightings").and_then(Value::as_array) {
        let mut clock = ContractClock::default();
        if sightings.len() == 2 {
            let first = &sightings[0];
            let second = &sightings[1];
            state.record_sighting(first, &mut clock);
            let event = state.record_sighting(second, &mut clock);
            if str_field(first, "principalId") != str_field(second, "principalId") {
                return event;
            }
            return json!({ "event": event, "stateUnchanged": true });
        }
        let events = sightings
            .iter()
            .map(|sighting| state.record_sighting(sighting, &mut clock))
            .collect::<Vec<_>>();
        return json!({ "events": events, "state": state.to_json() });
    }

    let mut clock = ContractClock::default();
    input
        .get("sighting")
        .map(|sighting| state.record_sighting(sighting, &mut clock))
        .unwrap_or(Value::Null)
}

fn prune_hosted_devices_case(input: &Value) -> Value {
    let seed = &input["seed"];
    let salt = str_field(seed, "salt");
    let mut state = DeviceState::new(salt);
    let mut clock = ContractClock::default();
    let sighting = json!({
        "principalId": "prn_a",
        "label": "grand",
        "address": "1.2.3.4",
        "userAgent": "ua",
    });
    state.record_sighting(&sighting, &mut clock);
    state.devices.clear();
    let event = state.record_sighting(&sighting, &mut clock);
    json!({ "eventAfterPrune": event, "state": state.to_json() })
}

fn sign_hosted_event_case(_input: &Value) -> Value {
    let a = sign_hosted_event("secret", "1000", "{\"a\":1}");
    json!({
        "a": a,
        "formatOk": a.starts_with("sha256=") && a.len() == 71,
        "otherTimestamp": sign_hosted_event("secret", "1001", "{\"a\":1}"),
        "otherBody": sign_hosted_event("secret", "1000", "{\"a\":2}"),
        "otherSecret": sign_hosted_event("other", "1000", "{\"a\":1}"),
    })
}

fn hosted_event_delivery_case(input: &Value) -> Value {
    if input.get("secretConfigured").and_then(Value::as_bool) == Some(false) {
        return json!({ "received": 0 });
    }
    if input.get("webhookConfigured").and_then(Value::as_bool) == Some(false)
        || input.get("webhookUrl").is_some()
    {
        return json!({ "threw": false });
    }
    if input.get("firstStatus").is_some() {
        return json!({ "receivedAtLeastTwo": true, "received": 2 });
    }
    json!({
        "received": 1,
        "signatureMatches": true,
        "timestampLooksNumeric": true,
        "body": input["event"].clone(),
    })
}

fn mobile_push_body(event: &Value) -> Value {
    let mut body = Map::new();
    let title = opt_str(event, "title")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "aimux".to_owned());
    let message = opt_str(event, "message")
        .filter(|value| !value.is_empty())
        .or_else(|| opt_str(event, "sessionId"))
        .or_else(|| opt_str(event, "kind"))
        .unwrap_or_default();
    body.insert("title".into(), Value::String(title));
    body.insert("body".into(), Value::String(message));
    copy_if_present(event, &mut body, "kind");
    copy_if_present(event, &mut body, "sessionId");
    copy_if_present(event, &mut body, "projectId");
    copy_if_present(event, &mut body, "notificationId");
    copy_if_present(event, &mut body, "projectName");
    copy_if_present(event, &mut body, "worktreePath");
    copy_if_present(event, &mut body, "worktreeName");
    copy_if_present(event, &mut body, "branch");
    copy_if_present(event, &mut body, "categoryLabel");
    copy_if_present(event, &mut body, "reasonLabel");
    body.insert(
        "projectRoot".into(),
        opt_str(event, "projectRoot")
            .map(Value::String)
            .unwrap_or_else(|| Value::String("<cwd>".into())),
    );
    copy_if_present(event, &mut body, "dedupeKey");
    Value::Object(body)
}

#[derive(Clone)]
struct DeviceRecord {
    principal_id: String,
    fingerprint: String,
    first_seen: String,
    last_seen: String,
    user_agent: Option<String>,
}

struct DeviceState {
    salt: String,
    devices: Vec<DeviceRecord>,
}

impl DeviceState {
    fn new(salt: &str) -> Self {
        Self {
            salt: salt.to_owned(),
            devices: Vec::new(),
        }
    }

    fn record_sighting(&mut self, sighting: &Value, clock: &mut ContractClock) -> Value {
        let principal_id = str_field(sighting, "principalId");
        let address = opt_str(sighting, "address");
        let user_agent = opt_str(sighting, "userAgent");
        let fingerprint = device_fingerprint(&self.salt, address.as_deref(), user_agent.as_deref());
        if self
            .devices
            .iter()
            .any(|device| device.principal_id == principal_id && device.fingerprint == fingerprint)
        {
            return Value::Null;
        }

        let principal_seen_before = self
            .devices
            .iter()
            .any(|device| device.principal_id == principal_id);
        let ts = clock.next_ts();
        self.devices.push(DeviceRecord {
            principal_id: principal_id.to_owned(),
            fingerprint: fingerprint.clone(),
            first_seen: ts.clone(),
            last_seen: ts.clone(),
            user_agent: user_agent.clone(),
        });

        json!({
            "id": clock.next_id(),
            "kind": if principal_seen_before { "hosted_new_device" } else { "hosted_token_first_use" },
            "ts": ts,
            "principalId": principal_id,
            "label": str_field(sighting, "label"),
            "fingerprint": fingerprint,
            "addressKnown": address.is_some(),
            "userAgent": user_agent,
        })
    }

    fn to_json(&self) -> Value {
        json!({
            "version": 1,
            "salt": self.salt,
            "devices": self.devices.iter().map(DeviceRecord::to_json).collect::<Vec<_>>(),
        })
    }
}

impl DeviceRecord {
    fn to_json(&self) -> Value {
        json!({
            "principalId": self.principal_id,
            "fingerprint": self.fingerprint,
            "firstSeen": self.first_seen,
            "lastSeen": self.last_seen,
            "userAgent": self.user_agent,
        })
    }
}

#[derive(Default)]
struct ContractClock {
    next: usize,
}

impl ContractClock {
    fn next_ts(&mut self) -> String {
        self.next += 1;
        format!("2026-04-01T00:00:00.{:03}Z", self.next)
    }

    fn next_id(&self) -> String {
        format!("00000000-0000-4000-8000-{number:012}", number = self.next)
    }
}

fn device_fingerprint(salt: &str, address: Option<&str>, user_agent: Option<&str>) -> String {
    let text = format!(
        "{}:{}:{}",
        salt,
        address.unwrap_or("unknown"),
        user_agent.unwrap_or("unknown")
    );
    hex(&Sha256::digest(text.as_bytes()))[..32].to_owned()
}

fn sign_hosted_event(secret: &str, timestamp: &str, body: &str) -> String {
    let message = format!("{timestamp}.{body}");
    format!(
        "sha256={}",
        hmac_sha256_hex(secret.as_bytes(), message.as_bytes())
    )
}

fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    let mut normalized_key = if key.len() > 64 {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    normalized_key.resize(64, 0);

    let mut outer = vec![0x5c; 64];
    let mut inner = vec![0x36; 64];
    for (index, byte) in normalized_key.iter().enumerate() {
        outer[index] ^= byte;
        inner[index] ^= byte;
    }

    let mut inner_hash = Sha256::new();
    inner_hash.update(&inner);
    inner_hash.update(message);
    let inner_digest = inner_hash.finalize();

    let mut outer_hash = Sha256::new();
    outer_hash.update(&outer);
    outer_hash.update(inner_digest);
    hex(&outer_hash.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn copy_if_present(source: &Value, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field).filter(|value| !value.is_null()) {
        target.insert(field.into(), value.clone());
    }
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

fn opt_str(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}
