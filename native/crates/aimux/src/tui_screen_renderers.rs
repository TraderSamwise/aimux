use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::team_contract::is_project_control_session;
use crate::tui_render::{
    OverlayBoxSpec, OverlayVariant, render_overlay_box,
    theme::{Tone, keycap_hint, pad_visible, style, visible_width},
};

pub fn run_tui_screen_overlay_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    let ctx = input.get("ctx").unwrap_or(&Value::Null);
    let cols = usize_field(input, "cols", 80);
    let rows = usize_field(input, "rows", 24);
    let rendered = match api {
        "buildWorktreeListOverlayOutput" => {
            Some(build_worktree_list_overlay_output(ctx, cols, rows))
        }
        "buildWorktreeCacheCleanupConfirmOverlayOutput" => {
            build_worktree_cache_cleanup_confirm_overlay_output(ctx, cols, rows)
        }
        "buildWorkOutlineOverlayOutput" => Some(build_work_outline_overlay_output(ctx, cols, rows)),
        "buildAgentRestoreConfirmOverlayOutput" => {
            build_agent_restore_confirm_overlay_output(ctx, cols, rows)
        }
        "buildHelpOverlayOutput" => Some(build_help_overlay_output(cols, rows)),
        "buildOverseerOverlayOutput" => Some(build_overseer_overlay_output(ctx, cols, rows)),
        "buildOverseerWatchInstructionsOverlayOutput" => {
            build_overseer_watch_instructions_overlay_output(ctx, cols, rows)
        }
        _ => None,
    };
    overlay_output_value(api, rendered)
}

fn overlay_output_value(api: &str, rendered: Option<String>) -> Value {
    let mut output = json!({
        "rendered": rendered.clone().unwrap_or_default(),
        "visibleText": rendered.as_deref().map(visible_text).unwrap_or_default(),
        "isNull": rendered.is_none(),
    });
    if api == "buildWorktreeListOverlayOutput" {
        output["sideEffects"] = json!({ "listAllWorktreesCalled": false });
    }
    output
}

fn build_service_hints(pairs: &[(&str, &str)]) -> String {
    format!(
        "  {}",
        pairs
            .iter()
            .map(|(key, label)| keycap_hint(key, label, None))
            .collect::<Vec<_>>()
            .join("  ")
    )
}

fn build_worktree_list_overlay_output(ctx: &Value, cols: usize, rows: usize) -> String {
    let groups = ctx
        .get("dashboardWorktreeGroupsCache")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut body = Vec::new();
    if groups.is_empty() {
        body.push(format!("  {}", style("No worktrees found.", Tone::Muted)));
    } else {
        for (index, worktree) in groups.iter().enumerate() {
            let name = string_field(worktree, "name").unwrap_or_default();
            let branch = string_field(worktree, "branch").unwrap_or_default();
            let is_dashboard = string_field(ctx, "mode").as_deref() == Some("dashboard");
            let is_main = if worktree.get("path").is_none() || (!is_dashboard && index == 0) {
                format!(" {}", style("(main)", Tone::Muted))
            } else {
                String::new()
            };
            body.push(format!(
                "  {} {}{}",
                style(&name, Tone::Strong),
                style(&format!("({branch})"), Tone::Muted),
                is_main
            ));
        }
    }
    body.push(String::new());
    body.push(build_service_hints(&[("Esc", "back")]));
    overlay_box(
        "Worktree Management",
        body,
        cols,
        rows,
        OverlayVariant::Blue,
    )
}

fn build_worktree_cache_cleanup_confirm_overlay_output(
    ctx: &Value,
    cols: usize,
    rows: usize,
) -> Option<String> {
    let result = ctx.get("worktreeCacheCleanupConfirm")?;
    let targets = array_at(result, &["plan", "targets"]);
    let body = if targets.is_empty() {
        vec![
            format!(
                "  {}",
                style("No inactive generated worktree caches found.", Tone::Muted)
            ),
            String::new(),
            build_service_hints(&[("Enter", "dismiss"), ("Esc", "back")]),
        ]
    } else {
        let mut body = render_worktree_cache_cleanup_run_result(result, 6, 8)
            .into_iter()
            .map(|line| format!("  {}", style(&line, Tone::Muted)))
            .collect::<Vec<_>>();
        body.push(String::new());
        body.push(format!(
            "  {}",
            style(
                &format!(
                    "This removes {} from inactive worktrees.",
                    format_worktree_cache_bytes(number_at(result, &["plan", "reclaimableBytes"]))
                ),
                Tone::Muted
            )
        ));
        body.push(String::new());
        body.push(build_service_hints(&[
            ("Enter/y", "remove"),
            ("n/Esc", "cancel"),
        ]));
        body
    };
    Some(overlay_box(
        "Worktree Cache Cleanup",
        body,
        cols,
        rows,
        if targets.is_empty() {
            OverlayVariant::Blue
        } else {
            OverlayVariant::Red
        },
    ))
}

fn render_worktree_cache_cleanup_run_result(
    result: &Value,
    max_worktrees: usize,
    max_targets: usize,
) -> Vec<String> {
    let dry_run = bool_field(result, "dryRun");
    let targets = array_at(result, &["plan", "targets"]);
    let results = array_at(result, &["results"]);
    let failed = results
        .iter()
        .filter(|item| string_field(item, "status").as_deref() == Some("failed"))
        .count();
    let bytes = if dry_run {
        number_at(result, &["plan", "reclaimableBytes"])
    } else {
        number_at(result, &["reclaimedBytes"])
    };
    let action = if dry_run { "would remove" } else { "removed" };
    let mut lines = vec![format!(
        "Worktree cache cleanup {action} {} item(s), {}; {failed} failed.",
        targets.len(),
        format_worktree_cache_bytes(bytes)
    )];
    let by_worktree = summarize_worktree_cache_targets(targets);
    if !by_worktree.is_empty() {
        lines.push("By worktree:".to_owned());
        for summary in by_worktree.iter().take(max_worktrees) {
            let size = format_worktree_cache_bytes(summary.size_bytes);
            lines.push(format!(
                "{size:>7}  {:>4} item(s)  {}",
                summary.target_count, summary.worktree_path
            ));
        }
        if by_worktree.len() > max_worktrees {
            lines.push(format!(
                "... {} more worktree(s) hidden; use --json for full detail.",
                by_worktree.len() - max_worktrees
            ));
        }
    }
    if !targets.is_empty() && targets.len() <= max_targets {
        lines.push("Targets:".to_owned());
        for target in targets {
            let size = format_worktree_cache_bytes(number_field(target, "sizeBytes"));
            lines.push(format!(
                "{size:>7}  {}",
                string_field(target, "path").unwrap_or_default()
            ));
        }
    } else if targets.len() > max_targets {
        lines.push(format!(
            "Targets hidden ({}); use --json for full detail.",
            targets.len()
        ));
    }
    let skipped = array_at(result, &["plan", "skipped"]);
    if !skipped.is_empty() {
        let active = skipped
            .iter()
            .filter(|entry| string_field(entry, "reason").as_deref() == Some("active-runtime"))
            .count();
        let suffix = if active > 0 {
            format!(" ({active} active-runtime)")
        } else {
            String::new()
        };
        lines.push(format!("Skipped {} worktree(s){suffix}.", skipped.len()));
    }
    lines
}

#[derive(Debug)]
struct WorktreeCacheSummary {
    worktree_path: String,
    size_bytes: f64,
    target_count: usize,
}

fn summarize_worktree_cache_targets(targets: &[Value]) -> Vec<WorktreeCacheSummary> {
    let mut by_worktree = BTreeMap::<String, WorktreeCacheSummary>::new();
    for target in targets {
        let worktree_path = string_field(target, "worktreePath").unwrap_or_default();
        let entry =
            by_worktree
                .entry(worktree_path.clone())
                .or_insert_with(|| WorktreeCacheSummary {
                    worktree_path,
                    size_bytes: 0.0,
                    target_count: 0,
                });
        entry.size_bytes += number_field(target, "sizeBytes");
        entry.target_count += 1;
    }
    let mut summaries = by_worktree.into_values().collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        right
            .size_bytes
            .partial_cmp(&left.size_bytes)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    summaries
}

fn format_worktree_cache_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0B".to_owned();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut unit_index = 0;
    while value >= 1024.0 && unit_index < units.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    let decimals = if value >= 10.0 || unit_index == 0 {
        0
    } else {
        1
    };
    format!("{value:.decimals$}{}", units[unit_index])
}

fn build_work_outline_overlay_output(ctx: &Value, cols: usize, rows: usize) -> String {
    let entries = ctx
        .get("workOutlineOverlayEntries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let scribes = dashboard_scribe_sessions(ctx);
    let live_scribe = scribes.iter().find(|session| is_live_session(session));
    let scribe = live_scribe.copied().or_else(|| scribes.first().copied());
    let scribe_line = scribe.map_or_else(
        || style("none", Tone::Muted),
        |session| {
            format!(
                "{} {}",
                style(&session_label(session), Tone::Strong),
                style(
                    &string_field(session, "status").unwrap_or_else(|| "active".to_owned()),
                    if live_scribe.is_some() {
                        Tone::Done
                    } else {
                        Tone::Muted
                    },
                )
            )
        },
    );
    let offset =
        usize_field(ctx, "workOutlineOverlayOffset", 0).min(entries.len().saturating_sub(1));
    let max_rows = rows
        .saturating_sub(
            14 + if ctx.get("workOutlineOverlaySessionId").is_some() {
                2
            } else {
                0
            },
        )
        .max(2);
    let row_width = cols.saturating_sub(12).clamp(24, 120);
    let truncate = |value: &str, reserve: usize| {
        pad_visible(value, row_width.saturating_sub(reserve).max(8))
            .trim_end()
            .to_owned()
    };
    let mut body_rows = Vec::new();
    let visible_entries = entries.iter().skip(offset).collect::<Vec<_>>();
    let mut rendered_count = 0;
    for entry in &visible_entries {
        let mut entry_rows = Vec::new();
        let status = string_field(entry, "status")
            .map(|status| {
                style(
                    &status,
                    if status == "done" {
                        Tone::Done
                    } else {
                        Tone::Accent
                    },
                )
            })
            .unwrap_or_default();
        let worktree = outline_entry_worktree(entry);
        let meta = [
            (!status.is_empty()).then_some(status),
            string_field(entry, "source").map(|source| style(&source, Tone::Muted)),
            (!worktree.is_empty()).then(|| style(&format!("worktree={worktree}"), Tone::Muted)),
            string_field(entry, "updatedAt").map(|updated| {
                style(
                    &format!(
                        "updated={}",
                        updated
                            .chars()
                            .take(16)
                            .collect::<String>()
                            .replace('T', " ")
                    ),
                    Tone::Muted,
                )
            }),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        let meta_suffix = if meta.is_empty() {
            String::new()
        } else {
            format!(" {meta}")
        };
        let title = string_field(entry, "title")
            .or_else(|| string_field(entry, "topicKey"))
            .or_else(|| string_field(entry, "entryId"))
            .unwrap_or_default();
        entry_rows.push(format!(
            "  {}{}",
            style(&truncate(&title, visible_width(&meta_suffix)), Tone::Strong),
            meta_suffix
        ));
        if let Some(summary) = string_field(entry, "summary") {
            entry_rows.push(format!(
                "    {}",
                style(&truncate(&summary, 4), Tone::Muted)
            ));
        }
        let suffix = outline_entry_session_suffix(entry);
        if !suffix.is_empty() {
            let topic = string_field(entry, "topicKey")
                .or_else(|| string_field(entry, "entryId"))
                .unwrap_or_default();
            entry_rows.push(format!(
                "    {}",
                style(&truncate(&format!("{topic}{suffix}"), 4), Tone::Muted)
            ));
        }
        entry_rows.push(String::new());
        if body_rows.len() + entry_rows.len() > max_rows {
            break;
        }
        body_rows.extend(entry_rows);
        rendered_count += 1;
    }
    if entries.is_empty() {
        body_rows.push(format!("  {}", style("No scribe notes yet.", Tone::Muted)));
        body_rows.push(String::new());
    } else if visible_entries.len() > rendered_count {
        body_rows.push(format!(
            "  {}",
            style(
                &format!("{} more entries", visible_entries.len() - rendered_count),
                Tone::Muted
            )
        ));
    }
    let scope = string_field(ctx, "workOutlineOverlaySessionId").map(|session_id| {
        format!(
            "  {}",
            style(&format!("Session: {session_id}"), Tone::Muted)
        )
    });
    let mut body = vec![
        format!("  {} {scribe_line}", style("Scribe:", Tone::Muted)),
        String::new(),
    ];
    if let Some(scope) = scope {
        body.push(scope);
        body.push(String::new());
    }
    body.extend(body_rows);
    let mut hint_pairs = vec![
        (
            "Enter",
            if live_scribe.is_some() {
                "focus scribe"
            } else {
                "start scribe"
            },
        ),
        ("↑↓/jk", "scroll"),
        ("r", "reload"),
    ];
    if live_scribe.is_some() {
        hint_pairs.push(("x", "stop scribe"));
    }
    if scribe.is_some() {
        hint_pairs.push(("d", "unset scribe"));
    }
    hint_pairs.push(("Esc/q", "back"));
    body.push(build_service_hints(&hint_pairs));
    overlay_box("Scribe", body, cols, rows, OverlayVariant::Blue)
}

fn build_agent_restore_confirm_overlay_output(
    ctx: &Value,
    cols: usize,
    rows: usize,
) -> Option<String> {
    let offer = ctx.get("dashboardAgentRestoreOfferCache")?;
    let sessions = array_at(offer, &["sessions"]);
    let session_ids = array_at(offer, &["sessionIds"]);
    if sessions.is_empty() || session_ids.is_empty() {
        return None;
    }
    let selected = if string_field(ctx, "agentRestoreConfirmSelection").as_deref() == Some("cancel")
    {
        "cancel"
    } else {
        "restore"
    };
    let labels = sessions
        .iter()
        .take(5)
        .map(restore_offer_session_label)
        .collect::<Vec<_>>()
        .join(", ");
    let extra = if sessions.len() > 5 {
        format!(", +{} more", sessions.len() - 5)
    } else {
        String::new()
    };
    let count = session_ids.len();
    let groups = restore_offer_group_labels(offer);
    let mut body = vec![format!(
        "  Restore {count} restorable session{} for this project?",
        if count == 1 { "" } else { "s" }
    )];
    if !groups.is_empty() {
        body.push(format!("  {}", style(&groups, Tone::Muted)));
    }
    if !labels.is_empty() {
        body.push(format!(
            "  {}",
            style(&format!("{labels}{extra}"), Tone::Muted)
        ));
    }
    body.push(format!(
        "  {}  {}",
        restore_confirm_button("Restore", selected == "restore"),
        restore_confirm_button("Cancel", selected == "cancel")
    ));
    body.push(build_service_hints(&[
        ("←/→", "choose"),
        ("Enter", "confirm"),
        ("Esc", "cancel"),
    ]));
    Some(overlay_box(
        "Restore sessions",
        body,
        cols,
        rows,
        OverlayVariant::Blue,
    ))
}

fn restore_confirm_button(label: &str, active: bool) -> String {
    if active {
        format!("\x1b[7m {label} \x1b[0m")
    } else {
        style(&format!(" {label} "), Tone::Muted)
    }
}

fn restore_offer_group_labels(offer: &Value) -> String {
    let mut groups = BTreeMap::<String, usize>::new();
    let mut control_roles = BTreeMap::<String, usize>::new();
    for session in array_at(offer, &["sessions"]) {
        if let Some(control_role) = restore_offer_session_control_role(session) {
            *control_roles.entry(control_role).or_default() += 1;
            continue;
        }
        let path = string_field(session, "worktreePath").unwrap_or_default();
        let marker = "/.aimux/worktrees/";
        let name = path
            .find(marker)
            .map(|index| {
                path[index + marker.len()..]
                    .split('/')
                    .next()
                    .unwrap_or("Main Checkout")
                    .to_owned()
            })
            .unwrap_or_else(|| "Main Checkout".to_owned());
        *groups
            .entry(if name.is_empty() {
                "Main Checkout".to_owned()
            } else {
                name
            })
            .or_default() += 1;
    }
    let mut labels = groups
        .into_iter()
        .map(|(name, count)| format!("{name} {count}"))
        .collect::<Vec<_>>();
    if !control_roles.is_empty() {
        let controls = control_roles
            .into_iter()
            .map(|(role, count)| {
                if count == 1 {
                    role
                } else {
                    format!("{role} {count}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        labels.push(format!("project control: {controls}"));
    }
    labels.into_iter().take(4).collect::<Vec<_>>().join(" · ")
}

fn restore_offer_session_control_role(session: &Value) -> Option<String> {
    if !is_project_control_session(Some(session)) {
        return None;
    }
    let role = string_at(session, &["team", "role"]);
    if bool_field(session, "overseer") || role == Some("overseer") {
        return Some("overseer".to_owned());
    }
    if is_scribe_session(session) {
        return Some("scribe".to_owned());
    }
    Some(role.unwrap_or("control").to_owned())
}

fn restore_offer_session_label(session: &Value) -> String {
    let label = session_label(session);
    restore_offer_session_control_role(session)
        .map_or(label.clone(), |role| format!("{role}: {label}"))
}

fn build_help_overlay_output(cols: usize, rows: usize) -> String {
    let all_lines = [
        "Tmux mode",
        "  Dashboard lives in a managed tmux dashboard window",
        "  Each agent runs in its own tmux window",
        "  Use normal tmux window navigation inside agents",
        "  Run aimux with no args to return to the dashboard window",
        "  Ctrl+A d  return to the dashboard window",
        "",
        "Dashboard mode",
        "  ?  show help",
        "  1-9  jump to visible item",
        "  arrows / h j k l  navigate",
        "  Enter / → / l  step in, open, resume, or focus",
        "  Tab  toggle details",
        "  c  coordination",
        "  p  project",
        "  L  library",
        "  t  topology",
        "  g  graveyard",
        "  n  new agent",
        "  v  new service",
        "  f  fork agent",
        "  S  switch selected agent tool",
        "  s  send message",
        "  H  handoff",
        "  T  task",
        "  P  scribe",
        "  o  open thread",
        "  R  reply",
        "  r  name agent",
        "  m  migrate agent",
        "  x  stop or remove selected item",
        "  q  quit",
        "",
        "Esc, Enter, or ? to close",
    ];
    let max_content_rows = rows.saturating_sub(6).max(6);
    let mut lines = all_lines.to_vec();
    if lines.len() > max_content_rows {
        let close_line = *lines.last().unwrap_or(&"");
        let available = max_content_rows.saturating_sub(2).max(4);
        lines = lines
            .into_iter()
            .take(available)
            .chain(["...", close_line])
            .collect();
    }
    overlay_box(
        "Help",
        lines.into_iter().map(style_help_line).collect(),
        cols,
        rows,
        OverlayVariant::Blue,
    )
}

fn style_help_line(line: &str) -> String {
    if line.is_empty() {
        return String::new();
    }
    let indented = line.starts_with("  ");
    let text = line.trim();
    if !indented {
        return style(text, Tone::Strong);
    }
    if let Some((key, label)) = split_help_hint(text) {
        return format!("  {}", keycap_hint(key, label, None));
    }
    format!("  {}", style(text, Tone::Muted))
}

fn split_help_hint(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut start = None;
    let mut len = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b' ' {
            start.get_or_insert(index);
            len += 1;
            if len >= 2 {
                let split = start.unwrap_or(index);
                return Some((text[..split].trim_end(), text[index + 1..].trim_start()));
            }
        } else {
            start = None;
            len = 0;
        }
    }
    None
}

fn build_overseer_overlay_output(ctx: &Value, cols: usize, rows: usize) -> String {
    let overseers = dashboard_overseer_sessions(ctx);
    let live_overseer = overseers.iter().find(|session| is_live_session(session));
    let watched = watched_dashboard_sessions(ctx);
    let selected = watched.first();
    let max_watched_rows = rows.saturating_sub(15).max(2);
    let mut watched_rows = watched
        .iter()
        .take(max_watched_rows)
        .map(|entry| {
            let goal = entry
                .get("loop")
                .and_then(|loop_state| string_field(loop_state, "goal"));
            let goal = goal.map_or_else(String::new, |goal| {
                style(&format!(" - {goal}"), Tone::Muted)
            });
            format!(
                "  {} {} {}{}",
                style("•", Tone::Accent),
                style(&session_label(entry), Tone::Strong),
                style(
                    &string_field(entry, "status").unwrap_or_default(),
                    Tone::Muted
                ),
                goal
            )
        })
        .collect::<Vec<_>>();
    if watched.len() > watched_rows.len() {
        watched_rows.push(format!(
            "  {}",
            style(
                &format!("{} more watched agents", watched.len() - watched_rows.len()),
                Tone::Muted
            )
        ));
    }
    let selected_line = selected.map_or_else(
        || style("none", Tone::Muted),
        |entry| {
            format!(
                "{} {}",
                style(&session_label(entry), Tone::Strong),
                if entry
                    .get("loop")
                    .and_then(|loop_state| loop_state.get("active"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    style("watched", Tone::Done)
                } else {
                    style("not watched", Tone::Muted)
                }
            )
        },
    );
    let overseer_line = live_overseer.map_or_else(
        || style("none running", Tone::Muted),
        |entry| {
            format!(
                "{} {}",
                style(&session_label(entry), Tone::Strong),
                style(
                    &string_field(entry, "status").unwrap_or_else(|| "active".to_owned()),
                    Tone::Done
                )
            )
        },
    );
    let mut body = vec![
        format!(
            "  {} {}",
            style("Status:", Tone::Muted),
            if live_overseer.is_some() {
                style("Active", Tone::Done)
            } else {
                style("Off", Tone::Muted)
            }
        ),
        format!("  {} {overseer_line}", style("Overseer:", Tone::Muted)),
        format!(
            "  {} {} {}",
            style("Watching:", Tone::Muted),
            watched.len(),
            if watched.len() == 1 {
                "agent"
            } else {
                "agents"
            }
        ),
        format!("  {} {selected_line}", style("Selected:", Tone::Muted)),
        String::new(),
    ];
    if watched_rows.is_empty() {
        body.push(format!(
            "  {}",
            style("No watched agents yet.", Tone::Muted)
        ));
    } else {
        body.extend(watched_rows);
    }
    body.push(String::new());
    let mut hints = vec![
        (
            "Enter",
            if live_overseer.is_some() {
                "focus"
            } else {
                "start"
            },
        ),
        ("w", "watch selected"),
        ("u", "unwatch selected"),
    ];
    if live_overseer.is_some() {
        hints.push(("x", "stop overseer"));
    }
    hints.push(("Esc", "back"));
    body.push(build_service_hints(&hints));
    overlay_box("Overseer", body, cols, rows, OverlayVariant::Blue)
}

fn build_overseer_watch_instructions_overlay_output(
    ctx: &Value,
    cols: usize,
    rows: usize,
) -> Option<String> {
    let target = ctx.get("overseerWatchInstructionsTarget")?;
    let buffer = string_field(ctx, "overseerWatchInstructionsBuffer").unwrap_or_default();
    let goal = string_field(target, "taskDescription")
        .or_else(|| string_field(target, "headline"))
        .or_else(|| {
            target
                .get("loop")
                .and_then(|loop_state| string_field(loop_state, "goal"))
        })
        .unwrap_or_default();
    let mut body = vec![format!(
        "  {} {} {}",
        style("Watch:", Tone::Muted),
        style(&session_label(target), Tone::Strong),
        style(
            &string_field(target, "status").unwrap_or_default(),
            Tone::Muted
        )
    )];
    if !goal.is_empty() {
        body.push(format!("  {} {goal}", style("Goal:", Tone::Muted)));
    }
    body.push(String::new());
    body.push(format!(
        "  {} {buffer}_",
        style("Instructions:", Tone::Muted)
    ));
    body.push(String::new());
    body.push(build_service_hints(&[
        ("Enter", "watch"),
        ("Esc", "cancel"),
    ]));
    Some(overlay_box(
        "Overseer Watch",
        body,
        cols,
        rows,
        OverlayVariant::Blue,
    ))
}

fn overlay_box(
    title: &str,
    body: Vec<String>,
    cols: usize,
    rows: usize,
    variant: OverlayVariant,
) -> String {
    render_overlay_box(&OverlayBoxSpec {
        title,
        body: &body,
        cols,
        rows,
        variant,
        icon: None,
    })
}

fn dashboard_overseer_sessions(ctx: &Value) -> Vec<&Value> {
    ctx.get("dashboardOverseerSessionsCache")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .or_else(|| {
            ctx.get("dashboard")
                .and_then(|dashboard| dashboard.get("viewModel"))
                .and_then(|view_model| view_model.get("overseerSessions"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
        })
        .unwrap_or(&[])
        .iter()
        .collect()
}

fn dashboard_scribe_sessions(ctx: &Value) -> Vec<&Value> {
    ctx.get("dashboardScribeSessionsCache")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .or_else(|| {
            ctx.get("dashboard")
                .and_then(|dashboard| dashboard.get("viewModel"))
                .and_then(|view_model| view_model.get("scribeSessions"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
        })
        .unwrap_or(&[])
        .iter()
        .collect()
}

fn watched_dashboard_sessions(ctx: &Value) -> Vec<Value> {
    let normal = ctx
        .get("dashboardSessionsCache")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .or_else(|| {
            ctx.get("dashboard")
                .and_then(|dashboard| dashboard.get("viewModel"))
                .and_then(|view_model| view_model.get("sessions"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
        })
        .unwrap_or(&[]);
    let teammates = ctx
        .get("dashboardTeammatesCache")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut by_id = BTreeMap::<String, Value>::new();
    for entry in normal.iter().chain(teammates) {
        let Some(id) = string_field(entry, "id") else {
            continue;
        };
        if entry
            .get("loop")
            .and_then(|loop_state| loop_state.get("active"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            by_id.insert(id, entry.clone());
        }
    }
    by_id.into_values().collect()
}

fn outline_entry_session_suffix(entry: &Value) -> String {
    let session_ids = entry
        .get("sessionIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if session_ids.is_empty() {
        return String::new();
    }
    let shown = session_ids
        .iter()
        .take(2)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let more = if session_ids.len() > 2 {
        format!(", +{}", session_ids.len() - 2)
    } else {
        String::new()
    };
    format!(" sessions={shown}{more}")
}

fn outline_entry_worktree(entry: &Value) -> String {
    let path = string_field(entry, "worktreePath").unwrap_or_default();
    if path.trim().is_empty() {
        return String::new();
    }
    let marker = "/.aimux/worktrees/";
    path.find(marker)
        .map(|index| {
            path[index + marker.len()..]
                .split('/')
                .next()
                .unwrap_or("")
                .to_owned()
        })
        .unwrap_or_else(|| "main".to_owned())
}

fn session_label(entry: &Value) -> String {
    if let Some(label) = string_at(entry, &["team", "label"]) {
        return label.to_owned();
    }
    string_field(entry, "label")
        .or_else(|| string_field(entry, "command"))
        .or_else(|| string_field(entry, "id"))
        .unwrap_or_else(|| "agent".to_owned())
}

fn is_live_session(entry: &Value) -> bool {
    !matches!(
        string_field(entry, "status").as_deref(),
        Some("offline" | "exited" | "graveyard")
    )
}

fn is_scribe_session(session: &Value) -> bool {
    if bool_field_is(session, "scribe", false) {
        return false;
    }
    bool_field(session, "scribe") || string_at(session, &["team", "role"]) == Some("scribe")
}

fn visible_text(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            if matches!(bytes.get(index + 1), Some(b'7' | b'8')) {
                index += 2;
                continue;
            }
            if bytes.get(index + 1) == Some(&b'[') {
                index += 2;
                while let Some(byte) = bytes.get(index) {
                    index += 1;
                    if (0x40..=0x7e).contains(byte) {
                        break;
                    }
                }
                continue;
            }
        }
        let character = text[index..]
            .chars()
            .next()
            .expect("index must be a UTF-8 boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn array_at<'a>(value: &'a Value, path: &[&str]) -> &'a [Value] {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn bool_field_is(value: &Value, key: &str, expected: bool) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(expected)
}

fn number_field(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn number_at(value: &Value, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_f64().unwrap_or(0.0)
}

fn usize_field(value: &Value, key: &str, fallback: usize) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}
