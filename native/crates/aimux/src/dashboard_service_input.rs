use crate::dashboard_create::{
    DashboardCreateIntent, DashboardCreatePlan, DashboardServiceCreateIntent, plan_dashboard_create,
};
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
