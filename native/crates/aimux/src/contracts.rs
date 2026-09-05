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
            "src/main.ts",
            "src/full/main.ts",
            "src/core-cli.ts",
            "src/launcher-env.ts",
        ],
        native_owner: "native/crates/aimux/src/bin/aimux.rs",
        parity_gate: "native CLI stdout/stderr/status matches TypeScript command fixtures",
    },
    ContractArea {
        id: "daemon",
        source_spec: &[
            "src/daemon.ts",
            "src/daemon-state.ts",
            "src/daemon/projects-route.ts",
        ],
        native_owner: "native/crates/aimux/src/daemon",
        parity_gate: "daemon status, project catalog, and lifecycle JSON match TypeScript fixtures",
    },
    ContractArea {
        id: "project-service",
        source_spec: &[
            "src/metadata-server.ts",
            "src/metadata-server/*",
            "src/project-api-contract.ts",
        ],
        native_owner: "native/crates/aimux/src/metadata_server",
        parity_gate: "project API routes and SSE payloads match project-api-contract fixtures",
    },
    ContractArea {
        id: "tmux-runtime",
        source_spec: &["src/tmux/runtime-manager.ts", "src/tmux/*"],
        native_owner: "native/crates/aimux/src/tmux",
        parity_gate: "tmux targets, metadata, statusline, expose, and doctor output match fixtures",
    },
    ContractArea {
        id: "multiplexer",
        source_spec: &["src/multiplexer/*", "src/dashboard/*"],
        native_owner: "native/crates/aimux/src/multiplexer",
        parity_gate: "desktop-state snapshots and dashboard model golden fixtures match TypeScript",
    },
    ContractArea {
        id: "runtime-exchange",
        source_spec: &[
            "src/runtime-core/*",
            "src/threads.ts",
            "src/tasks.ts",
            "src/coordination-model.ts",
        ],
        native_owner: "native/crates/aimux/src/runtime_core",
        parity_gate: "task, handoff, thread, notification, topology, and graveyard stores round-trip",
    },
    ContractArea {
        id: "output",
        source_spec: &[
            "src/multiplexer/session-capture.ts",
            "src/multiplexer/transcript-reconciler.ts",
            "app/lib/ansi.ts",
            "app/lib/terminal-output.ts",
        ],
        native_owner: "native/crates/aimux/src/output",
        parity_gate: "ANSI, preview, transcript, and liveness adversarial fixtures match",
    },
    ContractArea {
        id: "dashboard-tui",
        source_spec: &["src/tui/*", "src/multiplexer/dashboard-*.ts"],
        native_owner: "native/crates/aimux/src/tui",
        parity_gate: "keybindings, rendered rows, dialogs, and lifecycle actions match dashboard fixtures",
    },
];

pub fn contract_manifest() -> ContractManifest {
    ContractManifest {
        version: 1,
        rule: "translation-first: TypeScript behavior is the spec until full feature parity is reached",
        areas: AREAS,
    }
}
