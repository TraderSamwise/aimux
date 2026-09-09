use serde_json::{Map, Value, json};

const DESKTOP_APP_ZOOM_VALUES: [i64; 8] = [80, 90, 100, 110, 120, 130, 140, 150];
const MONITOR_INTERVAL_SECONDS: [i64; 5] = [5, 10, 15, 30, 60];
const MONITOR_AUDIO_SAMPLE_RATES: [i64; 5] = [8000, 16000, 24000, 44100, 48000];

pub fn run_app_settings_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "defaultSettings" => default_settings(),
        "normalizeAppSettings" => {
            normalize_app_settings(input.get("value").unwrap_or(&Value::Null))
        }
        "stepDesktopAppZoom" => json!(
            array_field(input, "values")
                .iter()
                .map(|entry| step_desktop_app_zoom(
                    number_field(entry, "value"),
                    number_field(entry, "direction")
                ))
                .collect::<Vec<_>>()
        ),
        "desktopAppZoomScale" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| value.as_f64().unwrap_or(0.0) / 100.0)
                .collect::<Vec<_>>()
        ),
        api => panic!("unknown app settings contract api: {api}"),
    }
}

fn normalize_app_settings(input: &Value) -> Value {
    let defaults = default_settings();
    let mut settings = defaults.as_object().cloned().unwrap_or_default();
    if let Some(input) = input.as_object() {
        for (key, value) in input {
            settings.insert(key.clone(), value.clone());
        }
    }
    settings.insert(
        "desktopAppZoom".to_string(),
        json!(normalize_desktop_app_zoom(number_field(
            input,
            "desktopAppZoom"
        ))),
    );
    settings.insert(
        "notifications".to_string(),
        normalize_notification_settings(input.get("notifications")),
    );
    settings.insert(
        "acceptedShares".to_string(),
        json!(normalize_accepted_shares(
            input.get("acceptedShares"),
            input.get("activeShare")
        )),
    );
    settings.insert(
        "activeShare".to_string(),
        normalize_active_share(input.get("activeShare")),
    );
    settings.insert(
        "monitor".to_string(),
        normalize_monitor_settings(input.get("monitor")),
    );
    Value::Object(settings)
}

fn default_settings() -> Value {
    json!({
        "theme": "dark",
        "agentOutputViewMode": "split",
        "exposePreviewMode": "terminal",
        "desktopAppZoom": 110,
        "chatRichTerminalColors": true,
        "notifications": default_notification_settings(),
        "acceptedShares": [],
        "activeShare": null,
        "monitor": default_monitor_settings(),
    })
}

fn default_notification_settings() -> Value {
    json!({
        "enabled": false,
        "channels": {
            "browser": true,
            "push": false,
        },
        "categories": {
            "agent": {
                "enabled": true,
                "needsInput": true,
                "blocked": true,
                "errors": true,
                "completed": false,
                "activity": false,
            },
            "system": {
                "enabled": false,
                "relayStatus": false,
                "projectHealth": false,
            },
        },
    })
}

fn default_monitor_settings() -> Value {
    json!({
        "intervalSeconds": 10,
        "targetKind": "project-agent",
        "captureMode": "camera",
        "cameraViewport": {
            "centerX": 0.5,
            "centerY": 0.5,
            "zoom": 1,
        },
        "speechToText": true,
        "speechOnDeviceOnly": true,
        "speechInterimResults": true,
        "speechLanguage": "en-US",
        "audioSampleRate": 16000,
        "projectPath": null,
        "sessionId": null,
        "shareOwnerUserId": null,
        "shareId": null,
    })
}

fn normalize_notification_settings(input: Option<&Value>) -> Value {
    let defaults = default_notification_settings();
    json!({
        "enabled": input.and_then(|value| value.get("enabled")).and_then(Value::as_bool).unwrap_or(false),
        "channels": {
            "browser": bool_or_default(input, &defaults, &["channels", "browser"]),
            "push": bool_or_default(input, &defaults, &["channels", "push"]),
        },
        "categories": {
            "agent": {
                "enabled": bool_or_default(input, &defaults, &["categories", "agent", "enabled"]),
                "needsInput": bool_or_default(input, &defaults, &["categories", "agent", "needsInput"]),
                "blocked": bool_or_default(input, &defaults, &["categories", "agent", "blocked"]),
                "errors": bool_or_default(input, &defaults, &["categories", "agent", "errors"]),
                "completed": bool_or_default(input, &defaults, &["categories", "agent", "completed"]),
                "activity": bool_or_default(input, &defaults, &["categories", "agent", "activity"]),
            },
            "system": {
                "enabled": bool_or_default(input, &defaults, &["categories", "system", "enabled"]),
                "relayStatus": bool_or_default(input, &defaults, &["categories", "system", "relayStatus"]),
                "projectHealth": bool_or_default(input, &defaults, &["categories", "system", "projectHealth"]),
            },
        },
    })
}

fn normalize_monitor_settings(value: Option<&Value>) -> Value {
    json!({
        "intervalSeconds": one_of_i64(value.and_then(|value| value.get("intervalSeconds")).and_then(Value::as_i64), &MONITOR_INTERVAL_SECONDS, 10),
        "targetKind": match value.and_then(|value| value.get("targetKind")).and_then(Value::as_str) {
            Some("shared-chat") => "shared-chat",
            Some("project-agent") => "project-agent",
            _ => "project-agent",
        },
        "captureMode": match value.and_then(|value| value.get("captureMode")).and_then(Value::as_str) {
            Some("audio") => "audio",
            Some("camera-audio") => "camera-audio",
            Some("camera") => "camera",
            _ => "camera",
        },
        "cameraViewport": normalize_monitor_camera_viewport(value.and_then(|value| value.get("cameraViewport"))),
        "speechToText": value.and_then(|value| value.get("speechToText")).and_then(Value::as_bool).unwrap_or(true),
        "speechOnDeviceOnly": value.and_then(|value| value.get("speechOnDeviceOnly")).and_then(Value::as_bool).unwrap_or(true),
        "speechInterimResults": value.and_then(|value| value.get("speechInterimResults")).and_then(Value::as_bool).unwrap_or(true),
        "speechLanguage": sanitize_locale(value.and_then(|value| value.get("speechLanguage"))),
        "audioSampleRate": one_of_i64(value.and_then(|value| value.get("audioSampleRate")).and_then(Value::as_i64), &MONITOR_AUDIO_SAMPLE_RATES, 16000),
        "projectPath": sanitize_nullable_text(value.and_then(|value| value.get("projectPath"))),
        "sessionId": sanitize_nullable_text(value.and_then(|value| value.get("sessionId"))),
        "shareOwnerUserId": sanitize_nullable_text(value.and_then(|value| value.get("shareOwnerUserId"))),
        "shareId": sanitize_nullable_text(value.and_then(|value| value.get("shareId"))),
    })
}

fn normalize_monitor_camera_viewport(value: Option<&Value>) -> Value {
    let Some(value) = value.and_then(Value::as_object) else {
        return json!({ "centerX": 0.5, "centerY": 0.5, "zoom": 1 });
    };
    let zoom = clamp_number(value.get("zoom").and_then(Value::as_f64), 1.0, 4.0, 1.0);
    let min_center = 1.0 / (2.0 * zoom);
    let max_center = 1.0 - min_center;
    object_from_entries([
        (
            "centerX",
            number_value(clamp_number(
                value.get("centerX").and_then(Value::as_f64),
                min_center,
                max_center,
                0.5,
            )),
        ),
        (
            "centerY",
            number_value(clamp_number(
                value.get("centerY").and_then(Value::as_f64),
                min_center,
                max_center,
                0.5,
            )),
        ),
        ("zoom", number_value(zoom)),
    ])
}

fn normalize_active_share(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let share_id = str_field(value, "shareId");
    let owner_user_id = str_field(value, "ownerUserId");
    let project_root = str_field(value, "projectRoot");
    let session_id = str_field(value, "sessionId");
    if share_id.is_empty()
        || owner_user_id.is_empty()
        || project_root.is_empty()
        || session_id.is_empty()
    {
        return Value::Null;
    }
    let host = value
        .get("serviceEndpoint")
        .and_then(|endpoint| endpoint.get("host"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let port = value
        .get("serviceEndpoint")
        .and_then(|endpoint| endpoint.get("port"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if host.is_empty() || !(1..=65_535).contains(&port) {
        return Value::Null;
    }
    json!({
        "shareId": share_id,
        "ownerUserId": owner_user_id,
        "projectRoot": project_root,
        "sessionId": session_id,
        "serviceEndpoint": { "host": host, "port": port },
        "acceptedAt": optional_str(value, "acceptedAt").filter(|text| !text.is_empty()).unwrap_or("1970-01-01T00:00:00.000Z"),
    })
}

fn normalize_accepted_shares(
    value: Option<&Value>,
    legacy_active_share: Option<&Value>,
) -> Vec<Value> {
    let mut by_key = Map::new();
    for share in value.and_then(Value::as_array).into_iter().flatten() {
        let normalized = normalize_active_share(Some(share));
        if !normalized.is_null() {
            by_key.insert(share_key(&normalized), normalized);
        }
    }
    let legacy = normalize_active_share(legacy_active_share);
    if !legacy.is_null() {
        by_key.insert(share_key(&legacy), legacy);
    }
    let mut shares = by_key.into_values().collect::<Vec<_>>();
    shares.sort_by(|a, b| str_field(b, "acceptedAt").cmp(str_field(a, "acceptedAt")));
    shares
}

fn share_key(share: &Value) -> String {
    format!(
        "{}:{}",
        str_field(share, "ownerUserId"),
        str_field(share, "shareId")
    )
}

fn sanitize_nullable_text(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_str).map(str::trim) {
        Some(text) if !text.is_empty() => json!(text),
        _ => Value::Null,
    }
}

fn sanitize_locale(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str).map(str::trim) else {
        return String::from("en-US");
    };
    let parts = text.split('-').collect::<Vec<_>>();
    let valid = match parts.as_slice() {
        [language] => {
            (2..=3).contains(&language.len()) && language.chars().all(|ch| ch.is_ascii_alphabetic())
        }
        [language, region] => {
            (2..=3).contains(&language.len())
                && language.chars().all(|ch| ch.is_ascii_alphabetic())
                && (2..=8).contains(&region.len())
                && region.chars().all(|ch| ch.is_ascii_alphanumeric())
        }
        _ => false,
    };
    if valid {
        text.to_string()
    } else {
        String::from("en-US")
    }
}

fn normalize_desktop_app_zoom(value: i64) -> i64 {
    if DESKTOP_APP_ZOOM_VALUES.contains(&value) {
        value
    } else {
        110
    }
}

fn step_desktop_app_zoom(value: i64, direction: i64) -> i64 {
    let index = DESKTOP_APP_ZOOM_VALUES
        .iter()
        .position(|entry| *entry == value)
        .unwrap_or(usize::MAX);
    let next_index = if index == usize::MAX {
        0
    } else {
        (index as i64 + direction).clamp(0, DESKTOP_APP_ZOOM_VALUES.len() as i64 - 1) as usize
    };
    DESKTOP_APP_ZOOM_VALUES
        .get(next_index)
        .copied()
        .unwrap_or(110)
}

fn bool_or_default(input: Option<&Value>, defaults: &Value, path: &[&str]) -> bool {
    input
        .and_then(|input| value_at_path(input, path))
        .and_then(Value::as_bool)
        .or_else(|| value_at_path(defaults, path).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(*key))
}

fn one_of_i64(value: Option<i64>, allowed: &[i64], fallback: i64) -> i64 {
    match value {
        Some(value) if allowed.contains(&value) => value,
        _ => fallback,
    }
}

fn clamp_number(value: Option<f64>, min: f64, max: f64, fallback: f64) -> f64 {
    value
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn object_from_entries<const N: usize>(entries: [(&str, Value); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
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

fn optional_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
