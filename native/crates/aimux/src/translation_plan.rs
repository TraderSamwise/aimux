use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhaseStatus {
    Planned,
    InProgress,
    Complete,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RewritePhase {
    pub id: &'static str,
    pub status: PhaseStatus,
    pub objective: &'static str,
    pub acceptance: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RewriteStatus {
    pub version: u32,
    pub strategy: &'static str,
    pub end_state: &'static str,
    pub progress_estimate_percent: u8,
    pub active_slice: &'static str,
    pub checkpoints: &'static [&'static str],
    pub phases: &'static [RewritePhase],
}

const PHASES: &[RewritePhase] = &[
    RewritePhase {
        id: "phase-0",
        status: PhaseStatus::Complete,
        objective: "Create native workspace, parity contract manifest, and progress tracking.",
        acceptance: &[
            "cargo fmt",
            "cargo test",
            "native aimux rewrite status --json",
        ],
    },
    RewritePhase {
        id: "phase-1",
        status: PhaseStatus::InProgress,
        objective: "Port pure contracts and data models line-for-line enough to drive golden fixtures.",
        acceptance: &[
            "contract fixture generator runs",
            "Rust models serialize to TypeScript-compatible JSON",
        ],
    },
    RewritePhase {
        id: "phase-2",
        status: PhaseStatus::InProgress,
        objective: "Port CLI/core command text and JSON behavior.",
        acceptance: &["CLI stdout, stderr, and exit codes match"],
    },
    RewritePhase {
        id: "phase-3",
        status: PhaseStatus::InProgress,
        objective: "Port project-service HTTP and SSE behavior.",
        acceptance: &["project API route and SSE fixtures match"],
    },
    RewritePhase {
        id: "phase-4",
        status: PhaseStatus::Planned,
        objective: "Port tmux runtime manager behavior before changing tmux architecture.",
        acceptance: &[
            "tmux runtime fixtures pass",
            "live tmux inventory diff matches TypeScript",
        ],
    },
    RewritePhase {
        id: "phase-5",
        status: PhaseStatus::InProgress,
        objective: "Port output capture, ANSI parsing, transcript reconciliation, and preview behavior.",
        acceptance: &[
            "adversarial ANSI fixtures pass",
            "capture preview output matches TypeScript",
        ],
    },
    RewritePhase {
        id: "phase-6",
        status: PhaseStatus::InProgress,
        objective: "Port runtime exchange mutations, tasks, handoffs, threads, reviews, and stores.",
        acceptance: &[
            "store round-trip fixtures pass",
            "CLI task/thread commands match",
        ],
    },
    RewritePhase {
        id: "phase-7",
        status: PhaseStatus::InProgress,
        objective: "Port dashboard TUI and app/relay integration parity.",
        acceptance: &[
            "desktop-state golden fixtures match",
            "dashboard model and route fixtures match",
        ],
    },
    RewritePhase {
        id: "phase-8",
        status: PhaseStatus::Planned,
        objective: "Cut over native release/install path and retire replaced TypeScript.",
        acceptance: &[
            "normal installed CLI starts no Node process",
            "TypeScript hot path removed",
        ],
    },
];

pub fn rewrite_status() -> RewriteStatus {
    RewriteStatus {
        version: 2,
        strategy: "translation first: preserve functional behavior, function logic, loops, and data shapes; split large TypeScript monoliths into smaller Rust modules when the split does not change behavior.",
        end_state: "zero Node in the normal Aimux CLI, daemon, project-service, tmux runtime, and dashboard hot path",
        progress_estimate_percent: 18,
        active_slice: "normal root CLI/dashboard launches now stay native; runtime event and notification parity is being closed before the remaining CLI fallback families",
        checkpoints: &[
            "native CLI scaffold and rewrite status command",
            "project API contract constants and mutation invalidation mapping",
            "project-service router claims declared routes without 501 fallback",
            "runtime event route derives activity, attention, event history, notifications, and focused unread suppression",
            "dashboard desktop-state model, renderer, navigation, action planning, input loop, focus sync, and process selection",
            "root dashboard, configured tool launch, and root resume entrypoints avoid the Node launcher fallback",
            "native dashboard is the default project dashboard launcher, with an explicit Node renderer escape hatch",
            "output capture/projection cache and expose preview attachment slices",
        ],
        phases: PHASES,
    }
}
