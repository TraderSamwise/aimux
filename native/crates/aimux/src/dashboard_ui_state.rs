use crate::atomic_write::write_json_atomic;
use crate::dashboard_controller::DashboardScreen;
use crate::paths::PathResolver;
use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct DashboardUiStatePersistence {
    path: PathBuf,
    client_session: String,
    last_screen: Option<DashboardScreen>,
}

impl DashboardUiStatePersistence {
    pub fn for_project(project_root: &Path) -> Result<Self> {
        let mut resolver = PathResolver::from_env();
        let project_state_dir = resolver.project_state_dir_for(project_root);
        let session = current_tmux_session().ok_or_else(|| anyhow!("tmux session unavailable"))?;
        Self::new(project_state_dir, &session)
    }

    pub fn new(project_state_dir: impl AsRef<Path>, client_session: &str) -> Result<Self> {
        let client_key = dashboard_client_key(client_session);
        if client_key.is_empty() {
            return Err(anyhow!("dashboard client session is empty"));
        }
        let path = project_state_dir
            .as_ref()
            .join(format!("dashboard-ui-client-{client_key}.json"));
        let last_screen = read_dashboard_screen(&path);
        Ok(Self {
            path,
            client_session: client_session.to_owned(),
            last_screen,
        })
    }

    pub fn load_screen(&self) -> Option<DashboardScreen> {
        self.last_screen
    }

    pub fn persist_screen(&mut self, screen: DashboardScreen) -> Result<bool> {
        if self.last_screen == Some(screen) {
            return Ok(false);
        }
        let mut snapshot = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()));
        snapshot["screen"] = Value::String(screen.as_str().to_owned());
        write_json_atomic(&self.path, &snapshot)
            .with_context(|| format!("write dashboard ui state {}", self.path.display()))?;
        self.last_screen = Some(screen);
        Ok(true)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn client_session(&self) -> &str {
        &self.client_session
    }
}

pub fn dashboard_client_key(session: &str) -> String {
    session
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn read_dashboard_screen(path: &Path) -> Option<DashboardScreen> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let screen = value.get("screen").and_then(Value::as_str)?;
    DashboardScreen::parse(screen)
}

fn current_tmux_session() -> Option<String> {
    let output = Command::new("tmux")
        .args(["display-message", "-p", "#{session_name}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let session = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!session.is_empty()).then_some(session)
}

#[derive(Debug, Clone)]
pub struct DashboardUiState {
    pub screen: String,
    pub details_sidebar_visible: bool,
    pub focused_worktree_path: Option<String>,
    pub level: String,
    pub session_index: usize,
    pub preview_source: String,
    pub worktree_entries: Vec<Value>,
}

impl Default for DashboardUiState {
    fn default() -> Self {
        Self {
            screen: "dashboard".to_owned(),
            details_sidebar_visible: true,
            focused_worktree_path: None,
            level: "worktrees".to_owned(),
            session_index: 0,
            preview_source: "output".to_owned(),
            worktree_entries: Vec::new(),
        }
    }
}

impl DashboardUiState {
    pub fn snapshot(&self) -> Value {
        let mut snapshot = Map::new();
        snapshot.insert("screen".to_owned(), Value::String(self.screen.clone()));
        snapshot.insert(
            "detailsSidebarVisible".to_owned(),
            Value::Bool(self.details_sidebar_visible),
        );
        if let Some(path) = &self.focused_worktree_path {
            snapshot.insert(
                "focusedWorktreePath".to_owned(),
                Value::String(path.clone()),
            );
        }
        snapshot.insert("level".to_owned(), Value::String(self.level.clone()));
        snapshot.insert("sessionIndex".to_owned(), json!(self.session_index));
        snapshot.insert(
            "previewSource".to_owned(),
            Value::String(self.preview_source.clone()),
        );
        snapshot.insert(
            "worktreeEntries".to_owned(),
            Value::Array(self.worktree_entries.clone()),
        );
        Value::Object(snapshot)
    }
}

#[derive(Debug, Clone, Default)]
pub struct DashboardOrderState {
    pub agent_order_by_worktree_key: BTreeMap<String, Vec<String>>,
    pub service_order_by_worktree_key: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreferredSelection {
    kind: String,
    id: String,
}

#[derive(Debug, Clone)]
pub struct DashboardUiStateStore {
    project_state_dir: PathBuf,
    preferred_selection: Option<PreferredSelection>,
    pending_preferred_selection: bool,
    flat_session_id: Option<String>,
    selection_needs_restore: bool,
    order_state: DashboardOrderState,
}

impl DashboardUiStateStore {
    pub fn new(project_state_dir: impl AsRef<Path>) -> Self {
        Self {
            project_state_dir: project_state_dir.as_ref().to_path_buf(),
            preferred_selection: None,
            pending_preferred_selection: false,
            flat_session_id: None,
            selection_needs_restore: true,
            order_state: DashboardOrderState::default(),
        }
    }

    pub fn load_shared_state(&mut self, state: Option<&mut DashboardUiState>) {
        self.order_state = DashboardOrderState::default();
        let Some(snapshot) = self.read_json(&self.shared_path()) else {
            return;
        };
        if let Some(state) = state {
            if let Some(details) = snapshot
                .get("detailsSidebarVisible")
                .and_then(Value::as_bool)
            {
                state.details_sidebar_visible = details;
            }
            state.preview_source = normalize_preview_source(snapshot.get("previewSource"));
        }
        self.order_state = DashboardOrderState {
            agent_order_by_worktree_key: sanitize_order_map(
                snapshot.get("agentOrderByWorktreeKey"),
            ),
            service_order_by_worktree_key: sanitize_order_map(
                snapshot.get("serviceOrderByWorktreeKey"),
            ),
        };
    }

    pub fn load_into(&mut self, state: &mut DashboardUiState, client_key: &str) {
        self.load_shared_state(Some(state));
        let Some(snapshot) = self.read_json(&self.client_path(client_key)) else {
            return;
        };
        if let Some(screen) = snapshot.get("screen").and_then(Value::as_str) {
            state.screen = normalize_persisted_screen(screen);
        }
        if snapshot.get("focusedWorktreePath").is_some() {
            state.focused_worktree_path = snapshot
                .get("focusedWorktreePath")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if let Some(level) = snapshot.get("level").and_then(Value::as_str) {
            state.level = level.to_owned();
        }
        if let (Some(kind), Some(id)) = (
            snapshot.get("selectedEntryKind").and_then(Value::as_str),
            snapshot.get("selectedEntryId").and_then(Value::as_str),
        ) {
            self.preferred_selection = Some(PreferredSelection {
                kind: kind.to_owned(),
                id: id.to_owned(),
            });
            self.pending_preferred_selection = false;
            self.selection_needs_restore = true;
        }
        if let Some(flat_session_id) = snapshot.get("flatSessionId").and_then(Value::as_str) {
            self.flat_session_id = Some(flat_session_id.to_owned());
            self.selection_needs_restore = true;
        }
    }

    pub fn persist(
        &mut self,
        mode: &str,
        client_key: &str,
        state: &DashboardUiState,
        active_index: usize,
        dash_sessions: &[Value],
    ) {
        if mode != "dashboard" {
            return;
        }
        let mut shared = Map::new();
        shared.insert(
            "detailsSidebarVisible".to_owned(),
            Value::Bool(state.details_sidebar_visible),
        );
        shared.insert(
            "previewSource".to_owned(),
            Value::String(normalize_preview_source(Some(&Value::String(
                state.preview_source.clone(),
            )))),
        );
        if has_order_entries(&self.order_state.agent_order_by_worktree_key) {
            shared.insert(
                "agentOrderByWorktreeKey".to_owned(),
                order_map_value(&self.order_state.agent_order_by_worktree_key),
            );
        }
        if has_order_entries(&self.order_state.service_order_by_worktree_key) {
            shared.insert(
                "serviceOrderByWorktreeKey".to_owned(),
                order_map_value(&self.order_state.service_order_by_worktree_key),
            );
        }

        let mut client = Map::new();
        client.insert("screen".to_owned(), Value::String(state.screen.clone()));
        if let Some(path) = &state.focused_worktree_path {
            client.insert(
                "focusedWorktreePath".to_owned(),
                Value::String(path.clone()),
            );
        }
        client.insert("level".to_owned(), Value::String(state.level.clone()));
        if state.level == "sessions"
            && let Some(entry) = state.worktree_entries.get(state.session_index)
            && let (Some(kind), Some(id)) = (
                entry.get("kind").and_then(Value::as_str),
                entry.get("id").and_then(Value::as_str),
            )
        {
            client.insert(
                "selectedEntryKind".to_owned(),
                Value::String(kind.to_owned()),
            );
            client.insert("selectedEntryId".to_owned(), Value::String(id.to_owned()));
            self.preferred_selection = Some(PreferredSelection {
                kind: kind.to_owned(),
                id: id.to_owned(),
            });
            self.pending_preferred_selection = false;
        }
        if let Some(flat_session) = dash_sessions.get(active_index)
            && let Some(id) = flat_session.get("id").and_then(Value::as_str)
        {
            client.insert("flatSessionId".to_owned(), Value::String(id.to_owned()));
            self.flat_session_id = Some(id.to_owned());
        }
        let _ = write_json_atomic(self.shared_path(), &Value::Object(shared));
        let _ = write_json_atomic(self.client_path(client_key), &Value::Object(client));
    }

    pub fn prefer_entry_selection(
        &mut self,
        state: &mut DashboardUiState,
        kind: &str,
        id: &str,
        worktree_path: Option<&str>,
    ) {
        state.level = "sessions".to_owned();
        state.focused_worktree_path = worktree_path.map(str::to_owned);
        self.preferred_selection = Some(PreferredSelection {
            kind: kind.to_owned(),
            id: id.to_owned(),
        });
        self.pending_preferred_selection = true;
        self.selection_needs_restore = true;
    }

    pub fn remember_current_entry_selection(&mut self, state: &DashboardUiState) {
        if state.level != "sessions" {
            return;
        }
        let Some(entry) = state.worktree_entries.get(state.session_index) else {
            return;
        };
        let (Some(kind), Some(id)) = (
            entry.get("kind").and_then(Value::as_str),
            entry.get("id").and_then(Value::as_str),
        ) else {
            return;
        };
        self.preferred_selection = Some(PreferredSelection {
            kind: kind.to_owned(),
            id: id.to_owned(),
        });
        self.pending_preferred_selection = false;
        self.selection_needs_restore = false;
    }

    pub fn mark_selection_dirty(&mut self) {
        self.selection_needs_restore = true;
    }

    pub fn consume_selection_restore(
        &mut self,
        state: &mut DashboardUiState,
        dash_sessions: &[Value],
        has_worktrees: bool,
        active_index: &mut usize,
    ) {
        if !self.selection_needs_restore {
            return;
        }
        if has_worktrees {
            if self.pending_preferred_selection && state.level != "sessions" {
                return;
            }
            if state.level == "sessions"
                && let Some(preferred) = &self.preferred_selection
            {
                let preferred_index = state.worktree_entries.iter().position(|entry| {
                    entry.get("kind").and_then(Value::as_str) == Some(preferred.kind.as_str())
                        && entry.get("id").and_then(Value::as_str) == Some(preferred.id.as_str())
                });
                if let Some(index) = preferred_index {
                    state.session_index = index;
                    self.pending_preferred_selection = false;
                } else if state.session_index >= state.worktree_entries.len() {
                    state.session_index = state.worktree_entries.len().saturating_sub(1);
                }
                if self.pending_preferred_selection {
                    return;
                }
            }
            self.selection_needs_restore = false;
            return;
        }

        if let Some(flat_session_id) = &self.flat_session_id {
            if let Some(index) = dash_sessions.iter().position(|session| {
                session.get("id").and_then(Value::as_str) == Some(flat_session_id)
            }) {
                *active_index = index;
            } else if *active_index >= dash_sessions.len() {
                *active_index = dash_sessions.len().saturating_sub(1);
            }
        } else if *active_index >= dash_sessions.len() {
            *active_index = dash_sessions.len().saturating_sub(1);
        }
        self.selection_needs_restore = false;
    }

    pub fn move_entry_within_worktree(
        &mut self,
        kind: &str,
        worktree_path: Option<&str>,
        selected_id: &str,
        direction: &str,
        sessions: &[Value],
        services: &[Value],
    ) -> bool {
        let key = dashboard_order_key(worktree_path);
        if kind == "session" {
            let result = move_dashboard_order(
                sessions,
                self.order_state
                    .agent_order_by_worktree_key
                    .get(&key)
                    .map(Vec::as_slice),
                selected_id,
                direction,
            );
            self.order_state
                .agent_order_by_worktree_key
                .insert(key, result.order);
            return result.moved;
        }

        let result = move_dashboard_order(
            services,
            self.order_state
                .service_order_by_worktree_key
                .get(&key)
                .map(Vec::as_slice),
            selected_id,
            direction,
        );
        self.order_state
            .service_order_by_worktree_key
            .insert(key, result.order);
        result.moved
    }

    pub fn order_sessions_for_worktree(
        &self,
        sessions: &[Value],
        worktree_path: Option<&str>,
    ) -> Vec<Value> {
        let key = dashboard_order_key(worktree_path);
        apply_dashboard_order(
            sessions,
            self.order_state
                .agent_order_by_worktree_key
                .get(&key)
                .map(Vec::as_slice),
        )
    }

    pub fn shared_path(&self) -> PathBuf {
        self.project_state_dir.join("dashboard-ui.json")
    }

    pub fn client_path(&self, client_key: &str) -> PathBuf {
        self.project_state_dir
            .join(format!("dashboard-ui-client-{client_key}.json"))
    }

    fn read_json(&self, path: &Path) -> Option<Value> {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DashboardMoveOrderResult {
    moved: bool,
    order: Vec<String>,
}

pub fn run_dashboard_ui_state_store_contract_case(input: &Value) -> Value {
    let root = temp_contract_dir("dashboard-ui-state-store");
    fs::create_dir_all(&root).expect("create dashboard ui state contract temp dir");
    let output = if input.get("clientId").is_some() {
        dashboard_ui_state_case_persist_split(&root)
    } else if input.get("clients").is_some() {
        dashboard_ui_state_case_load_independent(&root)
    } else if input.get("previewSource").is_some() {
        dashboard_ui_state_case_preview_source(&root, input)
    } else if input.get("persistedScreen").is_some() {
        dashboard_ui_state_case_screen_normalization(&root, input)
    } else if input
        .get("persistedSelectedEntryId")
        .and_then(Value::as_str)
        == Some("claude-1")
    {
        dashboard_ui_state_case_rearms_selection(&root)
    } else if input.get("preferredEntryId").is_some()
        && input
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.contains("non-session"))
    {
        dashboard_ui_state_case_preferred_across_non_session()
    } else if input.get("preferredEntryId").is_some() {
        dashboard_ui_state_case_preferred_until_entry()
    } else if input
        .get("persistedSelectedEntryId")
        .and_then(Value::as_str)
        == Some("gone-agent")
    {
        dashboard_ui_state_case_stale_persisted_selection(&root)
    } else if input.get("manualEntryId").is_some() {
        dashboard_ui_state_case_manual_selection(&root)
    } else if input.get("move").is_some() {
        dashboard_ui_state_case_order(&root)
    } else {
        Value::Null
    };
    let _ = fs::remove_dir_all(root);
    output
}

pub fn run_dashboard_ui_state_store_named_contract_case(name: &str, input: &Value) -> Value {
    let mut tagged = input.clone();
    if let Value::Object(object) = &mut tagged {
        object.insert("name".to_owned(), Value::String(name.to_owned()));
    }
    run_dashboard_ui_state_store_contract_case(&tagged)
}

fn dashboard_ui_state_case_persist_split(root: &Path) -> Value {
    let mut store = DashboardUiStateStore::new(root);
    let state = DashboardUiState {
        screen: "activity".to_owned(),
        details_sidebar_visible: false,
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "claude-1" })],
        ..DashboardUiState::default()
    };
    store.persist(
        "dashboard",
        "client-a",
        &state,
        0,
        &[json!({ "id": "claude-1" })],
    );
    json!({
        "shared": read_json_or_null(store.shared_path()),
        "client": read_json_or_null(store.client_path("client-a")),
    })
}

fn dashboard_ui_state_case_load_independent(root: &Path) -> Value {
    let mut store = DashboardUiStateStore::new(root);
    let client_a = DashboardUiState {
        screen: "threads".to_owned(),
        details_sidebar_visible: false,
        focused_worktree_path: Some("/repo/wt-a".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "claude-a" })],
        ..DashboardUiState::default()
    };
    store.persist(
        "dashboard",
        "client-a",
        &client_a,
        0,
        &[json!({ "id": "claude-a" })],
    );
    let client_b = DashboardUiState {
        screen: "coordination".to_owned(),
        details_sidebar_visible: false,
        focused_worktree_path: Some("/repo/wt-b".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "claude-b" })],
        ..DashboardUiState::default()
    };
    store.persist(
        "dashboard",
        "client-b",
        &client_b,
        0,
        &[json!({ "id": "claude-b" })],
    );
    let mut state = DashboardUiState::default();
    store.load_into(&mut state, "client-b");
    json!({ "state": state.snapshot() })
}

fn dashboard_ui_state_case_preview_source(root: &Path, input: &Value) -> Value {
    let mut writer = DashboardUiStateStore::new(root);
    let state = DashboardUiState {
        preview_source: input
            .get("previewSource")
            .and_then(Value::as_str)
            .unwrap_or("output")
            .to_owned(),
        ..DashboardUiState::default()
    };
    writer.persist("dashboard", "client-a", &state, 0, &[]);
    let mut state = DashboardUiState {
        preview_source: input
            .get("initialPreviewSource")
            .and_then(Value::as_str)
            .unwrap_or("output")
            .to_owned(),
        ..DashboardUiState::default()
    };
    DashboardUiStateStore::new(root).load_shared_state(Some(&mut state));
    json!({
        "state": state.snapshot(),
        "shared": read_json_or_null(DashboardUiStateStore::new(root).shared_path()),
    })
}

fn dashboard_ui_state_case_screen_normalization(root: &Path, input: &Value) -> Value {
    let mut store = DashboardUiStateStore::new(root);
    let persisted = DashboardUiState {
        screen: input
            .get("persistedScreen")
            .and_then(Value::as_str)
            .unwrap_or("dashboard")
            .to_owned(),
        ..DashboardUiState::default()
    };
    let client = if persisted.screen == "bogus" {
        "weird"
    } else {
        "legacy"
    };
    store.persist("dashboard", client, &persisted, 0, &[]);
    let mut state = DashboardUiState {
        screen: input
            .get("initialScreen")
            .and_then(Value::as_str)
            .unwrap_or("dashboard")
            .to_owned(),
        ..DashboardUiState::default()
    };
    store.load_into(&mut state, client);
    json!({ "state": state.snapshot() })
}

fn dashboard_ui_state_case_rearms_selection(root: &Path) -> Value {
    let mut writer = DashboardUiStateStore::new(root);
    let persisted = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "claude-1" })],
        ..DashboardUiState::default()
    };
    writer.persist(
        "dashboard",
        "client-a",
        &persisted,
        0,
        &[json!({ "id": "claude-1" })],
    );
    let mut state = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![
            json!({ "kind": "session", "id": "other-0" }),
            json!({ "kind": "session", "id": "claude-1" }),
        ],
        ..DashboardUiState::default()
    };
    let mut store = DashboardUiStateStore::new(root);
    let mut active_index = 0;
    store.mark_selection_dirty();
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    let before_load_index = state.session_index;
    store.load_into(&mut state, "client-a");
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    json!({
        "beforeLoadIndex": before_load_index,
        "afterLoadIndex": state.session_index,
        "state": state.snapshot(),
    })
}

fn dashboard_ui_state_case_preferred_until_entry() -> Value {
    let mut state = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "old-agent" })],
        ..DashboardUiState::default()
    };
    let mut store = DashboardUiStateStore::new(temp_contract_dir("dashboard-ui-state-unused"));
    store.prefer_entry_selection(&mut state, "session", "new-agent", Some("/repo/wt"));
    let mut active_index = 0;
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    let before_entry_appears = state.session_index;
    state.worktree_entries = vec![
        json!({ "kind": "session", "id": "new-agent" }),
        json!({ "kind": "session", "id": "old-agent" }),
    ];
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    json!({
        "beforeEntryAppears": before_entry_appears,
        "afterEntryAppears": state.session_index,
        "state": state.snapshot(),
    })
}

fn dashboard_ui_state_case_preferred_across_non_session() -> Value {
    let mut state = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "old-agent" })],
        ..DashboardUiState::default()
    };
    let mut store = DashboardUiStateStore::new(temp_contract_dir("dashboard-ui-state-unused"));
    store.prefer_entry_selection(&mut state, "session", "new-agent", Some("/repo/wt"));
    state.level = "worktrees".to_owned();
    let mut active_index = 0;
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    let during_worktree_view = state.session_index;
    state.level = "sessions".to_owned();
    state.worktree_entries = vec![
        json!({ "kind": "session", "id": "old-agent" }),
        json!({ "kind": "session", "id": "new-agent" }),
    ];
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    json!({
        "duringWorktreeView": during_worktree_view,
        "afterSessionView": state.session_index,
        "state": state.snapshot(),
    })
}

fn dashboard_ui_state_case_stale_persisted_selection(root: &Path) -> Value {
    let mut writer = DashboardUiStateStore::new(root);
    let persisted = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "gone-agent" })],
        ..DashboardUiState::default()
    };
    writer.persist(
        "dashboard",
        "client-a",
        &persisted,
        0,
        &[json!({ "id": "gone-agent" })],
    );
    let mut state = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "remaining-agent" })],
        ..DashboardUiState::default()
    };
    let mut store = DashboardUiStateStore::new(root);
    store.load_into(&mut state, "client-a");
    let mut active_index = 0;
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    let after_missing_entry = state.session_index;
    state.worktree_entries = vec![
        json!({ "kind": "session", "id": "later-agent" }),
        json!({ "kind": "session", "id": "remaining-agent" }),
    ];
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    json!({
        "afterMissingEntry": after_missing_entry,
        "afterLaterRefresh": state.session_index,
        "state": state.snapshot(),
    })
}

fn dashboard_ui_state_case_manual_selection(root: &Path) -> Value {
    let mut writer = DashboardUiStateStore::new(root);
    let persisted = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        worktree_entries: vec![json!({ "kind": "session", "id": "old-agent" })],
        ..DashboardUiState::default()
    };
    writer.persist(
        "dashboard",
        "client-a",
        &persisted,
        0,
        &[json!({ "id": "old-agent" })],
    );
    let mut state = DashboardUiState {
        focused_worktree_path: Some("/repo/wt".to_owned()),
        level: "sessions".to_owned(),
        session_index: 1,
        worktree_entries: vec![
            json!({ "kind": "session", "id": "old-agent" }),
            json!({ "kind": "session", "id": "manual-agent" }),
        ],
        ..DashboardUiState::default()
    };
    let mut store = DashboardUiStateStore::new(root);
    store.load_into(&mut state, "client-a");
    store.remember_current_entry_selection(&state);
    state.worktree_entries = vec![
        json!({ "kind": "session", "id": "inserted-agent" }),
        json!({ "kind": "session", "id": "old-agent" }),
        json!({ "kind": "session", "id": "manual-agent" }),
    ];
    state.session_index = 1;
    let mut active_index = 0;
    store.mark_selection_dirty();
    store.consume_selection_restore(&mut state, &[], true, &mut active_index);
    json!({
        "finalIndex": state.session_index,
        "state": state.snapshot(),
    })
}

fn dashboard_ui_state_case_order(root: &Path) -> Value {
    let mut store = DashboardUiStateStore::new(root);
    let state = DashboardUiState::default();
    let moved = store.move_entry_within_worktree(
        "session",
        Some("/repo/wt"),
        "agent-a",
        "down",
        &[json!({ "id": "agent-a" }), json!({ "id": "agent-b" })],
        &[],
    );
    store.persist("dashboard", "client-a", &state, 0, &[]);
    let mut next = DashboardUiStateStore::new(root);
    next.load_into(&mut DashboardUiState::default(), "client-a");
    json!({
        "moved": moved,
        "ordered": next.order_sessions_for_worktree(
            &[json!({ "id": "agent-a" }), json!({ "id": "agent-b" })],
            Some("/repo/wt")
        ),
        "shared": read_json_or_null(store.shared_path()),
    })
}

fn dashboard_order_key(worktree_path: Option<&str>) -> String {
    worktree_path.unwrap_or("__main__").to_owned()
}

fn normalize_persisted_screen(screen: &str) -> String {
    match screen {
        "dashboard" | "coordination" | "project" | "library" | "topology" | "graveyard"
        | "help" => screen.to_owned(),
        "notifications" | "threads" | "workflow" => "coordination".to_owned(),
        "plans" => "library".to_owned(),
        _ => "dashboard".to_owned(),
    }
}

fn normalize_preview_source(value: Option<&Value>) -> String {
    if value.and_then(Value::as_str) == Some("scribe") {
        "scribe".to_owned()
    } else {
        "output".to_owned()
    }
}

fn sanitize_order_map(value: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    let mut output = BTreeMap::new();
    let Some(object) = value.and_then(Value::as_object) else {
        return output;
    };
    for (key, ids) in object {
        let clean_ids = ids
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !clean_ids.is_empty() {
            output.insert(key.clone(), clean_ids);
        }
    }
    output
}

fn has_order_entries(value: &BTreeMap<String, Vec<String>>) -> bool {
    value.values().any(|ids| !ids.is_empty())
}

fn order_map_value(value: &BTreeMap<String, Vec<String>>) -> Value {
    let mut object = Map::new();
    for (key, ids) in value {
        object.insert(key.clone(), json!(ids));
    }
    Value::Object(object)
}

fn normalize_dashboard_order(items: &[Value], saved_order: Option<&[String]>) -> Vec<String> {
    let current_ids = items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let current = current_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for id in saved_order.into_iter().flatten() {
        if current.contains(id) && seen.insert(id.clone()) {
            normalized.push(id.clone());
        }
    }
    for id in current_ids {
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    normalized
}

fn apply_dashboard_order(items: &[Value], saved_order: Option<&[String]>) -> Vec<Value> {
    let order = normalize_dashboard_order(items, saved_order);
    let by_id = items
        .iter()
        .filter_map(|item| Some((item.get("id").and_then(Value::as_str)?, item.clone())))
        .collect::<BTreeMap<_, _>>();
    order
        .into_iter()
        .filter_map(|id| by_id.get(id.as_str()).cloned())
        .collect()
}

fn move_dashboard_order(
    items: &[Value],
    saved_order: Option<&[String]>,
    selected_id: &str,
    direction: &str,
) -> DashboardMoveOrderResult {
    let mut order = normalize_dashboard_order(items, saved_order);
    let Some(index) = order.iter().position(|id| id == selected_id) else {
        return DashboardMoveOrderResult {
            moved: false,
            order,
        };
    };
    let next_index = if direction == "up" {
        index.checked_sub(1)
    } else {
        Some(index + 1)
    };
    let Some(next_index) = next_index.filter(|next| *next < order.len()) else {
        return DashboardMoveOrderResult {
            moved: false,
            order,
        };
    };
    order.swap(index, next_index);
    DashboardMoveOrderResult { moved: true, order }
}

fn read_json_or_null(path: impl AsRef<Path>) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null)
}

fn temp_contract_dir(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
