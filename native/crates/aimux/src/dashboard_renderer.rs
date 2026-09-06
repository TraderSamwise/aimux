use crate::dashboard_model::{DashboardService, DashboardSession, DesktopStateSnapshot};
use crate::tui_render::screen_frame::{
    ScreenFrameInput, ScreenFrameResult, compose_screen_frame, screen_content_width,
};
use crate::tui_render::text::{center, truncate_ansi};
use crate::tui_render::theme::{
    ChipTone, StatusKind, Tone, chip, footer_hints, pad_visible, pill, status_dot, style,
    visible_width,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardNavLevel {
    Worktrees,
    Sessions,
}

#[derive(Debug, Clone)]
pub struct DashboardRenderInput<'a> {
    pub snapshot: &'a DesktopStateSnapshot,
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
}

pub fn render_dashboard_frame(input: &DashboardRenderInput<'_>) -> ScreenFrameResult {
    let content_width = screen_content_width(input.cols);
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
        style(&"─".repeat(input.cols), Tone::Attention)
    } else {
        "─".repeat(input.cols)
    };
    let header = vec![
        String::new(),
        center_in_block(&title),
        divider,
        String::new(),
    ];
    let content = render_dashboard_content(input);
    let footer_lines = vec![footer_hints(&footer_hint_text(input))];
    let focus_line = find_focus_line(&content);

    compose_screen_frame(&ScreenFrameInput {
        cols: input.cols,
        rows: input.rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line,
        scroll_offset: input.scroll_offset,
        two_pane: false,
        right_panel: None,
    })
}

fn render_dashboard_content(input: &DashboardRenderInput<'_>) -> Vec<String> {
    if input.snapshot.sessions.is_empty() && input.snapshot.worktree_groups.is_empty() {
        return vec![truncate_ansi(
            &center(
                "No sessions. Press [n] to create one.",
                screen_content_width(input.cols),
            ),
            input.cols,
        )];
    }
    if !input.snapshot.worktree_groups.is_empty() {
        return render_worktree_groups(input);
    }
    input
        .snapshot
        .sessions
        .iter()
        .enumerate()
        .map(|(index, session)| {
            format!(
                "  {}",
                render_session_row(
                    session,
                    input.selected_session_id == Some(session.id.as_str()),
                    (index < 9).then_some(index + 1),
                )
            )
        })
        .collect()
}

fn render_worktree_groups(input: &DashboardRenderInput<'_>) -> Vec<String> {
    let mut lines = Vec::new();
    for (index, group) in input.snapshot.worktree_groups.iter().enumerate() {
        let selected = input.nav_level == DashboardNavLevel::Worktrees
            && input.focused_worktree_path == group.path.as_deref();
        let digit = (index < 9).then_some(index + 1);
        let selector = if selected {
            style("▸", Tone::Accent)
        } else {
            " ".to_owned()
        };
        let index_cell = digit
            .map(|digit| style(&format!("[{digit}]"), Tone::Muted))
            .unwrap_or_default();
        let title = if group.branch.is_empty() {
            group.name.clone()
        } else {
            format!("{} {}", group.name, style(&group.branch, Tone::Muted))
        };
        let summary = worktree_summary(group.sessions.len(), group.services.len());
        lines.push(format!(
            "{} {} {} {}",
            selector,
            pad_visible(&index_cell, 4),
            style(&title, Tone::Strong),
            summary
        ));

        for (session_index, session) in group.sessions.iter().enumerate() {
            let selected = input.nav_level == DashboardNavLevel::Sessions
                && input.selected_session_id == Some(session.id.as_str());
            lines.push(format!(
                "    {}",
                render_session_row(
                    session,
                    selected,
                    if input.nav_level == DashboardNavLevel::Sessions && session_index < 9 {
                        Some(session_index + 1)
                    } else {
                        None
                    },
                )
            ));
        }
        for service in &group.services {
            let selected = input.nav_level == DashboardNavLevel::Sessions
                && input.selected_service_id == Some(service.id.as_str());
            lines.push(format!("    {}", render_service_row(service, selected)));
        }
        lines.push(String::new());
    }
    lines
}

fn render_session_row(session: &DashboardSession, selected: bool, digit: Option<usize>) -> String {
    let selector = if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    };
    let index = digit
        .map(|digit| style(&format!("[{digit}]"), Tone::Muted))
        .unwrap_or_default();
    let identity = style(&session_identity(session), Tone::Strong);
    let status = session_status_label(session);
    let chips = session_chips(session);
    compact_columns(&[
        (selector, 3),
        (format!("{} ", session_status_dot(session)), 2),
        (index, 5),
        (identity, 24),
        (status, 14),
        (chips, 32),
    ])
}

fn render_service_row(service: &DashboardService, selected: bool) -> String {
    let selector = if selected {
        format!("{} ", style("▸", Tone::Accent))
    } else {
        "  ".to_owned()
    };
    let command = service.command.as_deref().unwrap_or("service");
    let status = match service.status {
        crate::dashboard_model::ServiceStatus::Running => style("[svc] running", Tone::Done),
        crate::dashboard_model::ServiceStatus::Exited => style("[svc] exited", Tone::Danger),
        crate::dashboard_model::ServiceStatus::Offline => style("[svc] offline", Tone::Muted),
    };
    compact_columns(&[
        (selector, 3),
        (format!("{} ", service_status_dot(service)), 2),
        (String::new(), 5),
        (style(command, Tone::Strong), 24),
        (status, 14),
        (String::new(), 32),
    ])
}

fn compact_columns(columns: &[(String, usize)]) -> String {
    columns
        .iter()
        .map(|(content, width)| pad_visible(content, *width))
        .collect::<Vec<_>>()
        .join("")
        .trim_end()
        .to_owned()
}

fn session_identity(session: &DashboardSession) -> String {
    session
        .tool_config_key
        .as_deref()
        .unwrap_or(session.command.as_str())
        .to_owned()
}

fn session_status_dot(session: &DashboardSession) -> String {
    match session.status {
        crate::dashboard_model::SessionStatus::Running => status_dot(StatusKind::Ready),
        crate::dashboard_model::SessionStatus::Idle => status_dot(StatusKind::Done),
        crate::dashboard_model::SessionStatus::Waiting => status_dot(StatusKind::Needs),
        crate::dashboard_model::SessionStatus::Offline => status_dot(StatusKind::Offline),
    }
}

fn service_status_dot(service: &DashboardService) -> String {
    match service.status {
        crate::dashboard_model::ServiceStatus::Running => status_dot(StatusKind::Service),
        crate::dashboard_model::ServiceStatus::Exited => style("◇", Tone::Danger),
        crate::dashboard_model::ServiceStatus::Offline => status_dot(StatusKind::ServiceOff),
    }
}

fn session_status_label(session: &DashboardSession) -> String {
    match session.status {
        crate::dashboard_model::SessionStatus::Running => pill("READY", Tone::Ready),
        crate::dashboard_model::SessionStatus::Idle => pill("DONE", Tone::Done),
        crate::dashboard_model::SessionStatus::Waiting => pill("NEEDS", Tone::Attention),
        crate::dashboard_model::SessionStatus::Offline => style("offline", Tone::Muted),
    }
}

fn session_chips(session: &DashboardSession) -> String {
    let mut chips = Vec::new();
    if session.notification_unread_count > 0 {
        chips.push(chip(
            &format!("{} unread", session.notification_unread_count.min(99)),
            if session.notification_stale {
                ChipTone::Muted
            } else {
                ChipTone::Work
            },
        ));
    }
    if session.thread_unread_count > 0 {
        chips.push(chip(
            &format!("thread {}", session.thread_unread_count.min(99)),
            ChipTone::Muted,
        ));
    }
    chips.join(" ")
}

fn worktree_summary(session_count: usize, service_count: usize) -> String {
    if session_count == 0 && service_count == 0 {
        return style("no agents", Tone::Muted);
    }
    let mut parts = Vec::new();
    if session_count > 0 {
        parts.push(format!("{session_count} agents"));
    }
    if service_count > 0 {
        parts.push(format!("{service_count} services"));
    }
    style(&parts.join(" · "), Tone::Muted)
}

fn footer_hint_text(input: &DashboardRenderInput<'_>) -> String {
    if !input.snapshot.worktree_groups.is_empty() && input.nav_level == DashboardNavLevel::Worktrees
    {
        return "↑↓/jk worktrees  [1-9] worktree  [Enter/→/l] step in  [Tab] details  [n] agent  [v] service  [q] quit"
            .to_owned();
    }
    if !input.snapshot.sessions.is_empty() || !input.snapshot.worktree_groups.is_empty() {
        return "↑↓/jk items  [1-9] entry  [Enter/→/l] open  [Esc/h] back  [n] agent  [v] service  [x] stop  [q] quit"
            .to_owned();
    }
    "[n] agent  [v] service  [?] help  [q] quit".to_owned()
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
