use serde_json::{Value, json};

use super::ids::{base36_sequence, now_iso};
use super::json_helpers::object_insert_mut;
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;

pub(super) fn lifecycle_response(
    mut result: Value,
    operation: &str,
    target_kind: &str,
    target_id: Option<&str>,
) -> ProjectServiceDispatchResponse {
    object_insert_mut(&mut result, "ok", Value::Bool(true));
    object_insert_mut(
        &mut result,
        "transition",
        lifecycle_transition(operation, target_kind, target_id),
    );
    ProjectServiceDispatchResponse::json(200, result)
}

fn lifecycle_transition(operation: &str, target_kind: &str, target_id: Option<&str>) -> Value {
    lifecycle_transition_with_phase(operation, target_kind, target_id, "succeeded")
}

pub(super) fn lifecycle_transition_with_phase(
    operation: &str,
    target_kind: &str,
    target_id: Option<&str>,
    phase: &str,
) -> Value {
    let now = now_iso();
    let target_key = target_id.unwrap_or("unknown");
    json!({
        "operationId": format!("{operation}:{target_key}:{}", base36_sequence()),
        "operation": operation,
        "targetKind": target_kind,
        "phase": phase,
        "startedAt": now,
        "updatedAt": now,
        "targetId": target_id,
    })
}

pub(super) fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}
