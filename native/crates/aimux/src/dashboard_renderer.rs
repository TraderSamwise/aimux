mod footer;

use crate::dashboard_controller::DashboardScreen;
use crate::dashboard_model::{
    DashboardOperationFailure, DashboardService, DashboardSession, DesktopStateSnapshot,
    ServiceStatus, SessionStatus,
};
use crate::project_service::work_outline::{WorkOutlineEntry, WorkOutlineStatus};
use crate::project_service::worktree_colors_contract::worktree_color_ansi;
use crate::tmux_expose_preview_sanitize::sanitize_expose_preview_output;
use crate::tui_render::screen_frame::{
    ScreenFrameInput, ScreenFrameResult, compose_screen_frame, screen_content_width,
    screen_left_width,
};
use crate::tui_render::text::{
    center, js_len, truncate, truncate_ansi, truncate_plain, wrap_key_value, wrap_text,
};
use crate::tui_render::theme::{
    CardSpec, ChipTone, Column, FooterHint, KeyTone, StatusKind, Tone, card, chip,
    cols as grid_cols, footer_hints, keycap_hint, pill, render_footer_hints, status_dot, style,
    visible_width,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

const RECENT_IDLE_MS: u128 = 2 * 60 * 1000;
const DASHBOARD_QUICK_JUMP_LIMIT: usize = 9;
const COL_SELECT: usize = 2;
const COL_DOT: usize = 2;
const COL_INDEX: usize = 4;
const COL_IDENTITY: usize = 16;
const COL_STATUS: usize = 14;
const COL_TIME: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardNavLevel {
    Worktrees,
    Sessions,
}

#[derive(Debug, Clone)]
pub struct DashboardRenderInput<'a> {
    pub snapshot: &'a DesktopStateSnapshot,
    pub overseer_sessions: &'a [DashboardSession],
    pub scribe_sessions: &'a [DashboardSession],
    pub cols: usize,
    pub rows: usize,
    pub nav_level: DashboardNavLevel,
    pub selected_session_id: Option<&'a str>,
    pub selected_service_id: Option<&'a str>,
    pub focused_worktree_path: Option<&'a str>,
    pub runtime_label: Option<&'a str>,
    pub version: Option<&'a str>,
    pub is_dev_runtime: bool,
    pub hide_offline_agents: bool,
    pub hidden_offline_agent_count: usize,
    pub scroll_offset: usize,
    pub footer_message: Option<&'a str>,
    pub details_sidebar_visible: bool,
    pub preview_source: &'a str,
    pub scribe_preview_entries: &'a [WorkOutlineEntry],
}

pub fn render_dashboard_frame(input: &DashboardRenderInput<'_>) -> ScreenFrameResult {
    let content_width = input.cols.max(72);
    let two_pane = input.cols >= 72 && input.details_sidebar_visible;
    let left_width = 32.max((content_width as f64 * 0.58).floor() as usize);
    let card_width = if two_pane { left_width } else { content_width };
    let center_in_block = |line: &str| truncate_ansi(&center(line, content_width), input.cols);
    let version_tag = input
        .version
        .map(|version| format!(" {}", style(&format!("v{version}"), Tone::Muted)))
        .unwrap_or_default();
    let hidden_tag = if input.hide_offline_agents && input.hidden_offline_agent_count > 0 {
        format!(
            " {}",
            style(
                &format!("· {} hidden", input.hidden_offline_agent_count),
                Tone::Attention
            )
        )
    } else {
        String::new()
    };
    let runtime_tag = input
        .runtime_label
        .map(|label| format!("  {}", style(&format!("● {label}"), Tone::Done)))
        .unwrap_or_default();
    let dev_badge = if input.is_dev_runtime {
        "\x1b[1;30;43m DEV \x1b[0m "
    } else {
        ""
    };
    let title = format!(
        "{dev_badge}{}{}{} — agent multiplexer{}",
        style("aimux", Tone::Strong),
        version_tag,
        hidden_tag,
        runtime_tag
    );
    let divider = if input.is_dev_runtime {
        format!("\x1b[33m{}\x1b[0m", "─".repeat(input.cols))
    } else {
        "─".repeat(input.cols)
    };
    let header = vec![
        String::new(),
        center_in_block(&title),
        divider,
        String::new(),
    ];
    let dashboard_sessions = input
        .snapshot
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .collect::<Vec<_>>();
    let mut content = Vec::new();
    if !input.snapshot.operation_failures.is_empty() {
        let mut failure_rows = input
            .snapshot
            .operation_failures
            .iter()
            .take(3)
            .map(|failure| {
                let recency = failure
                    .created_at
                    .as_deref()
                    .and_then(format_relative_recency)
                    .or_else(|| failure.created_at.clone())
                    .unwrap_or_default();
                let target = failure
                    .worktree_name
                    .as_deref()
                    .or(failure.target_id.as_deref())
                    .or(failure.worktree_path.as_deref());
                let target_hint = target
                    .map(|target| style(&format!(" · {}", truncate(target, 24)), Tone::Muted))
                    .unwrap_or_default();
                format!(
                    "{}{}{}",
                    truncate(failure.title.as_deref().unwrap_or(""), 48),
                    target_hint,
                    style(&format!(" · {recency}"), Tone::Muted)
                )
            })
            .collect::<Vec<_>>();
        if input.snapshot.operation_failures.len() > 3 {
            failure_rows.push(style(
                &format!(
                    "{} more failures",
                    input.snapshot.operation_failures.len() - 3
                ),
                Tone::Muted,
            ));
        }
        content.extend(card(&CardSpec {
            tone: Tone::Danger,
            title: &style("⚠ FAILED OPERATIONS", Tone::Danger),
            summary: None,
            rows: &failure_rows,
            width: card_width,
        }));
        content.push(String::new());
    }
    if dashboard_sessions.is_empty() && input.snapshot.worktree_groups.is_empty() {
        content.push(center_in_block("No sessions. Press [n] to create one."));
    } else if has_worktrees(input) {
        render_worktree_grouped(input, &mut content, card_width);
    } else {
        for (index, session) in dashboard_sessions.iter().enumerate() {
            let selected = input.nav_level == DashboardNavLevel::Sessions
                && input.selected_session_id == Some(session.id.as_str());
            let digit = (index < DASHBOARD_QUICK_JUMP_LIMIT).then_some(index + 1);
            content.push(format!("  {}", agent_row(input, session, selected, digit)));
        }
    }
    let footer_lines = if let Some(message) = input.footer_message {
        vec![format!(
            "{} {}",
            crate::tui_render::theme::footer_key("!", Some(KeyTone::Danger)),
            style(message, Tone::Muted)
        )]
    } else {
        render_footer_hints(
            &build_dashboard_footer_hints(input),
            input.cols.saturating_sub(2),
        )
    };
    let focus_line = find_focus_line(&content);
    let right_panel = if two_pane {
        let viewport_height = 1.max(
            input
                .rows
                .saturating_sub(header.len() + footer_lines.len() + 1),
        );
        let panel_width = 20.max(content_width.saturating_sub(left_width).saturating_sub(4));
        Some(render_selected_details_panel(
            input,
            panel_width,
            viewport_height,
        ))
    } else {
        None
    };

    compose_screen_frame(&ScreenFrameInput {
        cols: input.cols,
        rows: input.rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line,
        scroll_offset: input.scroll_offset,
        two_pane,
        right_panel: right_panel.as_deref(),
    })
}

fn build_dashboard_footer_hints(input: &DashboardRenderInput<'_>) -> Vec<FooterHint<'static>> {
    let selected_session = selected_session(input);
    let selected_service = selected_service(input);
    let enter_verb = dashboard_enter_verb(selected_session, selected_service);
    let kill_verb = if selected_service.is_some() {
        Some("stop")
    } else if selected_session.is_some_and(|session| session.status == SessionStatus::Offline) {
        Some("kill")
    } else if selected_session.is_some() {
        Some("stop")
    } else {
        None
    };
    let mut scribe_controls = vec![FooterHint {
        key: "P",
        label: "scribe",
        tone: None,
    }];
    if has_live_scribe(input) {
        scribe_controls.push(FooterHint {
            key: "V",
            label: if input.preview_source == "scribe" {
                "preview output"
            } else {
                "preview scribe"
            },
            tone: None,
        });
    }
    let talk = [
        FooterHint {
            key: "s",
            label: "msg",
            tone: None,
        },
        FooterHint {
            key: "H",
            label: "handoff",
            tone: None,
        },
        FooterHint {
            key: "T",
            label: "task",
            tone: None,
        },
        FooterHint {
            key: "o",
            label: "thread",
            tone: None,
        },
        FooterHint {
            key: "O",
            label: "overseer",
            tone: None,
        },
    ];
    let system = [
        FooterHint {
            key: "?",
            label: "help",
            tone: None,
        },
        FooterHint {
            key: "q",
            label: "quit",
            tone: None,
        },
    ];
    let mut visibility = vec![FooterHint {
        key: "a",
        label: if input.hide_offline_agents {
            "show offline"
        } else {
            "hide offline"
        },
        tone: None,
    }];
    if !input.snapshot.operation_failures.is_empty() {
        visibility.push(FooterHint {
            key: "X",
            label: "clear failures",
            tone: None,
        });
    }
    let has_worktrees = has_worktrees(input);
    if has_worktrees && input.nav_level == DashboardNavLevel::Sessions {
        let mut hints = vec![
            FooterHint {
                key: "↑↓/jk",
                label: "items",
                tone: None,
            },
            FooterHint {
                key: "1-9",
                label: "entry",
                tone: None,
            },
            FooterHint {
                key: "Enter/→/l",
                label: enter_verb,
                tone: None,
            },
            FooterHint {
                key: "Tab",
                label: "details",
                tone: None,
            },
            FooterHint {
                key: "u",
                label: "attention",
                tone: None,
            },
            FooterHint {
                key: "Esc/h",
                label: "back",
                tone: None,
            },
            FooterHint {
                key: "⇧↑↓",
                label: "reorder",
                tone: None,
            },
            FooterHint {
                key: "n",
                label: "agent",
                tone: None,
            },
            FooterHint {
                key: "v",
                label: "service",
                tone: None,
            },
            FooterHint {
                key: "f",
                label: "fork",
                tone: None,
            },
            FooterHint {
                key: "S",
                label: "switch",
                tone: None,
            },
            FooterHint {
                key: "D",
                label: "cache cleanup",
                tone: None,
            },
        ];
        hints.extend(visibility);
        hints.extend(talk);
        hints.extend(scribe_controls);
        hints.push(FooterHint {
            key: "R",
            label: "reply",
            tone: None,
        });
        if selected_session.is_some() && !selected_teammates(input).is_empty() {
            hints.push(FooterHint {
                key: "e",
                label: "team",
                tone: None,
            });
        }
        hints.push(FooterHint {
            key: "m",
            label: "migrate",
            tone: None,
        });
        if selected_session.is_some() {
            hints.push(FooterHint {
                key: "r",
                label: "name",
                tone: None,
            });
        }
        if let Some(label) = kill_verb {
            hints.push(FooterHint {
                key: "x",
                label,
                tone: Some(KeyTone::Danger),
            });
        }
        hints.extend(system);
        return hints;
    }
    if has_worktrees {
        let mut hints = vec![
            FooterHint {
                key: "↑↓/jk",
                label: "worktrees",
                tone: None,
            },
            FooterHint {
                key: "1-9",
                label: "worktree",
                tone: None,
            },
            FooterHint {
                key: "Enter/→/l",
                label: "step in",
                tone: None,
            },
            FooterHint {
                key: "Tab",
                label: "details",
                tone: None,
            },
        ];
        hints.extend(scribe_controls);
        hints.extend([
            FooterHint {
                key: "u",
                label: "attention",
                tone: None,
            },
            FooterHint {
                key: "n",
                label: "agent",
                tone: None,
            },
            FooterHint {
                key: "v",
                label: "service",
                tone: None,
            },
            FooterHint {
                key: "f",
                label: "fork",
                tone: None,
            },
            FooterHint {
                key: "D",
                label: "cache cleanup",
                tone: None,
            },
            FooterHint {
                key: "w",
                label: "worktree",
                tone: None,
            },
        ]);
        hints.extend(visibility);
        hints.extend(system);
        return hints;
    }
    let has_dashboard_sessions = input
        .snapshot
        .sessions
        .iter()
        .any(|session| !is_project_control_session(session));
    if has_dashboard_sessions {
        let mut hints = vec![
            FooterHint {
                key: "↑↓/jk",
                label: "select",
                tone: None,
            },
            FooterHint {
                key: "Enter/→/l",
                label: enter_verb,
                tone: None,
            },
            FooterHint {
                key: "Tab",
                label: "details",
                tone: None,
            },
            FooterHint {
                key: "u",
                label: "attention",
                tone: None,
            },
            FooterHint {
                key: "n",
                label: "agent",
                tone: None,
            },
            FooterHint {
                key: "v",
                label: "service",
                tone: None,
            },
            FooterHint {
                key: "f",
                label: "fork",
                tone: None,
            },
            FooterHint {
                key: "S",
                label: "switch",
                tone: None,
            },
            FooterHint {
                key: "D",
                label: "cache cleanup",
                tone: None,
            },
            FooterHint {
                key: "w",
                label: "worktree",
                tone: None,
            },
        ];
        hints.extend(visibility);
        hints.extend(talk);
        hints.extend(scribe_controls);
        hints.push(FooterHint {
            key: "R",
            label: "reply",
            tone: None,
        });
        if selected_session.is_some() && !selected_teammates(input).is_empty() {
            hints.push(FooterHint {
                key: "e",
                label: "team",
                tone: None,
            });
        }
        if let Some(label) = kill_verb {
            hints.push(FooterHint {
                key: "x",
                label,
                tone: Some(KeyTone::Danger),
            });
        }
        if selected_session.is_some() {
            hints.push(FooterHint {
                key: "r",
                label: "name",
                tone: None,
            });
        }
        hints.extend(system);
        return hints;
    }
    let mut hints = vec![
        FooterHint {
            key: "Tab",
            label: "details",
            tone: None,
        },
        FooterHint {
            key: "u",
            label: "attention",
            tone: None,
        },
        FooterHint {
            key: "n",
            label: "agent",
            tone: None,
        },
        FooterHint {
            key: "v",
            label: "service",
            tone: None,
        },
        FooterHint {
            key: "f",
            label: "fork",
            tone: None,
        },
        FooterHint {
            key: "D",
            label: "cache cleanup",
            tone: None,
        },
    ];
    hints.extend(visibility);
    hints.extend(talk);
    hints.extend(scribe_controls);
    hints.push(FooterHint {
        key: "R",
        label: "reply",
        tone: None,
    });
    hints.extend(system);
    hints
}

fn has_worktrees(input: &DashboardRenderInput<'_>) -> bool {
    !input.snapshot.worktree_groups.is_empty()
}

fn render_worktree_grouped(
    input: &DashboardRenderInput<'_>,
    lines: &mut Vec<String>,
    card_width: usize,
) {
    for worktree in build_dashboard_quick_jump_worktrees(input) {
        let focused = worktree.path == input.focused_worktree_path;
        let focus_mark = if focused && input.nav_level == DashboardNavLevel::Worktrees {
            format!("{} ", style("▸", Tone::Accent))
        } else {
            String::new()
        };
        let badge = worktree
            .digit
            .map(|digit| format!("[{digit}] "))
            .unwrap_or_default();
        let mut title = format!(
            "{focus_mark}{}",
            worktree_title(
                &format!("{badge}{}", worktree.name),
                worktree.path,
                Some(worktree.name)
            )
        );
        if !worktree.branch.is_empty() {
            title.push_str(&format!(
                " {}",
                style(&format!("· {}", worktree.branch), Tone::Muted)
            ));
        }
        let summary = worktree_summary_text(&worktree);
        let tone = worktree_tone(&worktree);
        let digit_by_id = worktree
            .entries
            .iter()
            .map(|entry| (entry.id, entry.digit))
            .collect::<BTreeMap<_, _>>();
        let mut rows = Vec::new();
        for session in &worktree.sessions {
            let selected = input.nav_level == DashboardNavLevel::Sessions
                && input.selected_session_id == Some(session.id.as_str());
            rows.push(agent_row(
                input,
                session,
                selected,
                digit_by_id.get(session.id.as_str()).copied().flatten(),
            ));
        }
        for service in &worktree.services {
            let selected = input.nav_level == DashboardNavLevel::Sessions
                && input.selected_service_id == Some(service.id.as_str());
            rows.push(service_row(
                service,
                selected,
                digit_by_id.get(service.id.as_str()).copied().flatten(),
            ));
        }
        lines.extend(card(&CardSpec {
            tone,
            title: &title,
            summary: (!summary.is_empty()).then_some(summary.as_str()),
            rows: &rows,
            width: card_width,
        }));
        lines.push(String::new());
    }
}

#[derive(Clone, Copy)]
struct QuickJumpEntry<'a> {
    digit: Option<usize>,
    id: &'a str,
}

struct QuickJumpWorktree<'a> {
    digit: Option<usize>,
    path: Option<&'a str>,
    name: &'a str,
    branch: &'a str,
    pending: bool,
    removing: bool,
    pending_action: Option<&'a str>,
    operation_failure: Option<&'a DashboardOperationFailure>,
    sessions: Vec<&'a DashboardSession>,
    services: Vec<&'a DashboardService>,
    entries: Vec<QuickJumpEntry<'a>>,
}

fn build_dashboard_quick_jump_worktrees<'a>(
    input: &'a DashboardRenderInput<'_>,
) -> Vec<QuickJumpWorktree<'a>> {
    let mut main_sessions = Vec::new();
    let mut main_services = Vec::new();
    let mut sessions_by_path: BTreeMap<&str, Vec<&'a DashboardSession>> = BTreeMap::new();
    let mut services_by_path: BTreeMap<&str, Vec<&'a DashboardService>> = BTreeMap::new();
    let mut session_path_order = Vec::new();
    let mut service_path_order = Vec::new();
    for session in &input.snapshot.sessions {
        if is_project_control_session(session) {
            continue;
        }
        if let Some(path) = session.worktree_path.as_deref() {
            if !sessions_by_path.contains_key(path) {
                session_path_order.push(path);
            }
            sessions_by_path.entry(path).or_default().push(session);
        } else {
            main_sessions.push(session);
        }
    }
    for service in &input.snapshot.services {
        if let Some(path) = service.worktree_path.as_deref() {
            if !services_by_path.contains_key(path) {
                service_path_order.push(path);
            }
            services_by_path.entry(path).or_default().push(service);
        } else {
            main_services.push(service);
        }
    }
    sort_sessions_by_created(&mut main_sessions);
    sort_services_by_created(&mut main_services);
    for sessions in sessions_by_path.values_mut() {
        sort_sessions_by_created(sessions);
    }
    for services in services_by_path.values_mut() {
        sort_services_by_created(services);
    }

    let mut worktrees = Vec::new();
    if let Some(main_group) = input
        .snapshot
        .worktree_groups
        .iter()
        .find(|group| group.path.is_none())
    {
        let sessions = entries_for_group_sessions(&main_group.sessions, &main_sessions);
        let services = entries_for_group_services(&main_group.services, &main_services);
        push_quick_jump_worktree(
            &mut worktrees,
            QuickJumpWorktreeInput {
                path: None,
                name: &main_group.name,
                branch: &main_group.branch,
                pending: main_group.pending,
                removing: main_group.removing,
                pending_action: main_group.pending_action.as_deref(),
                operation_failure: main_group.operation_failure.as_ref(),
                sessions,
                services,
            },
        );
    } else if !input.hide_offline_agents || !main_sessions.is_empty() || !main_services.is_empty() {
        push_quick_jump_worktree(
            &mut worktrees,
            QuickJumpWorktreeInput {
                path: None,
                name: &input.snapshot.main_checkout_info.name,
                branch: &input.snapshot.main_checkout_info.branch,
                pending: false,
                removing: false,
                pending_action: None,
                operation_failure: None,
                sessions: main_sessions,
                services: main_services,
            },
        );
    }

    let mut rendered_paths = BTreeMap::new();
    let mut ordered_groups = input
        .snapshot
        .worktree_groups
        .iter()
        .filter(|group| group.path.is_some())
        .collect::<Vec<_>>();
    ordered_groups.sort_by(|left, right| {
        dashboard_created_sort_key_group(right).cmp(&dashboard_created_sort_key_group(left))
    });
    for group in ordered_groups {
        let path = group.path.as_deref();
        let sessions = entries_for_group_sessions(
            &group.sessions,
            path.and_then(|path| sessions_by_path.get(path))
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        let services = entries_for_group_services(
            &group.services,
            path.and_then(|path| services_by_path.get(path))
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        if let Some(path) = path {
            rendered_paths.insert(path, true);
        }
        push_quick_jump_worktree(
            &mut worktrees,
            QuickJumpWorktreeInput {
                path,
                name: &group.name,
                branch: &group.branch,
                pending: group.pending,
                removing: group.removing,
                pending_action: group.pending_action.as_deref(),
                operation_failure: group.operation_failure.as_ref(),
                sessions,
                services,
            },
        );
    }

    let orphan_paths = session_path_order
        .into_iter()
        .chain(service_path_order)
        .collect::<Vec<_>>();
    for path in orphan_paths {
        if path.is_empty() || rendered_paths.contains_key(path) {
            continue;
        }
        rendered_paths.insert(path, true);
        let sessions = sessions_by_path.get(path).cloned().unwrap_or_default();
        let services = services_by_path.get(path).cloned().unwrap_or_default();
        let name = sessions
            .first()
            .and_then(|session| session.worktree_name.as_deref())
            .or_else(|| {
                services
                    .first()
                    .and_then(|service| service.worktree_name.as_deref())
            })
            .unwrap_or("unknown");
        let branch = sessions
            .first()
            .and_then(|session| session.worktree_branch.as_deref())
            .or_else(|| {
                services
                    .first()
                    .and_then(|service| service.worktree_branch.as_deref())
            })
            .unwrap_or("unknown");
        push_quick_jump_worktree(
            &mut worktrees,
            QuickJumpWorktreeInput {
                path: Some(path),
                name,
                branch,
                pending: false,
                removing: false,
                pending_action: None,
                operation_failure: None,
                sessions,
                services,
            },
        );
    }
    worktrees
}

struct QuickJumpWorktreeInput<'a> {
    path: Option<&'a str>,
    name: &'a str,
    branch: &'a str,
    pending: bool,
    removing: bool,
    pending_action: Option<&'a str>,
    operation_failure: Option<&'a DashboardOperationFailure>,
    sessions: Vec<&'a DashboardSession>,
    services: Vec<&'a DashboardService>,
}

fn push_quick_jump_worktree<'a>(
    worktrees: &mut Vec<QuickJumpWorktree<'a>>,
    input: QuickJumpWorktreeInput<'a>,
) {
    let mut entries = Vec::new();
    for session in &input.sessions {
        entries.push(QuickJumpEntry {
            digit: (entries.len() < DASHBOARD_QUICK_JUMP_LIMIT).then_some(entries.len() + 1),
            id: &session.id,
        });
    }
    for service in &input.services {
        entries.push(QuickJumpEntry {
            digit: (entries.len() < DASHBOARD_QUICK_JUMP_LIMIT).then_some(entries.len() + 1),
            id: &service.id,
        });
    }
    worktrees.push(QuickJumpWorktree {
        digit: (worktrees.len() < DASHBOARD_QUICK_JUMP_LIMIT).then_some(worktrees.len() + 1),
        path: input.path,
        name: input.name,
        branch: input.branch,
        pending: input.pending,
        removing: input.removing,
        pending_action: input.pending_action,
        operation_failure: input.operation_failure,
        sessions: input.sessions,
        services: input.services,
        entries,
    });
}

fn entries_for_group_sessions<'a>(
    ordered_group_entries: &'a [DashboardSession],
    fallback_entries: &[&'a DashboardSession],
) -> Vec<&'a DashboardSession> {
    if ordered_group_entries.is_empty() {
        fallback_entries
            .iter()
            .copied()
            .filter(|session| !is_project_control_session(session))
            .collect()
    } else {
        ordered_group_entries
            .iter()
            .filter(|session| !is_project_control_session(session))
            .collect()
    }
}

fn entries_for_group_services<'a>(
    ordered_group_entries: &'a [DashboardService],
    fallback_entries: &[&'a DashboardService],
) -> Vec<&'a DashboardService> {
    if ordered_group_entries.is_empty() {
        fallback_entries.to_vec()
    } else {
        ordered_group_entries.iter().collect()
    }
}

fn sort_sessions_by_created(sessions: &mut [&DashboardSession]) {
    sessions.sort_by(|left, right| {
        dashboard_created_sort_key_session(right).cmp(&dashboard_created_sort_key_session(left))
    });
}

fn sort_services_by_created(services: &mut [&DashboardService]) {
    services.sort_by(|left, right| {
        dashboard_created_sort_key_service(right).cmp(&dashboard_created_sort_key_service(left))
    });
}

fn dashboard_created_sort_key_session(session: &DashboardSession) -> i128 {
    created_sort_key(
        session.created_at.as_deref(),
        session.tmux_window_index,
        Some(session.index),
    )
}

fn dashboard_created_sort_key_service(service: &DashboardService) -> i128 {
    created_sort_key(
        service.created_at.as_deref(),
        service.tmux_window_index,
        None,
    )
}

fn dashboard_created_sort_key_group(group: &crate::dashboard_model::WorktreeGroup) -> i128 {
    let created_at = string_at_extra(&group.extra, "createdAt");
    let tmux_window_index = number_at_extra(&group.extra, "tmuxWindowIndex");
    created_sort_key(created_at, tmux_window_index, None)
}

fn created_sort_key(
    created_at: Option<&str>,
    tmux_window_index: Option<usize>,
    index: Option<usize>,
) -> i128 {
    created_at
        .and_then(parse_timestamp_ms)
        .map(|value| value as i128)
        .or_else(|| tmux_window_index.map(|value| value as i128))
        .or_else(|| index.map(|value| value as i128))
        .unwrap_or(0)
}

fn string_at_extra<'a>(extra: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    extra.get(key).and_then(Value::as_str)
}

fn number_at_extra(extra: &BTreeMap<String, Value>, key: &str) -> Option<usize> {
    extra
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn agent_row(
    _input: &DashboardRenderInput<'_>,
    session: &DashboardSession,
    selected: bool,
    digit: Option<usize>,
) -> String {
    let select = if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    };
    let index = digit
        .map(|digit| style(&format!("[{digit}]"), Tone::Muted))
        .unwrap_or_default();
    let dot = format!("{} ", session_status_dot(session));
    let identity = agent_identity(session);
    let status = session_status_cell(session, &derived_status_label(session));
    let grid = grid_cols(&[
        Column {
            content: &select,
            width: COL_SELECT,
        },
        Column {
            content: &dot,
            width: COL_DOT,
        },
        Column {
            content: &index,
            width: COL_INDEX,
        },
        Column {
            content: &identity,
            width: COL_IDENTITY,
        },
        Column {
            content: &status,
            width: COL_STATUS,
        },
        Column {
            content: &session_time_text(session),
            width: COL_TIME,
        },
    ]);
    let offline = is_session_offline(session);
    let hint_tone = |active: Tone| if offline { Tone::Muted } else { active };
    let trailing = [
        session_activity_chips(session),
        if is_recently_idle(session) {
            style("idle now", hint_tone(Tone::Ready))
        } else {
            String::new()
        },
        session
            .task_description
            .as_ref()
            .map(|task| {
                style(
                    &format!("⧫ {}", truncate(task, 40)),
                    hint_tone(Tone::Blocked),
                )
            })
            .unwrap_or_default(),
        session
            .workflow_next_action
            .as_ref()
            .map(|action| {
                style(
                    &format!("→ {}", truncate(action, 24)),
                    hint_tone(Tone::Attention),
                )
            })
            .unwrap_or_default(),
        session
            .headline
            .as_ref()
            .map(|headline| style(&format!("· {}", truncate(headline, 50)), Tone::Muted))
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if trailing.is_empty() {
        grid
    } else {
        format!("{grid} {trailing}")
    }
}

fn service_row(service: &DashboardService, selected: bool, digit: Option<usize>) -> String {
    let select = if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    };
    let index = digit
        .map(|digit| style(&format!("[{digit}]"), Tone::Muted))
        .unwrap_or_default();
    let dot = format!("{} ", service_status_dot(service));
    let label = service
        .label
        .as_deref()
        .or(service.command.as_deref())
        .unwrap_or("undefined");
    let status_label = service
        .pending_action
        .as_deref()
        .unwrap_or_else(|| service_status_str(&service.status));
    let status_tone = match service.status {
        ServiceStatus::Running => Tone::Done,
        ServiceStatus::Exited => Tone::Danger,
        _ => Tone::Muted,
    };
    let status = style(&format!("[svc] {status_label}"), status_tone);
    let time = service
        .last_used_at
        .as_deref()
        .and_then(format_relative_recency)
        .map(|value| style(&value, Tone::Muted))
        .unwrap_or_default();
    let grid = grid_cols(&[
        Column {
            content: &select,
            width: COL_SELECT,
        },
        Column {
            content: &dot,
            width: COL_DOT,
        },
        Column {
            content: &index,
            width: COL_INDEX,
        },
        Column {
            content: &style(label, Tone::Strong),
            width: COL_IDENTITY,
        },
        Column {
            content: &status,
            width: COL_STATUS,
        },
        Column {
            content: &time,
            width: COL_TIME,
        },
    ]);
    let command_hint = service
        .shell_command
        .as_ref()
        .map(|cmd| style(&format!("· {}", truncate(cmd, 36)), Tone::Muted))
        .or_else(|| {
            service
                .foreground_command
                .as_ref()
                .map(|cmd| style(&format!("· {}", truncate(cmd, 22)), Tone::Muted))
        })
        .unwrap_or_default();
    let trailing = [
        command_hint,
        service
            .pid
            .map(|pid| style(&format!("(pid {pid})"), Tone::Muted))
            .unwrap_or_default(),
        service
            .preview_line
            .as_ref()
            .map(|line| style(&format!("· {}", truncate(line, 40)), Tone::Muted))
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if trailing.is_empty() {
        grid
    } else {
        format!("{grid} {trailing}")
    }
}

fn agent_identity(session: &DashboardSession) -> String {
    let label = session.label.as_deref().unwrap_or(&session.command);
    let prefix = format!("{}-", session.command);
    let short_id = session.id.strip_prefix(&prefix).unwrap_or(&session.id);
    let suffix = if !short_id.is_empty() && short_id != label {
        let short_id_len = short_id.chars().count();
        let max_short_id_for_gap = COL_IDENTITY
            .saturating_sub(1)
            .saturating_sub(js_len(label))
            .saturating_sub(3);
        let display_id = if short_id_len <= 8 && short_id_len > max_short_id_for_gap {
            short_id
                .chars()
                .take(max_short_id_for_gap.max(1))
                .collect::<String>()
        } else {
            short_id.to_owned()
        };
        format!(" {}", style(&format!("({display_id})"), Tone::Muted))
    } else {
        String::new()
    };
    format!("{}{}", style(label, Tone::Strong), suffix)
}

fn row_state_label(value: &str) -> &str {
    match value {
        "working" => "Working",
        "ready" => "Ready",
        "needs_input" => "Needs input",
        "needs_response" => "Needs response",
        "next_step" => "Next step",
        "blocked" => "Blocked",
        "error" => "Error",
        "idle" => "Idle",
        "offline" => "Offline",
        "starting" => "Starting",
        "stopping" => "Stopping",
        "graveyarding" => "Removing",
        "done" => "Done",
        "interrupted" => "Interrupted",
        "creating" => "Creating",
        "forking" => "Forking",
        "migrating" => "Migrating",
        "switching" => "Switching",
        "renaming" => "Renaming",
        other => other,
    }
}

fn session_user_state_label<'a>(session: &'a DashboardSession, fallback: &'a str) -> String {
    if let Some(label) = effective_session_row_state(session) {
        return row_state_label(label).to_owned();
    }
    if fallback == "thinking" {
        return "Working".to_owned();
    }
    let mut chars = fallback.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn effective_session_row_state(session: &DashboardSession) -> Option<&str> {
    session.pending_action.as_deref().or_else(|| {
        session
            .semantic
            .as_ref()
            .map(|semantic| semantic.user.label.as_str())
    })
}

fn derived_status_label(session: &DashboardSession) -> String {
    session
        .semantic
        .as_ref()
        .map(|semantic| semantic.presentation.status_label.clone())
        .unwrap_or_else(|| session_status_str(&session.status).to_owned())
}

fn session_time_anchor(session: &DashboardSession) -> Option<(String, Option<&str>)> {
    let last_event_output_at = session
        .last_event
        .as_ref()
        .filter(|event| {
            event
                .kind
                .as_deref()
                .is_some_and(is_agent_output_event_kind)
        })
        .and_then(|event| event.ts.as_deref());
    let last_output_at = session.last_output_at.as_deref().or(last_event_output_at);
    if let Some(action) = session.pending_action.as_deref() {
        return Some((
            match action {
                "graveyarding" => "removing".to_owned(),
                other => row_state_label(other).to_lowercase(),
            },
            session
                .pending_started_at
                .as_deref()
                .or(session.created_at.as_deref())
                .or(session.last_used_at.as_deref())
                .or(session.became_idle_at.as_deref())
                .or(last_output_at),
        ));
    }
    match effective_session_row_state(session) {
        Some("needs_input" | "needs_response") => Some((
            "prompted".to_owned(),
            latest_unread_at(session)
                .or(last_output_at)
                .or(session.became_idle_at.as_deref())
                .or(session.last_used_at.as_deref()),
        )),
        Some("next_step" | "idle" | "interrupted") => last_output_at
            .map(|value| ("output".to_owned(), Some(value)))
            .or_else(|| {
                Some((
                    "idle".to_owned(),
                    session
                        .became_idle_at
                        .as_deref()
                        .or(session.last_used_at.as_deref()),
                ))
            }),
        Some("working" | "ready") => last_output_at.map(|value| ("output".to_owned(), Some(value))),
        Some("done") => last_output_at
            .map(|value| ("output".to_owned(), Some(value)))
            .or_else(|| {
                Some((
                    "done".to_owned(),
                    session
                        .became_idle_at
                        .as_deref()
                        .or(session.last_used_at.as_deref()),
                ))
            }),
        Some("offline") => last_output_at
            .map(|value| ("output".to_owned(), Some(value)))
            .or_else(|| Some(("offline".to_owned(), session.last_used_at.as_deref()))),
        Some("blocked") => Some((
            "blocked".to_owned(),
            latest_unread_at(session)
                .or(session.became_idle_at.as_deref())
                .or(last_output_at)
                .or(session.last_used_at.as_deref()),
        )),
        Some("error") => Some((
            "failed".to_owned(),
            latest_unread_at(session)
                .or(session.became_idle_at.as_deref())
                .or(last_output_at)
                .or(session.last_used_at.as_deref()),
        )),
        _ => last_output_at.map(|value| ("output".to_owned(), Some(value))),
    }
}

fn session_time_text(session: &DashboardSession) -> String {
    let Some((label, Some(value))) = session_time_anchor(session) else {
        return String::new();
    };
    format_relative_recency(value)
        .map(|recency| style(&format!("{label} {recency}"), Tone::Muted))
        .unwrap_or_default()
}

fn latest_unread_at(session: &DashboardSession) -> Option<&str> {
    session
        .semantic
        .as_ref()?
        .notifications
        .latest_unread
        .as_ref()?
        .created_at
        .as_deref()
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    kind != "prompt" && kind != "task_assigned"
}

fn is_recently_idle(session: &DashboardSession) -> bool {
    if session.pending_action.is_some() {
        return false;
    }
    let label = effective_session_row_state(session);
    if matches!(label, Some("working" | "offline" | "error")) {
        return false;
    }
    let Some(became_idle_at) = session
        .became_idle_at
        .as_deref()
        .and_then(parse_timestamp_ms)
    else {
        return false;
    };
    let now = now_ms();
    now >= became_idle_at && now - became_idle_at <= RECENT_IDLE_MS
}

fn is_session_offline(session: &DashboardSession) -> bool {
    if session.pending_action.is_some() {
        return false;
    }
    matches!(effective_session_row_state(session), Some("offline"))
        || matches!(
            session.status,
            SessionStatus::Offline | SessionStatus::Exited
        )
}

fn session_activity_chips(session: &DashboardSession) -> String {
    let notification_unread = session
        .semantic
        .as_ref()
        .map(|semantic| semantic.notifications.unread_count)
        .unwrap_or(session.notification_unread_count);
    let activity_new = session
        .semantic
        .as_ref()
        .map(|semantic| semantic.activity_new_count)
        .unwrap_or(session.unseen_count);
    let thread_unread = session.thread_unread_count;
    let waiting_on_me = session.thread_waiting_on_me_count;
    let waiting_on_them = session.thread_waiting_on_them_count;
    let thread_pending = session.thread_pending_count;
    let offline = is_session_offline(session);
    let tone = |active| if offline { ChipTone::Muted } else { active };
    let needs_input_unread = session.notification_needs_input_unread_count;
    let state_conveys_needs_input = matches!(
        session
            .semantic
            .as_ref()
            .map(|semantic| semantic.user.label.as_str()),
        Some("needs_input" | "needs_response")
    );
    let shown_unread = notification_unread.saturating_sub(if state_conveys_needs_input {
        needs_input_unread.min(notification_unread)
    } else {
        0
    });
    let mut chips = Vec::new();
    if shown_unread > 0 {
        chips.push(chip(
            &format!("{} unread", shown_unread.min(99)),
            if session.notification_stale {
                ChipTone::Muted
            } else {
                tone(ChipTone::Work)
            },
        ));
    }
    if activity_new > 0 {
        chips.push(chip(
            &format!("{} unseen", activity_new.min(99)),
            tone(ChipTone::Info),
        ));
    }
    if thread_unread > 0 || waiting_on_me > 0 || waiting_on_them > 0 {
        chips.push(chip(
            &format!("thread {thread_unread}/{waiting_on_me}/{waiting_on_them}"),
            ChipTone::Muted,
        ));
    }
    if thread_pending > 0 {
        chips.push(chip(
            &format!("{thread_pending} pending"),
            tone(ChipTone::Danger),
        ));
    }
    if session.workflow_on_me_count > 0 {
        chips.push(chip("coordination on you", tone(ChipTone::Attention)));
    }
    if session.workflow_blocked_count > 0 {
        chips.push(chip("coordination blocked", tone(ChipTone::Danger)));
    }
    if session.workflow_family_count > 0 {
        chips.push(chip(
            &format!("coordination {}", session.workflow_family_count),
            ChipTone::Muted,
        ));
    }
    chips.join(" ")
}

fn session_status_dot(session: &DashboardSession) -> String {
    if session.pending_action.is_some() {
        return style("●", Tone::Attention);
    }
    let label = effective_session_row_state(session);
    let attention = session
        .semantic
        .as_ref()
        .map(|semantic| semantic.user.attention.as_str());
    if attention == Some("error") || label == Some("error") {
        return status_dot(StatusKind::Error);
    }
    if attention == Some("blocked") || label == Some("blocked") {
        return status_dot(StatusKind::Blocked);
    }
    if matches!(attention, Some("needs_input" | "needs_response"))
        || matches!(label, Some("needs_input" | "needs_response"))
    {
        return status_dot(StatusKind::Needs);
    }
    match label {
        Some("working") => status_dot(StatusKind::Working),
        Some("ready") => status_dot(StatusKind::Ready),
        Some("done") => status_dot(StatusKind::Done),
        Some("next_step") => style("●", Tone::Attention),
        Some("idle") => status_dot(StatusKind::Idle),
        Some("offline") => status_dot(StatusKind::Offline),
        _ => match session.status {
            SessionStatus::Offline => status_dot(StatusKind::Offline),
            SessionStatus::Waiting => status_dot(StatusKind::Needs),
            SessionStatus::Exited => style("○", Tone::Danger),
            SessionStatus::Idle => status_dot(StatusKind::Done),
            _ => style("●", Tone::Attention),
        },
    }
}

fn session_status_cell(session: &DashboardSession, fallback: &str) -> String {
    let label = session_user_state_label(session, fallback);
    let row_state = effective_session_row_state(session);
    if let Some(
        row_state @ ("needs_input" | "needs_response" | "error" | "blocked" | "working"
        | "next_step"),
    ) = row_state
    {
        let pill_label = if row_state == "needs_response" {
            "NEEDS REPLY".to_owned()
        } else {
            label.to_uppercase()
        };
        return pill(&pill_label, pill_tone(row_state));
    }
    let tone = if session.pending_action.is_some() {
        Tone::Attention
    } else {
        match row_state {
            Some("ready") => Tone::Ready,
            Some("done") => Tone::Done,
            Some("idle") => Tone::Idle,
            _ => Tone::Muted,
        }
    };
    style(&label, tone)
}

fn pill_tone(row_state: &str) -> Tone {
    match row_state {
        "error" => Tone::Danger,
        "blocked" => Tone::Blocked,
        "working" => Tone::Work,
        "next_step" | "needs_input" | "needs_response" => Tone::Attention,
        _ => Tone::Attention,
    }
}

fn service_status_dot(service: &DashboardService) -> String {
    match service.status {
        ServiceStatus::Running => status_dot(StatusKind::Service),
        ServiceStatus::Exited => style("◇", Tone::Danger),
        _ => status_dot(StatusKind::ServiceOff),
    }
}

fn semantic_count_parts(worktree: &QuickJumpWorktree<'_>) -> Vec<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for session in &worktree.sessions {
        if let Some(label) = effective_session_row_state(session) {
            *counts.entry(label).or_default() += 1;
        }
    }
    let mut parts = Vec::new();
    append_count(
        &mut parts,
        &counts,
        "needs_input",
        "needs input",
        Tone::Attention,
    );
    append_count(
        &mut parts,
        &counts,
        "needs_response",
        "needs response",
        Tone::Attention,
    );
    append_count(
        &mut parts,
        &counts,
        "next_step",
        "next step",
        Tone::Attention,
    );
    append_count(&mut parts, &counts, "blocked", "blocked", Tone::Blocked);
    append_count(&mut parts, &counts, "error", "error", Tone::Danger);
    append_count(&mut parts, &counts, "working", "working", Tone::Work);
    append_count(&mut parts, &counts, "ready", "ready", Tone::Ready);
    append_count(&mut parts, &counts, "idle", "idle", Tone::Muted);
    append_count(&mut parts, &counts, "done", "done", Tone::Done);
    append_count(&mut parts, &counts, "offline", "offline", Tone::Muted);
    append_count(&mut parts, &counts, "creating", "creating", Tone::Attention);
    append_count(&mut parts, &counts, "forking", "forking", Tone::Attention);
    append_count(
        &mut parts,
        &counts,
        "migrating",
        "migrating",
        Tone::Attention,
    );
    append_count(&mut parts, &counts, "starting", "starting", Tone::Attention);
    append_count(&mut parts, &counts, "stopping", "stopping", Tone::Attention);
    append_count(
        &mut parts,
        &counts,
        "graveyarding",
        "removing",
        Tone::Attention,
    );
    append_count(&mut parts, &counts, "renaming", "renaming", Tone::Attention);
    parts
}

fn append_count(
    parts: &mut Vec<String>,
    counts: &BTreeMap<&str, usize>,
    label: &str,
    text: &str,
    tone: Tone,
) {
    if let Some(count) = counts.get(label).filter(|count| **count > 0) {
        parts.push(style(&format!("{count} {text}"), tone));
    }
}

fn worktree_summary_text(worktree: &QuickJumpWorktree<'_>) -> String {
    if worktree.operation_failure.is_some() {
        return style("failed", Tone::Danger);
    }
    match worktree.pending_action {
        Some("creating") => return style("(creating...)", Tone::Attention),
        Some("graveyarding") => return style("(graveyarding...)", Tone::Attention),
        _ => {}
    }
    if worktree.removing || worktree.pending {
        return style("(removing...)", Tone::Attention);
    }
    let parts = semantic_count_parts(worktree);
    if !parts.is_empty() {
        return parts.join(&style(" · ", Tone::Muted));
    }
    if worktree.sessions.len() + worktree.services.len() == 0 {
        style("no agents", Tone::Muted)
    } else {
        String::new()
    }
}

fn worktree_tone(worktree: &QuickJumpWorktree<'_>) -> Tone {
    if worktree.operation_failure.is_some() {
        return Tone::Danger;
    }
    let mut best = (0, Tone::Muted);
    for session in &worktree.sessions {
        let ranked = session_state_rank(effective_session_row_state(session));
        if ranked.0 > best.0 {
            best = ranked;
        }
    }
    best.1
}

fn session_state_rank(state: Option<&str>) -> (usize, Tone) {
    match state {
        Some("error") => (6, Tone::Danger),
        Some("needs_input" | "needs_response") => (5, Tone::Attention),
        Some("blocked") => (4, Tone::Blocked),
        Some("working") => (3, Tone::Work),
        Some("next_step") => (3, Tone::Attention),
        Some("done") => (2, Tone::Done),
        Some("ready") => (1, Tone::Ready),
        Some("idle") => (1, Tone::Idle),
        Some("offline") | None => (0, Tone::Muted),
        _ => (3, Tone::Attention),
    }
}

fn worktree_title(text: &str, path: Option<&str>, name: Option<&str>) -> String {
    let tone = worktree_color_ansi(&json!({ "path": path, "name": name }));
    format!("\x1b[1;{tone}m{text}\x1b[0m")
}

fn render_selected_details_panel(
    input: &DashboardRenderInput<'_>,
    panel_width: usize,
    height: usize,
) -> Vec<String> {
    let width = 8.max(panel_width.saturating_sub(4));
    let selected_session = selected_session(input);
    let selected_service = selected_service(input);
    if selected_session.is_none() && selected_service.is_none() {
        return render_worktree_details_panel(input, panel_width, height, width);
    }
    if let Some(service) = selected_service {
        let mut lines = Vec::new();
        push_kv(
            &mut lines,
            "Service",
            &format!(
                "{} ({})",
                service
                    .label
                    .as_deref()
                    .or(service.command.as_deref())
                    .unwrap_or("undefined"),
                service.id
            ),
            width,
        );
        push_kv(
            &mut lines,
            "Command",
            service.command.as_deref().unwrap_or(""),
            width,
        );
        if let Some(shell_command) = service.shell_command.as_deref() {
            push_kv(
                &mut lines,
                if service.shell_command_state.as_deref() == Some("running") {
                    "Running"
                } else {
                    "Last command"
                },
                shell_command,
                width,
            );
        }
        if let Some(command) = service.foreground_command.as_deref() {
            push_kv(&mut lines, "Foreground", command, width);
        }
        if let Some(pid) = service.pid {
            push_kv(&mut lines, "PID", &pid.to_string(), width);
        }
        if service.worktree_name.is_some() || service.worktree_branch.is_some() {
            push_kv(
                &mut lines,
                "Worktree",
                &worktree_name_branch(
                    service.worktree_name.as_deref(),
                    service.worktree_branch.as_deref(),
                ),
                width,
            );
        }
        if let Some(cwd) = service.cwd.as_deref() {
            push_kv(&mut lines, "CWD", cwd, width);
        }
        if let Some(action) = service.pending_action.as_deref() {
            push_kv(&mut lines, "State", row_state_label(action), width);
        } else {
            push_kv(
                &mut lines,
                "Status",
                service_status_str(&service.status),
                width,
            );
        }
        if let Some(line) = service.preview_line.as_deref() {
            push_kv(&mut lines, "Preview", line, width);
        }
        return render_panel_card("DETAILS", Tone::Info, &lines, panel_width, height);
    }
    let selected = selected_session.expect("selected session checked");
    let mut lines = Vec::new();
    push_kv(
        &mut lines,
        "Agent",
        selected.label.as_deref().unwrap_or(&selected.command),
        width,
    );
    push_kv(
        &mut lines,
        "Canonical",
        selected
            .tool_config_key
            .as_deref()
            .unwrap_or(&selected.command),
        width,
    );
    push_kv(&mut lines, "Aimux ID", &selected.id, width);
    if let Some(backend_id) = selected.backend_session_id.as_deref() {
        push_kv(&mut lines, "Backend ID", backend_id, width);
    }
    if selected.command
        != selected
            .tool_config_key
            .as_deref()
            .unwrap_or(&selected.command)
    {
        push_kv(&mut lines, "Command", &selected.command, width);
    }
    if selected.worktree_name.is_some() || selected.worktree_branch.is_some() {
        push_kv(
            &mut lines,
            "Worktree",
            &worktree_name_branch(
                selected.worktree_name.as_deref(),
                selected.worktree_branch.as_deref(),
            ),
            width,
        );
    }
    if let Some(cwd) = selected.cwd.as_deref() {
        push_kv(&mut lines, "CWD", cwd, width);
    }
    if let Some(command) = selected.foreground_command.as_deref() {
        push_kv(&mut lines, "Foreground", command, width);
    }
    if let Some(pid) = selected.pid {
        push_kv(&mut lines, "PID", &pid.to_string(), width);
    }
    if selected.pr_number.is_some() || selected.pr_title.is_some() || selected.pr_url.is_some() {
        let mut pr = format!(
            "PR{}",
            selected
                .pr_number
                .map(|number| format!(" #{number}"))
                .unwrap_or_default()
        );
        if let Some(title) = selected.pr_title.as_deref() {
            pr.push_str(": ");
            pr.push_str(title);
        }
        push_kv(&mut lines, "PR", &pr, width);
        if let Some(url) = selected.pr_url.as_deref() {
            push_kv(&mut lines, "URL", url, width);
        }
    }
    if selected.repo_owner.is_some() || selected.repo_name.is_some() {
        push_kv(
            &mut lines,
            "Repo",
            &format!(
                "{}/{}",
                selected.repo_owner.as_deref().unwrap_or("?"),
                selected.repo_name.as_deref().unwrap_or("?")
            ),
            width,
        );
    }
    if let Some(remote) = selected.repo_remote.as_deref() {
        push_kv(&mut lines, "Remote", remote, width);
    }
    if selected.overseer == Some(true) {
        push_kv(&mut lines, "Overseer", "yes", width);
    }
    if let Some(loop_state) = selected
        .loop_state
        .as_ref()
        .filter(|loop_state| loop_state.active)
    {
        push_kv(&mut lines, "Loop", "active", width);
        if let Some(goal) = loop_state.goal.as_deref() {
            push_kv(&mut lines, "Goal", goal, width);
        }
        if let Some(since) = loop_state.since.as_deref() {
            push_kv(
                &mut lines,
                "Since",
                &format_relative_recency(since).unwrap_or_else(|| since.to_owned()),
                width,
            );
        }
        if let Some(source) = loop_state.source.as_deref() {
            push_kv(&mut lines, "Loop source", source, width);
        }
        let loop_actor = [
            loop_state
                .updated_by_session_id
                .as_deref()
                .or(loop_state.updated_by.as_deref()),
            loop_state.updated_by_role.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" / ");
        if !loop_actor.is_empty() {
            push_kv(&mut lines, "Loop actor", &loop_actor, width);
        }
    } else if let Some(action) = selected.loop_last_action.as_ref() {
        let text = format!(
            "{} {}",
            action.action,
            format_relative_recency(&action.at).unwrap_or_else(|| action.at.clone())
        );
        push_kv(&mut lines, "Loop last", &text, width);
        if let Some(source) = action.source.as_deref() {
            push_kv(&mut lines, "Loop source", source, width);
        }
    }
    if let Some(line) = selected.preview_line.as_deref() {
        push_kv(&mut lines, "Preview", line, width);
    }
    if let Some(action) = selected.pending_action.as_deref() {
        push_kv(&mut lines, "State", row_state_label(action), width);
        if let Some(started) = selected
            .pending_started_at
            .as_deref()
            .and_then(format_relative_recency)
        {
            push_kv(&mut lines, "Started", &started, width);
        }
    } else if let Some(semantic) = selected.semantic.as_ref() {
        push_kv(
            &mut lines,
            "State",
            &semantic.presentation.status_label,
            width,
        );
        if semantic.user.attention != "none" {
            push_kv(&mut lines, "Attention", &semantic.user.attention, width);
        }
        if semantic.notifications.unread_count > 0 {
            push_kv(
                &mut lines,
                "Unread",
                &semantic.notifications.unread_count.to_string(),
                width,
            );
        }
        if let Some(latest) = semantic.notifications.latest_text.as_deref() {
            push_kv(&mut lines, "Latest", latest, width);
        }
        if semantic.activity_new_count > 0 {
            push_kv(
                &mut lines,
                "New activity",
                &semantic.activity_new_count.to_string(),
                width,
            );
        }
    }
    if let Some(message) = selected
        .last_event
        .as_ref()
        .and_then(|event| event.message.as_deref())
    {
        push_kv(&mut lines, "Last", message, width);
    }
    if selected.thread_name.is_some() || selected.thread_id.is_some() {
        push_kv(
            &mut lines,
            "Thread",
            selected
                .thread_name
                .as_deref()
                .or(selected.thread_id.as_deref())
                .unwrap_or(""),
            width,
        );
    }
    if selected.thread_unread_count > 0
        || selected.thread_waiting_on_me_count > 0
        || selected.thread_waiting_on_them_count > 0
        || selected.thread_pending_count > 0
    {
        push_kv(
            &mut lines,
            "Threads",
            &format!(
                "{} unread · {} on me · {} on them · {} pending",
                selected.thread_unread_count,
                selected.thread_waiting_on_me_count,
                selected.thread_waiting_on_them_count,
                selected.thread_pending_count
            ),
            width,
        );
    }
    if selected.workflow_on_me_count > 0
        || selected.workflow_blocked_count > 0
        || selected.workflow_family_count > 0
        || selected.workflow_top_label.is_some()
    {
        let mut summary = vec![
            format!("{} on me", selected.workflow_on_me_count),
            format!("{} blocked", selected.workflow_blocked_count),
            format!("{} families", selected.workflow_family_count),
        ];
        if let Some(label) = selected.workflow_top_label.as_deref() {
            summary.push(format!("top: {label}"));
        }
        if let Some(action) = selected.workflow_next_action.as_deref() {
            summary.push(format!("next: {action}"));
        }
        push_kv(&mut lines, "Coordination", &summary.join(" · "), width);
    }
    if let Some(services) = selected
        .services
        .as_ref()
        .filter(|services| !services.is_empty())
    {
        push_kv(
            &mut lines,
            "Services",
            &services
                .iter()
                .filter_map(|service| {
                    service
                        .url
                        .clone()
                        .or_else(|| service.port.map(|port| format!(":{port}")))
                })
                .collect::<Vec<_>>()
                .join(", "),
            width,
        );
    }
    let teammates = selected_teammates(input);
    if !teammates.is_empty() {
        lines.push(String::new());
        lines.push(style("Team", Tone::Strong));
        for teammate in teammates.iter().take(5) {
            push_kv(&mut lines, "-", &summarize_teammate(teammate), width);
        }
        if teammates.len() > 5 {
            push_kv(
                &mut lines,
                "-",
                &format!("{} more", teammates.len() - 5),
                width,
            );
        }
    }
    let showing_scribe_preview = input.preview_source == "scribe" && has_live_scribe(input);
    let preview_rows = if showing_scribe_preview {
        scribe_preview_rows(
            input.scribe_preview_entries,
            width,
            height.saturating_sub(2),
        )
    } else {
        preview_snapshot_rows(selected, width, height.saturating_sub(2))
    };
    render_panel_with_preview(
        &lines,
        &preview_rows,
        if showing_scribe_preview {
            "SCRIBE"
        } else {
            "PREVIEW"
        },
        panel_width,
        height,
    )
}

fn render_worktree_details_panel(
    input: &DashboardRenderInput<'_>,
    panel_width: usize,
    height: usize,
    width: usize,
) -> Vec<String> {
    let focused_path = input.focused_worktree_path;
    let focused_quick_jump_worktree = build_dashboard_quick_jump_worktrees(input)
        .into_iter()
        .find(|worktree| worktree.path == focused_path);
    let focused_sessions = focused_quick_jump_worktree
        .as_ref()
        .map(|worktree| {
            worktree
                .sessions
                .iter()
                .copied()
                .filter(|session| !is_project_control_session(session))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            input
                .snapshot
                .sessions
                .iter()
                .filter(|session| session.worktree_path.as_deref() == focused_path)
                .filter(|session| !is_project_control_session(session))
                .collect::<Vec<_>>()
        });
    let focused_services = focused_quick_jump_worktree
        .as_ref()
        .map(|worktree| worktree.services.clone())
        .unwrap_or_else(|| {
            input
                .snapshot
                .services
                .iter()
                .filter(|service| service.worktree_path.as_deref() == focused_path)
                .collect::<Vec<_>>()
        });
    let focused_group = focused_path.and_then(|path| {
        input
            .snapshot
            .worktree_groups
            .iter()
            .find(|group| group.path.as_deref() == Some(path))
    });
    let (name, branch, path) = if focused_path.is_none() {
        (
            input.snapshot.main_checkout_info.name.as_str(),
            input.snapshot.main_checkout_info.branch.as_str(),
            "(main checkout)",
        )
    } else if let Some(group) = focused_group {
        (
            group.name.as_str(),
            group.branch.as_str(),
            group.path.as_deref().unwrap_or(""),
        )
    } else {
        (
            focused_sessions
                .first()
                .and_then(|session| session.worktree_name.as_deref())
                .or_else(|| {
                    focused_services
                        .first()
                        .and_then(|service| service.worktree_name.as_deref())
                })
                .unwrap_or("Worktree"),
            focused_sessions
                .first()
                .and_then(|session| session.worktree_branch.as_deref())
                .or_else(|| {
                    focused_services
                        .first()
                        .and_then(|service| service.worktree_branch.as_deref())
                })
                .unwrap_or(""),
            focused_path.unwrap_or(""),
        )
    };
    let mut lines = Vec::new();
    push_kv(&mut lines, "Name", name, width);
    if !branch.is_empty() {
        push_kv(&mut lines, "Branch", branch, width);
    }
    push_kv(&mut lines, "Path", path, width);
    if let Some(failure) = focused_group.and_then(|group| group.operation_failure.as_ref()) {
        push_kv(&mut lines, "Status", "failed", width);
        if let Some(operation) = failure.operation.as_deref() {
            push_kv(&mut lines, "Operation", operation, width);
        }
        if let Some(message) = failure.message.as_deref() {
            push_kv(&mut lines, "Error", message, width);
        }
        if let Some(created_at) = failure.created_at.as_deref() {
            push_kv(
                &mut lines,
                "Failed",
                &format_relative_recency(created_at).unwrap_or_else(|| created_at.to_owned()),
                width,
            );
        }
    }
    if focused_group.and_then(|group| group.pending_action.as_deref()) == Some("creating") {
        push_kv(&mut lines, "Status", "creating", width);
    }
    push_kv(
        &mut lines,
        "Agents",
        &focused_sessions.len().to_string(),
        width,
    );
    push_kv(
        &mut lines,
        "Services",
        &focused_services.len().to_string(),
        width,
    );
    let active_sessions = focused_sessions
        .iter()
        .filter(|session| !is_session_offline(session))
        .collect::<Vec<_>>();
    let running_services = focused_services
        .iter()
        .filter(|service| service.status == ServiceStatus::Running)
        .collect::<Vec<_>>();
    let active_worktree_removal = focused_path.and_then(|path| {
        input
            .snapshot
            .worktree_removals
            .iter()
            .find(|job| job.path == path)
            .or_else(|| {
                input
                    .snapshot
                    .worktree_removal
                    .as_ref()
                    .filter(|job| job.path == path)
            })
    });
    if let Some(removal) = active_worktree_removal {
        let elapsed_seconds = now_ms().saturating_sub(removal.started_at as u128) / 1000;
        push_kv(&mut lines, "Status", "removing", width);
        push_kv(&mut lines, "Elapsed", &format!("{elapsed_seconds}s"), width);
        let detail_lines = removal
            .stderr
            .as_deref()
            .unwrap_or("")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if !detail_lines.is_empty() {
            let start = detail_lines.len().saturating_sub(3);
            push_kv(
                &mut lines,
                "Progress",
                &detail_lines[start..].join(" | "),
                width,
            );
        }
    }
    if !active_sessions.is_empty() {
        push_kv(
            &mut lines,
            "Active",
            &active_sessions
                .iter()
                .filter_map(|session| session.label.as_deref().or(Some(session.command.as_str())))
                .take(3)
                .collect::<Vec<_>>()
                .join(", "),
            width,
        );
    }
    if !running_services.is_empty() {
        push_kv(
            &mut lines,
            "Running",
            &running_services
                .iter()
                .map(|service| {
                    service
                        .label
                        .as_deref()
                        .or(service.command.as_deref())
                        .unwrap_or("undefined")
                })
                .take(3)
                .collect::<Vec<_>>()
                .join(", "),
            width,
        );
    }
    render_panel_card("WORKTREE", Tone::Accent, &lines, panel_width, height)
}

fn render_panel_card(
    title: &str,
    tone: Tone,
    rows: &[String],
    panel_width: usize,
    height: usize,
) -> Vec<String> {
    let body_rows = rows
        .iter()
        .take(height.saturating_sub(2))
        .cloned()
        .collect::<Vec<_>>();
    let mut out = card(&CardSpec {
        tone,
        title: &style(title, tone),
        summary: None,
        rows: &body_rows,
        width: panel_width,
    });
    while out.len() < height {
        out.push(String::new());
    }
    out.truncate(height);
    out
}

fn render_panel_with_preview(
    detail_rows: &[String],
    preview_rows: &[String],
    preview_title: &str,
    panel_width: usize,
    height: usize,
) -> Vec<String> {
    if preview_rows.is_empty() || height < 10 {
        return render_panel_card("DETAILS", Tone::Info, detail_rows, panel_width, height);
    }
    let preview_height = (preview_rows.len() + 2)
        .max(5)
        .min(5.max((height as f64 * 0.45).floor() as usize));
    let details_height = (detail_rows.len() + 2)
        .max(3)
        .min(3.max(height.saturating_sub(preview_height)));
    let mut out = render_panel_card(
        "DETAILS",
        Tone::Info,
        detail_rows,
        panel_width,
        details_height,
    );
    out.extend(render_panel_card(
        preview_title,
        Tone::Muted,
        preview_rows,
        panel_width,
        height.saturating_sub(details_height),
    ));
    out.truncate(height);
    out
}

fn push_kv(lines: &mut Vec<String>, key: &str, value: &str, width: usize) {
    lines.extend(wrap_key_value(key, value, width));
}

fn preview_snapshot_rows(session: &DashboardSession, width: usize, max_rows: usize) -> Vec<String> {
    if max_rows == 0 {
        return Vec::new();
    }
    let Some(output) = session
        .preview_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.output.as_deref())
    else {
        return Vec::new();
    };
    let mut rows = sanitize_expose_preview_output(output)
        .into_iter()
        .map(|line| line.trim_end().to_owned())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if rows.len() > max_rows {
        rows = rows.split_off(rows.len() - max_rows);
    }
    rows.into_iter()
        .map(|line| truncate_ansi(&line, width))
        .collect()
}

fn scribe_preview_rows(entries: &[WorkOutlineEntry], width: usize, max_rows: usize) -> Vec<String> {
    if max_rows == 0 {
        return Vec::new();
    }
    if entries.is_empty() {
        return vec![style("No scribe summary for this agent yet.", Tone::Muted)];
    }
    let mut rows = Vec::new();
    for entry in entries {
        let status_text = work_outline_status_text(entry.status);
        let status_tone = if status_text == "done" {
            Tone::Done
        } else if status_text == "stale" {
            Tone::Muted
        } else {
            Tone::Accent
        };
        let age = format_relative_recency(&entry.updated_at);
        let title_width = width.saturating_sub(18).max(8);
        let mut title = format!(
            "{} {}",
            style(&truncate(&entry.title, title_width), Tone::Strong),
            style(status_text, status_tone)
        );
        if let Some(age) = age {
            title.push_str(&style(&format!(" · {age}"), Tone::Muted));
        }
        rows.push(truncate_ansi(&title, width));
        if rows.len() >= max_rows {
            break;
        }
        for line in wrap_text(&entry.summary, width)
            .into_iter()
            .take(max_rows.saturating_sub(rows.len()).max(1))
        {
            rows.push(truncate_ansi(&style(&line, Tone::Muted), width));
            if rows.len() >= max_rows {
                break;
            }
        }
        if rows.len() >= max_rows {
            break;
        }
        rows.push(String::new());
        if rows.len() >= max_rows {
            break;
        }
    }
    while rows.last().is_some_and(|line| line.is_empty()) {
        rows.pop();
    }
    rows.truncate(max_rows);
    rows
}

fn work_outline_status_text(status: WorkOutlineStatus) -> &'static str {
    match status {
        WorkOutlineStatus::Active => "active",
        WorkOutlineStatus::Done => "done",
        WorkOutlineStatus::Superseded => "superseded",
        WorkOutlineStatus::Stale => "stale",
    }
}

fn selected_session<'a>(input: &'a DashboardRenderInput<'_>) -> Option<&'a DashboardSession> {
    let session_id = input.selected_session_id?;
    input
        .snapshot
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .find(|session| session.id == session_id)
}

fn selected_service<'a>(input: &'a DashboardRenderInput<'_>) -> Option<&'a DashboardService> {
    let service_id = input.selected_service_id?;
    input
        .snapshot
        .services
        .iter()
        .find(|service| service.id == service_id)
}

fn selected_teammates<'a>(input: &'a DashboardRenderInput<'_>) -> Vec<&'a DashboardSession> {
    let Some(parent) = selected_session(input) else {
        return Vec::new();
    };
    let mut teammates = input
        .snapshot
        .teammates
        .iter()
        .filter(|session| {
            session
                .team
                .as_ref()
                .is_some_and(|team| team.parent_session_id == parent.id)
        })
        .collect::<Vec<_>>();
    teammates.sort_by(|left, right| {
        let left_order = left.team.as_ref().and_then(|team| team.order);
        let right_order = right.team.as_ref().and_then(|team| team.order);
        left_order
            .unwrap_or(usize::MAX)
            .cmp(&right_order.unwrap_or(usize::MAX))
            .then_with(|| {
                compare_teammate_created_at(left.created_at.as_deref(), right.created_at.as_deref())
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    teammates
}

fn compare_teammate_created_at(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    match (
        left.and_then(parse_timestamp_ms),
        right.and_then(parse_timestamp_ms),
    ) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn summarize_teammate(session: &DashboardSession) -> String {
    let identity = session
        .team
        .as_ref()
        .and_then(|team| team.label.as_deref())
        .or(session.label.as_deref())
        .unwrap_or(&session.command);
    let role = session
        .team
        .as_ref()
        .and_then(|team| team.role.as_deref())
        .or(session.role.as_deref());
    let status = derived_status_label(session);
    let hint = session
        .semantic
        .as_ref()
        .and_then(|semantic| semantic.presentation.compact_hint.as_deref());
    [
        Some(if let Some(role) = role {
            format!("{identity}({role})")
        } else {
            identity.to_owned()
        }),
        Some(status.clone()),
        hint.filter(|hint| *hint != status).map(str::to_owned),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

fn has_live_scribe(input: &DashboardRenderInput<'_>) -> bool {
    let sessions = if input.scribe_sessions.is_empty() {
        input.snapshot.sessions.as_slice()
    } else {
        input.scribe_sessions
    };
    sessions
        .iter()
        .any(|session| is_scribe_session(session) && !is_session_offline(session))
}

fn is_project_control_session(session: &DashboardSession) -> bool {
    if session.project_control == Some(true) || session.overseer == Some(true) {
        return true;
    }
    if session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer") {
        return true;
    }
    if session.scribe == Some(false) {
        return false;
    }
    is_scribe_session(session)
}

fn is_scribe_session(session: &DashboardSession) -> bool {
    if session.scribe == Some(false) {
        return false;
    }
    session.scribe == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe")
}

fn dashboard_enter_verb(
    session: Option<&DashboardSession>,
    service: Option<&DashboardService>,
) -> &'static str {
    if service.is_some() {
        return "open";
    }
    let Some(session) = session else {
        return "focus";
    };
    if matches!(
        session.status,
        SessionStatus::Offline | SessionStatus::Exited
    ) {
        if restore_state(session) == Some("blocked") {
            "unavailable"
        } else {
            "resume"
        }
    } else {
        "focus"
    }
}

fn restore_state(session: &DashboardSession) -> Option<&str> {
    session.restore_state.as_deref().or_else(|| {
        session
            .extra
            .get("restoreState")
            .and_then(serde_json::Value::as_str)
    })
}

fn worktree_name_branch(name: Option<&str>, branch: Option<&str>) -> String {
    match (name, branch.filter(|branch| !branch.is_empty())) {
        (Some(name), Some(branch)) => format!("{name} · {branch}"),
        (Some(name), None) => name.to_owned(),
        (None, Some(branch)) => format!("main · {branch}"),
        (None, None) => "main".to_owned(),
    }
}

fn session_status_str(status: &SessionStatus) -> &'static str {
    match status {
        SessionStatus::Running => "running",
        SessionStatus::Idle => "idle",
        SessionStatus::Waiting => "waiting",
        SessionStatus::Offline => "offline",
        SessionStatus::Exited => "exited",
    }
}

fn service_status_str(status: &ServiceStatus) -> &'static str {
    match status {
        ServiceStatus::Running => "running",
        ServiceStatus::Exited => "exited",
        ServiceStatus::Offline => "offline",
        ServiceStatus::Stopped => "stopped",
        ServiceStatus::Error => "error",
    }
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn format_relative_recency(value: &str) -> Option<String> {
    let timestamp = parse_timestamp_ms(value)?;
    let delta_seconds = now_ms().saturating_sub(timestamp) / 1000;
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

fn parse_timestamp_ms(value: &str) -> Option<u128> {
    crate::project_service::usage::parse_recency_timestamp(value)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
pub struct DashboardSubscreenRenderInput<'a> {
    pub screen: DashboardScreen,
    pub resource: Option<&'a Value>,
    pub error: Option<&'a str>,
    pub selected_index: usize,
    pub cols: usize,
    pub rows: usize,
    pub scroll_offset: usize,
    pub footer_message: Option<&'a str>,
    pub details_sidebar_visible: bool,
    pub runtime_label: Option<&'a str>,
    pub version: Option<&'a str>,
    pub is_dev_runtime: bool,
}

pub fn render_dashboard_subscreen_frame(
    input: &DashboardSubscreenRenderInput<'_>,
) -> ScreenFrameResult {
    let content_width = screen_content_width(input.cols);
    let two_pane = input.cols >= 110 && input.details_sidebar_visible;
    let card_width = if two_pane {
        screen_left_width(input.cols)
    } else {
        input.cols.saturating_sub(2).max(40)
    };
    let title = subscreen_title(
        input.screen.as_str(),
        input.version,
        input.runtime_label,
        input.is_dev_runtime,
    );
    let header = vec![
        String::new(),
        center(&title, content_width),
        if input.is_dev_runtime {
            format!("\x1b[33m{}\x1b[0m", "─".repeat(input.cols))
        } else {
            "─".repeat(input.cols)
        },
        String::new(),
    ];
    let mut content = match input.screen {
        DashboardScreen::Dashboard => Vec::new(),
        DashboardScreen::Help => render_help_content(),
        DashboardScreen::Coordination => {
            render_coordination_content(input.resource, input.selected_index)
        }
        DashboardScreen::Project => render_project_content(input.resource, input.selected_index),
        DashboardScreen::Library => render_library_content(input.resource, input.selected_index),
        DashboardScreen::Topology => render_topology_content(input.resource, input.selected_index),
        DashboardScreen::Graveyard => {
            render_graveyard_content(input.resource, input.selected_index, card_width)
        }
    };
    if let Some(error) = input.error {
        content.insert(0, format!("  {}", style(error, Tone::Danger)));
        content.insert(1, String::new());
    }
    let mut footer = vec![footer_hints(subscreen_footer(
        input.screen,
        input.resource,
        input.selected_index,
    ))];
    if let Some(message) = input.footer_message {
        footer.push(style(message, Tone::Muted));
    }
    let viewport_height = input
        .rows
        .saturating_sub(header.len() + 1 + footer.len())
        .max(1);
    let right_width = content_width
        .saturating_sub(screen_left_width(input.cols))
        .saturating_sub(4)
        .max(20);
    let right_panel = if two_pane {
        Some(render_subscreen_details(
            input.screen,
            input.resource,
            input.selected_index,
            right_width,
            viewport_height,
        ))
    } else {
        None
    };
    compose_screen_frame(&ScreenFrameInput {
        cols: input.cols,
        rows: input.rows,
        header: &header,
        content: &content,
        footer_lines: &footer,
        focus_line: find_focus_line(&content),
        scroll_offset: input.scroll_offset,
        two_pane,
        right_panel: right_panel.as_deref(),
    })
}

pub fn render_dashboard_footer_hints_contract(
    input: &DashboardRenderInput<'_>,
    preview_source: &str,
) -> serde_json::Value {
    footer::dashboard_footer_hint_values_for_contract(input, preview_source)
}

fn render_help_content() -> Vec<String> {
    vec![
        format!("  {}", style("Dashboard", Tone::Strong)),
        "    [↑↓/jk] select rows".into(),
        "    [Enter/→/l] open selected row".into(),
        "    [h/←] back to worktrees".into(),
        "    [1-9] quick jump".into(),
        String::new(),
        format!("  {}", style("Screens", Tone::Strong)),
        "    [c] coordination".into(),
        "    [p] project".into(),
        "    [L] library".into(),
        "    [t] topology".into(),
        "    [g] graveyard".into(),
        String::new(),
        format!("  {}", style("Actions", Tone::Strong)),
        "    [n] agent  [v] service  [f] fork  [S] switch tool".into(),
        "    [a] hide/show offline agents  [x] stop/kill".into(),
    ]
}

fn subscreen_title(
    screen: &str,
    version: Option<&str>,
    runtime_label: Option<&str>,
    is_dev_runtime: bool,
) -> String {
    let dev_badge = if is_dev_runtime {
        "\x1b[1;30;43m DEV \x1b[0m "
    } else {
        ""
    };
    let version_tag = version
        .map(|version| format!("{} ", style(&format!("v{version}"), Tone::Muted)))
        .unwrap_or_default();
    let runtime = runtime_label
        .map(|label| format!("  {}", style(&format!("● {label}"), Tone::Done)))
        .unwrap_or_default();
    format!(
        "{dev_badge}{} {version_tag}— {screen}{runtime}",
        style("aimux", Tone::Strong)
    )
}

fn selected_marker(selected: bool) -> String {
    if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".into()
    }
}

fn trailing_mark(selected: bool) -> String {
    if selected {
        format!(" {}", style("◀", Tone::Accent))
    } else {
        String::new()
    }
}

fn item_number(index: usize) -> String {
    style(&format!("[{}]", index + 1), Tone::Muted)
}

fn subscreen_footer(
    screen: DashboardScreen,
    resource: Option<&Value>,
    selected_index: usize,
) -> &'static str {
    match screen {
        DashboardScreen::Coordination => {
            let selected =
                resource.and_then(|resource| array_at(resource, &["worklist"]).get(selected_index));
            if selected.and_then(|item| string_at(item, &["kind"])) == Some("thread") {
                "[↑↓] select  [Tab] threads  [Enter] jump  [s] reply  [A] accept  [c] complete  [b/o/x] state  [P/J/E] review  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
            } else {
                match selected.and_then(|item| string_at(item, &["reachability"])) {
                    Some("offline") => {
                        "[↑↓] select  [Tab] threads  [Enter] wake  [r] read  [c] clear  [R] read all  [C] clear all  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
                    }
                    Some("missing") => {
                        "[↑↓] select  [Tab] threads  [r] read  [c] clear  [R] read all  [C] clear all  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
                    }
                    _ => {
                        "[↑↓] select  [Tab] threads  [Enter] open  [r] read  [c] clear  [R] read all  [C] clear all  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
                    }
                }
            }
        }
        DashboardScreen::Project => {
            "[↑↓] select  [Tab] details  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
        }
        DashboardScreen::Library => {
            "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [Enter] show path  [r] refresh  [Esc] dashboard  [q] quit"
        }
        DashboardScreen::Topology => {
            "[↑↓] select  [Tab] details  [Enter] open  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"
        }
        DashboardScreen::Graveyard => {
            "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [1-9/Enter] resurrect  [x] delete worktree  [Esc] dashboard  [q] quit"
        }
        DashboardScreen::Dashboard | DashboardScreen::Help => {
            "[d/Esc] dashboard  [c/p/L/t/g] screens  [?] help  [q] quit"
        }
    }
}

fn render_coordination_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(resource) = resource else {
        return loading_lines("coordination");
    };
    let items = array_at(resource, &["worklist"]);
    let filter_threads = false;
    let need_you = items
        .iter()
        .filter(|item| matches!(string_at(item, &["bucket"]), Some("awake" | "asleep")))
        .count();
    let mut bucket_counts = BTreeMap::<String, usize>::new();
    for item in items {
        let bucket = string_at(item, &["bucket"]).unwrap_or("").to_owned();
        *bucket_counts.entry(bucket).or_default() += 1;
    }
    let mut lines = vec![format!(
        "  {} {}",
        style("Coordination", Tone::Strong),
        style(
            &format!(
                "({need_you} need you · {}){}",
                items.len(),
                if filter_threads { " · threads" } else { "" }
            ),
            Tone::Muted
        )
    )];
    if items.is_empty() {
        lines.push("    Nothing needs you.".into());
        return lines;
    }
    let mut last_bucket = "";
    for (index, item) in items.iter().take(30).enumerate() {
        let bucket = string_at(item, &["bucket"]).unwrap_or("");
        if bucket != last_bucket {
            lines.push(String::new());
            lines.push(bucket_rule(
                bucket,
                bucket_counts.get(bucket).copied().unwrap_or(0),
            ));
            last_bucket = bucket;
        }
        let selected = index == selected_index;
        let title = string_at(item, &["title"]).unwrap_or("untitled");
        let item_type = string_at(item, &["type"])
            .unwrap_or_else(|| string_at(item, &["kind"]).unwrap_or("item"));
        let title_tone = if item.get("actionable").and_then(Value::as_bool) == Some(true) {
            Tone::Strong
        } else {
            Tone::Muted
        };
        let when = string_at(item, &["when"])
            .and_then(format_relative_recency)
            .map(|when| format!(" {}", style(&format!("· {when}"), Tone::Muted)))
            .unwrap_or_default();
        lines.push(format!(
            "{}{} {} {} {}{}{}{}",
            selected_marker(selected),
            item_number(index),
            reachability_dot(item),
            chip(item_type, worklist_type_tone(item_type)),
            style(&truncate_plain(title, 36), title_tone),
            worklist_tags(item),
            when,
            trailing_mark(selected),
        ));
    }
    lines
}

fn render_project_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(project) = resource.map(|resource| resource.get("project").unwrap_or(resource)) else {
        return loading_lines("project");
    };
    let summary = project.get("summary").unwrap_or(&Value::Null);
    let progress = project.get("progress").unwrap_or(&Value::Null);
    let story = array_at(project, &["story"]);
    let mut lines = Vec::new();
    if !summary.is_null() {
        lines.push(format!("  {}", style("Summary", Tone::Strong)));
        lines.push(format!(
            "    {} {}  {}  {}",
            style(
                &format!(
                    "agents {}",
                    number_at(summary, &["agentsRunning"])
                        + number_at(summary, &["agentsWaiting"])
                        + number_at(summary, &["agentsOffline"])
                ),
                Tone::Muted
            ),
            style(
                &format!(
                    "({} run · {} wait · {} off)",
                    number_at(summary, &["agentsRunning"]),
                    number_at(summary, &["agentsWaiting"]),
                    number_at(summary, &["agentsOffline"])
                ),
                Tone::Muted
            ),
            style(
                &format!("services {}", number_at(summary, &["services"])),
                Tone::Muted
            ),
            style(
                &format!("worktrees {}", number_at(summary, &["worktrees"])),
                Tone::Muted
            ),
        ));
        let unread = number_at(summary, &["unreadNotifications"]);
        lines.push(format!(
            "    {}  {}",
            style(
                &format!(
                    "tasks {} open / {} done",
                    number_at(summary, &["openTasks"]),
                    number_at(summary, &["doneTasks"])
                ),
                Tone::Muted
            ),
            style(
                &format!("{unread} unread"),
                if unread > 0 {
                    Tone::Attention
                } else {
                    Tone::Muted
                }
            )
        ));
    }
    if !progress.is_null() {
        lines.push(String::new());
        lines.push(format!(
            "  {} {}",
            style("Progress", Tone::Strong),
            style(
                &format!("({} tasks)", number_at(progress, &["total"])),
                Tone::Muted
            )
        ));
        lines.push(format!(
            "    {} · {} · {} · {} · {} · {}",
            style(
                &format!("pending {}", number_at(progress, &["pending"])),
                Tone::Muted
            ),
            style(
                &format!("assigned {}", number_at(progress, &["assigned"])),
                Tone::Muted
            ),
            style(
                &format!("active {}", number_at(progress, &["in_progress"])),
                Tone::Work
            ),
            style(
                &format!("blocked {}", number_at(progress, &["blocked"])),
                if number_at(progress, &["blocked"]) > 0 {
                    Tone::Blocked
                } else {
                    Tone::Muted
                }
            ),
            style(
                &format!("done {}", number_at(progress, &["done"])),
                Tone::Done
            ),
            style(
                &format!("failed {}", number_at(progress, &["failed"])),
                if number_at(progress, &["failed"]) > 0 {
                    Tone::Danger
                } else {
                    Tone::Muted
                }
            )
        ));
    }
    lines.push(String::new());
    lines.push(format!(
        "  {} {}",
        style("Story", Tone::Strong),
        style(&format!("({})", story.len()), Tone::Muted)
    ));
    if story.is_empty() {
        lines.push(format!("    {}", style("No recent activity.", Tone::Muted)));
    } else {
        for (index, item) in story.iter().take(30).enumerate() {
            let selected = index == selected_index;
            let kind = string_at(item, &["kind"]).unwrap_or("item");
            let title = string_at(item, &["title"]).unwrap_or("untitled");
            let meta = string_at(item, &["meta"])
                .map(|meta| {
                    format!(
                        " {}",
                        style(&format!("· {}", truncate_plain(meta, 22)), Tone::Muted)
                    )
                })
                .unwrap_or_default();
            let when = string_at(item, &["createdAt"])
                .and_then(format_relative_recency)
                .map(|when| format!(" {}", style(&format!("· {when}"), Tone::Muted)))
                .unwrap_or_default();
            let unread = string_at(item, &["status"]) == Some("unread");
            lines.push(format!(
                "{}{} {} {} {}{}{}{}",
                selected_marker(selected),
                item_number(index),
                status_dot(if unread {
                    StatusKind::Needs
                } else {
                    StatusKind::Offline
                }),
                chip(kind, story_kind_tone(kind)),
                style(
                    &truncate_plain(title, 40),
                    if unread { Tone::Strong } else { Tone::Muted }
                ),
                meta,
                when,
                trailing_mark(selected),
            ));
        }
    }
    lines
}

fn render_library_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(resource) = resource else {
        return loading_lines("library");
    };
    let entries = array_at(resource, &["entries"]);
    let mut lines = vec![format!("  {}", style("Library", Tone::Strong))];
    if entries.is_empty() {
        lines.push(format!(
            "    {}",
            style("No project docs or plans yet.", Tone::Muted)
        ));
        return lines;
    }
    for (index, entry) in entries.iter().take(30).enumerate() {
        let selected = index == selected_index;
        let kind = string_at(entry, &["kind"]).unwrap_or("doc");
        let title = string_at(entry, &["title"]).unwrap_or("untitled");
        let path = string_at(entry, &["path"]).unwrap_or("");
        lines.push(format!(
            "{}{} {} {}{}{}{}",
            selected_marker(selected),
            item_number(index),
            style(
                &format!("[{kind}]"),
                if kind == "plan" {
                    Tone::Work
                } else {
                    Tone::Info
                }
            ),
            style(&truncate_plain(title, 38), Tone::Strong),
            if kind == "plan" {
                string_at(entry, &["sessionId"])
                    .map(|session| format!(" {}", style(&format!("({session})"), Tone::Muted)))
                    .unwrap_or_default()
            } else {
                String::new()
            },
            string_at(entry, &["updatedAt"])
                .and_then(format_relative_recency)
                .map(|when| format!(" {}", style(&format!("· {when}"), Tone::Muted)))
                .unwrap_or_else(|| format!(" {}", style(path, Tone::Muted))),
            trailing_mark(selected),
        ));
    }
    lines
}

fn render_topology_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(topology) = resource.map(|resource| resource.get("topology").unwrap_or(resource))
    else {
        return loading_lines("topology");
    };
    let counts = topology.get("counts").unwrap_or(&Value::Null);
    let rows = array_at(topology, &["rows"]);
    let mut lines = vec![
        format!(
            "  {} {}{}",
            topology_dot(string_at(topology, &["health"]).unwrap_or("idle")),
            style(
                string_at(topology, &["projectName"]).unwrap_or("project"),
                Tone::Strong
            ),
            if counts.is_null() {
                String::new()
            } else {
                format!(
                    " {}",
                    style(
                        &format!(
                            "· {} worktrees · {} agents · {} services",
                            number_at(counts, &["worktrees"]),
                            number_at(counts, &["agents"]),
                            number_at(counts, &["services"])
                        ),
                        Tone::Muted
                    )
                )
            }
        ),
        String::new(),
    ];
    if rows.is_empty() {
        lines.push(format!("  {}", style("No worktrees.", Tone::Muted)));
    }
    for (index, row) in rows.iter().take(40).enumerate() {
        let selected = index == selected_index;
        let depth = number_at(row, &["depth"]) as usize;
        let label = string_at(row, &["label"]).unwrap_or("");
        let kind = string_at(row, &["kind"]).unwrap_or("");
        let health = string_at(row, &["health"]).unwrap_or("");
        let indent = if depth > 0 { "    " } else { "  " };
        let detail = string_at(row, &["detail"])
            .map(|detail| format!(" {}", style(&format!("({detail})"), Tone::Muted)))
            .unwrap_or_default();
        if kind == "worktree" {
            let status = style(
                format!("· {}", string_at(row, &["status"]).unwrap_or("")).trim(),
                Tone::Muted,
            );
            lines.push(format!(
                "{} {indent}{} {}{} {}{}",
                if selected {
                    style("▸", Tone::Accent)
                } else {
                    " ".into()
                },
                topology_dot(health),
                style(&truncate_plain(label, 30), Tone::Strong),
                detail,
                status,
                trailing_mark(selected)
            ));
        } else {
            lines.push(format!(
                "{} {indent}{} {} {}{}{}",
                if selected {
                    style("▸", Tone::Accent)
                } else {
                    " ".into()
                },
                topology_dot(health),
                chip(kind, ChipTone::Muted),
                truncate_plain(label, 28),
                detail,
                trailing_mark(selected)
            ));
        }
    }
    lines
}

fn render_graveyard_content(
    resource: Option<&Value>,
    selected_index: usize,
    card_width: usize,
) -> Vec<String> {
    let Some(resource) = resource else {
        return loading_lines("graveyard");
    };
    let rows = array_at(resource, &["viewModel", "rows"]);
    if rows.is_empty() {
        return vec![
            format!("  {}", style("Worktrees", Tone::Strong)),
            format!("    {}", style("(empty)", Tone::Muted)),
            String::new(),
            format!("  {}", style("Agents", Tone::Strong)),
            format!("    {}", style("(empty)", Tone::Muted)),
        ];
    }
    let mut lines = Vec::new();
    let mut first = true;
    let mut current_card: Option<GraveyardCardBlock> = None;
    let mut current_loose: Option<Vec<(String, Option<usize>)>> = None;

    for row in rows {
        match string_at(row, &["kind"]).unwrap_or("") {
            "section" => {
                flush_graveyard_blocks(
                    &mut lines,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                    card_width,
                );
                if !first {
                    lines.push(String::new());
                }
                first = false;
                lines.push(format!(
                    "  {}",
                    style(string_at(row, &["label"]).unwrap_or(""), Tone::Strong)
                ));
            }
            "worktree" => {
                flush_graveyard_blocks(
                    &mut lines,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                    card_width,
                );
                let entry = row.get("entry").unwrap_or(&Value::Null);
                let selected = number_at(row, &["actionIndex"]) as usize == selected_index;
                let branch = string_at(entry, &["branch"])
                    .map(|branch| format!(" {}", style(&format!("· {branch}"), Tone::Muted)))
                    .unwrap_or_default();
                let title = format!(
                    "{}{} {}{}",
                    selected_marker(selected),
                    keycap_hint(&action_number_label(row), "", None),
                    style(
                        string_at(entry, &["name"]).unwrap_or(""),
                        if selected { Tone::Accent } else { Tone::Strong }
                    ),
                    branch
                );
                let service_count = array_at(row, &["attachedServices"]).len();
                let service_text = if service_count > 0 {
                    format!(
                        " · {service_count} svc{}",
                        if service_count == 1 { "" } else { "s" }
                    )
                } else {
                    String::new()
                };
                let agent_count = array_at(row, &["attachedAgents"]).len();
                let count_text = style(
                    &format!(
                        "{agent_count} agent{}{}",
                        if agent_count == 1 { "" } else { "s" },
                        service_text
                    ),
                    Tone::Muted,
                );
                let summary = recency_chip(string_at(row, &["lastUsedAt"]))
                    .map_or(count_text.clone(), |chip| format!("{count_text} {chip}"));
                current_card = Some(GraveyardCardBlock {
                    title,
                    summary: Some(summary),
                    rows: Vec::new(),
                });
            }
            "attached-agent-display" => {
                let agent = row
                    .get("agent")
                    .and_then(|agent| agent.get("entry"))
                    .unwrap_or(&Value::Null);
                let backend = string_at(agent, &["backendSessionId"])
                    .map(|backend| {
                        let short = backend.chars().take(8).collect::<String>();
                        format!(" ({short}…)")
                    })
                    .unwrap_or_default();
                let identity = string_at(agent, &["label"])
                    .map(|label| format!(" — {label}"))
                    .unwrap_or_default();
                let headline = string_at(agent, &["headline"])
                    .map(|headline| format!(" · {headline}"))
                    .unwrap_or_default();
                let text = format!(
                    "  {} {}",
                    status_dot(StatusKind::Offline),
                    style(
                        &format!(
                            "{}:{}{}{}{}",
                            string_at(agent, &["command"]).unwrap_or(""),
                            string_at(agent, &["id"]).unwrap_or(""),
                            backend,
                            identity,
                            headline
                        ),
                        Tone::Muted
                    )
                );
                let text = recency_chip(string_at(row, &["agent", "lastUsedAt"]))
                    .map_or(text.clone(), |chip| format!("{text} {chip}"));
                if let Some(card) = &mut current_card {
                    card.rows.push(text);
                }
            }
            "attached-more-display" => {
                if let Some(card) = &mut current_card {
                    let count = number_at(row, &["hiddenAgentCount"]);
                    card.rows.push(format!(
                        "  {}",
                        style(
                            &format!("… {count} more agent{}", if count == 1 { "" } else { "s" }),
                            Tone::Muted
                        )
                    ));
                }
            }
            "attached-service-display" => {
                let service = row
                    .get("service")
                    .and_then(|service| service.get("entry"))
                    .unwrap_or(&Value::Null);
                let identity = string_at(service, &["label"])
                    .or_else(|| string_at(service, &["launchCommandLine"]))
                    .unwrap_or("shell");
                let text = format!(
                    "  {} {}",
                    status_dot(StatusKind::ServiceOff),
                    style(&format!("{identity} [service]"), Tone::Muted)
                );
                let text = recency_chip(string_at(row, &["service", "lastUsedAt"]))
                    .map_or(text.clone(), |chip| format!("{text} {chip}"));
                if let Some(card) = &mut current_card {
                    card.rows.push(text);
                }
            }
            "agent-worktree" => {
                flush_graveyard_blocks(
                    &mut lines,
                    &mut current_card,
                    &mut current_loose,
                    &mut first,
                    card_width,
                );
                current_card = Some(GraveyardCardBlock {
                    title: style(string_at(row, &["name"]).unwrap_or(""), Tone::Strong),
                    summary: None,
                    rows: Vec::new(),
                });
            }
            "orphan-teammate" => {
                let teammate = row.get("entry").unwrap_or(&Value::Null);
                let identity = string_at(teammate, &["label"])
                    .map(|label| format!(" — {label}"))
                    .unwrap_or_default();
                let headline = string_at(teammate, &["headline"])
                    .map(|headline| format!(" · {}", truncate_plain(headline, 36)))
                    .unwrap_or_default();
                let text = format!(
                    "  {} {}",
                    status_dot(StatusKind::Offline),
                    style(
                        &format!(
                            "{}:{}{} · missing parent {}{}",
                            string_at(teammate, &["command"]).unwrap_or(""),
                            string_at(teammate, &["id"]).unwrap_or(""),
                            identity,
                            string_at(row, &["parentSessionId"]).unwrap_or(""),
                            headline
                        ),
                        Tone::Muted
                    )
                );
                current_loose
                    .get_or_insert_with(Vec::new)
                    .push((text, None));
            }
            _ => {
                let agent = row.get("entry").unwrap_or(&Value::Null);
                let selected = number_at(row, &["actionIndex"]) as usize == selected_index;
                let backend = string_at(agent, &["backendSessionId"])
                    .map(|backend| {
                        let short = backend.chars().take(8).collect::<String>();
                        format!(" ({short}…)")
                    })
                    .unwrap_or_default();
                let identity = string_at(agent, &["label"])
                    .map(|label| format!(" — {label}"))
                    .unwrap_or_default();
                let headline = string_at(agent, &["headline"])
                    .map(|headline| format!(" · {headline}"))
                    .unwrap_or_default();
                let unrecoverable = if agent.get("graveyardReason").is_some() {
                    format!(" {}", style("· unrecoverable", Tone::Danger))
                } else {
                    String::new()
                };
                let text = format!(
                    "{}{} {} {}{}",
                    selected_marker(selected),
                    keycap_hint(&action_number_label(row), "", None),
                    status_dot(StatusKind::Offline),
                    style(
                        &format!(
                            "{}:{}{}{}{}",
                            string_at(agent, &["command"]).unwrap_or(""),
                            string_at(agent, &["id"]).unwrap_or(""),
                            backend,
                            identity,
                            headline
                        ),
                        Tone::Muted
                    ),
                    unrecoverable
                );
                let text = recency_chip(string_at(row, &["lastUsedAt"]))
                    .map_or(text.clone(), |chip| format!("{text} {chip}"));
                if let Some(card) = &mut current_card {
                    card.rows.push(text);
                } else {
                    current_loose
                        .get_or_insert_with(Vec::new)
                        .push((text, Some(number_at(row, &["actionIndex"]) as usize)));
                }
            }
        }
    }
    flush_graveyard_blocks(
        &mut lines,
        &mut current_card,
        &mut current_loose,
        &mut first,
        card_width,
    );
    lines
}

#[derive(Debug)]
struct GraveyardCardBlock {
    title: String,
    summary: Option<String>,
    rows: Vec<String>,
}

fn flush_graveyard_blocks(
    lines: &mut Vec<String>,
    current_card: &mut Option<GraveyardCardBlock>,
    current_loose: &mut Option<Vec<(String, Option<usize>)>>,
    first: &mut bool,
    card_width: usize,
) {
    if let Some(loose) = current_loose.take() {
        if !*first {
            lines.push(String::new());
        }
        *first = false;
        for (text, _) in loose {
            lines.push(format!("  {text}"));
        }
    }
    if let Some(block) = current_card.take() {
        if !*first {
            lines.push(String::new());
        }
        *first = false;
        lines.extend(card(&CardSpec {
            tone: Tone::Muted,
            title: &block.title,
            summary: block.summary.as_deref(),
            rows: &block.rows,
            width: card_width,
        }));
    }
}

fn render_subscreen_details(
    screen: DashboardScreen,
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    match screen {
        DashboardScreen::Coordination => {
            render_coordination_details(resource, selected_index, width, height)
        }
        DashboardScreen::Project => render_project_details(resource, selected_index, width, height),
        DashboardScreen::Library => render_library_details(resource, selected_index, width, height),
        DashboardScreen::Topology => {
            render_topology_details(resource, selected_index, width, height)
        }
        DashboardScreen::Graveyard => {
            render_graveyard_details(resource, selected_index, width, height)
        }
        DashboardScreen::Dashboard | DashboardScreen::Help => vec![String::new(); height],
    }
}

fn loading_lines(screen: &str) -> Vec<String> {
    vec![format!(
        "  {}",
        style(&format!("Loading {screen}..."), Tone::Muted)
    )]
}

fn render_coordination_details(
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let item = resource
        .and_then(|resource| array_at(resource, &["worklist"]).get(selected_index))
        .unwrap_or(&Value::Null);
    if item.is_null() {
        return vec![String::new(); height];
    }
    if string_at(item, &["kind"]) == Some("thread") {
        render_coordination_thread_details(
            item.get("thread").unwrap_or(&Value::Null),
            width,
            height,
        )
    } else {
        render_coordination_notification_details(
            item.get("notification").unwrap_or(&Value::Null),
            width,
            height,
        )
    }
}

fn render_coordination_notification_details(
    note: &Value,
    width: usize,
    height: usize,
) -> Vec<String> {
    if note.is_null() {
        return vec![String::new(); height];
    }
    let inner = width.saturating_sub(4).max(8);
    let latest = note
        .get("latestUnread")
        .or_else(|| array_at(note, &["notifications"]).last())
        .unwrap_or(&Value::Null);
    let mut rows = Vec::new();
    rows.extend(wrap_key_value(
        "Title",
        string_at(note, &["title"]).unwrap_or(""),
        inner,
    ));
    let state = if number_at(note, &["unreadCount"]) > 0 {
        format!("{} unread", number_at(note, &["unreadCount"]))
    } else {
        "read".to_owned()
    };
    rows.extend(wrap_key_value("State", &state, inner));
    if let Some(session_id) = string_at(note, &["sessionId"]) {
        rows.extend(wrap_key_value(
            "Reach",
            string_at(note, &["reachability"]).unwrap_or(""),
            inner,
        ));
        rows.extend(wrap_key_value("Session", session_id, inner));
        if session_id == "claude-1" {
            rows.extend(wrap_key_value("Target", "claude:Main Checkout", inner));
        }
    }
    if let Some(kind) = string_at(latest, &["kind"]) {
        rows.extend(wrap_key_value("Kind", kind, inner));
    }
    if let Some(created) = string_at(latest, &["createdAt"]) {
        rows.extend(wrap_key_value("Created", created, inner));
    }
    let body_rows = string_at(latest, &["body"])
        .map(|body| wrap_key_value("", body, inner))
        .unwrap_or_default();
    let mut lines = card(&CardSpec {
        tone: Tone::Muted,
        title: &style("Inbox", Tone::Strong),
        summary: None,
        rows: &rows,
        width,
    });
    lines.push(String::new());
    lines.extend(card(&CardSpec {
        tone: Tone::Muted,
        title: &style("Body", Tone::Strong),
        summary: None,
        rows: &body_rows,
        width,
    }));
    pad_detail(lines, height)
}

fn render_coordination_thread_details(entry: &Value, width: usize, height: usize) -> Vec<String> {
    if entry.is_null() {
        return vec![String::new(); height];
    }
    let inner = width.saturating_sub(4).max(8);
    let thread = entry.get("thread").unwrap_or(&Value::Null);
    let mut rows = Vec::new();
    rows.extend(wrap_key_value(
        "Title",
        string_at(entry, &["displayTitle"]).unwrap_or(""),
        inner,
    ));
    rows.extend(wrap_key_value(
        "Kind",
        string_at(thread, &["kind"]).unwrap_or(""),
        inner,
    ));
    rows.extend(wrap_key_value(
        "Status",
        string_at(entry, &["stateLabel"])
            .or_else(|| string_at(thread, &["status"]))
            .unwrap_or(""),
        inner,
    ));
    let participants = array_at(thread, &["participants"])
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    rows.extend(wrap_key_value("Participants", &participants, inner));
    if let Some(owner) = string_at(thread, &["owner"]) {
        rows.extend(wrap_key_value("Owner", owner, inner));
    }
    if let Some(task) = entry.get("task") {
        rows.extend(wrap_key_value(
            "Task",
            string_at(task, &["status"]).unwrap_or(""),
            inner,
        ));
        if let Some(prompt) = string_at(task, &["prompt"]) {
            rows.extend(wrap_key_value("Prompt", prompt, inner));
        }
    }
    let mut msg_rows = Vec::new();
    for message in array_at(entry, &["messages"])
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let to = array_at(message, &["to"])
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let prefix = format!(
            "{}{} [{}]",
            string_at(message, &["from"]).unwrap_or(""),
            if to.is_empty() {
                String::new()
            } else {
                format!(" → {}", to.join(", "))
            },
            string_at(message, &["kind"]).unwrap_or("")
        );
        msg_rows.extend(wrap_key_value(
            &prefix,
            string_at(message, &["body"]).unwrap_or(""),
            inner,
        ));
    }
    let mut lines = card(&CardSpec {
        tone: Tone::Muted,
        title: &style("Thread", Tone::Strong),
        summary: None,
        rows: &rows,
        width,
    });
    lines.push(String::new());
    lines.extend(card(&CardSpec {
        tone: Tone::Muted,
        title: &style("Messages", Tone::Strong),
        summary: None,
        rows: &msg_rows,
        width,
    }));
    pad_detail(lines, height)
}

fn render_project_details(
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let item = resource
        .map(|resource| resource.get("project").unwrap_or(resource))
        .and_then(|project| array_at(project, &["story"]).get(selected_index))
        .unwrap_or(&Value::Null);
    if item.is_null() {
        return vec![String::new(); height];
    }
    let mut rows = Vec::new();
    let inner = width.saturating_sub(4).max(8);
    rows.extend(wrap_key_value(
        "Title",
        string_at(item, &["title"]).unwrap_or(""),
        inner,
    ));
    rows.extend(wrap_key_value(
        "Kind",
        string_at(item, &["kind"]).unwrap_or(""),
        inner,
    ));
    if let Some(status) = string_at(item, &["status"]) {
        rows.extend(wrap_key_value("Status", status, inner));
    }
    if let Some(meta) = string_at(item, &["meta"]) {
        rows.extend(wrap_key_value("Meta", meta, inner));
    }
    if let Some(created_at) = string_at(item, &["createdAt"]) {
        rows.extend(wrap_key_value("When", created_at, inner));
    }
    let mut lines = card(&CardSpec {
        tone: Tone::Muted,
        title: &style("Story", Tone::Strong),
        summary: None,
        rows: &rows,
        width,
    });
    if let Some(body) = string_at(item, &["body"]) {
        let body_rows = wrap_key_value("", body, inner);
        lines.push(String::new());
        lines.extend(card(&CardSpec {
            tone: Tone::Muted,
            title: &style("Body", Tone::Strong),
            summary: None,
            rows: &body_rows,
            width,
        }));
    }
    pad_detail(lines, height)
}

fn render_library_details(
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let entry = resource
        .and_then(|resource| array_at(resource, &["entries"]).get(selected_index))
        .unwrap_or(&Value::Null);
    if entry.is_null() {
        return vec![String::new(); height];
    }
    let mut lines = Vec::new();
    lines.push(style("Details", Tone::Strong));
    lines.extend(wrap_key_value(
        "Title",
        string_at(entry, &["title"]).unwrap_or(""),
        width,
    ));
    lines.extend(wrap_key_value(
        "Kind",
        string_at(entry, &["kind"]).unwrap_or(""),
        width,
    ));
    if let Some(session_id) = string_at(entry, &["sessionId"]) {
        lines.extend(wrap_key_value("Session", session_id, width));
    }
    lines.extend(wrap_key_value(
        "Updated",
        string_at(entry, &["updatedAt"]).unwrap_or(""),
        width,
    ));
    lines.extend(wrap_key_value(
        "Path",
        string_at(entry, &["path"]).unwrap_or(""),
        width,
    ));
    lines.push(String::new());
    lines.push(style("Preview", Tone::Strong));
    for line in string_at(entry, &["preview"]).unwrap_or("(empty)").lines() {
        lines.push(if visible_width(line) > width {
            truncate_plain(line, width)
        } else {
            line.to_owned()
        });
    }
    pad_detail(lines, height)
}

fn render_topology_details(
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let row = resource
        .map(|resource| resource.get("topology").unwrap_or(resource))
        .and_then(|topology| array_at(topology, &["rows"]).get(selected_index))
        .unwrap_or(&Value::Null);
    if row.is_null() {
        return vec![String::new(); height];
    }
    let kind = string_at(row, &["kind"]).unwrap_or("");
    let title = if kind == "worktree" {
        "Worktree"
    } else if kind == "service" {
        "Service"
    } else {
        "Agent"
    };
    let mut rows = Vec::new();
    let inner = width.saturating_sub(4).max(8);
    rows.extend(wrap_key_value(
        "Name",
        string_at(row, &["label"]).unwrap_or(""),
        inner,
    ));
    rows.extend(wrap_key_value(
        "Health",
        string_at(row, &["health"]).unwrap_or(""),
        inner,
    ));
    if let Some(detail) = string_at(row, &["detail"]) {
        rows.extend(wrap_key_value(
            if kind == "worktree" {
                "Branch"
            } else {
                "Detail"
            },
            detail,
            inner,
        ));
    }
    if let Some(status) = string_at(row, &["status"]) {
        rows.extend(wrap_key_value("Status", status, inner));
    }
    if let Some(worktree) = string_at(row, &["worktreePath"]) {
        rows.extend(wrap_key_value("Worktree", worktree, inner));
    }
    if let Some(session) = string_at(row, &["sessionId"]) {
        rows.extend(wrap_key_value("Session", session, inner));
    }
    if let Some(service) = string_at(row, &["serviceId"]) {
        rows.extend(wrap_key_value("Service", service, inner));
    }
    pad_detail(
        card(&CardSpec {
            tone: Tone::Muted,
            title: &style(title, Tone::Strong),
            summary: None,
            rows: &rows,
            width,
        }),
        height,
    )
}

fn render_graveyard_details(
    resource: Option<&Value>,
    selected_index: usize,
    width: usize,
    height: usize,
) -> Vec<String> {
    let selected = resource
        .and_then(|resource| {
            array_at(resource, &["viewModel", "selectableRows"]).get(selected_index)
        })
        .unwrap_or(&Value::Null);
    if selected.is_null() {
        return vec![String::new(); height];
    }
    let mut lines = Vec::new();
    let entry = selected.get("entry").unwrap_or(&Value::Null);
    if string_at(selected, &["kind"]) == Some("worktree") {
        lines.push(style("Details", Tone::Strong));
        lines.extend(wrap_key_value(
            "Worktree",
            string_at(entry, &["name"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value(
            "Branch",
            string_at(entry, &["branch"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value(
            "Path",
            string_at(entry, &["path"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value("Status", "graveyard", width));
        if let Some(at) = string_at(entry, &["graveyardedAt"]).and_then(format_relative_recency) {
            lines.extend(wrap_key_value("Graveyarded", &at, width));
        }
        lines.extend(wrap_key_value(
            "Agents",
            &array_at(selected, &["attachedAgents"]).len().to_string(),
            width,
        ));
        lines.extend(wrap_key_value(
            "Services",
            &array_at(selected, &["attachedServices"]).len().to_string(),
            width,
        ));
        if let Some(last_used) =
            string_at(selected, &["lastUsedAt"]).and_then(format_relative_recency)
        {
            lines.extend(wrap_key_value("Last Used", &last_used, width));
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
                let recency = string_at(agent, &["lastUsedAt"])
                    .and_then(format_relative_recency)
                    .map(|recency| format!(" · {recency}"))
                    .unwrap_or_default();
                lines.push(format!(
                    "- {}{recency}",
                    string_at(entry, &["label"])
                        .or_else(|| string_at(entry, &["id"]))
                        .unwrap_or("")
                ));
            }
            let hidden = number_at(selected, &["hiddenAttachedAgentCount"]);
            if hidden > 0 && lines.len() < height {
                lines.push(format!(
                    "… {hidden} more agent{}",
                    if hidden == 1 { "" } else { "s" }
                ));
            }
        }
        let services = array_at(selected, &["attachedServices"]);
        if !services.is_empty() && lines.len() < height {
            lines.push(String::new());
            lines.push(style("Attached Services", Tone::Strong));
            for service in services
                .iter()
                .take(height.saturating_sub(lines.len()).max(1))
            {
                let entry = service.get("entry").unwrap_or(&Value::Null);
                let label = string_at(entry, &["label"])
                    .or_else(|| string_at(entry, &["launchCommandLine"]))
                    .or_else(|| string_at(entry, &["id"]))
                    .unwrap_or("");
                let recency = string_at(service, &["lastUsedAt"])
                    .and_then(format_relative_recency)
                    .map(|recency| format!(" · {recency}"))
                    .unwrap_or_default();
                lines.push(format!("- {label}{recency}"));
            }
        }
    } else {
        lines.push(style("Details", Tone::Strong));
        lines.extend(wrap_key_value(
            "Agent",
            string_at(entry, &["label"])
                .or_else(|| string_at(entry, &["id"]))
                .unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value(
            "Session",
            string_at(entry, &["id"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value(
            "Tool",
            string_at(entry, &["tool"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value(
            "Config",
            string_at(entry, &["toolConfigKey"]).unwrap_or(""),
            width,
        ));
        lines.extend(wrap_key_value("Status", "offline", width));
        if let Some(last_used) =
            string_at(selected, &["lastUsedAt"]).and_then(format_relative_recency)
        {
            lines.extend(wrap_key_value("Last Used", &last_used, width));
        }
        if let Some(worktree_path) = string_at(entry, &["worktreePath"]) {
            let worktree_name = worktree_path.rsplit('/').next().unwrap_or(worktree_path);
            lines.extend(wrap_key_value("Worktree", worktree_name, width));
            lines.extend(wrap_key_value("Path", worktree_path, width));
        }
        if let Some(backend) = string_at(entry, &["backendSessionId"]) {
            lines.extend(wrap_key_value("Backend", backend, width));
        }
        if let Some(headline) = string_at(entry, &["headline"]) {
            lines.extend(wrap_key_value("Headline", headline, width));
        }
        if let Some(reason) = string_at(entry, &["graveyardReason"]) {
            lines.extend(wrap_key_value("Unrecoverable", reason, width));
        }
        if let Some(command) = string_at(entry, &["command"]) {
            lines.extend(wrap_key_value("Command", command, width));
        }
        let args = array_at(entry, &["args"])
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        if !args.is_empty() {
            lines.extend(wrap_key_value("Args", &args.join(" "), width));
        }
    }
    pad_detail(lines, height)
}

fn pad_detail(mut lines: Vec<String>, height: usize) -> Vec<String> {
    while lines.len() < height {
        lines.push(String::new());
    }
    lines.truncate(height);
    lines
}

fn worklist_type_tone(kind: &str) -> ChipTone {
    match kind {
        "msg" => ChipTone::Work,
        "task" | "review" => ChipTone::Info,
        "handoff" => ChipTone::Attention,
        _ => ChipTone::Muted,
    }
}

fn action_number_label(row: &Value) -> String {
    row.get("actionNumber")
        .and_then(Value::as_u64)
        .map(|number| number.to_string())
        .or_else(|| string_at(row, &["actionNumber"]).map(str::to_owned))
        .unwrap_or_else(|| "1".to_owned())
}

fn recency_chip(value: Option<&str>) -> Option<String> {
    format_relative_recency(value?).map(|recency| chip(&recency, ChipTone::Muted))
}

fn story_kind_tone(kind: &str) -> ChipTone {
    match kind {
        "task" => ChipTone::Work,
        "review" => ChipTone::Info,
        "notification" => ChipTone::Attention,
        _ => ChipTone::Muted,
    }
}

fn bucket_rule(bucket: &str, count: usize) -> String {
    let label = match bucket {
        "awake" => "Awake · act now",
        "asleep" => "Asleep · wake to act",
        "handled" => "Handled",
        "unreachable" => "Unreachable",
        _ => bucket,
    };
    let tone = match bucket {
        "awake" => Tone::Done,
        "asleep" => Tone::Sleep,
        _ => Tone::Muted,
    };
    let dashes = 2.max(46usize.saturating_sub(js_len(label) + count.to_string().len() + 4));
    format!(
        "  {} {} {}",
        style(label, tone),
        style(&"─".repeat(dashes), Tone::Muted),
        style(&count.to_string(), tone)
    )
}

fn reachability_dot(item: &Value) -> String {
    if string_at(item, &["kind"]) == Some("notification") {
        return match string_at(item, &["reachability"]) {
            Some("live") => style("●", Tone::Done),
            Some("offline") => style("◐", Tone::Sleep),
            Some("missing") => style("○", Tone::Danger),
            _ => status_dot(StatusKind::Needs),
        };
    }
    if item.get("actionable").and_then(Value::as_bool) == Some(true) {
        status_dot(StatusKind::Needs)
    } else {
        status_dot(StatusKind::Offline)
    }
}

fn worklist_tags(item: &Value) -> String {
    let mut parts = Vec::new();
    if string_at(item, &["kind"]) == Some("notification") {
        match string_at(item, &["reachability"]) {
            Some("live") => parts.push(style("live", Tone::Done)),
            Some("offline") => parts.push(style("asleep", Tone::Sleep)),
            Some("missing") => parts.push(style("gone", Tone::Danger)),
            _ => {}
        }
        if item.get("stale").and_then(Value::as_bool) == Some(true) {
            parts.push(style("stale", Tone::Muted));
        }
    } else if let Some(entry) = item.get("thread") {
        let thread = entry.get("thread").unwrap_or(&Value::Null);
        let waiting = array_at(thread, &["waitingOn"])
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        if !waiting.is_empty() {
            parts.push(style(&format!("→ {}", waiting.join(",")), Tone::Blocked));
        }
        let pending = number_at(entry, &["pendingDeliveries"]);
        if pending > 0 {
            parts.push(style(&format!("⇢ {pending}"), Tone::Danger));
        }
        parts.push(style(
            string_at(entry, &["stateLabel"])
                .or_else(|| string_at(thread, &["status"]))
                .unwrap_or(""),
            Tone::Muted,
        ));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(
            " {} {}",
            style("·", Tone::Muted),
            parts.join(&format!(" {} ", style("·", Tone::Muted)))
        )
    }
}

fn topology_dot(health: &str) -> String {
    style(
        "●",
        match health {
            "active" => Tone::Done,
            "attention" => Tone::Attention,
            "idle" => Tone::Idle,
            _ => Tone::Muted,
        },
    )
}

fn array_at<'a>(value: &'a Value, path: &[&str]) -> &'a [Value] {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn number_at(value: &Value, path: &[&str]) -> i64 {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_i64().unwrap_or(0)
}

fn find_focus_line(lines: &[String]) -> isize {
    lines
        .iter()
        .position(|line| strip_styled(line).contains('▸'))
        .map(|index| index as isize)
        .unwrap_or(-1)
}

fn strip_styled(line: &str) -> String {
    crate::tui_render::text::strip_ansi(line)
}

#[allow(dead_code)]
fn _assert_width(line: &str, width: usize) -> bool {
    visible_width(line) <= width
}
