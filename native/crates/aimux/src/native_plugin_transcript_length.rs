use crate::plugin_api::{
    NativePlugin, NativePluginApi, NativePluginApiRequest, NativePluginCapability,
    NativePluginEventKind, NativePluginManifest,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct TranscriptLengthPlugin {
    line: String,
    last_rendered: BTreeMap<String, String>,
}

impl TranscriptLengthPlugin {
    pub fn new(line: impl Into<String>) -> Self {
        Self {
            line: line.into(),
            last_rendered: BTreeMap::new(),
        }
    }

    pub fn sync(&mut self, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        let sessions = list_sessions(api)?;
        let live_ids = sessions.iter().cloned().collect::<BTreeSet<_>>();
        for session_id in self.last_rendered.keys().cloned().collect::<Vec<_>>() {
            if live_ids.contains(&session_id) {
                continue;
            }
            api.call(NativePluginApiRequest::ClearStatuslineSegment {
                session_id: session_id.clone(),
                segment_id: "transcript-length".to_owned(),
                line: None,
            })?;
            self.last_rendered.remove(&session_id);
        }

        for session_id in sessions {
            let text = segment_text(api, &session_id)?;
            if self.last_rendered.get(&session_id) == Some(&text) {
                continue;
            }
            api.call(NativePluginApiRequest::SetStatuslineSegment {
                session_id: session_id.clone(),
                line: self.line.clone(),
                segment: json!({
                    "id": "transcript-length",
                    "text": text,
                    "tone": "neutral",
                }),
            })?;
            self.last_rendered.insert(session_id, text);
        }
        Ok(())
    }
}

impl NativePlugin for TranscriptLengthPlugin {
    fn manifest(&self) -> NativePluginManifest {
        NativePluginManifest {
            name: "transcript-length".to_owned(),
            display_name: "Transcript Length".to_owned(),
            builtin: true,
            subscriptions: vec![
                NativePluginEventKind::SessionLifecycle,
                NativePluginEventKind::Activity,
            ],
            capabilities: vec![NativePluginCapability::FileRead {
                name: "session-transcript".to_owned(),
                paths: vec!["sessionContext.transcriptPath".to_owned()],
            }],
        }
    }

    fn start(&mut self, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        api.call(NativePluginApiRequest::SubscribeEvents {
            kinds: self.manifest().subscriptions,
        })?;
        self.sync(api)
    }

    fn on_event(&mut self, _event: Value, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        self.sync(api)
    }
}

fn list_sessions(api: &mut NativePluginApi<'_>) -> Result<Vec<String>, String> {
    Ok(api
        .call(NativePluginApiRequest::ListSessions)?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

fn segment_text(api: &mut NativePluginApi<'_>, session_id: &str) -> Result<String, String> {
    let context = api.call(NativePluginApiRequest::ReadSessionContext {
        session_id: session_id.to_owned(),
    })?;
    if let Some(path) = context.get("transcriptPath").and_then(Value::as_str) {
        let metadata = api.call(NativePluginApiRequest::ReadDeclaredFileMetadata {
            capability: "session-transcript".to_owned(),
            path: path.to_owned(),
        })?;
        if metadata.get("isFile").and_then(Value::as_bool) == Some(true)
            && let Some(bytes) = metadata.get("bytes").and_then(Value::as_u64)
        {
            return Ok(format_bytes(bytes));
        }
    }
    let transcript = api.call(NativePluginApiRequest::ReadTranscriptBytesSinceCheckpoint {
        session_id: session_id.to_owned(),
    })?;
    Ok(format_bytes(
        transcript.get("bytes").and_then(Value::as_u64).unwrap_or(0),
    ))
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes}b");
    }
    if bytes < 1024 * 1024 {
        return format_decimal_kb_or_mb((bytes as f64 / 102.4).round() / 10.0, "kb");
    }
    format_decimal_kb_or_mb((bytes as f64 / 104_857.6).round() / 10.0, "mb")
}

fn format_decimal_kb_or_mb(value: f64, suffix: &str) -> String {
    let value = value.max(1.0);
    if value.fract() == 0.0 {
        format!("{}{suffix}", value as u64)
    } else {
        format!("{value:.1}{suffix}")
    }
}
