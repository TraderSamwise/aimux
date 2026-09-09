use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMigrationDiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMigrationSourceKind {
    LegacyContext,
    LegacyHistory,
    LegacyStatus,
    LegacyThread,
    LegacyMessageLog,
    LegacyTask,
    LegacyPlan,
    LegacyRecording,
    LegacyAttachment,
    RuntimeTopology,
    RuntimeExchange,
    SavedState,
    Metadata,
}

impl RuntimeMigrationSourceKind {
    pub(super) fn as_key(self) -> &'static str {
        match self {
            Self::LegacyContext => "legacy-context",
            Self::LegacyHistory => "legacy-history",
            Self::LegacyStatus => "legacy-status",
            Self::LegacyThread => "legacy-thread",
            Self::LegacyMessageLog => "legacy-message-log",
            Self::LegacyTask => "legacy-task",
            Self::LegacyPlan => "legacy-plan",
            Self::LegacyRecording => "legacy-recording",
            Self::LegacyAttachment => "legacy-attachment",
            Self::RuntimeTopology => "runtime-topology",
            Self::RuntimeExchange => "runtime-exchange",
            Self::SavedState => "saved-state",
            Self::Metadata => "metadata",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationDiagnostic {
    pub severity: RuntimeMigrationDiagnosticSeverity,
    pub kind: RuntimeMigrationSourceKind,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMigrationProject {
    pub repo_root: String,
    pub project_id: String,
    pub project_state_dir: String,
    pub local_aimux_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMigrationAuthority {
    pub runtime_topology_path: String,
    pub runtime_exchange_path: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMigrationStatus {
    Clean,
    NeedsImport,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMigrationReport {
    pub version: u8,
    pub generated_at: String,
    pub status: RuntimeMigrationStatus,
    pub project: RuntimeMigrationProject,
    pub authority: RuntimeMigrationAuthority,
    pub legacy: Map<String, Value>,
    pub diagnostics: Vec<RuntimeMigrationDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationFileBackup {
    pub kind: RuntimeMigrationSourceKind,
    pub source: String,
    pub backup: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationCopiedDir {
    pub kind: RuntimeMigrationSourceKind,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationCopiedFile {
    pub kind: RuntimeMigrationSourceKind,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationWrite {
    pub kind: RuntimeMigrationSourceKind,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMigrationManifest {
    pub version: u8,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub report: RuntimeMigrationReport,
    pub backups: Vec<RuntimeMigrationFileBackup>,
    #[serde(rename = "copiedDirs")]
    pub copied_dirs: Vec<RuntimeMigrationCopiedDir>,
    #[serde(rename = "copiedFiles")]
    pub copied_files: Vec<RuntimeMigrationCopiedFile>,
    pub wrote: Vec<RuntimeMigrationWrite>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeMigrationImportResult {
    pub exchange: Value,
    pub manifest: RuntimeMigrationManifest,
}
