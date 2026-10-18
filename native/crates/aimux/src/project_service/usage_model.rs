use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const CLAUDE_STATUSLINE_SOURCE: &str = "claude-statusline";
pub const CODEX_RATE_LIMIT_SOURCE: &str = "codex-rollout";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageState {
    Known,
    Absent,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub state: UsageState,
    pub used_percent: Option<f64>,
    pub used_usd: Option<f64>,
    pub limit_usd: Option<f64>,
    pub period: Option<String>,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<i64>,
    pub reason: Option<String>,
    pub source: String,
}

impl UsageWindow {
    pub fn display_text(&self) -> String {
        let value = match (self.state, self.used_percent) {
            (UsageState::Known, percent) => {
                let mut value = match self.used_usd {
                    Some(used) => match self.limit_usd {
                        Some(limit) => format!("${used} / ${limit}"),
                        None => format!("${used} used"),
                    },
                    None => String::new(),
                };
                if let Some(percent) = percent {
                    if value.is_empty() {
                        value = format!("{percent}% used");
                    } else {
                        value.push_str(&format!(" ({percent}% used)"));
                    }
                }
                if let Some(period) = &self.period {
                    value.push_str(&format!(", {period}"));
                }
                value
            }
            (UsageState::Error, _) => format!(
                "error: {}",
                self.reason.as_deref().unwrap_or("collection failed")
            ),
            _ => format!(
                "unknown: {}",
                self.reason
                    .as_deref()
                    .unwrap_or("runtime did not report usage")
            ),
        };
        format!("{}: {value}", self.label)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageQuotaObservation {
    pub state: UsageState,
    pub source: String,
    pub observed_at: i64,
    pub windows: Vec<UsageWindow>,
    pub reason: Option<String>,
}

impl UsageQuotaObservation {
    pub fn absent(source: &str, observed_at: i64, reason: impl Into<String>) -> Self {
        Self::unavailable(UsageState::Absent, source, observed_at, reason.into())
    }

    pub fn error(source: &str, observed_at: i64, reason: impl Into<String>) -> Self {
        Self::unavailable(UsageState::Error, source, observed_at, reason.into())
    }

    fn unavailable(state: UsageState, source: &str, observed_at: i64, reason: String) -> Self {
        let windows = [("five_hour", "5h", 300), ("weekly", "Weekly", 10080)]
            .map(|(id, label, minutes)| UsageWindow {
                id: id.to_owned(),
                label: label.to_owned(),
                state,
                used_percent: None,
                used_usd: None,
                limit_usd: None,
                period: None,
                window_minutes: Some(minutes),
                resets_at: None,
                reason: Some(reason.clone()),
                source: source.to_owned(),
            })
            .to_vec();
        Self {
            state,
            source: source.to_owned(),
            observed_at,
            windows,
            reason: Some(reason),
        }
    }

    pub fn display_lines(&self) -> Vec<String> {
        self.windows.iter().map(UsageWindow::display_text).collect()
    }
}

pub fn claude_statusline_usage(
    payload: &Value,
    observed_at: i64,
) -> Result<UsageQuotaObservation, String> {
    let payload = object(payload, "Claude statusline payload")?;
    let Some(limits) = optional_object(payload.get("rate_limits"), "Claude rate_limits")? else {
        return Ok(UsageQuotaObservation::absent(
            CLAUDE_STATUSLINE_SOURCE,
            observed_at,
            "Claude statusline has not reported quota windows",
        ));
    };
    let mut result = UsageQuotaObservation::absent(
        CLAUDE_STATUSLINE_SOURCE,
        observed_at,
        "Claude did not report this quota window",
    );
    for (key, value) in limits {
        if value.is_null() {
            continue;
        }
        let bucket = object(value, &format!("Claude rate_limits.{key}"))?;
        let (id, label, minutes) = match key.as_str() {
            "five_hour" => ("five_hour", "5h", Some(300)),
            "seven_day" => ("weekly", "Weekly", Some(10080)),
            _ => (key.as_str(), key.as_str(), None),
        };
        let window = parse_window(
            bucket,
            id,
            label,
            minutes,
            "used_percentage",
            "resets_at",
            CLAUDE_STATUSLINE_SOURCE,
        )?;
        replace_or_append(&mut result.windows, window);
    }
    finalize(&mut result);
    Ok(result)
}

pub fn codex_rate_limit_usage(
    rate_limits: &Value,
    observed_at: i64,
) -> Result<UsageQuotaObservation, String> {
    if rate_limits.is_null() {
        return Ok(UsageQuotaObservation::absent(
            CODEX_RATE_LIMIT_SOURCE,
            observed_at,
            "Codex has not reported quota windows",
        ));
    }
    let limits = object(rate_limits, "Codex rate_limits")?;
    let mut result = UsageQuotaObservation::absent(
        CODEX_RATE_LIMIT_SOURCE,
        observed_at,
        "Codex did not report this quota window",
    );
    let bucket_id = optional_string(limits.get("limit_id"), "Codex limit_id")?;
    let bucket_label = optional_string(limits.get("limit_name"), "Codex limit_name")?;
    if let Some(individual) =
        optional_object(limits.get("individual_limit"), "Codex individual_limit")?
    {
        let mut individual = individual.clone();
        if let Some(remaining) = individual
            .get("remaining_percent")
            .filter(|value| !value.is_null())
        {
            let remaining = remaining
                .as_f64()
                .filter(|value| value.is_finite() && *value <= 100.0)
                .ok_or_else(|| {
                    "Codex individual_limit.remaining_percent must be a number at most 100"
                        .to_owned()
                })?;
            individual.insert("used_percent".to_owned(), Value::from(100.0 - remaining));
        }
        let mut window = parse_window(
            &individual,
            "individual_limit",
            "Spend limit",
            None,
            "used_percent",
            "resets_at",
            CODEX_RATE_LIMIT_SOURCE,
        )?;
        if let Some(bucket_id) = bucket_id.filter(|id| *id != "codex") {
            window.id = format!("{bucket_id}:{}", window.id);
            window.label = format!("{} {}", bucket_label.unwrap_or(bucket_id), window.label);
        }
        result.windows.push(window);
    }
    for (key, value) in limits {
        if value.is_null() || codex_metadata_field(key) {
            continue;
        }
        let is_window = matches!(key.as_str(), "primary" | "secondary" | "tertiary")
            || value.as_object().is_some_and(|value| {
                value.contains_key("used_percent") || value.contains_key("window_minutes")
            });
        if !is_window {
            continue;
        }
        let bucket = object(value, &format!("Codex rate_limits.{key}"))?;
        let minutes = optional_u64(bucket.get("window_minutes"), "Codex window_minutes")?;
        let (id, label) = match minutes {
            Some(300) => ("five_hour".to_owned(), "5h".to_owned()),
            Some(10080) => ("weekly".to_owned(), "Weekly".to_owned()),
            Some(minutes) => (key.clone(), format!("{minutes}m")),
            None => (key.clone(), key.clone()),
        };
        let mut window = parse_window(
            bucket,
            &id,
            &label,
            minutes,
            "used_percent",
            "resets_at",
            CODEX_RATE_LIMIT_SOURCE,
        )?;
        if let Some(bucket_id) = bucket_id.filter(|id| *id != "codex") {
            window.id = format!("{bucket_id}:{}", window.id);
            window.label = format!("{} {}", bucket_label.unwrap_or(bucket_id), window.label);
        }
        if result
            .windows
            .iter()
            .any(|existing| existing.id == window.id && existing.state != UsageState::Absent)
        {
            window.id = format!("{}:{key}", window.id);
            window.label = format!("{} ({key})", window.label);
        }
        replace_or_append(&mut result.windows, window);
    }
    finalize(&mut result);
    Ok(result)
}

fn codex_metadata_field(key: &str) -> bool {
    matches!(
        key,
        "limit_id"
            | "limit_name"
            | "credits"
            | "individual_limit"
            | "spend_control_reached"
            | "plan_type"
            | "rate_limit_reached_type"
    )
}

#[allow(clippy::too_many_arguments)]
fn parse_window(
    bucket: &Map<String, Value>,
    id: &str,
    label: &str,
    window_minutes: Option<u64>,
    percent_field: &str,
    reset_field: &str,
    source: &str,
) -> Result<UsageWindow, String> {
    let used_percent = match bucket.get(percent_field).filter(|value| !value.is_null()) {
        None => None,
        Some(value) => {
            let percent = value
                .as_f64()
                .filter(|percent| percent.is_finite() && *percent >= 0.0)
                .ok_or_else(|| {
                    format!("{source} window {id}.{percent_field} must be a nonnegative number")
                })?;
            Some(percent)
        }
    };
    let used_usd = optional_nonnegative_number(
        bucket.get("used_usd"),
        &format!("{source} window {id}.used_usd"),
    )?;
    let limit_usd = optional_nonnegative_number(
        bucket.get("limit_usd"),
        &format!("{source} window {id}.limit_usd"),
    )?;
    let period = optional_string(
        bucket.get("period"),
        &format!("{source} window {id}.period"),
    )?
    .map(str::to_owned);
    let measured = used_percent.is_some() || used_usd.is_some();
    let resets_at = match bucket.get(reset_field).filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_i64().ok_or_else(|| {
            format!("{source} window {id}.{reset_field} must be integer epoch seconds")
        })?),
    };
    Ok(UsageWindow {
        id: id.to_owned(),
        label: label.to_owned(),
        state: if measured {
            UsageState::Known
        } else {
            UsageState::Absent
        },
        used_percent,
        used_usd,
        limit_usd,
        period,
        window_minutes,
        resets_at,
        reason: (!measured)
            .then(|| format!("{source} did not report a percentage or spend for {id}")),
        source: source.to_owned(),
    })
}

fn replace_or_append(windows: &mut Vec<UsageWindow>, window: UsageWindow) {
    if let Some(existing) = windows.iter_mut().find(|existing| existing.id == window.id) {
        *existing = window;
    } else {
        windows.push(window);
    }
}

fn finalize(result: &mut UsageQuotaObservation) {
    if result
        .windows
        .iter()
        .any(|window| window.state == UsageState::Known)
    {
        result.state = UsageState::Known;
        result.reason = None;
    }
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))
}

fn optional_object<'a>(
    value: Option<&'a Value>,
    context: &str,
) -> Result<Option<&'a Map<String, Value>>, String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| object(value, context))
        .transpose()
}

fn optional_string<'a>(value: Option<&'a Value>, context: &str) -> Result<Option<&'a str>, String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("{context} must be a string"))
        })
        .transpose()
}

fn optional_u64(value: Option<&Value>, context: &str) -> Result<Option<u64>, String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_u64()
                .filter(|value| *value > 0)
                .ok_or_else(|| format!("{context} must be a positive integer"))
        })
        .transpose()
}

fn optional_nonnegative_number(
    value: Option<&Value>,
    context: &str,
) -> Result<Option<f64>, String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or_else(|| format!("{context} must be a nonnegative number"))
        })
        .transpose()
}
