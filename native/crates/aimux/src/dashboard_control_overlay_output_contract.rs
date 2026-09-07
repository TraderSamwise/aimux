use crate::dashboard_controller::{
    DashboardOrchestrationInputState, DashboardOrchestrationMode,
    DashboardOrchestrationRoutePickerState, DashboardOrchestrationTarget,
};
use crate::dashboard_service_input::{
    render_orchestration_input_overlay, render_orchestration_route_picker_overlay,
};
use serde_json::Value;

pub fn run_dashboard_control_overlay_output_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "buildOrchestrationInputOverlayOutput" => input_overlay(input)
            .map(Value::String)
            .unwrap_or(Value::Null),
        "buildOrchestrationRoutePickerOverlayOutput" => route_picker_overlay(input)
            .map(Value::String)
            .unwrap_or(Value::Null),
        api => panic!("unknown dashboard control overlay output api: {api}"),
    }
}

fn input_overlay(input: &Value) -> Option<String> {
    let mode = orchestration_mode(
        input
            .get("orchestrationInputMode")
            .and_then(Value::as_str)?,
    )?;
    let target = orchestration_target(input.get("orchestrationInputTarget")?.clone())?;
    let state = DashboardOrchestrationInputState {
        mode,
        target,
        buffer: string_field(input, "orchestrationInputBuffer"),
    };
    Some(render_orchestration_input_overlay(
        &state,
        usize_field(input, "cols"),
        usize_field(input, "rows"),
    ))
}

fn route_picker_overlay(input: &Value) -> Option<String> {
    let mode = orchestration_mode(
        input
            .get("orchestrationRouteMode")
            .and_then(Value::as_str)?,
    )?;
    let state = DashboardOrchestrationRoutePickerState {
        mode,
        options: array_field(input, "orchestrationRouteOptions")
            .into_iter()
            .filter_map(orchestration_target)
            .collect(),
    };
    Some(render_orchestration_route_picker_overlay(
        &state,
        usize_field(input, "cols"),
        usize_field(input, "rows"),
    ))
}

fn orchestration_mode(value: &str) -> Option<DashboardOrchestrationMode> {
    match value {
        "message" => Some(DashboardOrchestrationMode::Message),
        "handoff" => Some(DashboardOrchestrationMode::Handoff),
        "task" => Some(DashboardOrchestrationMode::Task),
        _ => None,
    }
}

fn orchestration_target(value: Value) -> Option<DashboardOrchestrationTarget> {
    Some(DashboardOrchestrationTarget {
        label: string_field(&value, "label"),
        session_id: optional_string(&value, "sessionId"),
        source_session_id: optional_string(&value, "sourceSessionId"),
        assignee: optional_string(&value, "assignee"),
        tool: optional_string(&value, "tool"),
        worktree_path: optional_string(&value, "worktreePath"),
        recipient_ids: array_field(&value, "recipientIds")
            .into_iter()
            .filter_map(|entry| entry.as_str().map(str::to_owned))
            .collect(),
    })
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn usize_field(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .try_into()
        .unwrap_or_default()
}
