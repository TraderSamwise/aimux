use serde_json::Value;

use super::{
    array, coalesce_string, field, filtered_objects, js_string, nullish_or, object, pad_end,
    pad_start,
};

pub fn render_core_work_outline_entries_lines(entries: &[Value]) -> Vec<String> {
    if entries.is_empty() {
        return vec!["No scribe notes.".into()];
    }
    let mut lines = Vec::new();
    for entry in entries {
        let session_ids = array(entry, "sessionIds")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let session_text = if session_ids.is_empty() {
            String::new()
        } else {
            format!(" · {}", session_ids.join(","))
        };
        let worktree_text = field(entry, "worktreePath")
            .and_then(Value::as_str)
            .map(|value| format!(" · {value}"))
            .unwrap_or_default();
        lines.push(format!(
            "{} [{}] {}{}{}",
            js_string(field(entry, "entryId")),
            js_string(field(entry, "status")),
            js_string(field(entry, "title")),
            session_text,
            worktree_text
        ));
        lines.push(format!("  {}", js_string(field(entry, "summary"))));
    }
    lines
}

fn render_worktree_table_lines(
    worktrees: Vec<&serde_json::Map<String, Value>>,
    fallback: &str,
) -> Vec<String> {
    let mut lines = vec![
        format!(
            "{}{}Path",
            pad_end("Name".into(), 30),
            pad_end("Branch".into(), 35)
        ),
        "-".repeat(95),
    ];
    for worktree in worktrees {
        lines.push(format!(
            "{}{}{}",
            pad_end(coalesce_string(worktree.get("name"), fallback), 30),
            pad_end(coalesce_string(worktree.get("branch"), ""), 35),
            coalesce_string(worktree.get("path"), fallback)
        ));
    }
    lines
}

pub fn render_core_worktree_list_lines(payload: &Value) -> Vec<String> {
    let worktrees = filtered_objects(array(payload, "worktrees"));
    if worktrees.is_empty() {
        vec!["No worktrees found.".into()]
    } else {
        render_worktree_table_lines(worktrees, "")
    }
}

pub fn render_core_worktree_create_lines(payload: &Value) -> Vec<String> {
    if field(payload, "status").and_then(Value::as_str) == Some("creating") {
        vec![format!(
            "Creating worktree \"{}\"{}.",
            js_string(field(payload, "name")),
            field(payload, "path")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(|path| format!(" ({path})"))
                .unwrap_or_default()
        )]
    } else {
        vec![format!(
            "Created worktree \"{}\" at {}",
            js_string(field(payload, "name")),
            js_string(field(payload, "path"))
        )]
    }
}

pub fn render_core_worktree_remove_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "{} {}",
        if field(payload, "status").and_then(Value::as_str) == Some("removing") {
            "removing"
        } else {
            "removed"
        },
        js_string(field(payload, "path"))
    )]
}

pub fn render_core_worktree_graveyard_lines(payload: &Value) -> Vec<String> {
    vec![format!("graveyarded {}", js_string(field(payload, "path")))]
}

pub fn render_core_worktree_resurrect_lines(payload: &Value) -> Vec<String> {
    vec![format!("resurrected {}", js_string(field(payload, "path")))]
}

pub fn render_core_worktree_delete_graveyard_lines(payload: &Value) -> Vec<String> {
    vec![format!("deleted {}", js_string(field(payload, "path")))]
}

fn format_worktree_cache_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0B".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if value >= 10.0 || index == 0 {
        format!("{:.0}{}", value.round(), units[index])
    } else {
        format!("{:.1}{}", (value * 10.0).round() / 10.0, units[index])
    }
}

pub fn render_core_worktree_cache_cleanup_lines(payload: &Value) -> Vec<String> {
    let targets = array(payload, "targets");
    let dry_run = field(payload, "dryRun").and_then(Value::as_bool) == Some(true);
    let bytes = if dry_run {
        field(payload, "reclaimableBytes")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    } else {
        field(payload, "reclaimedBytes")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    let failed = array(payload, "results")
        .iter()
        .filter(|result| field(result, "status").and_then(Value::as_str) == Some("failed"))
        .count();
    let mut lines = vec![format!(
        "Worktree cache cleanup {} {} item(s), {}; {failed} failed.",
        if dry_run { "would remove" } else { "removed" },
        targets.len(),
        format_worktree_cache_bytes(bytes)
    )];
    let mut by_worktree: Vec<(String, f64, usize)> = Vec::new();
    for target in targets {
        let path = coalesce_string(
            nullish_or(field(target, "worktreePath"), field(target, "path")),
            "undefined",
        );
        let size = field(target, "sizeBytes")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some((_, total, count)) = by_worktree
            .iter_mut()
            .find(|(worktree_path, _, _)| *worktree_path == path)
        {
            *total += size;
            *count += 1;
        } else {
            by_worktree.push((path, size, 1));
        }
    }
    by_worktree.sort_by(|left, right| right.1.total_cmp(&left.1));
    if !by_worktree.is_empty() {
        lines.push("By worktree:".into());
        for (path, size, count) in by_worktree.iter().take(12) {
            lines.push(format!(
                "{}  {} item(s)  {path}",
                pad_start(format_worktree_cache_bytes(*size), 7),
                pad_start(count.to_string(), 4)
            ));
        }
        if by_worktree.len() > 12 {
            lines.push(format!(
                "... {} more worktree(s) hidden; use --json for full detail.",
                by_worktree.len() - 12
            ));
        }
    }
    if !targets.is_empty() && targets.len() <= 20 {
        lines.push("Targets:".into());
        for target in targets {
            lines.push(format!(
                "{}  {}",
                pad_start(
                    format_worktree_cache_bytes(
                        field(target, "sizeBytes")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                    ),
                    7
                ),
                js_string(field(target, "path"))
            ));
        }
    } else if targets.len() > 20 {
        lines.push(format!(
            "Targets hidden ({}); use --json for full detail.",
            targets.len()
        ));
    }
    let skipped = array(payload, "skipped");
    if !skipped.is_empty() {
        let active = skipped
            .iter()
            .filter(|entry| {
                field(entry, "reason").and_then(Value::as_str) == Some("active-runtime")
            })
            .count();
        lines.push(format!(
            "Skipped {} worktree(s){}.",
            skipped.len(),
            if active > 0 {
                format!(" ({active} active-runtime)")
            } else {
                "".into()
            }
        ));
    }
    lines
}

pub fn render_core_graveyard_lines(payload: &Value) -> Vec<String> {
    let entries = filtered_objects(array(payload, "entries"));
    let worktrees = filtered_objects(array(payload, "worktrees"));
    if entries.is_empty() && worktrees.is_empty() {
        return vec!["Graveyard is empty.".into()];
    };
    let mut lines = Vec::new();
    if !worktrees.is_empty() {
        lines.push("Worktrees".into());
        lines.extend(render_worktree_table_lines(worktrees, "?"));
    }
    if !entries.is_empty() {
        if !lines.is_empty() {
            lines.push("".into());
        }
        lines.extend([
            "Agents".into(),
            format!(
                "{}{}Backend Session ID",
                pad_end("ID".into(), 25),
                pad_end("Tool".into(), 15)
            ),
            "-".repeat(70),
        ]);
        for session in entries {
            lines.push(format!(
                "{}{}{}",
                pad_end(coalesce_string(session.get("id"), "?"), 25),
                pad_end(
                    coalesce_string(nullish_or(session.get("command"), session.get("tool")), "?"),
                    15
                ),
                coalesce_string(session.get("backendSessionId"), "(none)")
            ));
        }
    }
    lines
}

pub fn render_core_graveyard_agent_lines(payload: &Value) -> Vec<String> {
    let status = field(payload, "status").and_then(Value::as_str);
    vec![format!(
        "{} {}",
        if status == Some("graveyard") || status == Some("graveyarded") {
            "graveyarded"
        } else {
            "resurrected"
        },
        js_string(field(payload, "sessionId"))
    )]
}

pub fn render_core_graveyard_cleanup_lines(payload: &Value) -> Vec<String> {
    let result = object(payload, "result");
    let plan = result
        .and_then(|result| result.get("plan"))
        .and_then(Value::as_object);
    if plan
        .and_then(|plan| plan.get("enabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return vec!["Graveyard cleanup is disabled.".into()];
    };
    let records = result
        .and_then(|result| result.get("results"))
        .and_then(Value::as_array)
        .map(|items| filtered_objects(items))
        .unwrap_or_default();
    let removed = records
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("removed"))
        .count();
    let dry_run_count = records
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("dry-run"))
        .count();
    let failed = records
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("failed"))
        .count();
    let dry_run = result
        .and_then(|result| result.get("dryRun"))
        .and_then(Value::as_bool)
        == Some(true);
    let mut lines = vec![format!(
        "Graveyard cleanup {} {} item(s); {failed} failed. Retention: {} day(s).",
        if dry_run { "would remove" } else { "removed" },
        if dry_run { dry_run_count } else { removed },
        coalesce_string(plan.and_then(|plan| plan.get("retentionDays")), "?")
    )];
    for item in records {
        let status = if item.get("status").and_then(Value::as_str) == Some("failed") {
            format!("failed: {}", coalesce_string(item.get("error"), ""))
        } else {
            coalesce_string(item.get("status"), "?")
        };
        lines.push(format!(
            "{} {}: {status}",
            coalesce_string(item.get("kind"), "?"),
            coalesce_string(item.get("id"), "?")
        ));
    }
    lines
}
