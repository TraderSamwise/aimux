use crate::dashboard_model::{DashboardService, DashboardSession};
use crate::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput};
use crate::tui_render::theme::{KeyTone, Tone, footer_key, style, visible_width};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FooterHint<'a> {
    key: &'a str,
    label: &'a str,
    danger: bool,
}

pub(super) fn render_dashboard_footer(input: &DashboardRenderInput<'_>) -> Vec<String> {
    render_footer_hints(
        &build_dashboard_footer_hints(input),
        input.cols.saturating_sub(2),
    )
}

fn build_dashboard_footer_hints<'a>(input: &'a DashboardRenderInput<'_>) -> Vec<FooterHint<'a>> {
    if let Some(message) = input.footer_message {
        return vec![FooterHint {
            key: "!",
            label: message,
            danger: true,
        }];
    }
    let selected_session = selected_session(input);
    let selected_service = selected_service(input);
    let enter_label = dashboard_enter_verb(selected_session, selected_service);
    let kill_label = if selected_service.is_some() {
        Some("stop")
    } else if selected_session
        .map(|session| session.status == crate::dashboard_model::SessionStatus::Offline)
        == Some(true)
    {
        Some("kill")
    } else if selected_session.is_some() {
        Some("stop")
    } else {
        None
    };
    let system = [
        FooterHint {
            key: "?",
            label: "help",
            danger: false,
        },
        FooterHint {
            key: "q",
            label: "quit",
            danger: false,
        },
    ];
    let mut hints = Vec::new();
    if !input.snapshot.worktree_groups.is_empty() && input.nav_level == DashboardNavLevel::Worktrees
    {
        hints.extend([
            FooterHint {
                key: "\u{2191}\u{2193}/jk",
                label: "worktrees",
                danger: false,
            },
            FooterHint {
                key: "1-9",
                label: "worktree",
                danger: false,
            },
            FooterHint {
                key: "1-9",
                label: "worktree",
                danger: false,
            },
            FooterHint {
                key: "Enter/\u{2192}/l",
                label: "step in",
                danger: false,
            },
            FooterHint {
                key: "n",
                label: "agent",
                danger: false,
            },
            FooterHint {
                key: "v",
                label: "service",
                danger: false,
            },
            FooterHint {
                key: "f",
                label: "fork",
                danger: false,
            },
        ]);
        append_operation_failure_hint(input, &mut hints);
        hints.extend(system);
        return hints;
    }
    if !input.snapshot.sessions.is_empty() || !input.snapshot.worktree_groups.is_empty() {
        hints.extend([
            FooterHint {
                key: "\u{2191}\u{2193}/jk",
                label: if input.snapshot.worktree_groups.is_empty() {
                    "select"
                } else {
                    "items"
                },
                danger: false,
            },
            FooterHint {
                key: "Enter/\u{2192}/l",
                label: enter_label,
                danger: false,
            },
            FooterHint {
                key: "Esc/h",
                label: "back",
                danger: false,
            },
            FooterHint {
                key: "n",
                label: "agent",
                danger: false,
            },
            FooterHint {
                key: "v",
                label: "service",
                danger: false,
            },
            FooterHint {
                key: "f",
                label: "fork",
                danger: false,
            },
            FooterHint {
                key: "S",
                label: "switch",
                danger: false,
            },
            FooterHint {
                key: "o",
                label: "options",
                danger: false,
            },
        ]);
        if input.nav_level == DashboardNavLevel::Sessions
            && !input.snapshot.worktree_groups.is_empty()
        {
            hints.insert(
                1,
                FooterHint {
                    key: "1-9",
                    label: "entry",
                    danger: false,
                },
            );
        }
        append_operation_failure_hint(input, &mut hints);
        if let Some(label) = kill_label {
            hints.push(FooterHint {
                key: "x",
                label,
                danger: true,
            });
        }
        hints.extend(system);
        return hints;
    }
    hints.extend([
        FooterHint {
            key: "n",
            label: "agent",
            danger: false,
        },
        FooterHint {
            key: "v",
            label: "service",
            danger: false,
        },
        FooterHint {
            key: "f",
            label: "fork",
            danger: false,
        },
    ]);
    append_operation_failure_hint(input, &mut hints);
    hints.extend(system);
    hints
}

fn render_footer_hints(hints: &[FooterHint<'_>], width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for hint in hints {
        let token = format!(
            "{} {}",
            footer_key(hint.key, hint.danger.then_some(KeyTone::Danger)),
            style(hint.label, Tone::Muted)
        );
        let candidate = if line.is_empty() {
            token.clone()
        } else {
            format!("{line}  {token}")
        };
        if line.is_empty() || visible_width(&candidate) <= width {
            line = candidate;
        } else {
            lines.push(line);
            line = token;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn append_operation_failure_hint<'a>(
    input: &'a DashboardRenderInput<'_>,
    hints: &mut Vec<FooterHint<'a>>,
) {
    if !input.snapshot.operation_failures.is_empty() {
        hints.push(FooterHint {
            key: "X",
            label: "clear failures",
            danger: false,
        });
    }
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
    match session.status {
        crate::dashboard_model::SessionStatus::Offline
        | crate::dashboard_model::SessionStatus::Exited => {
            if session
                .extra
                .get("restoreState")
                .and_then(serde_json::Value::as_str)
                == Some("blocked")
            {
                "unavailable"
            } else {
                "resume"
            }
        }
        _ => "focus",
    }
}

fn selected_session<'a>(input: &'a DashboardRenderInput<'_>) -> Option<&'a DashboardSession> {
    let selected_id = input.selected_session_id?;
    input
        .snapshot
        .sessions
        .iter()
        .find(|session| session.id == selected_id)
}

fn selected_service<'a>(input: &'a DashboardRenderInput<'_>) -> Option<&'a DashboardService> {
    let selected_id = input.selected_service_id?;
    input
        .snapshot
        .services
        .iter()
        .find(|service| service.id == selected_id)
}
