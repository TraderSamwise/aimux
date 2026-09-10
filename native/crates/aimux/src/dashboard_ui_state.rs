use crate::atomic_write::write_json_atomic;
use crate::dashboard_controller::DashboardScreen;
use crate::dashboard_model::{
    DashboardSession, DesktopStateSnapshot, is_dashboard_project_control_session,
};
use crate::dashboard_navigation::{DashboardEntryRef, DashboardNavigationState};
use crate::dashboard_renderer::DashboardNavLevel;
use crate::paths::PathResolver;
use crate::tmux::tmux_command_from_env;
use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DashboardUiStatePersistence {
    project_state_dir: PathBuf,
    path: PathBuf,
    client_session: String,
    last_screen: Option<DashboardScreen>,
    last_preview_source: Option<String>,
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
        let client_snapshot = read_dashboard_state_snapshot(&path);
        let shared_snapshot =
            read_dashboard_state_snapshot(&shared_dashboard_state_path(project_state_dir.as_ref()));
        let last_screen = client_snapshot
            .as_ref()
            .and_then(read_dashboard_screen_from_snapshot);
        let last_preview_source = shared_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.get("previewSource"))
            .map(|value| normalize_preview_source(Some(value)));
        Ok(Self {
            project_state_dir: project_state_dir.as_ref().to_path_buf(),
            path,
            client_session: client_session.to_owned(),
            last_screen,
            last_preview_source,
        })
    }

    pub fn load_screen(&self) -> Option<DashboardScreen> {
        self.last_screen
    }

    pub fn load_preview_source(&self) -> Option<&str> {
        self.last_preview_source.as_deref()
    }

    pub fn load_details_sidebar_visible(&self) -> Option<bool> {
        read_dashboard_state_snapshot(&self.shared_path()).and_then(|snapshot| {
            snapshot
                .get("detailsSidebarVisible")
                .and_then(Value::as_bool)
        })
    }

    pub fn persist_screen(&mut self, screen: DashboardScreen) -> Result<bool> {
        if self.last_screen == Some(screen) {
            return Ok(false);
        }
        let mut snapshot = read_dashboard_state_snapshot(&self.path)
            .unwrap_or_else(|| Value::Object(Default::default()));
        snapshot["screen"] = Value::String(screen.as_str().to_owned());
        write_json_atomic(&self.path, &snapshot)
            .with_context(|| format!("write dashboard ui state {}", self.path.display()))?;
        self.last_screen = Some(screen);
        Ok(true)
    }

    pub fn persist_render_state(
        &mut self,
        screen: DashboardScreen,
        preview_source: &str,
    ) -> Result<bool> {
        let preview_source =
            normalize_preview_source(Some(&Value::String(preview_source.to_owned())));
        if self.last_screen == Some(screen)
            && self.last_preview_source.as_deref() == Some(preview_source.as_str())
        {
            return Ok(false);
        }
        let mut client = read_dashboard_state_snapshot(&self.path)
            .unwrap_or_else(|| Value::Object(Default::default()));
        let mut shared = read_dashboard_state_snapshot(&self.shared_path())
            .unwrap_or_else(|| Value::Object(Default::default()));
        client["screen"] = Value::String(screen.as_str().to_owned());
        shared["previewSource"] = Value::String(preview_source.clone());
        let changed = read_dashboard_state_snapshot(&self.path).as_ref() != Some(&client)
            || read_dashboard_state_snapshot(&self.shared_path()).as_ref() != Some(&shared);
        if changed {
            write_json_atomic(&self.path, &client)
                .with_context(|| format!("write dashboard ui state {}", self.path.display()))?;
            write_json_atomic(self.shared_path(), &shared).with_context(|| {
                format!("write dashboard ui state {}", self.shared_path().display())
            })?;
        }
        self.last_screen = Some(screen);
        self.last_preview_source = Some(preview_source);
        Ok(changed)
    }

    pub fn restore_navigation(
        &self,
        navigation: &mut DashboardNavigationState,
        snapshot: &DesktopStateSnapshot,
    ) {
        let Some(state) = read_dashboard_state_snapshot(&self.path) else {
            return;
        };
        restore_worktree_focus(navigation, snapshot, &state);
        restore_navigation_level(navigation, snapshot, &state);
        restore_selected_entry(navigation, snapshot, &state);
        navigation.clamp(snapshot);
    }

    pub fn persist_controller_state(
        &mut self,
        screen: DashboardScreen,
        preview_source: &str,
        details_sidebar_visible: bool,
        snapshot: &DesktopStateSnapshot,
        navigation: &DashboardNavigationState,
    ) -> Result<bool> {
        let preview_source =
            normalize_preview_source(Some(&Value::String(preview_source.to_owned())));
        let mut client = read_dashboard_state_snapshot(&self.path)
            .unwrap_or_else(|| Value::Object(Default::default()));
        client["screen"] = Value::String(screen.as_str().to_owned());
        persist_navigation_state(&mut client, snapshot, navigation);

        let mut shared = read_dashboard_state_snapshot(&self.shared_path())
            .unwrap_or_else(|| Value::Object(Default::default()));
        shared["previewSource"] = Value::String(preview_source.clone());
        shared["detailsSidebarVisible"] = Value::Bool(details_sidebar_visible);

        let changed = read_dashboard_state_snapshot(&self.path).as_ref() != Some(&client)
            || read_dashboard_state_snapshot(&self.shared_path()).as_ref() != Some(&shared);
        if changed {
            write_json_atomic(&self.path, &client)
                .with_context(|| format!("write dashboard ui state {}", self.path.display()))?;
            write_json_atomic(self.shared_path(), &shared).with_context(|| {
                format!("write dashboard ui state {}", self.shared_path().display())
            })?;
        }
        self.last_screen = Some(screen);
        self.last_preview_source = Some(preview_source);
        Ok(changed)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn client_session(&self) -> &str {
        &self.client_session
    }

    pub fn apply_order_to_snapshot(&self, snapshot: &mut DesktopStateSnapshot) {
        let order_state = self.read_shared_order_state();
        if snapshot.worktree_groups.is_empty() {
            apply_typed_dashboard_order(
                &mut snapshot.sessions,
                order_state
                    .agent_order_by_worktree_key
                    .get("__main__")
                    .map(Vec::as_slice),
                |session| &session.id,
            );
            apply_typed_dashboard_order(
                &mut snapshot.services,
                order_state
                    .service_order_by_worktree_key
                    .get("__main__")
                    .map(Vec::as_slice),
                |service| &service.id,
            );
            return;
        }
        for group in &mut snapshot.worktree_groups {
            let key = dashboard_order_key(group.path.as_deref());
            apply_typed_dashboard_order(
                &mut group.sessions,
                order_state
                    .agent_order_by_worktree_key
                    .get(&key)
                    .map(Vec::as_slice),
                |session| &session.id,
            );
            apply_typed_dashboard_order(
                &mut group.services,
                order_state
                    .service_order_by_worktree_key
                    .get(&key)
                    .map(Vec::as_slice),
                |service| &service.id,
            );
        }
    }

    pub fn move_entry_within_worktree(
        &self,
        kind: &str,
        worktree_path: Option<&str>,
        selected_id: &str,
        direction: &str,
        sessions: &[String],
        services: &[String],
    ) -> Result<bool> {
        let key = dashboard_order_key(worktree_path);
        let mut order_state = self.read_shared_order_state();
        let session_values = ids_as_json_values(sessions);
        let service_values = ids_as_json_values(services);
        let moved = if kind == "session" {
            let result = move_dashboard_order(
                &session_values,
                order_state
                    .agent_order_by_worktree_key
                    .get(&key)
                    .map(Vec::as_slice),
                selected_id,
                direction,
            );
            if result.moved {
                order_state
                    .agent_order_by_worktree_key
                    .insert(key, result.order);
            }
            result.moved
        } else {
            let result = move_dashboard_order(
                &service_values,
                order_state
                    .service_order_by_worktree_key
                    .get(&key)
                    .map(Vec::as_slice),
                selected_id,
                direction,
            );
            if result.moved {
                order_state
                    .service_order_by_worktree_key
                    .insert(key, result.order);
            }
            result.moved
        };
        if moved {
            self.write_shared_order_state(&order_state)?;
        }
        Ok(moved)
    }

    fn shared_path(&self) -> PathBuf {
        shared_dashboard_state_path(&self.project_state_dir)
    }

    fn read_shared_order_state(&self) -> DashboardOrderState {
        let Some(snapshot) = read_dashboard_state_snapshot(&self.shared_path()) else {
            return DashboardOrderState::default();
        };
        DashboardOrderState {
            agent_order_by_worktree_key: sanitize_order_map(
                snapshot.get("agentOrderByWorktreeKey"),
            ),
            service_order_by_worktree_key: sanitize_order_map(
                snapshot.get("serviceOrderByWorktreeKey"),
            ),
        }
    }

    fn write_shared_order_state(&self, order_state: &DashboardOrderState) -> Result<()> {
        let mut shared = read_dashboard_state_snapshot(&self.shared_path())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if has_order_entries(&order_state.agent_order_by_worktree_key) {
            shared.insert(
                "agentOrderByWorktreeKey".to_owned(),
                order_map_value(&order_state.agent_order_by_worktree_key),
            );
        } else {
            shared.remove("agentOrderByWorktreeKey");
        }
        if has_order_entries(&order_state.service_order_by_worktree_key) {
            shared.insert(
                "serviceOrderByWorktreeKey".to_owned(),
                order_map_value(&order_state.service_order_by_worktree_key),
            );
        } else {
            shared.remove("serviceOrderByWorktreeKey");
        }
        write_json_atomic(self.shared_path(), &Value::Object(shared))
            .with_context(|| format!("write dashboard ui state {}", self.shared_path().display()))
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

fn read_dashboard_state_snapshot(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
}

fn shared_dashboard_state_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("dashboard-ui.json")
}

fn read_dashboard_screen_from_snapshot(value: &Value) -> Option<DashboardScreen> {
    let screen = value.get("screen").and_then(Value::as_str)?;
    DashboardScreen::parse(screen)
}

fn restore_worktree_focus(
    navigation: &mut DashboardNavigationState,
    snapshot: &DesktopStateSnapshot,
    state: &Value,
) {
    if snapshot.worktree_groups.is_empty() {
        navigation.worktree_index = 0;
        return;
    }
    let focused_path = state.get("focusedWorktreePath").and_then(Value::as_str);
    navigation.worktree_index = focused_path
        .and_then(|path| {
            snapshot
                .worktree_groups
                .iter()
                .position(|group| group.path.as_deref() == Some(path))
        })
        .unwrap_or(0);
}

fn restore_navigation_level(
    navigation: &mut DashboardNavigationState,
    snapshot: &DesktopStateSnapshot,
    state: &Value,
) {
    navigation.level = if snapshot.worktree_groups.is_empty()
        || state.get("level").and_then(Value::as_str) == Some("sessions")
    {
        DashboardNavLevel::Sessions
    } else {
        DashboardNavLevel::Worktrees
    };
}

fn restore_selected_entry(
    navigation: &mut DashboardNavigationState,
    snapshot: &DesktopStateSnapshot,
    state: &Value,
) {
    if snapshot.worktree_groups.is_empty() {
        if let Some(flat_session_id) = state.get("flatSessionId").and_then(Value::as_str) {
            navigation.item_index = snapshot
                .sessions
                .iter()
                .filter(|session| !is_project_control_session(session))
                .position(|session| session.id == flat_session_id)
                .unwrap_or(navigation.item_index);
        }
        return;
    }
    if navigation.level != DashboardNavLevel::Sessions {
        return;
    }
    let Some(kind) = state.get("selectedEntryKind").and_then(Value::as_str) else {
        return;
    };
    let Some(id) = state.get("selectedEntryId").and_then(Value::as_str) else {
        return;
    };
    let Some(group) = snapshot.worktree_groups.get(navigation.worktree_index) else {
        return;
    };
    let session_index = group
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .position(|session| kind == "session" && session.id == id);
    if let Some(index) = session_index {
        navigation.item_index = index;
        return;
    }
    let session_count = group
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .count();
    if let Some(index) = group
        .services
        .iter()
        .position(|service| kind == "service" && service.id == id)
    {
        navigation.item_index = session_count + index;
    }
}

fn persist_navigation_state(
    state: &mut Value,
    snapshot: &DesktopStateSnapshot,
    navigation: &DashboardNavigationState,
) {
    state["level"] = Value::String(
        match navigation.level {
            DashboardNavLevel::Sessions => "sessions",
            DashboardNavLevel::Worktrees => "worktrees",
        }
        .to_owned(),
    );
    persist_worktree_focus(state, snapshot, navigation);
    persist_selected_entry(state, snapshot, navigation);
}

fn persist_worktree_focus(
    state: &mut Value,
    snapshot: &DesktopStateSnapshot,
    navigation: &DashboardNavigationState,
) {
    if snapshot.worktree_groups.is_empty() {
        remove_object_key(state, "focusedWorktreePath");
        return;
    }
    if let Some(path) = snapshot
        .worktree_groups
        .get(navigation.worktree_index)
        .and_then(|group| group.path.as_deref())
    {
        state["focusedWorktreePath"] = Value::String(path.to_owned());
    } else {
        remove_object_key(state, "focusedWorktreePath");
    }
}

fn persist_selected_entry(
    state: &mut Value,
    snapshot: &DesktopStateSnapshot,
    navigation: &DashboardNavigationState,
) {
    let Some(entry) = navigation.selected_entry(snapshot) else {
        remove_object_key(state, "selectedEntryKind");
        remove_object_key(state, "selectedEntryId");
        return;
    };
    match entry {
        DashboardEntryRef::Session(session) => {
            state["selectedEntryKind"] = Value::String("session".into());
            state["selectedEntryId"] = Value::String(session.id.clone());
            if snapshot.worktree_groups.is_empty() {
                state["flatSessionId"] = Value::String(session.id.clone());
            }
        }
        DashboardEntryRef::Service(service) => {
            state["selectedEntryKind"] = Value::String("service".into());
            state["selectedEntryId"] = Value::String(service.id.clone());
        }
    }
}

fn remove_object_key(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}

fn is_project_control_session(session: &DashboardSession) -> bool {
    is_dashboard_project_control_session(session)
}

fn current_tmux_session() -> Option<String> {
    let output = tmux_command_from_env()
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

fn apply_typed_dashboard_order<T, F>(items: &mut Vec<T>, saved_order: Option<&[String]>, id: F)
where
    F: Fn(&T) -> &str,
{
    let Some(saved_order) = saved_order else {
        return;
    };
    let current_values = items
        .iter()
        .map(|item| json!({ "id": id(item) }))
        .collect::<Vec<_>>();
    let order = normalize_dashboard_order(&current_values, Some(saved_order));
    let mut by_id = items
        .drain(..)
        .map(|item| (id(&item).to_owned(), item))
        .collect::<BTreeMap<_, _>>();
    *items = order
        .into_iter()
        .filter_map(|entry_id| by_id.remove(&entry_id))
        .collect();
}

fn ids_as_json_values(ids: &[String]) -> Vec<Value> {
    ids.iter().map(|id| json!({ "id": id })).collect()
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
