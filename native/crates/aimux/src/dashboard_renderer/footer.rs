use crate::dashboard_model::{DashboardService, DashboardSession};
use crate::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput};
use crate::tui_render::theme::{KeyTone, Tone, footer_key, style, visible_width};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FooterHint<'a> {
    key: &'a str,
    label: &'a str,
    danger: bool,
}

pub(super) fn render_dashboard_footer(input: &DashboardRenderInput<'_>) -> Vec<String> {
    render_footer_hints(
        &build_dashboard_footer_hints(input, "output"),
        input.cols.saturating_sub(2),
    )
}

pub(super) fn dashboard_footer_hint_values_for_contract(
    input: &DashboardRenderInput<'_>,
    preview_source: &str,
) -> Value {
    Value::Array(
        build_dashboard_footer_hints(input, preview_source)
            .into_iter()
            .map(|hint| {
                if hint.danger {
                    json!([hint.key, hint.label, "danger"])
                } else {
                    json!([hint.key, hint.label])
                }
            })
            .collect(),
    )
}

fn build_dashboard_footer_hints<'a>(
    input: &'a DashboardRenderInput<'_>,
    preview_source: &'a str,
) -> Vec<FooterHint<'a>> {
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
    let has_worktrees = !input.snapshot.worktree_groups.is_empty();
    let has_live_scribe = has_live_scribe(input);
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
    let scribe_preview_label = if preview_source == "scribe" {
        "preview output"
    } else {
        "preview scribe"
    };
    let mut scribe_controls = vec![FooterHint {
        key: "P",
        label: "scribe",
        danger: false,
    }];
    if has_live_scribe {
        scribe_controls.push(FooterHint {
            key: "V",
            label: scribe_preview_label,
            danger: false,
        });
    }
    let talk = [
        FooterHint {
            key: "s",
            label: "msg",
            danger: false,
        },
        FooterHint {
            key: "H",
            label: "handoff",
            danger: false,
        },
        FooterHint {
            key: "T",
            label: "task",
            danger: false,
        },
        FooterHint {
            key: "o",
            label: "thread",
            danger: false,
        },
        FooterHint {
            key: "O",
            label: "overseer",
            danger: false,
        },
    ];
    let mut hints = Vec::new();
    if has_worktrees && input.nav_level == DashboardNavLevel::Worktrees {
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
                key: "Enter/\u{2192}/l",
                label: "step in",
                danger: false,
            },
            FooterHint {
                key: "Tab",
                label: "details",
                danger: false,
            },
        ]);
        hints.extend(scribe_controls);
        hints.extend([
            FooterHint {
                key: "u",
                label: "attention",
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
                key: "D",
                label: "cache cleanup",
                danger: false,
            },
            FooterHint {
                key: "w",
                label: "worktree",
                danger: false,
            },
        ]);
        append_visibility_hint(input, &mut hints);
        append_operation_failure_hint(input, &mut hints);
        hints.extend(system);
        return hints;
    }
    if !input.snapshot.sessions.is_empty() || has_worktrees {
        hints.extend([
            FooterHint {
                key: "\u{2191}\u{2193}/jk",
                label: if has_worktrees { "items" } else { "select" },
                danger: false,
            },
            FooterHint {
                key: "Enter/\u{2192}/l",
                label: enter_label,
                danger: false,
            },
            FooterHint {
                key: "Tab",
                label: "details",
                danger: false,
            },
            FooterHint {
                key: "u",
                label: "attention",
                danger: false,
            },
        ]);
        if has_worktrees {
            hints.extend([
                FooterHint {
                    key: "Esc/h",
                    label: "back",
                    danger: false,
                },
                FooterHint {
                    key: "\u{21e7}\u{2191}\u{2193}",
                    label: "reorder",
                    danger: false,
                },
            ]);
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
            FooterHint {
                key: "S",
                label: "switch",
                danger: false,
            },
            FooterHint {
                key: "D",
                label: "cache cleanup",
                danger: false,
            },
        ]);
        if !has_worktrees {
            hints.push(FooterHint {
                key: "w",
                label: "worktree",
                danger: false,
            });
        }
        append_visibility_hint(input, &mut hints);
        append_operation_failure_hint(input, &mut hints);
        hints.extend(talk);
        hints.extend(scribe_controls);
        hints.push(FooterHint {
            key: "R",
            label: "reply",
            danger: false,
        });
        if selected_session.is_some() && selected_session_has_teammates(input, selected_session) {
            hints.push(FooterHint {
                key: "e",
                label: "team",
                danger: false,
            });
        }
        if has_worktrees {
            hints.push(FooterHint {
                key: "m",
                label: "migrate",
                danger: false,
            });
            if selected_session.is_some() {
                hints.push(FooterHint {
                    key: "r",
                    label: "name",
                    danger: false,
                });
            }
        }
        if input.nav_level == DashboardNavLevel::Sessions && has_worktrees {
            hints.insert(
                1,
                FooterHint {
                    key: "1-9",
                    label: "entry",
                    danger: false,
                },
            );
        }
        if let Some(label) = kill_label {
            hints.push(FooterHint {
                key: "x",
                label,
                danger: true,
            });
        }
        if !has_worktrees && selected_session.is_some() {
            hints.push(FooterHint {
                key: "r",
                label: "name",
                danger: false,
            });
        }
        hints.extend(system);
        return hints;
    }
    hints.extend([
        FooterHint {
            key: "Tab",
            label: "details",
            danger: false,
        },
        FooterHint {
            key: "u",
            label: "attention",
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
            key: "D",
            label: "cache cleanup",
            danger: false,
        },
    ]);
    append_visibility_hint(input, &mut hints);
    append_operation_failure_hint(input, &mut hints);
    hints.extend(talk);
    hints.extend(scribe_controls);
    hints.push(FooterHint {
        key: "R",
        label: "reply",
        danger: false,
    });
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

fn append_visibility_hint<'a>(
    input: &'a DashboardRenderInput<'_>,
    hints: &mut Vec<FooterHint<'a>>,
) {
    hints.push(FooterHint {
        key: "a",
        label: if input.hide_offline_agents {
            "show offline"
        } else {
            "hide offline"
        },
        danger: false,
    });
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

fn has_live_scribe(input: &DashboardRenderInput<'_>) -> bool {
    input.snapshot.sessions.iter().any(|session| {
        session.scribe == Some(true)
            && !matches!(
                session.status,
                crate::dashboard_model::SessionStatus::Offline
                    | crate::dashboard_model::SessionStatus::Exited
            )
    })
}

fn selected_session_has_teammates(
    input: &DashboardRenderInput<'_>,
    selected_session: Option<&DashboardSession>,
) -> bool {
    let Some(selected_session) = selected_session else {
        return false;
    };
    input.snapshot.teammates.iter().any(|session| {
        session
            .team
            .as_ref()
            .is_some_and(|team| team.parent_session_id == selected_session.id)
    })
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
