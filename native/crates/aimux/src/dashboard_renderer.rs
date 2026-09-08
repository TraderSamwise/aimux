mod footer;
mod rows;

use crate::dashboard_controller::DashboardScreen;
use crate::dashboard_model::{DesktopStateSnapshot, WorktreeGroup, WorktreeStatus};
use crate::dashboard_renderer::footer::render_dashboard_footer;
use crate::dashboard_renderer::rows::{render_service_row, render_session_row, worktree_summary};
use crate::dashboard_session_details::render_session_details;
use crate::tui_render::screen_frame::{
    ScreenFrameInput, ScreenFrameResult, compose_screen_frame, screen_content_width,
    screen_left_width,
};
use crate::tui_render::text::{center, truncate_ansi, truncate_plain, wrap_text};
use crate::tui_render::theme::{Tone, pad_visible, style, visible_width};
use serde_json::Value;

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
    pub details_sidebar_visible: bool,
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
    let right_panel = render_dashboard_right_panel(input, header.len(), footer_lines.len() + 1);

    compose_screen_frame(&ScreenFrameInput {
        cols: input.cols,
        rows: input.rows,
        header: &header,
        content: &content,
        footer_lines: &footer_lines,
        focus_line,
        scroll_offset: input.scroll_offset,
        two_pane: right_panel.is_some(),
        right_panel: right_panel.as_deref(),
    })
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
}

pub fn render_dashboard_subscreen_frame(
    input: &DashboardSubscreenRenderInput<'_>,
) -> ScreenFrameResult {
    let content_width = screen_content_width(input.cols);
    let title = format!(
        "{} — {}  {}",
        style("aimux", Tone::Strong),
        input.screen.as_str(),
        style("● native", Tone::Done)
    );
    let header = vec![
        String::new(),
        truncate_ansi(&center(&title, content_width), input.cols),
        "─".repeat(input.cols),
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
            render_graveyard_content(input.resource, input.selected_index)
        }
    };
    if let Some(error) = input.error {
        content.insert(0, format!("  {}", style(error, Tone::Danger)));
        content.insert(1, String::new());
    }
    let footer =
        vec![input.footer_message.map(str::to_owned).unwrap_or_else(|| {
            "[d/Esc] dashboard  [c/p/L/t/g] screens  [?] help  [q] quit".into()
        })];
    let right_panel = if input.details_sidebar_visible {
        input
            .resource
            .map(|resource| render_resource_details(resource, 28))
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
        two_pane: right_panel.is_some(),
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

fn render_coordination_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(resource) = resource else {
        return loading_lines("coordination");
    };
    let items = array_at(resource, &["worklist"]);
    let mut lines = vec![format!(
        "  {} {}",
        style("Coordination", Tone::Strong),
        style(&format!("({} items)", items.len()), Tone::Muted)
    )];
    if items.is_empty() {
        lines.push("    Nothing needs you.".into());
        return lines;
    }
    for (index, item) in items.iter().take(30).enumerate() {
        let selected = index == selected_index;
        let title = string_at(item, &["title"]).unwrap_or("untitled");
        let kind = string_at(item, &["kind"]).unwrap_or("item");
        let bucket = string_at(item, &["bucket"]).unwrap_or("");
        lines.push(format!(
            "{} {} {} {} {}",
            selector(selected),
            style(&format!("[{}]", index + 1), Tone::Muted),
            style(kind, Tone::Work),
            truncate_plain(title, 52),
            style(bucket, Tone::Muted),
        ));
    }
    lines
}

fn render_project_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(project) = resource.and_then(|resource| resource.get("project")) else {
        return loading_lines("project");
    };
    let summary = project.get("summary").unwrap_or(&Value::Null);
    let progress = project.get("progress").unwrap_or(&Value::Null);
    let story = array_at(project, &["story"]);
    let mut lines = vec![
        format!("  {}", style("Project", Tone::Strong)),
        format!(
            "    agents {} running · {} waiting · {} offline",
            number_at(summary, &["agentsRunning"]),
            number_at(summary, &["agentsWaiting"]),
            number_at(summary, &["agentsOffline"]),
        ),
        format!(
            "    services {} · worktrees {} · unread {}",
            number_at(summary, &["services"]),
            number_at(summary, &["worktrees"]),
            number_at(summary, &["unreadNotifications"]),
        ),
        format!(
            "    tasks {} open · {} done · {} blocked",
            number_at(summary, &["openTasks"]),
            number_at(summary, &["doneTasks"]),
            number_at(progress, &["blocked"]),
        ),
        String::new(),
    ];
    if story.is_empty() {
        lines.push("    No project story yet.".into());
    } else {
        lines.push(format!("  {}", style("Story", Tone::Strong)));
        for (index, item) in story.iter().take(30).enumerate() {
            let selected = index == selected_index;
            let kind = string_at(item, &["kind"]).unwrap_or("item");
            let title = string_at(item, &["title"]).unwrap_or("untitled");
            let meta = string_at(item, &["meta"]).unwrap_or("");
            lines.push(format!(
                "{} {} {} {} {}",
                selector(selected),
                style(&format!("[{}]", index + 1), Tone::Muted),
                style(kind, Tone::Work),
                truncate_plain(title, 52),
                style(meta, Tone::Muted),
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
    let mut lines = vec![format!(
        "  {} {}",
        style("Library", Tone::Strong),
        style(&format!("({} entries)", entries.len()), Tone::Muted)
    )];
    if entries.is_empty() {
        lines.push("    No documents or plans.".into());
        return lines;
    }
    for (index, entry) in entries.iter().take(30).enumerate() {
        let selected = index == selected_index;
        let kind = string_at(entry, &["kind"]).unwrap_or("doc");
        let title = string_at(entry, &["title"]).unwrap_or("untitled");
        let path = string_at(entry, &["path"]).unwrap_or("");
        lines.push(format!(
            "{} {} {} {} {}",
            selector(selected),
            style(&format!("[{}]", index + 1), Tone::Muted),
            style(kind, Tone::Work),
            truncate_plain(title, 42),
            style(path, Tone::Muted),
        ));
    }
    lines
}

fn render_topology_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(topology) = resource.and_then(|resource| resource.get("topology")) else {
        return loading_lines("topology");
    };
    let counts = topology.get("counts").unwrap_or(&Value::Null);
    let rows = array_at(topology, &["rows"]);
    let mut lines = vec![
        format!(
            "  {} {}",
            style(
                string_at(topology, &["projectName"]).unwrap_or("project"),
                Tone::Strong
            ),
            style(
                string_at(topology, &["health"]).unwrap_or("idle"),
                Tone::Muted
            )
        ),
        format!(
            "    {} worktrees · {} agents · {} services",
            number_at(counts, &["worktrees"]),
            number_at(counts, &["agents"]),
            number_at(counts, &["services"]),
        ),
        String::new(),
    ];
    for (index, row) in rows.iter().take(40).enumerate() {
        let selected = index == selected_index;
        let depth = number_at(row, &["depth"]) as usize;
        let label = string_at(row, &["label"]).unwrap_or("");
        let kind = string_at(row, &["kind"]).unwrap_or("");
        let health = string_at(row, &["health"]).unwrap_or("");
        lines.push(format!(
            "{}{}{} {} {}",
            selector(selected),
            "  ".repeat(depth),
            style(&format!("[{}]", index + 1), Tone::Muted),
            truncate_plain(label, 48),
            style(&format!("{kind} {health}"), Tone::Muted),
        ));
    }
    lines
}

fn render_graveyard_content(resource: Option<&Value>, selected_index: usize) -> Vec<String> {
    let Some(resource) = resource else {
        return loading_lines("graveyard");
    };
    let rows = array_at(resource, &["viewModel", "rows"]);
    let mut lines = vec![format!(
        "  {} {}",
        style("Graveyard", Tone::Strong),
        style(&format!("({} rows)", rows.len()), Tone::Muted)
    )];
    if rows.is_empty() {
        lines.push("    No graveyarded agents or worktrees.".into());
        return lines;
    }
    for (index, row) in rows.iter().take(40).enumerate() {
        let action_index = row.get("actionIndex").and_then(Value::as_u64);
        let selected = action_index == Some(selected_index as u64);
        let number = row
            .get("actionNumber")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| (index + 1).to_string());
        let kind = string_at(row, &["kind"]).unwrap_or("entry");
        let label = string_at(row, &["label"])
            .or_else(|| string_at(row, &["entry", "label"]))
            .or_else(|| string_at(row, &["entry", "id"]))
            .or_else(|| string_at(row, &["entry", "path"]))
            .unwrap_or("");
        lines.push(format!(
            "{} {} {} {}",
            selector(selected),
            style(&format!("[{number}]"), Tone::Muted),
            style(kind, Tone::Work),
            truncate_plain(label, 64),
        ));
    }
    lines
}

fn selector(selected: bool) -> String {
    if selected {
        format!("  {}", style("▸", Tone::Accent))
    } else {
        "   ".into()
    }
}

fn loading_lines(screen: &str) -> Vec<String> {
    vec![format!(
        "  {}",
        style(&format!("Loading {screen}..."), Tone::Muted)
    )]
}

fn render_resource_details(resource: &Value, height: usize) -> Vec<String> {
    let mut lines = serde_json::to_string_pretty(resource)
        .unwrap_or_default()
        .lines()
        .flat_map(|line| wrap_text(line, 40))
        .take(height)
        .collect::<Vec<_>>();
    while lines.len() < height {
        lines.push(String::new());
    }
    lines
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

fn number_at(value: &Value, path: &[&str]) -> i64 {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_i64().unwrap_or(0)
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

fn render_dashboard_right_panel(
    input: &DashboardRenderInput<'_>,
    header_len: usize,
    footer_len: usize,
) -> Option<Vec<String>> {
    if !input.details_sidebar_visible {
        return None;
    }
    let content_width = screen_content_width(input.cols);
    let separator_width = 3;
    let right_width = 20.max(
        content_width
            .saturating_sub(screen_left_width(input.cols))
            .saturating_sub(separator_width)
            .saturating_sub(1),
    );
    let panel_height = 1.max(input.rows.saturating_sub(header_len + footer_len));
    if let Some(session) = selected_session(input) {
        let session_value = serde_json::to_value(session).ok()?;
        return Some(render_session_details(
            Some(&session_value),
            right_width,
            panel_height,
        ));
    }
    selected_worktree(input)
        .map(|worktree| render_worktree_details(worktree, right_width, panel_height))
}

fn selected_worktree<'a>(input: &DashboardRenderInput<'a>) -> Option<&'a WorktreeGroup> {
    input
        .snapshot
        .focused_worktree(input.focused_worktree_path)
        .or_else(|| input.snapshot.worktree_groups.first())
}

fn render_worktree_details(worktree: &WorktreeGroup, width: usize, height: usize) -> Vec<String> {
    let mut lines = vec![style("Details", Tone::Strong), String::new()];
    push_detail_line(&mut lines, "Worktree", &worktree.name, width);
    if !worktree.branch.is_empty() {
        push_detail_line(&mut lines, "Branch", &worktree.branch, width);
    }
    if let Some(path) = worktree.path.as_deref() {
        push_detail_line(&mut lines, "Path", path, width);
    }
    push_detail_line(
        &mut lines,
        "Status",
        worktree_status_label(&worktree.status),
        width,
    );
    push_detail_line(
        &mut lines,
        "Agents",
        &worktree.sessions.len().to_string(),
        width,
    );
    push_detail_line(
        &mut lines,
        "Services",
        &worktree.services.len().to_string(),
        width,
    );
    if let Some(action) = worktree.pending_action.as_deref() {
        push_detail_line(&mut lines, "Pending", action, width);
    } else if worktree.pending {
        push_detail_line(&mut lines, "Pending", "yes", width);
    }
    lines
        .into_iter()
        .take(height)
        .map(|line| truncate_ansi(&line, width))
        .collect()
}

fn push_detail_line(lines: &mut Vec<String>, label: &str, value: &str, width: usize) {
    let text = format!("{}: {}", style(label, Tone::Muted), value);
    lines.extend(
        wrap_text(&text, width)
            .into_iter()
            .map(|line| format!("  {line}")),
    );
}

fn worktree_status_label(status: &WorktreeStatus) -> &'static str {
    match status {
        WorktreeStatus::Active => "active",
        WorktreeStatus::Offline => "offline",
    }
}

fn selected_session<'a>(
    input: &DashboardRenderInput<'a>,
) -> Option<&'a crate::dashboard_model::DashboardSession> {
    let session_id = input.selected_session_id?;
    input
        .snapshot
        .sessions
        .iter()
        .chain(
            input
                .snapshot
                .worktree_groups
                .iter()
                .flat_map(|group| group.sessions.iter()),
        )
        .find(|session| session.id == session_id)
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
