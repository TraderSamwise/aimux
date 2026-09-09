use serde_json::{Value, json};

use crate::tui_render::text::strip_ansi;
use crate::tui_render::theme::{Tone, style};

#[derive(Clone, Copy)]
struct Chip {
    kind: &'static str,
    label: &'static str,
}

pub fn agent_status_contract(input: &Value) -> Value {
    let rendered = render_agent_status_chip(input);
    json!({
        "chip": agent_status_chip(input),
        "rendered": rendered,
        "visibleText": strip_ansi(&rendered),
    })
}

fn agent_status_chip(input: &Value) -> Value {
    let chip = string_field(input, "userLabel")
        .and_then(user_label_chip)
        .or_else(|| string_field(input, "attention").and_then(attention_chip))
        .or_else(|| string_field(input, "activity").and_then(activity_chip));
    chip.map_or(Value::Null, |chip| {
        json!({
            "kind": chip.kind,
            "label": chip.label,
        })
    })
}

fn render_agent_status_chip(input: &Value) -> String {
    let Some(chip) = string_field(input, "userLabel")
        .and_then(user_label_chip)
        .or_else(|| string_field(input, "attention").and_then(attention_chip))
        .or_else(|| string_field(input, "activity").and_then(activity_chip))
    else {
        return String::new();
    };
    let tone = status_tone(chip.kind);
    format!("{} {}", status_dot(chip.kind), style(chip.label, tone))
}

fn user_label_chip(label: &str) -> Option<Chip> {
    Some(match label {
        "working" => Chip {
            kind: "working",
            label: "Working",
        },
        "ready" => Chip {
            kind: "ready",
            label: "Ready",
        },
        "needs_input" => Chip {
            kind: "needs",
            label: "Needs input",
        },
        "needs_response" => Chip {
            kind: "needs",
            label: "Needs reply",
        },
        "next_step" => Chip {
            kind: "needs",
            label: "Next step",
        },
        "blocked" => Chip {
            kind: "blocked",
            label: "Blocked",
        },
        "error" => Chip {
            kind: "error",
            label: "Error",
        },
        "idle" => Chip {
            kind: "idle",
            label: "Idle",
        },
        "offline" => Chip {
            kind: "offline",
            label: "Offline",
        },
        "done" => Chip {
            kind: "done",
            label: "Done",
        },
        "interrupted" => Chip {
            kind: "idle",
            label: "Interrupted",
        },
        "starting" => Chip {
            kind: "working",
            label: "Starting",
        },
        "stopping" => Chip {
            kind: "idle",
            label: "Stopping",
        },
        "graveyarding" => Chip {
            kind: "offline",
            label: "Removing",
        },
        _ => return None,
    })
}

fn attention_chip(attention: &str) -> Option<Chip> {
    Some(match attention {
        "error" => Chip {
            kind: "error",
            label: "Error",
        },
        "blocked" => Chip {
            kind: "blocked",
            label: "Blocked",
        },
        "needs_input" => Chip {
            kind: "needs",
            label: "Needs input",
        },
        "needs_response" => Chip {
            kind: "needs",
            label: "Needs reply",
        },
        _ => return None,
    })
}

fn activity_chip(activity: &str) -> Option<Chip> {
    Some(match activity {
        "running" => Chip {
            kind: "working",
            label: "Working",
        },
        "waiting" => Chip {
            kind: "needs",
            label: "Waiting",
        },
        "done" => Chip {
            kind: "done",
            label: "Done",
        },
        "idle" => Chip {
            kind: "idle",
            label: "Idle",
        },
        "error" => Chip {
            kind: "error",
            label: "Error",
        },
        "interrupted" => Chip {
            kind: "idle",
            label: "Interrupted",
        },
        _ => return None,
    })
}

fn status_dot(kind: &str) -> String {
    let glyph = match kind {
        "offline" => "○",
        "needs" => "◉",
        _ => "●",
    };
    style(glyph, status_tone(kind))
}

fn status_tone(kind: &str) -> Tone {
    match kind {
        "working" => Tone::Work,
        "needs" => Tone::Attention,
        "done" => Tone::Done,
        "error" => Tone::Danger,
        "blocked" => Tone::Blocked,
        "ready" => Tone::Ready,
        "idle" => Tone::Idle,
        "offline" => Tone::Muted,
        _ => Tone::Muted,
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
}
