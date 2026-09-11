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

const REWRITE_COMPLETE_SLICE: &str = "all rewrite phases complete; normal CLI, daemon, project-service, tmux runtime, and dashboard paths are Rust-owned and Node-free";

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
        status: PhaseStatus::Complete,
        objective: "Port pure contracts and data models line-for-line enough to drive golden fixtures.",
        acceptance: &[
            "contract fixture generator runs",
            "Rust models serialize to TypeScript-compatible JSON",
        ],
    },
    RewritePhase {
        id: "phase-2",
        status: PhaseStatus::Complete,
        objective: "Port CLI/core command text and JSON behavior.",
        acceptance: &["CLI stdout, stderr, and exit codes match"],
    },
    RewritePhase {
        id: "phase-3",
        status: PhaseStatus::Complete,
        objective: "Port project-service HTTP and SSE behavior.",
        acceptance: &["project API route and SSE fixtures match"],
    },
    RewritePhase {
        id: "phase-4",
        status: PhaseStatus::Complete,
        objective: "Port tmux runtime manager behavior before changing tmux architecture.",
        acceptance: &[
            "tmux runtime fixtures pass",
            "live tmux inventory diff matches TypeScript",
        ],
    },
    RewritePhase {
        id: "phase-5",
        status: PhaseStatus::Complete,
        objective: "Port output capture, ANSI parsing, transcript reconciliation, and preview behavior.",
        acceptance: &[
            "adversarial ANSI fixtures pass",
            "capture preview output matches TypeScript",
        ],
    },
    RewritePhase {
        id: "phase-6",
        status: PhaseStatus::Complete,
        objective: "Port runtime exchange mutations, tasks, handoffs, threads, reviews, and stores.",
        acceptance: &[
            "store round-trip fixtures pass",
            "CLI task/thread commands match",
        ],
    },
    RewritePhase {
        id: "phase-7",
        status: PhaseStatus::Complete,
        objective: "Port dashboard TUI and app/relay integration parity.",
        acceptance: &[
            "desktop-state golden fixtures match",
            "dashboard model and route fixtures match",
        ],
    },
    RewritePhase {
        id: "phase-8",
        status: PhaseStatus::Complete,
        objective: "Cut over native release/install path and retire replaced TypeScript.",
        acceptance: &[
            "normal installed CLI starts no Node process",
            "TypeScript hot path removed",
        ],
    },
];

const CHECKPOINTS: &[&str] = &[
    "native CLI scaffold and rewrite status command",
    "project API contract constants and mutation invalidation mapping",
    "project-service router claims declared routes without 501 fallback",
    "runtime event route derives activity, attention, event history, notifications, and focused unread suppression",
    "dashboard desktop-state model, renderer, navigation, action planning, input loop, focus sync, and process selection",
    "root dashboard, configured tool launch, and root resume entrypoints avoid the Node launcher fallback",
    "native dashboard command is the production dashboard launch default",
    "output capture/projection cache and expose preview attachment slices",
    "native daemon/runtime rejects legacy Node control-plane adoption and relaunches project services native on open",
    "native release archives install without requiring Node when the platform Rust binary is present",
    "retired TypeScript hot-path graph was deleted; committed corpora and active gates are the parity specification",
    "source checkout keeps only app-required TypeScript contract files plus GUI and relay TypeScript surfaces",
];

fn phase_progress_units(status: PhaseStatus) -> u16 {
    match status {
        PhaseStatus::Planned => 0,
        PhaseStatus::InProgress => 50,
        PhaseStatus::Complete => 100,
    }
}

fn progress_estimate_percent(phases: &[RewritePhase]) -> u8 {
    if phases.is_empty() {
        return 0;
    }
    let total: u16 = phases
        .iter()
        .map(|phase| phase_progress_units(phase.status))
        .sum();
    ((total + phases.len() as u16 / 2) / phases.len() as u16) as u8
}

fn active_slice(phases: &'static [RewritePhase]) -> &'static str {
    phases
        .iter()
        .find(|phase| phase.status == PhaseStatus::InProgress)
        .or_else(|| {
            phases
                .iter()
                .find(|phase| phase.status == PhaseStatus::Planned)
        })
        .map(|phase| phase.objective)
        .unwrap_or(REWRITE_COMPLETE_SLICE)
}

pub fn rewrite_status() -> RewriteStatus {
    RewriteStatus {
        version: 2,
        strategy: "translation first: preserve functional behavior, function logic, loops, and data shapes; split large TypeScript monoliths into smaller Rust modules when the split does not change behavior.",
        end_state: "zero Node in the normal Aimux CLI, daemon, project-service, tmux runtime, and dashboard hot path",
        progress_estimate_percent: progress_estimate_percent(PHASES),
        active_slice: active_slice(PHASES),
        checkpoints: CHECKPOINTS,
        phases: PHASES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_ACCEPTANCE: &[&str] = &[];

    fn phase(id: &'static str, status: PhaseStatus) -> RewritePhase {
        RewritePhase {
            id,
            status,
            objective: id,
            acceptance: EMPTY_ACCEPTANCE,
        }
    }

    #[test]
    fn progress_estimate_is_derived_from_phase_statuses() {
        let phases = [
            phase("planned", PhaseStatus::Planned),
            phase("active", PhaseStatus::InProgress),
            phase("done", PhaseStatus::Complete),
        ];

        assert_eq!(progress_estimate_percent(&phases), 50);
        assert_eq!(progress_estimate_percent(&[]), 0);
        assert_eq!(rewrite_status().progress_estimate_percent, 100);
    }

    #[test]
    fn active_slice_comes_from_phase_statuses() {
        let phases: &'static [RewritePhase] = Box::leak(Box::new([
            phase("planned objective", PhaseStatus::Planned),
            phase("active objective", PhaseStatus::InProgress),
            phase("done objective", PhaseStatus::Complete),
        ]));

        assert_eq!(active_slice(phases), "active objective");
        assert_eq!(rewrite_status().active_slice, REWRITE_COMPLETE_SLICE);
    }
}
