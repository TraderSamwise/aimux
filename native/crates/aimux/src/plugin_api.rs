use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginManifest {
    pub name: String,
    pub display_name: String,
    pub builtin: bool,
    pub subscriptions: Vec<NativePluginEventKind>,
    pub capabilities: Vec<NativePluginCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativePluginEventKind {
    SessionLifecycle,
    Activity,
    Attention,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NativePluginCapability {
    Subprocess {
        name: String,
        command: String,
        cwd_scopes: Vec<String>,
    },
    FileRead {
        name: String,
        paths: Vec<String>,
    },
    OutboundHttp {
        name: String,
        hosts: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "camelCase")]
pub enum NativePluginApiRequest {
    GetIdentity,
    ListSessions,
    ReadSessionMetadata {
        session_id: String,
    },
    ReadSessionContext {
        session_id: String,
    },
    ReadSessionHistory {
        session_id: String,
        since: Option<String>,
    },
    ReadSessionTranscript {
        session_id: String,
        since: Option<String>,
    },
    ReadAgentOutput {
        session_id: String,
        start_line: Option<u64>,
        mode: Option<String>,
    },
    ReadActivityAttention {
        session_id: String,
    },
    ReadConfig {
        path: Option<String>,
    },
    ReadProjectPaths,
    ReadRuntimeTopology {
        statuses: Option<Vec<String>>,
    },
    ReadWorktreeInventory,
    ReadCoordinationState,
    ReadNotificationFeed,
    ReadStatuslineSnapshot,
    ReadDaemonStateSnapshot,
    ReadMetadataState,
    ReadTranscriptBytesSinceCheckpoint {
        session_id: String,
    },
    SetStatuslineSegment {
        session_id: String,
        line: String,
        segment: Value,
    },
    ClearStatuslineSegment {
        session_id: String,
        segment_id: String,
        line: Option<String>,
    },
    SetSessionContext {
        session_id: String,
        context: Value,
    },
    PublishNotification {
        notification: Value,
    },
    MutateTaskThread {
        mutation: Value,
    },
    DeliverAgentInput {
        session_id: String,
        text: String,
        options: Value,
    },
    SubscribeEvents {
        kinds: Vec<NativePluginEventKind>,
    },
    PluginStoreGet {
        key: String,
    },
    PluginStoreSet {
        key: String,
        value: Value,
    },
    PluginStoreDelete {
        key: String,
    },
    PluginStoreList,
    ReadDeclaredFileMetadata {
        capability: String,
        path: String,
    },
    ReadDeclaredFile {
        capability: String,
        path: String,
    },
    RunDeclaredSubprocess {
        capability: String,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
    HttpRequest {
        capability: String,
        method: String,
        url: String,
        headers: BTreeMap<String, String>,
        body: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginStatus {
    pub source: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<NativePluginCapability>,
}

pub trait NativePluginHost {
    fn execute(
        &mut self,
        plugin_name: &str,
        request: NativePluginApiRequest,
    ) -> Result<Value, String>;
}

pub trait NativePlugin {
    fn manifest(&self) -> NativePluginManifest;
    fn start(&mut self, api: &mut NativePluginApi<'_>) -> Result<(), String>;
    fn on_event(&mut self, _event: Value, _api: &mut NativePluginApi<'_>) -> Result<(), String> {
        Ok(())
    }
}

pub struct NativePluginApi<'a> {
    plugin_name: &'a str,
    host: &'a mut dyn NativePluginHost,
}

impl<'a> NativePluginApi<'a> {
    pub fn new(plugin_name: &'a str, host: &'a mut dyn NativePluginHost) -> Self {
        Self { plugin_name, host }
    }

    pub fn call(&mut self, request: NativePluginApiRequest) -> Result<Value, String> {
        self.host.execute(self.plugin_name, request)
    }
}
