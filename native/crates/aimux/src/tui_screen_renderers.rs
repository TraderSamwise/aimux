use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::team_contract::is_project_control_session;
use crate::tui_render::{
    OverlayBoxSpec, OverlayVariant, render_overlay_box,
    screen_frame::{ScreenFrameInput, compose_screen_frame, screen_left_width},
    text::truncate_plain,
    theme::{
        CardSpec, StatusKind, Tone, card, footer_hints, keycap_hint, pad_visible, status_dot,
        style, visible_width,
    },
};

const CONTRACT_VERSION: &str = "0.1.34";
const CONTRACT_NOW: &str = "2026-09-07T00:00:00.000Z";

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

pub fn run_tui_subscreen_renderer_contract_case(api: &str, input: &Value) -> Value {
    let rendered = match api {
        "renderGraveyardScreen" => render_graveyard_screen_output(input),
        "renderGraveyardDetails" => render_graveyard_details_output(input),
        "renderProjectScreen" => render_project_screen_output(input),
        "renderLibraryScreen" => render_library_screen_output(input),
        _ => String::new(),
    };
    json!({
        "rendered": rendered,
        "visibleText": visible_text(&rendered),
    })
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

fn render_graveyard_screen_output(input: &Value) -> String {
    let cols = 120;
    let rows = 40;
    let view_model = input.get("viewModel").unwrap_or(&Value::Null);
    let graveyard_index = usize_field(input, "graveyardIndex", 0);
    let header = screen_header("graveyard", cols);
    let footer_lines = vec![footer_hints(
        "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [1-9/Enter] resurrect  [x] delete worktree  [Esc] dashboard  [q] quit",
    )];
    let two_pane = true;
    let card_width = screen_left_width(cols);
    let (content, focus_line) = graveyard_content(view_model, graveyard_index, card_width);
    let viewport_height = viewport_height(rows, header.len(), footer_lines.len());
    let right_width = right_panel_width(cols);
    let details =
        graveyard_details_lines(view_model, graveyard_index, right_width, viewport_height);
    compose_screen_frame(&ScreenFrameInput {
        cols,
        rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line: focus_line as isize,
        scroll_offset: 0,
        two_pane,
        right_panel: Some(&details),
    })
    .frame
}

fn render_graveyard_details_output(input: &Value) -> String {
    let width = usize_field(input, "width", 60);
    let height = usize_field(input, "height", 20);
    let view_model = input.get("viewModel").unwrap_or(&Value::Null);
    graveyard_details_lines(view_model, 0, width, height).join("\n")
}

fn render_project_screen_output(input: &Value) -> String {
    let ctx = input.get("ctx").unwrap_or(&Value::Null);
    let viewport = ctx.get("viewport").unwrap_or(&Value::Null);
    let cols = usize_field(viewport, "cols", 120);
    let rows = usize_field(viewport, "rows", 40);
    let header = screen_header("project", cols);
    let footer_lines = vec![footer_hints(
        "[Tab] details  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit",
    )];
    let content = vec![format!("  {}", style("Loading project...", Tone::Muted))];
    let details = vec![String::new(); viewport_height(rows, header.len(), footer_lines.len())];
    compose_screen_frame(&ScreenFrameInput {
        cols,
        rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line: 1,
        scroll_offset: 0,
        two_pane: cols >= 110 && bool_at(ctx, &["dashboardState", "detailsSidebarVisible"]),
        right_panel: Some(&details),
    })
    .frame
}

fn render_library_screen_output(input: &Value) -> String {
    let viewport = input.get("viewport").unwrap_or(&Value::Null);
    let cols = usize_field(viewport, "cols", 120);
    let rows = usize_field(viewport, "rows", 40);
    let library_index = usize_field(input, "libraryIndex", 0);
    let path =
        string_field(input, "path").unwrap_or_else(|| "/repo/.aimux/plans/codex-1.md".to_owned());
    let entry = json!({
        "id": "plan:codex-1",
        "kind": "plan",
        "title": "Codex plan",
        "path": path,
        "updatedAt": "2026-06-20T00:00:00.000Z",
        "sessionId": "codex-1",
        "preview": "# Plan",
    });
    let entries = vec![entry];
    let header = screen_header("library", cols);
    let selected = entries.get(library_index).unwrap_or(&entries[0]);
    let content = library_content(&entries, library_index);
    let mut footer_lines = vec![footer_hints(
        "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [Enter] show path  [r] refresh  [Esc] dashboard  [q] quit",
    )];
    if string_field(input, "libraryPathFlash").as_deref()
        == string_field(selected, "path").as_deref()
    {
        footer_lines.push(style(
            &format!(
                "Path: {}",
                string_field(selected, "path").unwrap_or_default()
            ),
            Tone::Muted,
        ));
    }
    let viewport_height = viewport_height(rows, header.len(), footer_lines.len());
    let details = library_details_lines(selected, right_panel_width(cols), viewport_height);
    compose_screen_frame(&ScreenFrameInput {
        cols,
        rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line: library_index as isize + 2,
        scroll_offset: 0,
        two_pane: true,
        right_panel: Some(&details),
    })
    .frame
}

fn screen_header(title: &str, cols: usize) -> Vec<String> {
    vec![
        String::new(),
        format!(
            "{} {} — {title}  {}",
            style("aimux", Tone::Strong),
            style(&format!("v{CONTRACT_VERSION}"), Tone::Muted),
            style("● tmux", Tone::Done)
        ),
        "─".repeat(cols),
        String::new(),
    ]
}

fn graveyard_content(
    view_model: &Value,
    graveyard_index: usize,
    card_width: usize,
) -> (Vec<String>, usize) {
    let rows = array_at(view_model, &["rows"]);
    if rows.is_empty() {
        return (
            vec![
                format!("  {}", style("Worktrees", Tone::Strong)),
                format!("    {}", style("(empty)", Tone::Muted)),
                String::new(),
                format!("  {}", style("Agents", Tone::Strong)),
                format!("    {}", style("(empty)", Tone::Muted)),
            ],
            1,
        );
    }
    let mut lines = Vec::new();
    let mut focus_line = 1;
    let mut first = true;
    let mut current_card: Option<GraveyardCardBlock> = None;
    let mut current_loose: Option<Vec<(String, Option<usize>)>> = None;

    let flush_card = |lines: &mut Vec<String>,
                      focus_line: &mut usize,
                      card_block: &mut Option<GraveyardCardBlock>,
                      loose: &mut Option<Vec<(String, Option<usize>)>>,
                      first: &mut bool| {
        if let Some(loose_rows) = loose.take() {
            if !*first {
                lines.push(String::new());
            }
            *first = false;
            for (text, action_index) in loose_rows {
                if action_index == Some(graveyard_index) {
                    *focus_line = lines.len();
                }
                lines.push(format!("  {text}"));
            }
        }
        if let Some(block) = card_block.take() {
            if !*first {
                lines.push(String::new());
            }
            *first = false;
            if block.title_action_index == Some(graveyard_index) {
                *focus_line = lines.len();
            }
            for (offset, (_, action_index)) in block.rows.iter().enumerate() {
                if *action_index == Some(graveyard_index) {
                    *focus_line = lines.len() + offset + 1;
                }
            }
            lines.extend(card(&CardSpec {
                tone: Tone::Muted,
                title: &block.title,
                summary: block.summary.as_deref(),
                rows: &block
                    .rows
                    .iter()
                    .map(|(row, _)| row.clone())
                    .collect::<Vec<_>>(),
                width: card_width,
            }));
        }
    };

    for row in rows {
        match string_field(row, "kind").as_deref().unwrap_or_default() {
            "section" => {
                flush_card(
                    &mut lines,
                    &mut focus_line,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                );
                if !first {
                    lines.push(String::new());
                }
                first = false;
                lines.push(format!(
                    "  {}",
                    style(
                        &string_field(row, "label").unwrap_or_default(),
                        Tone::Strong
                    )
                ));
            }
            "worktree" => {
                flush_card(
                    &mut lines,
                    &mut focus_line,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                );
                let selected = usize_field(row, "actionIndex", usize::MAX) == graveyard_index;
                let entry = row.get("entry").unwrap_or(&Value::Null);
                let branch = string_field(entry, "branch")
                    .map(|branch| format!(" {}", style(&format!("· {branch}"), Tone::Muted)))
                    .unwrap_or_default();
                let title = format!(
                    "{}{} {}{}",
                    selected_marker(selected),
                    keycap_hint(&action_number_label(row), "", None),
                    style(
                        &string_field(entry, "name").unwrap_or_default(),
                        if selected { Tone::Accent } else { Tone::Strong }
                    ),
                    branch
                );
                let agent_count = array_at(row, &["attachedAgents"]).len();
                let service_count = array_at(row, &["attachedServices"]).len();
                let service_text = if service_count > 0 {
                    format!(
                        " · {service_count} svc{}",
                        if service_count == 1 { "" } else { "s" }
                    )
                } else {
                    String::new()
                };
                let count_text = style(
                    &format!(
                        "{agent_count} agent{}{}",
                        if agent_count == 1 { "" } else { "s" },
                        service_text
                    ),
                    Tone::Muted,
                );
                let summary = recency_chip(string_field(row, "lastUsedAt").as_deref())
                    .map_or(count_text.clone(), |chip| format!("{count_text} {chip}"));
                current_card = Some(GraveyardCardBlock {
                    title,
                    summary: Some(summary),
                    title_action_index: Some(usize_field(row, "actionIndex", usize::MAX)),
                    rows: Vec::new(),
                });
            }
            "attached-agent-display" => {
                let agent = row
                    .get("agent")
                    .and_then(|agent| agent.get("entry"))
                    .unwrap_or(&Value::Null);
                let backend = string_field(agent, "backendSessionId")
                    .map(|backend| format!(" ({backend:.8}…)"))
                    .unwrap_or_default();
                let text = format!(
                    "  {} {}",
                    status_dot(StatusKind::Offline),
                    style(
                        &format!(
                            "{}:{}{}",
                            string_field(agent, "command").unwrap_or_default(),
                            string_field(agent, "id").unwrap_or_default(),
                            backend
                        ),
                        Tone::Muted
                    )
                );
                let text = recency_chip(string_at(row, &["agent", "lastUsedAt"]))
                    .map_or(text.clone(), |chip| format!("{text} {chip}"));
                if let Some(block) = &mut current_card {
                    block.rows.push((text, None));
                }
            }
            "agent-worktree" => {
                flush_card(
                    &mut lines,
                    &mut focus_line,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                );
                current_card = Some(GraveyardCardBlock {
                    title: style(&string_field(row, "name").unwrap_or_default(), Tone::Strong),
                    summary: None,
                    title_action_index: None,
                    rows: Vec::new(),
                });
            }
            "orphan-agent" | "standalone-agent" => {
                let entry = row.get("entry").unwrap_or(&Value::Null);
                let selected = usize_field(row, "actionIndex", usize::MAX) == graveyard_index;
                let text = format!(
                    "{}{} {} {}",
                    selected_marker(selected),
                    keycap_hint(&action_number_label(row), "", None),
                    status_dot(StatusKind::Offline),
                    style(
                        &format!(
                            "{}:{}",
                            string_field(entry, "command").unwrap_or_default(),
                            string_field(entry, "id").unwrap_or_default()
                        ),
                        Tone::Muted
                    )
                );
                let action = Some(usize_field(row, "actionIndex", usize::MAX));
                if current_card.is_some() {
                    if let Some(block) = &mut current_card {
                        block.rows.push((text, action));
                    }
                } else {
                    current_loose
                        .get_or_insert_with(Vec::new)
                        .push((text, action));
                }
            }
            _ => {}
        }
    }
    flush_card(
        &mut lines,
        &mut focus_line,
        &mut current_card,
        &mut current_loose,
        &mut first,
    );
    (lines, focus_line)
}

#[derive(Debug)]
struct GraveyardCardBlock {
    title: String,
    summary: Option<String>,
    title_action_index: Option<usize>,
    rows: Vec<(String, Option<usize>)>,
}

fn graveyard_details_lines(
    view_model: &Value,
    graveyard_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let selected = array_at(view_model, &["selectableRows"]).get(graveyard_index);
    let Some(selected) = selected else {
        return vec![String::new(); height];
    };
    let mut lines = Vec::new();
    if string_field(selected, "kind").as_deref() == Some("worktree") {
        let entry = selected.get("entry").unwrap_or(&Value::Null);
        lines.push(style("Details", Tone::Strong));
        push_kv(
            &mut lines,
            "Worktree",
            &string_field(entry, "name").unwrap_or_default(),
        );
        push_kv(
            &mut lines,
            "Branch",
            &string_field(entry, "branch").unwrap_or_default(),
        );
        push_kv(
            &mut lines,
            "Path",
            &string_field(entry, "path").unwrap_or_default(),
        );
        push_kv(&mut lines, "Status", "graveyard");
        if let Some(graveyarded_at) = string_field(entry, "graveyardedAt")
            && let Some(recency) = format_relative_recency(&graveyarded_at)
        {
            push_kv(&mut lines, "Graveyarded", &recency);
        }
        push_kv(
            &mut lines,
            "Agents",
            &array_at(selected, &["attachedAgents"]).len().to_string(),
        );
        push_kv(
            &mut lines,
            "Services",
            &array_at(selected, &["attachedServices"]).len().to_string(),
        );
        if let Some(last_used_at) = string_field(selected, "lastUsedAt")
            && let Some(recency) = format_relative_recency(&last_used_at)
        {
            push_kv(&mut lines, "Last Used", &recency);
        }
        lines.push(String::new());
        lines.push(style("Attached Agents", Tone::Strong));
        let attached = array_at(selected, &["visibleAttachedAgents"]);
        if attached.is_empty() {
            lines.push(style("(none)", Tone::Muted));
        } else {
            for agent in attached
                .iter()
                .take(height.saturating_sub(lines.len()).max(1))
            {
                let entry = agent.get("entry").unwrap_or(&Value::Null);
                let recency = string_field(agent, "lastUsedAt")
                    .and_then(|value| format_relative_recency(&value))
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default();
                lines.push(format!(
                    "- {}{recency}",
                    string_field(entry, "label")
                        .or_else(|| string_field(entry, "id"))
                        .unwrap_or_default()
                ));
            }
        }
    } else {
        let entry = selected.get("entry").unwrap_or(&Value::Null);
        lines.push(style("Details", Tone::Strong));
        push_kv(
            &mut lines,
            "Agent",
            &string_field(entry, "label")
                .or_else(|| string_field(entry, "id"))
                .unwrap_or_default(),
        );
        push_kv(
            &mut lines,
            "Session",
            &string_field(entry, "id").unwrap_or_default(),
        );
        push_kv(
            &mut lines,
            "Tool",
            &string_field(entry, "tool").unwrap_or_default(),
        );
        push_kv(
            &mut lines,
            "Config",
            &string_field(entry, "toolConfigKey").unwrap_or_default(),
        );
        push_kv(&mut lines, "Status", "offline");
        if let Some(command) = string_field(entry, "command") {
            push_kv(&mut lines, "Command", &command);
        }
    }
    while lines.len() < height {
        lines.push(String::new());
    }
    lines.truncate(height);
    lines
        .into_iter()
        .map(|line| truncate_plain(&line, width))
        .collect()
}

fn library_content(entries: &[Value], selected_index: usize) -> Vec<String> {
    let mut lines = vec![format!("  {}", style("Library", Tone::Strong))];
    for (index, entry) in entries.iter().enumerate() {
        let selected = index == selected_index;
        let kind = string_field(entry, "kind").unwrap_or_default();
        let tone = if kind == "plan" {
            Tone::Work
        } else {
            Tone::Info
        };
        let session = if kind == "plan" {
            string_field(entry, "sessionId")
                .map(|session| format!(" {}", style(&format!("({session})"), Tone::Muted)))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let when = string_field(entry, "updatedAt")
            .and_then(|updated| format_relative_recency(&updated))
            .map(|recency| format!(" {}", style(&format!("· {recency}"), Tone::Muted)))
            .unwrap_or_default();
        lines.push(format!(
            "{}{} {} {}{}{}{}",
            selected_marker(selected),
            style(&format!("[{}]", index + 1), Tone::Muted),
            style(&format!("[{kind}]"), tone),
            style(
                &truncate_plain(&string_field(entry, "title").unwrap_or_default(), 38),
                Tone::Strong
            ),
            session,
            when,
            trailing_mark(selected)
        ));
    }
    lines
}

fn library_details_lines(entry: &Value, width: usize, height: usize) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(style("Details", Tone::Strong));
    push_kv(
        &mut lines,
        "Title",
        &string_field(entry, "title").unwrap_or_default(),
    );
    push_kv(
        &mut lines,
        "Kind",
        &string_field(entry, "kind").unwrap_or_default(),
    );
    if let Some(session_id) = string_field(entry, "sessionId") {
        push_kv(&mut lines, "Session", &session_id);
    }
    push_kv(
        &mut lines,
        "Updated",
        &string_field(entry, "updatedAt").unwrap_or_default(),
    );
    push_kv(
        &mut lines,
        "Path",
        &string_field(entry, "path").unwrap_or_default(),
    );
    lines.push(String::new());
    lines.push(style("Preview", Tone::Strong));
    let preview = string_field(entry, "preview").unwrap_or_else(|| "(empty)".to_owned());
    for line in preview.lines() {
        lines.push(if line.chars().count() > width {
            format!(
                "{}…",
                line.chars()
                    .take(width.saturating_sub(1))
                    .collect::<String>()
            )
        } else {
            line.to_owned()
        });
    }
    while lines.len() < height {
        lines.push(String::new());
    }
    lines.truncate(height);
    lines
}

fn push_kv(lines: &mut Vec<String>, key: &str, value: &str) {
    lines.push(format!("{key}: {value}"));
}

fn action_number_label(row: &Value) -> String {
    row.get("actionNumber")
        .and_then(Value::as_u64)
        .map(|number| number.to_string())
        .or_else(|| string_field(row, "actionNumber"))
        .unwrap_or_else(|| "1".to_owned())
}

fn selected_marker(selected: bool) -> String {
    if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    }
}

fn trailing_mark(selected: bool) -> String {
    if selected {
        format!(" {}", style("◀", Tone::Accent))
    } else {
        String::new()
    }
}

fn recency_chip(value: Option<&str>) -> Option<String> {
    format_relative_recency(value?).map(|recency| {
        crate::tui_render::theme::chip(&recency, crate::tui_render::theme::ChipTone::Muted)
    })
}

fn format_relative_recency(value: &str) -> Option<String> {
    let then = days_from_civil_string(value)?;
    let now = days_from_civil_string(CONTRACT_NOW)?;
    let delta_seconds = ((now - then).max(0)) * 24 * 60 * 60;
    if delta_seconds < 15 {
        return Some("just now".to_owned());
    }
    if delta_seconds < 60 {
        return Some(format!("{delta_seconds}s ago"));
    }
    let minutes = delta_seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h ago"));
    }
    let days = hours / 24;
    if days < 7 {
        return Some(format!("{days}d ago"));
    }
    let weeks = days / 7;
    if weeks < 5 {
        return Some(format!("{weeks}w ago"));
    }
    let months = days / 30;
    if months < 12 {
        return Some(format!("{months}mo ago"));
    }
    Some(format!("{}y ago", days / 365))
}

fn days_from_civil_string(value: &str) -> Option<i64> {
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as i64)
}

fn viewport_height(rows: usize, header_len: usize, footer_line_len: usize) -> usize {
    rows.saturating_sub(header_len + 1 + footer_line_len).max(1)
}

fn right_panel_width(cols: usize) -> usize {
    let content_width = 72.max(cols);
    let left_width = screen_left_width(cols);
    content_width
        .saturating_sub(left_width)
        .saturating_sub(4)
        .max(20)
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

fn bool_at(value: &Value, path: &[&str]) -> bool {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_bool().unwrap_or(false)
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
