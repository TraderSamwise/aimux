use aimux::hosted_events::{
    DeviceRecord, DevicesState, HostedDevicesStore, HostedEvent, HostedEventDelivery,
    HostedEventDeliveryConfig, HostedEventSender, SeenDeviceInput, client_address,
    device_fingerprint, sign_hosted_event,
};
use aimux::paths::PathResolver;
use anyhow::{Result, anyhow};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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
    let headers = input
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_owned()))
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    client_address(
        opt_str(input, "peerAddress").as_deref(),
        &headers,
        opt_str(input, "trustedForwardedHeader").as_deref(),
    )
    .map(Value::String)
    .unwrap_or(Value::Null)
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
    let fixture = Fixture::new();
    if input.get("seed").is_some_and(Value::is_null) {
        let event = fixture.record_with_clock(input.get("sighting").expect("sighting"));
        let raw = fs::read_to_string(fixture.store.devices_path()).expect("devices raw");
        let state = fixture.store.load_devices();
        let event = event.expect("first sighting event");
        return json!({
            "event": {
                "kind": event.kind,
                "principalId": event.principal_id,
                "label": event.label,
                "addressKnown": event.address_known,
                "userAgent": event.user_agent,
                "fingerprintLooksHashed": event.fingerprint.as_deref().is_some_and(is_hash_prefix),
                "fingerprintContainsAddress": event.fingerprint.as_deref().is_some_and(|value| value.contains("203.0.113")),
            },
            "rawContainsAddress": raw.contains("203.0.113"),
            "saltLooksHex": state.salt.len() == 64 && state.salt.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "mode": mode_for(&fixture.store.devices_path()),
        });
    }

    seed_devices(&fixture, input.get("seed").expect("seed"));
    if let Some(sightings) = input.get("sightings").and_then(Value::as_array) {
        if sightings.len() == 2 {
            fixture.record_with_clock(&sightings[0]);
            let before = fs::read_to_string(fixture.store.devices_path()).expect("devices before");
            let event = fixture.record_with_clock(&sightings[1]);
            let after = fs::read_to_string(fixture.store.devices_path()).expect("devices after");
            if str_field(&sightings[0], "principalId") != str_field(&sightings[1], "principalId") {
                return json!(event);
            }
            return json!({ "event": event, "stateUnchanged": before == after });
        }
        let events = sightings
            .iter()
            .map(|sighting| fixture.record_with_clock(sighting))
            .collect::<Vec<_>>();
        return json!({ "events": events, "state": fixture.store.load_devices() });
    }

    input
        .get("sighting")
        .and_then(|sighting| fixture.record_with_clock(sighting))
        .map(|event| json!(event))
        .unwrap_or(Value::Null)
}

fn prune_hosted_devices_case(input: &Value) -> Value {
    let fixture = Fixture::new();
    seed_devices(&fixture, input.get("seed").expect("seed"));
    let old = SeenDeviceInput {
        principal_id: "prn_a".to_owned(),
        label: "grand".to_owned(),
        address: Some("1.2.3.4".to_owned()),
        user_agent: Some("ua".to_owned()),
    };
    let _ = fixture.store.record_device_sighting_with(
        old,
        parse_fixture_time("2026-01-01T00:00:00.000Z"),
        "2026-01-01T00:00:00.000Z".to_owned(),
        || "00000000-0000-4000-8000-000000000001".to_owned(),
    );
    fixture
        .store
        .prune_devices(30, parse_fixture_time("2026-02-01T00:00:00.000Z"));
    let event = fixture.record_with_clock(&json!({
        "principalId": "prn_a",
        "label": "grand",
        "address": "1.2.3.4",
        "userAgent": "ua",
    }));
    json!({ "eventAfterPrune": event, "state": fixture.store.load_devices() })
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
    let posts = Arc::new(Mutex::new(Vec::new()));
    let statuses = if input.get("firstStatus").is_some() {
        VecDeque::from([Err(anyhow!("receiver failed")), Ok(200)])
    } else if input.get("webhookUrl").is_some() {
        VecDeque::from([Err(anyhow!("receiver unreachable"))])
    } else {
        VecDeque::from([Ok(200)])
    };
    let sender = FakeSender {
        posts: Arc::clone(&posts),
        statuses: Arc::new(Mutex::new(statuses)),
    };
    let config = HostedEventDeliveryConfig {
        webhook_url: match input.get("webhookConfigured").and_then(Value::as_bool) {
            Some(false) => None,
            _ => Some(
                opt_str(input, "webhookUrl")
                    .unwrap_or_else(|| "https://example.invalid/hook".to_owned()),
            ),
        },
        webhook_secret: input
            .get("secretConfigured")
            .and_then(Value::as_bool)
            .filter(|enabled| *enabled)
            .map(|_| "secret".to_owned())
            .or_else(|| {
                input
                    .get("secretConfigured")
                    .is_none()
                    .then(|| "secret".to_owned())
            }),
    };
    let threw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut delivery =
            HostedEventDelivery::with_sender_and_delays(config, sender, vec![0, 0, 0]);
        delivery.enqueue(event_from_value(&input["event"]));
    }))
    .is_err();
    let posts = posts.lock().expect("posts").clone();
    if input.get("secretConfigured").and_then(Value::as_bool) == Some(false) {
        return json!({ "received": posts.len() });
    }
    if input.get("webhookConfigured").and_then(Value::as_bool) == Some(false)
        || input.get("webhookUrl").is_some()
    {
        return json!({ "threw": threw });
    }
    if input.get("firstStatus").is_some() {
        return json!({ "receivedAtLeastTwo": posts.len() >= 2, "received": posts.len() });
    }
    let post = posts.first().expect("webhook post");
    let timestamp = header(post, "x-aimux-timestamp").unwrap_or_default();
    json!({
        "received": posts.len(),
        "signatureMatches": header(post, "x-aimux-signature")
            == Some(sign_hosted_event("secret", &timestamp, &post.body)),
        "timestampLooksNumeric": timestamp.bytes().all(|byte| byte.is_ascii_digit()),
        "body": serde_json::from_str::<Value>(&post.body).expect("posted body"),
    })
}

#[derive(Clone, Debug)]
struct SentPost {
    headers: Vec<(String, String)>,
    body: String,
}

#[derive(Clone)]
struct FakeSender {
    posts: Arc<Mutex<Vec<SentPost>>>,
    statuses: Arc<Mutex<VecDeque<Result<u16>>>>,
}

impl HostedEventSender for FakeSender {
    fn post(&mut self, _url: &str, headers: &[(String, String)], body: &str) -> Result<u16> {
        self.posts.lock().expect("posts").push(SentPost {
            headers: headers.to_vec(),
            body: body.to_owned(),
        });
        self.statuses
            .lock()
            .expect("statuses")
            .pop_front()
            .unwrap_or(Ok(200))
    }
}

struct Fixture {
    root: PathBuf,
    store: HostedDevicesStore,
    clock: Mutex<ContractClock>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-events-contract-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self {
            root,
            store: HostedDevicesStore::with_resolver(resolver),
            clock: Mutex::new(ContractClock::default()),
        }
    }

    fn record_with_clock(&self, sighting: &Value) -> Option<HostedEvent> {
        let input = SeenDeviceInput {
            principal_id: str_field(sighting, "principalId").to_owned(),
            label: str_field(sighting, "label").to_owned(),
            address: opt_str(sighting, "address"),
            user_agent: opt_str(sighting, "userAgent"),
        };
        let mut clock = self.clock.lock().expect("clock");
        let ts = clock.next_ts();
        let id = clock.current_id();
        self.store
            .record_device_sighting_with(input, parse_fixture_time(&ts), ts, || id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
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

    fn current_id(&self) -> String {
        format!("00000000-0000-4000-8000-{number:012}", number = self.next)
    }
}

fn seed_devices(fixture: &Fixture, seed: &Value) {
    let devices = seed
        .get("devices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|device| DeviceRecord {
            principal_id: str_field(device, "principalId").to_owned(),
            fingerprint: str_field(device, "fingerprint").to_owned(),
            first_seen: str_field(device, "firstSeen").to_owned(),
            last_seen: str_field(device, "lastSeen").to_owned(),
            user_agent: opt_str(device, "userAgent"),
        })
        .collect();
    fixture
        .store
        .save_devices(&DevicesState {
            version: 1,
            salt: str_field(seed, "salt").to_owned(),
            devices,
        })
        .expect("seed devices");
}

fn event_from_value(value: &Value) -> HostedEvent {
    HostedEvent {
        id: str_field(value, "id").to_owned(),
        kind: str_field(value, "kind").to_owned(),
        ts: str_field(value, "ts").to_owned(),
        principal_id: opt_str(value, "principalId"),
        label: opt_str(value, "label"),
        session_id: opt_str(value, "sessionId"),
        fingerprint: opt_str(value, "fingerprint"),
        address_known: value
            .get("addressKnown")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        user_agent: opt_str(value, "userAgent"),
        detail: opt_str(value, "detail"),
    }
}

fn header(post: &SentPost, name: &str) -> Option<String> {
    post.headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

fn is_hash_prefix(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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

fn copy_if_present(source: &Value, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field).filter(|value| !value.is_null()) {
        target.insert(field.into(), value.clone());
    }
}

#[cfg(unix)]
fn mode_for(path: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).expect("metadata").mode() & 0o777
}

#[cfg(not(unix))]
fn mode_for(_path: &Path) -> u32 {
    0
}

fn parse_fixture_time(value: &str) -> u128 {
    parse_iso_millis(value).expect("fixture time")
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<u128>().ok()?;
    let minute = value.get(14..16)?.parse::<u128>().ok()?;
    let second = value.get(17..19)?.parse::<u128>().ok()?;
    let millis = value.get(20..23)?.parse::<u128>().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some(
        u128::try_from(days).ok()? * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn opt_str(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
