use crate::dashboard_create::{
    DashboardCreateIntent, DashboardCreatePlan, DashboardServiceCreateIntent, plan_dashboard_create,
};
use crate::dashboard_model::WorktreeGroup;
use crate::tui_render::theme::{Tone, footer_hints, style};
use crate::tui_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DashboardServiceInputState {
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
