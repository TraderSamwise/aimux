use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::agent_prompt_delivery::PromptDeliveryVerification;
use crate::daemon_state::{metadata_state_path, save_metadata_state, try_load_metadata_state};
use crate::debug_logging::{LogLevel, log_at};
use crate::state_update_lock::acquire_state_update_lock;

use super::router::ProjectServiceRequestContext;

pub const UNVERIFIED_SUBMISSION_NOTICE: &str = "Submission unverified; inspect the terminal before retrying. Ready does not confirm an answer.";
pub const UNVERIFIED_SUBMISSION_LABEL: &str = "last submit unverified";

#[derive(Debug, Clone)]
pub struct InputDeliveryAttempt {
    session_id: String,
    receipt: Value,
}

pub fn begin_input_delivery(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    window_id: &str,
) -> Result<InputDeliveryAttempt, String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = now_iso();
    let operation_id = format!(
        "input:{}:{}:{}",
        std::process::id(),
        now,
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let attempt = InputDeliveryAttempt {
        session_id: session_id.to_owned(),
        receipt: json!({
            "operationId": operation_id, "windowId": window_id, "state": "submitting",
            "verified": false, "notice": UNVERIFIED_SUBMISSION_NOTICE,
            "displayLabel": UNVERIFIED_SUBMISSION_LABEL, "startedAt": now,
        }),
    };
    persist_receipt(context, &attempt, &attempt.receipt, false)?;
    Ok(attempt)
}

fn persist_receipt(
    context: &ProjectServiceRequestContext,
    attempt: &InputDeliveryAttempt,
    receipt: &Value,
    require_token: bool,
) -> Result<bool, String> {
    let directory = context.project_state_dir();
    let lock = acquire_state_update_lock(&metadata_state_path(&directory))?;
    let mut state = try_load_metadata_state(&directory)?;
    let current = state
        .sessions
        .entry(attempt.session_id.clone())
        .or_insert_with(|| json!({}));
    let object = current
        .as_object_mut()
        .ok_or_else(|| format!("invalid metadata for session {}", attempt.session_id))?;
    if require_token {
        let reserved = object.get("inputDelivery").ok_or_else(|| {
            format!(
                "reserved input delivery receipt is missing for {}",
                attempt.session_id
            )
        })?;
        let token = reserved
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!(
                    "reserved input delivery receipt has invalid operationId for {}",
                    attempt.session_id
                )
            })?;
        if Some(token) != attempt.receipt.get("operationId").and_then(Value::as_str) {
            return Ok(false);
        }
    }
    object.insert("inputDelivery".into(), receipt.clone());
    object.insert("updatedAt".into(), Value::String(now_iso()));
    lock.ensure_owned_for_commit()?;
    save_metadata_state(&directory, &state)
        .map_err(|error| format!("save input delivery receipt: {error}"))?;
    context.project_events.publish_project_update(
        context.project_root(),
        crate::project_api_contract::invalidations::RUNTIME_SESSION.to_vec(),
        "input delivery receipt changed".to_owned(),
        Some(attempt.session_id.clone()),
        None,
    );
    Ok(true)
}

pub fn finish_input_delivery(
    context: &ProjectServiceRequestContext,
    attempt: &InputDeliveryAttempt,
    result: Result<PromptDeliveryVerification, &str>,
) -> Value {
    let mut receipt = attempt.receipt.clone();
    receipt["finishedAt"] = Value::String(now_iso());
    match result {
        Ok(verification) => {
            receipt["state"] = json!("delivered");
            receipt["verified"] = json!(verification.is_verified());
            if verification.is_verified() {
                receipt
                    .as_object_mut()
                    .expect("receipt object")
                    .remove("notice");
                receipt
                    .as_object_mut()
                    .expect("receipt object")
                    .remove("displayLabel");
            }
        }
        Err(error) => {
            receipt["state"] = json!("failed");
            receipt["error"] = json!(error);
            receipt["notice"] = json!(format!(
                "Input delivery failed: {error}. Inspect the terminal before retrying."
            ));
            receipt["displayLabel"] = json!("last submit failed");
        }
    }
    match persist_receipt(context, attempt, &receipt, true) {
        Ok(true) => {}
        Ok(false) => receipt["superseded"] = json!(true),
        Err(error) => {
            receipt["receiptError"] = json!(error);
            let previous = receipt
                .get("notice")
                .and_then(Value::as_str)
                .unwrap_or("Input sent.");
            receipt["notice"] = json!(format!(
                "{previous} Delivery receipt could not be saved: {error}. Inspect the terminal before retrying."
            ));
            log_at(
                LogLevel::Error,
                "input delivery receipt could not be saved after send",
                "input-delivery",
                Some(json!({"sessionId": attempt.session_id, "error": error, "delivery": receipt})),
            );
        }
    }
    if receipt.get("verified") != Some(&Value::Bool(true)) {
        log_at(
            LogLevel::Warn,
            "input delivery not verified",
            "input-delivery",
            Some(json!({"sessionId": attempt.session_id, "delivery": receipt})),
        );
    }
    receipt
}

pub fn projected_input_delivery(session: &Value, metadata: Option<&Value>) -> Option<Value> {
    let receipt = metadata?.get("inputDelivery")?;
    let window = session
        .pointer("/tmuxTarget/windowId")
        .or_else(|| session.get("tmuxWindowId"))?
        .as_str()?;
    (receipt.get("windowId").and_then(Value::as_str) == Some(window)).then(|| receipt.clone())
}

pub fn delivery_display_label(receipt: Option<&Value>) -> Option<&str> {
    receipt?.get("displayLabel")?.as_str()
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("UTC timestamp")
}
