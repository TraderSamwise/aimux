use crate::runtime_topology::list_topology_session_states;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_FIRST_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAgentIdentity {
    pub session_id: String,
    pub backend_session_id: String,
    pub source: &'static str,
    pub tool: Option<String>,
    pub tool_config_key: Option<String>,
    pub command: Option<String>,
    pub status: Option<String>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentIdentityError {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct BackendSessionDiscoveryOptions {
    pub claude_projects_dir: Option<PathBuf>,
    pub codex_sessions_dir: Option<PathBuf>,
    pub codex_since_ms: Option<u128>,
    pub codex_exclude_backend_session_ids: BTreeSet<String>,
}

pub fn resolve_agent_identity(
    project_root: &str,
    session_id: &str,
    topology: &Value,
) -> Result<ResolvedAgentIdentity, AgentIdentityError> {
    resolve_agent_identity_with_options(
        project_root,
        session_id,
        topology,
        &BackendSessionDiscoveryOptions::default(),
    )
}

pub fn resolve_agent_identity_with_options(
    project_root: &str,
    session_id: &str,
    topology: &Value,
    discovery: &BackendSessionDiscoveryOptions,
) -> Result<ResolvedAgentIdentity, AgentIdentityError> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(AgentIdentityError {
            session_id: String::new(),
            reason: "sessionId is required".into(),
        });
    }
    let session = match list_topology_session_states(topology, None)
        .into_iter()
        .find(|entry| string_field(entry, "id").as_deref() == Some(session_id))
    {
        Some(session) => session,
        None => {
            return Err(AgentIdentityError {
                session_id: session_id.into(),
                reason: format!("Agent \"{session_id}\" is not managed in runtime topology"),
            });
        }
    };

    if let Some(backend_session_id) = string_field(&session, "backendSessionId")
        && !backend_session_id.is_empty()
    {
        return Ok(identity_from_session(
            &session,
            &backend_session_id,
            "topology",
        ));
    }

    let tool_key = discovery_tool_key_for_session(&session);
    let cwd = string_field(&session, "worktreePath").unwrap_or_else(|| project_root.to_owned());
    if let Some(discovered) =
        discover_backend_session_id_with_options(tool_key.as_deref(), Some(cwd.as_str()), discovery)
    {
        return Ok(identity_from_session(&session, &discovered, "discovered"));
    }

    Err(AgentIdentityError {
        session_id: session_id.into(),
        reason: format!(
            "Agent \"{session_id}\" has no recorded {} session id, and {cwd} holds no single transcript to recover one from. Agents started before aimux recorded backend ids cannot be forked or moved natively.",
            tool_key.unwrap_or_else(|| "tool".into())
        ),
    })
}

pub fn build_agent_identity_payload(project_root: &str, identity: &ResolvedAgentIdentity) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root.into()));
    payload.insert(
        "canonical".into(),
        Value::String(agent_canonical_id(identity)),
    );
    payload.insert("aimuxId".into(), Value::String(identity.session_id.clone()));
    payload.insert(
        "backendSessionId".into(),
        Value::String(identity.backend_session_id.clone()),
    );
    payload.insert("source".into(), Value::String(identity.source.into()));
    insert_optional(&mut payload, "status", identity.status.as_deref());
    insert_optional(
        &mut payload,
        "worktreePath",
        identity.worktree_path.as_deref(),
    );
    Value::Object(payload)
}

pub fn build_agent_identity_error_payload(project_root: &str, error: &AgentIdentityError) -> Value {
    json!({
        "ok": false,
        "projectRoot": project_root,
        "sessionId": error.session_id,
        "error": error.reason,
    })
}

pub fn render_agent_identity_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec![format!(
        "{}  canonical={}  backend={}  status={}  source={}",
        string_field(payload, "aimuxId").unwrap_or_default(),
        string_field(payload, "canonical").unwrap_or_else(|| "?".into()),
        string_field(payload, "backendSessionId").unwrap_or_default(),
        string_field(payload, "status").unwrap_or_else(|| "?".into()),
        string_field(payload, "source").unwrap_or_default(),
    )];
    if let Some(worktree_path) = string_field(payload, "worktreePath")
        && !worktree_path.is_empty()
    {
        lines.push(format!("worktree: {worktree_path}"));
    }
    lines
}

pub fn discovery_tool_key_for_session(session: &Value) -> Option<String> {
    normalize_discovery_tool_key(string_field(session, "toolConfigKey").as_deref())
        .or_else(|| normalize_discovery_tool_key(string_field(session, "tool").as_deref()))
        .or_else(|| normalize_discovery_tool_key(string_field(session, "command").as_deref()))
}

pub fn normalize_discovery_tool_key(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let command = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    matches!(command.as_str(), "claude" | "codex").then_some(command)
}

pub fn discover_backend_session_id(
    tool_config_key: Option<&str>,
    cwd: Option<&str>,
) -> Option<String> {
    discover_backend_session_id_with_options(
        tool_config_key,
        cwd,
        &BackendSessionDiscoveryOptions::default(),
    )
}

pub fn discover_backend_session_id_with_options(
    tool_config_key: Option<&str>,
    cwd: Option<&str>,
    options: &BackendSessionDiscoveryOptions,
) -> Option<String> {
    let cwd = cwd?;
    match tool_config_key {
        Some("claude") => {
            discover_claude_backend_session_id(cwd, options.claude_projects_dir.as_deref())
        }
        Some("codex") => discover_codex_backend_session_id(cwd, options),
        _ => None,
    }
}

pub fn claude_transcript_path(
    cwd: &str,
    backend_session_id: &str,
    projects_dir: Option<&Path>,
) -> PathBuf {
    claude_projects_dir(projects_dir)
        .join(encode_claude_project_path(cwd))
        .join(format!("{backend_session_id}.jsonl"))
}

pub fn relocate_claude_transcript(
    source_cwd: &str,
    target_cwd: &str,
    backend_session_id: &str,
    projects_dir: Option<&Path>,
) -> bool {
    let from = claude_transcript_path(source_cwd, backend_session_id, projects_dir);
    let to = claude_transcript_path(target_cwd, backend_session_id, projects_dir);
    if from == to {
        return true;
    }
    if !from.exists() {
        return false;
    }
    if let Some(parent) = to.parent()
        && fs::create_dir_all(parent).is_err()
    {
        return false;
    }
    fs::copy(from, to).is_ok()
}

pub fn discover_claude_backend_session_id(
    cwd: &str,
    projects_dir: Option<&Path>,
) -> Option<String> {
    let dir = claude_projects_dir(projects_dir).join(encode_claude_project_path(cwd));
    let entries = fs::read_dir(dir).ok()?;
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if is_uuid(id) {
            ids.push(id.to_owned());
        }
    }
    (ids.len() == 1).then(|| ids.remove(0))
}

pub fn discover_codex_backend_session_id(
    cwd: &str,
    options: &BackendSessionDiscoveryOptions,
) -> Option<String> {
    let sessions_dir = codex_sessions_dir(options.codex_sessions_dir.as_deref());
    if !sessions_dir.exists() {
        return None;
    }
    let mut ids = BTreeSet::new();
    collect_codex_session_ids_for_cwd(&sessions_dir, cwd, &mut ids, options);
    if ids.len() == 1 {
        ids.into_iter().next()
    } else {
        None
    }
}

fn collect_codex_session_ids_for_cwd(
    dir: &Path,
    cwd: &str,
    ids: &mut BTreeSet<String>,
    options: &BackendSessionDiscoveryOptions,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_codex_session_ids_for_cwd(&path, cwd, ids, options);
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        if let Some(since_ms) = options.codex_since_ms
            && modified_ms(&path).is_none_or(|mtime| mtime < since_ms)
        {
            continue;
        }
        let Some(line) = read_first_line(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if string_field(&record, "type").as_deref() != Some("session_meta") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        let Some(id) = string_field(payload, "id") else {
            continue;
        };
        if !is_uuid(&id)
            || string_field(payload, "cwd").as_deref() != Some(cwd)
            || options.codex_exclude_backend_session_ids.contains(&id)
        {
            continue;
        }
        ids.insert(id);
    }
}

fn identity_from_session(
    session: &Value,
    backend_session_id: &str,
    source: &'static str,
) -> ResolvedAgentIdentity {
    ResolvedAgentIdentity {
        session_id: string_field(session, "id").unwrap_or_default(),
        backend_session_id: backend_session_id.into(),
        source,
        tool: string_field(session, "tool"),
        tool_config_key: string_field(session, "toolConfigKey"),
        command: string_field(session, "command"),
        status: string_field(session, "status"),
        worktree_path: string_field(session, "worktreePath"),
    }
}

fn agent_canonical_id(identity: &ResolvedAgentIdentity) -> String {
    identity
        .tool_config_key
        .as_deref()
        .or(identity.tool.as_deref())
        .or(identity.command.as_deref())
        .unwrap_or("?")
        .to_owned()
}

fn insert_optional(payload: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        payload.insert(key.into(), Value::String(value.into()));
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn read_first_line(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    while bytes.len() < MAX_FIRST_LINE_BYTES {
        let limit = buffer.len().min(MAX_FIRST_LINE_BYTES - bytes.len());
        let read = file.read(&mut buffer[..limit]).ok()?;
        if read == 0 {
            break;
        }
        if let Some(newline_index) = buffer[..read].iter().position(|byte| *byte == b'\n') {
            bytes.extend_from_slice(&buffer[..newline_index]);
            return String::from_utf8(bytes).ok();
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.is_empty() || bytes.len() >= MAX_FIRST_LINE_BYTES {
        None
    } else {
        String::from_utf8(bytes).ok()
    }
}

fn modified_ms(path: &Path) -> Option<u128> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn claude_projects_dir(override_dir: Option<&Path>) -> PathBuf {
    override_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        let base = std::env::var("CLAUDE_CONFIG_DIR")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".claude"));
        base.join("projects")
    })
}

fn codex_sessions_dir(override_dir: Option<&Path>) -> PathBuf {
    override_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        std::env::var("CODEX_HOME")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".codex"))
            .join("sessions")
    })
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn encode_claude_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|character| {
            if character == '/' || character == '.' {
                '-'
            } else {
                character
            }
        })
        .collect()
}

fn is_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    for (index, byte) in value.bytes().enumerate() {
        match index {
            8 | 13 | 18 | 23 if byte == b'-' => {}
            8 | 13 | 18 | 23 => return false,
            _ if byte.is_ascii_hexdigit() => {}
            _ => return false,
        }
    }
    true
}
