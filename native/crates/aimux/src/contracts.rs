use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractArea {
    pub id: &'static str,
    pub source_spec: &'static [&'static str],
    pub native_owner: &'static str,
    pub parity_gate: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractManifest {
    pub version: u32,
    pub rule: &'static str,
    pub areas: &'static [ContractArea],
}

const AREAS: &[ContractArea] = &[
    ContractArea {
        id: "cli",
        source_spec: &[
            "testdata/contracts/v1/cli",
            "scripts/phase8-live-residuals.py",
            "src/core-command-contract.ts",
        ],
        native_owner: "native/crates/aimux/src/bin/aimux.rs",
        parity_gate: "native CLI stdout/stderr/status matches committed corpora and live front-door residuals",
    },
    ContractArea {
        id: "daemon",
        source_spec: &[
            "testdata/contracts/v1/daemon",
            "testdata/contracts/v1/metadata-store",
            "scripts/phase8-live-residuals.py",
        ],
        native_owner: "native/crates/aimux/src/daemon",
        parity_gate: "daemon status, project catalog, and lifecycle JSON match committed corpora",
    },
    ContractArea {
        id: "project-service",
        source_spec: &[
            "testdata/contracts/v1/project-service",
            "testdata/contracts/v1/runtime-state",
            "src/project-api-contract.ts",
        ],
        native_owner: "native/crates/aimux/src/metadata_server",
        parity_gate: "project API routes and SSE payloads match committed corpora and project-api-contract",
    },
    ContractArea {
        id: "tmux-runtime",
        source_spec: &[
            "testdata/contracts/v1/tmux",
            "scripts/phase8-live-residuals.py",
        ],
        native_owner: "native/crates/aimux/src/tmux",
        parity_gate: "tmux targets, metadata, statusline, expose, and doctor output match committed corpora and live residuals",
    },
    ContractArea {
        id: "multiplexer",
        source_spec: &[
            "testdata/contracts/v1/multiplexer",
            "testdata/contracts/v1/dashboard",
            "src/multiplexer/*.contract.v1.json",
        ],
        native_owner: "native/crates/aimux/src/multiplexer",
        parity_gate: "desktop-state snapshots and dashboard model golden fixtures match committed corpora",
    },
    ContractArea {
        id: "runtime-exchange",
        source_spec: &[
            "testdata/contracts/v1/runtime-state",
            "testdata/contracts/v1/runtime-coherence",
            "testdata/contracts/v1/project-takeover",
        ],
        native_owner: "native/crates/aimux/src/runtime_core",
        parity_gate: "task, handoff, thread, notification, topology, and graveyard stores round-trip",
    },
    ContractArea {
        id: "output",
        source_spec: &[
            "testdata/contracts/v1/agent-output",
            "app/lib/ansi.ts",
            "app/lib/terminal-output.ts",
        ],
        native_owner: "native/crates/aimux/src/output",
        parity_gate: "ANSI, preview, transcript, and liveness adversarial corpora match",
    },
    ContractArea {
        id: "dashboard-tui",
        source_spec: &[
            "testdata/contracts/v1/dashboard",
            "testdata/contracts/v1/multiplexer",
            "scripts/phase8-live-residuals.py",
        ],
        native_owner: "native/crates/aimux/src/tui",
        parity_gate: "keybindings, rendered rows, dialogs, lifecycle actions, and terminal smoke behavior match committed fixtures",
    },
];

pub fn contract_manifest() -> ContractManifest {
    ContractManifest {
        version: 1,
        rule: "post-cut translation-first: committed corpora and live residual smokes are the spec for retired TypeScript behavior",
        areas: AREAS,
    }
}
