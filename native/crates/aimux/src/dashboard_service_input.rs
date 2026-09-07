use crate::dashboard_controller::{
    DashboardOrchestrationInputState, DashboardOrchestrationMode,
    DashboardOrchestrationRoutePickerState,
};
use crate::dashboard_create::{
    DashboardCreateIntent, DashboardCreatePlan, DashboardServiceCreateIntent, plan_dashboard_create,
};
use crate::dashboard_model::{DashboardSession, WorktreeGroup};
use crate::tui_render::theme::{Tone, footer_hints, keycap, keycap_hints, style};
use crate::tui_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DashboardServiceInputState {
    pub buffer: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DashboardThreadReplyState {
    pub thread_id: String,
    pub title: String,
    pub targets: Vec<String>,
    pub buffer: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardServiceInputEffect {
    Render,
    Close,
    Create(DashboardCreatePlan),
}

impl DashboardServiceInputState {
    pub fn handle_printable(&mut self, character: char) -> DashboardServiceInputEffect {
        self.buffer.push(character);
        DashboardServiceInputEffect::Render
    }

    pub fn handle_backspace(&mut self) -> DashboardServiceInputEffect {
        self.buffer.pop();
        DashboardServiceInputEffect::Render
    }

    pub fn create(&self, worktree_path: Option<&str>) -> DashboardServiceInputEffect {
        DashboardServiceInputEffect::Create(plan_dashboard_create(&DashboardCreateIntent::Service(
            DashboardServiceCreateIntent {
                command: Some(self.buffer.clone()),
                service_id: None,
                worktree_path: worktree_path.map(str::to_owned),
            },
        )))
    }
}

pub fn render_service_input_overlay(
    state: &DashboardServiceInputState,
    cols: usize,
    rows: usize,
) -> String {
    let body = vec![
        format!("  {} {}_", style("Command:", Tone::Muted), state.buffer),
        String::new(),
        format!(
            "  {}",
            style("Empty command opens an interactive shell", Tone::Muted)
        ),
        String::new(),
        footer_hints("[Enter] create  [Esc] cancel"),
    ];
    render_overlay_box(&OverlayBoxSpec {
        title: "Create service",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn render_worktree_input_overlay(buffer: &str, cols: usize, rows: usize) -> String {
    let body = vec![
        format!("  {} {}_", style("Name:", Tone::Muted), buffer),
        String::new(),
        footer_hints("[Enter] create  [Esc] cancel"),
    ];
    render_overlay_box(&OverlayBoxSpec {
        title: "Create worktree",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn render_worktree_remove_confirm_overlay(
    name: &str,
    path: &str,
    cols: usize,
    rows: usize,
) -> String {
    let body = vec![
        format!("  {}", style(&format!("\"{name}\""), Tone::Strong)),
        format!("  {} {path}", style("Path:", Tone::Muted)),
        format!(
            "  {}",
            style(
                "Offlines attached agents and moves the checkout to the graveyard.",
                Tone::Muted,
            )
        ),
        String::new(),
        footer_hints("[Enter/y] yes  [n/Esc] cancel"),
    ];
    render_overlay_box(&OverlayBoxSpec {
        title: "Graveyard worktree",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Red,
        icon: None,
    })
}

pub fn render_worktree_list_overlay(
    worktrees: &[WorktreeGroup],
    cols: usize,
    rows: usize,
) -> String {
    let mut body = Vec::new();
    if worktrees.is_empty() {
        body.push(format!("  {}", style("No worktrees found.", Tone::Muted)));
    } else {
        for worktree in worktrees {
            let main = if worktree.path.is_none() {
                format!(" {}", style("(main)", Tone::Muted))
            } else {
                String::new()
            };
            body.push(format!(
                "  {} {}{}",
                style(&worktree.name, Tone::Strong),
                style(&format!("({})", worktree.branch), Tone::Muted),
                main
            ));
        }
    }
    body.push(String::new());
    body.push(footer_hints("[Esc] back"));
    render_overlay_box(&OverlayBoxSpec {
        title: "Worktree Management",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn render_worktree_cache_cleanup_confirm_overlay(
    result: &serde_json::Value,
    cols: usize,
    rows: usize,
) -> String {
    let target_count = result
        .get("plan")
        .and_then(|plan| plan.get("targets"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let body = if target_count == 0 {
        vec![
            format!(
                "  {}",
                style("No inactive generated worktree caches found.", Tone::Muted)
            ),
            String::new(),
            footer_hints("[Enter] dismiss  [Esc] back"),
        ]
    } else {
        let mut body = worktree_cache_cleanup_lines(result)
            .into_iter()
            .map(|line| format!("  {}", style(&line, Tone::Muted)))
            .collect::<Vec<_>>();
        let reclaimable = result
            .get("plan")
            .and_then(|plan| plan.get("reclaimableBytes"))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        body.push(String::new());
        body.push(format!(
            "  {}",
            style(
                &format!(
                    "This removes {} from inactive worktrees.",
                    format_worktree_cache_bytes(reclaimable)
                ),
                Tone::Muted,
            )
        ));
        body.push(String::new());
        body.push(footer_hints("[Enter/y] remove  [n/Esc] cancel"));
        body
    };
    render_overlay_box(&OverlayBoxSpec {
        title: "Worktree Cache Cleanup",
        body: &body,
        cols,
        rows,
        variant: if target_count > 0 {
            OverlayVariant::Red
        } else {
            OverlayVariant::Blue
        },
        icon: None,
    })
}

pub fn render_orchestration_route_picker_overlay(
    state: &DashboardOrchestrationRoutePickerState,
    cols: usize,
    rows: usize,
) -> String {
    let visible_count = state.options.len().min(9);
    let mut body = state
        .options
        .iter()
        .take(visible_count)
        .enumerate()
        .map(|(index, target)| {
            format!(
                "  {} {}",
                keycap(&(index + 1).to_string(), None),
                target.label
            )
        })
        .collect::<Vec<_>>();
    if state.options.len() > visible_count {
        body.push(format!("  {}", style("...", Tone::Muted)));
    }
    body.push(String::new());
    body.push(format!("  {}", keycap_hints("[Esc] cancel")));
    render_overlay_box(&OverlayBoxSpec {
        title: &format!("{}: choose target", state.mode.title()),
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn render_orchestration_input_overlay(
    state: &DashboardOrchestrationInputState,
    cols: usize,
    rows: usize,
) -> String {
    let mut body = vec![format!(
        "  {} {}",
        style("To:", Tone::Muted),
        &state.target.label
    )];
    if let Some(worktree_path) = state.target.worktree_path.as_ref() {
        body.push(format!(
            "  {} {worktree_path}",
            style("Worktree:", Tone::Muted)
        ));
    }
    let recipient_count = if state.target.session_id.is_some() {
        1
    } else {
        state.target.recipient_ids.len()
    };
    if state.target.session_id.is_none() && recipient_count > 0 {
        if matches!(state.mode, DashboardOrchestrationMode::Task) {
            body.push(format!(
                "  {} best match from {recipient_count} live agent{}",
                style("Route:", Tone::Muted),
                if recipient_count == 1 { "" } else { "s" }
            ));
        } else {
            let preview = if state.target.recipient_ids.is_empty() {
                String::new()
            } else {
                format!(
                    " ({})",
                    state
                        .target
                        .recipient_ids
                        .iter()
                        .take(3)
                        .cloned()
                        .chain((state.target.recipient_ids.len() > 3).then(|| "...".to_owned()))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            body.push(format!(
                "  {} {recipient_count} live agent{}{preview}",
                style("Recipients:", Tone::Muted),
                if recipient_count == 1 { "" } else { "s" },
            ));
        }
    }
    body.push(format!(
        "  {} {}_",
        style("Text:", Tone::Muted),
        state.buffer
    ));
    body.push(String::new());
    body.push(format!(
        "  {}",
        keycap_hints(&format!(
            "[Enter] {}  [Esc] cancel",
            state.mode.action_label()
        ))
    ));
    render_overlay_box(&OverlayBoxSpec {
        title: state.mode.title(),
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn render_thread_reply_overlay(
    state: &DashboardThreadReplyState,
    cols: usize,
    rows: usize,
) -> String {
    let targets = if state.targets.is_empty() {
        "participants".into()
    } else {
        state.targets.join(", ")
    };
    let body = vec![
        format!(
            "  {} {}",
            style("Thread:", Tone::Muted),
            style(&state.title, Tone::Strong)
        ),
        format!("  {} {targets}", style("To:", Tone::Muted)),
        String::new(),
        format!("  {} {}_", style("Message:", Tone::Muted), state.buffer),
        String::new(),
        footer_hints("[Enter] send  [Esc] cancel"),
    ];
    render_overlay_box(&OverlayBoxSpec {
        title: "Reply in thread",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

pub fn format_worktree_cache_bytes(bytes: f64) -> String {
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

fn worktree_cache_cleanup_lines(result: &serde_json::Value) -> Vec<String> {
    let targets = result
        .get("plan")
        .and_then(|plan| plan.get("targets"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reclaimable = result
        .get("plan")
        .and_then(|plan| plan.get("reclaimableBytes"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let failed = result
        .get("results")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("status").and_then(serde_json::Value::as_str) == Some("failed"))
        .count();
    let mut lines = vec![format!(
        "Worktree cache cleanup would remove {} item(s), {}; {failed} failed.",
        targets.len(),
        format_worktree_cache_bytes(reclaimable)
    )];
    if !targets.is_empty() {
        lines.push("Targets:".into());
        for target in targets.iter().take(8) {
            let size = target
                .get("sizeBytes")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let path = target
                .get("path")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            lines.push(format!("{:>7}  {path}", format_worktree_cache_bytes(size)));
        }
        if targets.len() > 8 {
            lines.push(format!("... {} more target(s) hidden.", targets.len() - 8));
        }
    }
    lines
}

pub fn render_teammate_picker_overlay(
    teammates: &[&DashboardSession],
    selected_index: usize,
    cols: usize,
    rows: usize,
) -> Option<String> {
    if teammates.is_empty() {
        return None;
    }
    let visible_count = teammates.len().min(usize::max(3, rows.saturating_sub(10)));
    let visible = &teammates[..visible_count];
    let selected_index = selected_index.min(visible.len().saturating_sub(1));
    let mut body = visible
        .iter()
        .enumerate()
        .map(|(index, teammate)| {
            let marker = if index == selected_index {
                style(">", Tone::Accent)
            } else {
                " ".into()
            };
            let number = if index < 9 {
                format!("[{}]", index + 1)
            } else {
                "   ".into()
            };
            let status = format!("{:?}", teammate.status).to_lowercase();
            let label = teammate_label(teammate);
            let summary = teammate.headline.as_deref().or_else(|| {
                teammate
                    .extra
                    .get("previewLine")
                    .and_then(serde_json::Value::as_str)
            });
            let suffix = summary
                .map(|summary| format!(" - {}", style(summary, Tone::Muted)))
                .unwrap_or_default();
            format!(
                "  {marker} {} {} {}{suffix}",
                style(&number, Tone::Muted),
                style(&label, Tone::Strong),
                style(&format!("- {status}"), Tone::Muted),
            )
        })
        .collect::<Vec<_>>();
    if teammates.len() > visible.len() {
        body.push(format!(
            "  {}",
            style(
                &format!("{} more", teammates.len() - visible.len()),
                Tone::Muted
            )
        ));
    }
    body.push(String::new());
    body.push(footer_hints(
        "[up/down] select  [1-9/Enter] open  [Esc] back",
    ));
    Some(render_overlay_box(&OverlayBoxSpec {
        title: "Team",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    }))
}

fn teammate_label(teammate: &DashboardSession) -> String {
    let label = teammate
        .team
        .as_ref()
        .and_then(|team| team.label.as_deref())
        .or(teammate.label.as_deref())
        .unwrap_or(teammate.command.as_str());
    if let Some(role) = teammate.team.as_ref().and_then(|team| team.role.as_deref()) {
        format!("{label} ({role})")
    } else {
        label.to_owned()
    }
}
