mod footer;
mod rows;

use crate::dashboard_model::DesktopStateSnapshot;
use crate::dashboard_renderer::footer::render_dashboard_footer;
use crate::dashboard_renderer::rows::{render_service_row, render_session_row, worktree_summary};
use crate::tui_render::screen_frame::{
    ScreenFrameInput, ScreenFrameResult, compose_screen_frame, screen_content_width,
};
use crate::tui_render::text::{center, truncate_ansi};
use crate::tui_render::theme::{Tone, pad_visible, style, visible_width};

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
    pub footer_message: Option<&'a str>,
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
    let footer_lines = render_dashboard_footer(input);
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
