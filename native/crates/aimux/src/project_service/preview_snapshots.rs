use serde_json::{Value, json};

use crate::tmux::CapturePaneOptions;
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
    if let Some(snapshot) = hot_preview_snapshot(context, window_id, max_chars) {
        return Some(snapshot);
    }
    let options = CapturePaneOptions {
        start_line: Some(-line_count),
        end_line: None,
        include_escapes: true,
    };
    let (output, _coalesced) = context
        .output_cache
        .capture_or_reuse(
            AgentOutputCaptureCacheKey {
                window_id: window_id.to_owned(),
                options,
            },
            || runtime.capture_pane(window_id, options),
        )
        .ok()?;
    Some(json!({
        "output": trailing_chars(&output, max_chars),
        "capturedAt": now_iso(),
        "source": "capture",
        "windowId": window_id,
        "startLine": -line_count,
        "lineCount": line_count,
    }))
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

fn trailing_chars(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_owned();
    }
    value.chars().skip(char_count - max_chars).collect()
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
