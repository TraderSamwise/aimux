use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractSourceStatus {
    pub spec: String,
    pub exists: bool,
    pub matches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractAreaReport {
    pub id: &'static str,
    pub source_spec: &'static [&'static str],
    pub source_status: Vec<ContractSourceStatus>,
    pub missing_source_spec: Vec<String>,
    pub native_owner: &'static str,
    pub parity_gate: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractManifestReport {
    pub version: u32,
    pub rule: &'static str,
    pub areas: Vec<ContractAreaReport>,
    pub missing_source_spec: Vec<String>,
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
            "testdata/contracts/v1/project-api",
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

pub fn contract_manifest_report(repo_root: impl AsRef<Path>) -> ContractManifestReport {
    let manifest = contract_manifest();
    let areas = manifest
        .areas
        .iter()
        .map(|area| {
            let source_status: Vec<_> = area
                .source_spec
                .iter()
                .map(|spec| contract_source_status(repo_root.as_ref(), spec))
                .collect();
            let missing_source_spec = source_status
                .iter()
                .filter(|status| !status.exists)
                .map(|status| status.spec.clone())
                .collect();
            ContractAreaReport {
                id: area.id,
                source_spec: area.source_spec,
                source_status,
                missing_source_spec,
                native_owner: area.native_owner,
                parity_gate: area.parity_gate,
            }
        })
        .collect::<Vec<_>>();
    let missing_source_spec = areas
        .iter()
        .flat_map(|area| {
            area.missing_source_spec
                .iter()
                .map(move |spec| format!("{}:{spec}", area.id))
        })
        .collect();
    ContractManifestReport {
        version: manifest.version,
        rule: manifest.rule,
        areas,
        missing_source_spec,
    }
}

pub fn missing_contract_manifest_sources(repo_root: impl AsRef<Path>) -> Vec<String> {
    contract_manifest_report(repo_root).missing_source_spec
}

pub fn find_contract_repo_root(start: impl AsRef<Path>) -> PathBuf {
    let mut current = start.as_ref();
    if current.is_file() {
        current = current.parent().unwrap_or(current);
    }
    for candidate in current.ancestors() {
        if candidate.join("package.json").is_file() && candidate.join("native/Cargo.toml").is_file()
        {
            return candidate.to_path_buf();
        }
    }
    start.as_ref().to_path_buf()
}

fn contract_source_status(repo_root: &Path, spec: &str) -> ContractSourceStatus {
    let matches = contract_source_matches(repo_root, spec);
    ContractSourceStatus {
        spec: spec.to_owned(),
        exists: !matches.is_empty(),
        matches,
    }
}

fn contract_source_matches(repo_root: &Path, spec: &str) -> Vec<String> {
    if let Some((prefix, suffix)) = spec.split_once('*') {
        let prefix_path = Path::new(prefix);
        let (parent, file_prefix) = if prefix.ends_with('/') {
            (prefix_path, "")
        } else {
            (
                prefix_path.parent().unwrap_or_else(|| Path::new("")),
                prefix_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(""),
            )
        };
        let dir = repo_root.join(parent);
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut matches = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_name = entry.file_name();
                let file_name = file_name.to_str()?;
                (file_name.starts_with(file_prefix) && file_name.ends_with(suffix))
                    .then(|| parent.join(file_name).to_string_lossy().into_owned())
            })
            .collect::<Vec<_>>();
        matches.sort();
        return matches;
    }
    let path = repo_root.join(spec);
    path.exists().then(|| spec.to_owned()).into_iter().collect()
}
