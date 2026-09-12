use serde_json::{Value, json};
use std::time::Duration;

use crate::async_subprocess::AsyncCommand;
use crate::tmux::{CapturePaneOptions, capture_pane_argv, tmux_command_from_env};
use crate::tmux_expose::ExposeScope;
use crate::tmux_expose_hot_snapshot::{HotExposeScopeKey, read_hot_expose_scope_view};

use super::agent_output::AgentOutputCaptureRuntime;
use super::output_cache::AgentOutputCaptureCacheKey;
use super::router::ProjectServiceRequestContext;

pub const DEFAULT_PREVIEW_CAPTURE_LINES: i64 = 40;
pub const DEFAULT_PREVIEW_MAX_CHARS: usize = 8_192;

pub fn capture_preview_snapshot(
    context: &ProjectServiceRequestContext,
    window_id: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
    line_count: i64,
    max_chars: usize,
) -> Option<Value> {
    capture_preview_snapshot_with_tap(context, window_id, None, runtime, line_count, max_chars)
}

pub fn capture_preview_snapshot_with_tap(
    context: &ProjectServiceRequestContext,
    window_id: &str,
    tap_snapshot: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
    line_count: i64,
    max_chars: usize,
) -> Option<Value> {
    capture_preview_snapshot_with_tap_result(
        context,
        window_id,
        tap_snapshot,
        runtime,
        line_count,
        max_chars,
    )
    .ok()?
}

pub fn capture_preview_snapshot_with_tap_result(
    context: &ProjectServiceRequestContext,
    window_id: &str,
    tap_snapshot: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
    line_count: i64,
    max_chars: usize,
) -> Result<Option<Value>, String> {
    if let Some(snapshot) = hot_preview_snapshot(context, window_id, max_chars) {
        return Ok(
            merge_expose_preview_snapshots(Some(&snapshot), tap_snapshot).map(|mut snapshot| {
                if let Some(output) = snapshot
                    .get("output")
                    .and_then(Value::as_str)
                    .map(|output| trailing_chars(output, max_chars))
                    && let Some(object) = snapshot.as_object_mut()
                {
                    object.insert("output".into(), Value::String(output));
                }
                snapshot
            }),
        );
    }
    let options = CapturePaneOptions {
        start_line: Some(-line_count),
        end_line: None,
        include_escapes: true,
    };
    let (output, _coalesced) = context.output_cache.capture_or_reuse(
        AgentOutputCaptureCacheKey {
            window_id: window_id.to_owned(),
            options,
        },
        || runtime.capture_pane(window_id, options),
    )?;
    let capture_snapshot = json!({
        "output": trailing_chars(&output, max_chars),
        "capturedAt": now_iso(),
        "source": "capture",
        "windowId": window_id,
        "startLine": -line_count,
        "lineCount": line_count,
    });
    Ok(
        merge_expose_preview_snapshots(Some(&capture_snapshot), tap_snapshot).map(
            |mut snapshot| {
                if let Some(output) = snapshot
                    .get("output")
                    .and_then(Value::as_str)
                    .map(|output| trailing_chars(output, max_chars))
                    && let Some(object) = snapshot.as_object_mut()
                {
                    object.insert("output".into(), Value::String(output));
                }
                snapshot
            },
        ),
    )
}

pub async fn capture_preview_snapshot_with_tap_async(
    context: &ProjectServiceRequestContext,
    window_id: &str,
    tap_snapshot: Option<&Value>,
    line_count: i64,
    max_chars: usize,
) -> Result<Option<Value>, String> {
    if let Some(snapshot) = hot_preview_snapshot(context, window_id, max_chars) {
        return Ok(merge_expose_preview_snapshots(
            Some(&snapshot),
            tap_snapshot,
        ));
    }
    let options = CapturePaneOptions {
        start_line: Some(-line_count),
        end_line: None,
        include_escapes: true,
    };
    let key = AgentOutputCaptureCacheKey {
        window_id: window_id.to_owned(),
        options,
    };
    let output = match context.output_cache.fresh(&key)? {
        Some(output) => output,
        None => {
            let mut command: AsyncCommand = tmux_command_from_env();
            command.args(capture_pane_argv(window_id, options));
            let output = command
                .output_timeout_async(Duration::from_secs(2))
                .await
                .map_err(|error| format!("tmux capture-pane failed for {window_id}: {error}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(if stderr.is_empty() {
                    format!("tmux capture-pane failed for {window_id}")
                } else {
                    stderr
                });
            }
            let output = String::from_utf8_lossy(&output.stdout).into_owned();
            context.output_cache.store(key, output.clone())?;
            output
        }
    };
    let capture_snapshot = json!({
        "output": trailing_chars(&output, max_chars),
        "capturedAt": now_iso(),
        "source": "capture",
        "windowId": window_id,
        "startLine": -line_count,
        "lineCount": line_count,
    });
    Ok(merge_expose_preview_snapshots(
        Some(&capture_snapshot),
        tap_snapshot,
    ))
}

pub fn hot_preview_snapshot(
    context: &ProjectServiceRequestContext,
    window_id: &str,
    max_chars: usize,
) -> Option<Value> {
    let project_root = context.project_root().to_string_lossy().into_owned();
    let view = read_hot_expose_scope_view(
        context.project_state_dir(),
        &HotExposeScopeKey {
            project_root,
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
    )?;
    for item in view.items {
        let item_window_id = item
            .get("target")
            .and_then(|target| target.get("windowId"))
            .and_then(Value::as_str);
        if item_window_id != Some(window_id) {
            continue;
        }
        let mut snapshot = item.get("previewSnapshot")?.clone();
        if let Some(output) = snapshot
            .get("output")
            .and_then(Value::as_str)
            .map(|output| trailing_chars(output, max_chars))
            && let Some(object) = snapshot.as_object_mut()
        {
            object.insert("output".into(), Value::String(output));
        }
        return Some(snapshot);
    }
    None
}

pub(crate) fn trailing_chars(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_owned();
    }
    value.chars().skip(char_count - max_chars).collect()
}

pub fn merge_expose_preview_snapshots(
    capture_snapshot: Option<&Value>,
    tap_snapshot: Option<&Value>,
) -> Option<Value> {
    let capture_snapshot = capture_snapshot.filter(|value| !value.is_null());
    let tap_snapshot = tap_snapshot.filter(|value| !value.is_null());
    let Some(tap_snapshot) = tap_snapshot else {
        return capture_snapshot.cloned();
    };
    let Some(capture_snapshot) = capture_snapshot else {
        return Some(json!({
            "output": string_field(tap_snapshot, "output"),
            "capturedAt": string_field(tap_snapshot, "capturedAt"),
            "source": string_field(tap_snapshot, "source"),
            "windowId": string_field(tap_snapshot, "windowId"),
        }));
    };
    let tap_output = string_field(tap_snapshot, "output");
    let capture_output = string_field(capture_snapshot, "output");
    if tap_output.is_empty() {
        return Some(capture_snapshot.clone());
    }
    if capture_output.is_empty() || tap_output.starts_with(capture_output) {
        return Some(json!({
            "output": tap_output,
            "capturedAt": string_field(tap_snapshot, "capturedAt"),
            "source": string_field(tap_snapshot, "source"),
            "windowId": string_field(tap_snapshot, "windowId"),
        }));
    }
    if capture_output.ends_with(tap_output) {
        return Some(capture_snapshot.clone());
    }
    let separator = if capture_output.ends_with('\n') || tap_output.starts_with('\n') {
        ""
    } else {
        "\n"
    };
    Some(json!({
        "output": format!("{capture_output}{separator}{tap_output}"),
        "capturedAt": string_field(tap_snapshot, "capturedAt"),
        "source": string_field(tap_snapshot, "source"),
        "windowId": string_field(tap_snapshot, "windowId"),
    }))
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
