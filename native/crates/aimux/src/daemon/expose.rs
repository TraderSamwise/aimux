use crate::daemon::json::ExposeFocusRequest;
use crate::daemon::routing::DaemonRouteUrl;
use crate::daemon_projects::ProjectsRouteProject;
use crate::daemon_state::load_metadata_state;
use crate::paths::PathResolver;
use crate::project_catalog::{hidden_project_tmp_dirs, list_registered_desktop_projects};
use crate::project_service::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, assign_worktree_tones, dashboard_worktree_order_paths,
    expose_tile_context_for_item, order_expose_items,
};
use crate::project_service::switchable_agents::{
    AgentListScope, SwitchableContext, SwitchableListOptions, agent_status_chip,
    list_switchable_agent_items, serialize_fast_control_item, topology_switchable_entries,
};
use crate::project_service::usage::load_last_used_state;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};
use crate::tmux::{
    TmuxTarget, attach_session_argv, is_dashboard_window_name, is_tmux_client_session_for_host,
    list_clients_argv, list_windows_argv, refresh_status_argv, send_focus_in_argv,
    switch_client_argv, switch_client_to_target_argv,
};
use crate::tmux_expose::{ExposeScope, ExposeScopeView};
use crate::tmux_expose_hot_snapshot::{HotExposeScopeKey, read_hot_expose_scope_view};
use crate::tmux_expose_hot_snapshot_worker::{
    ExposeHotSnapshotWorkerProject, refresh_global_expose_hot_snapshots,
};
use crate::visual_client_leases_contract::{VisualClientLeaseRegistry, parse_visual_client_kind};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const GLOBAL_EXPOSE_HOT_SNAPSHOT_REFRESH_MS: u64 = 3_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxClientInfo {
    pub tty: String,
    pub session_name: String,
    pub window_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxWindowInfo {
    pub id: String,
    pub index: i64,
    pub name: String,
    pub pane_dead: bool,
}

#[derive(Clone)]
pub struct GlobalExposeHotSnapshotCoordinator {
    leases: Arc<Mutex<VisualClientLeaseRegistry>>,
    refresh: Arc<Mutex<GlobalExposeHotSnapshotRefreshState>>,
    background_refresh_enabled: bool,
    refresh_delay_ms: u64,
}

#[derive(Debug, Default)]
struct GlobalExposeHotSnapshotRefreshState {
    scheduled: bool,
    refreshing: bool,
}

impl std::fmt::Debug for GlobalExposeHotSnapshotCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GlobalExposeHotSnapshotCoordinator")
            .field(
                "background_refresh_enabled",
                &self.background_refresh_enabled,
            )
            .field("refresh_delay_ms", &self.refresh_delay_ms)
            .finish_non_exhaustive()
    }
}

impl Default for GlobalExposeHotSnapshotCoordinator {
    fn default() -> Self {
        Self::new(false)
    }
}

impl GlobalExposeHotSnapshotCoordinator {
    pub fn new(background_refresh_enabled: bool) -> Self {
        Self {
            leases: Arc::new(Mutex::new(VisualClientLeaseRegistry::default())),
            refresh: Arc::new(Mutex::new(GlobalExposeHotSnapshotRefreshState::default())),
            background_refresh_enabled,
            refresh_delay_ms: GLOBAL_EXPOSE_HOT_SNAPSHOT_REFRESH_MS,
        }
    }

    pub fn touch_route_lease(
        &self,
        route_url: &DaemonRouteUrl,
        projects: &[ProjectsRouteProject],
        project_state_dirs: BTreeMap<String, PathBuf>,
    ) -> bool {
        if route_url.search_param("includePreview") != Some("1")
            && route_url.search_param("includeChatPreview") != Some("1")
        {
            return false;
        }
        let kind =
            parse_visual_client_kind(route_url.search_param("clientKind").or(Some("expose")));
        let id = route_url
            .search_param("clientId")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_global_client_id(kind));
        let input = json!({
            "id": id,
            "kind": kind,
            "surface": "global-expose",
            "requestedPreview": route_url.search_param("includePreview") == Some("1"),
            "requestedChatPreview": route_url.search_param("includeChatPreview") == Some("1"),
            "ttlMs": route_url
                .search_param("clientTtlMs")
                .map(|value| Value::String(value.to_owned()))
                .unwrap_or(Value::Null),
        });
        let now = current_unix_millis();
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        leases.touch(&input, now);
        let active = leases.has_active_preview_clients(now);
        drop(leases);
        if active {
            self.schedule_global_refresh(worker_projects(projects), project_state_dirs);
        }
        active
    }

    fn has_active_preview_clients(&self) -> bool {
        self.leases
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .has_active_preview_clients(current_unix_millis())
    }

    fn schedule_global_refresh(
        &self,
        projects: Vec<ExposeHotSnapshotWorkerProject>,
        project_state_dirs: BTreeMap<String, PathBuf>,
    ) {
        if !self.background_refresh_enabled {
            return;
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if refresh.scheduled || refresh.refreshing {
                return;
            }
            refresh.scheduled = true;
        }
        let coordinator = self.clone();
        let delay = Duration::from_millis(self.refresh_delay_ms);
        thread::spawn(move || {
            thread::sleep(delay);
            coordinator.run_scheduled_global_refresh(projects, project_state_dirs);
        });
    }

    fn run_scheduled_global_refresh(
        &self,
        projects: Vec<ExposeHotSnapshotWorkerProject>,
        project_state_dirs: BTreeMap<String, PathBuf>,
    ) {
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.scheduled = false;
            if refresh.refreshing {
                return;
            }
            refresh.refreshing = true;
        }
        if self.has_active_preview_clients() {
            refresh_global_expose_hot_snapshots(&projects, |id| {
                project_state_dirs.get(id).cloned().unwrap_or_default()
            });
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.refreshing = false;
        }
        if self.has_active_preview_clients() {
            self.schedule_global_refresh(projects, project_state_dirs);
        }
    }
}

pub trait DaemonExposeFocusRuntime {
    fn list_clients(&mut self) -> Result<Vec<TmuxClientInfo>, String>;
    fn target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Result<Option<TmuxTarget>, String>;
    fn switch_client_to_target(&mut self, client_tty: &str, window_id: &str) -> Result<(), String>;
    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String>;
    fn attach_session(
        &mut self,
        session_name: &str,
        window_index: Option<i64>,
    ) -> Result<(), String>;
    fn refresh_status(&mut self);
    fn send_focus_in(&mut self, window_id: &str) -> Result<(), String>;
}

pub struct SystemDaemonExposeFocusRuntime;

impl DaemonExposeFocusRuntime for SystemDaemonExposeFocusRuntime {
    fn list_clients(&mut self) -> Result<Vec<TmuxClientInfo>, String> {
        let raw = run_tmux_argv_output(list_clients_argv(), "tmux list-clients failed".to_owned())?;
        Ok(parse_tmux_clients(&raw))
    }

    fn target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Result<Option<TmuxTarget>, String> {
        let raw = run_tmux_argv_output(
            list_windows_argv(session_name),
            format!("tmux list-windows failed for {session_name}"),
        )?;
        Ok(parse_tmux_windows(&raw)
            .into_iter()
            .find(|window| window.id == window_id)
            .map(|window| TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: window.id,
                window_index: window.index,
                window_name: window.name,
                pane_dead: Some(window.pane_dead),
            }))
    }

    fn switch_client_to_target(&mut self, client_tty: &str, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            switch_client_to_target_argv(client_tty, window_id),
            format!("failed to focus window {window_id}"),
        )
    }

    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String> {
        run_tmux_argv(
            switch_client_argv(session_name, window_index, None),
            format!("failed to switch client to {session_name}:{window_index}"),
        )
    }

    fn attach_session(
        &mut self,
        session_name: &str,
        window_index: Option<i64>,
    ) -> Result<(), String> {
        let target = window_index
            .map(|index| format!("{session_name}:{index}"))
            .unwrap_or_else(|| session_name.to_owned());
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(format!(
                "cannot attach to tmux session {target} without a terminal; run \"tmux attach -t {target}\" yourself"
            ));
        }
        run_tmux_argv(
            attach_session_argv(session_name, window_index),
            format!("tmux attach -t {target} failed"),
        )
    }

    fn refresh_status(&mut self) {
        let _ = run_tmux_argv(
            refresh_status_argv(),
            "tmux refresh-client failed".to_owned(),
        );
    }

    fn send_focus_in(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            send_focus_in_argv(window_id),
            format!("tmux send focus-in failed for {window_id}"),
        )
    }
}

pub fn expose_items_route(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    path: &str,
    projects_for_refresh: &[ProjectsRouteProject],
    hot_snapshots: &GlobalExposeHotSnapshotCoordinator,
) -> Result<Value, String> {
    let route_url = DaemonRouteUrl::parse(path);
    let include_preview = route_url.search_param("includePreview") == Some("1");
    let include_chat_preview = route_url.search_param("includeChatPreview") == Some("1");
    let project_state_dirs = project_state_dirs_by_id(resolver, projects_for_refresh);
    let items = list_all_projects_expose_items(resolver, session_prefix_for_project)?;
    let ordered = order_global_expose_items(resolver, items);
    if include_preview || include_chat_preview {
        hot_snapshots.touch_route_lease(
            &route_url,
            projects_for_refresh,
            project_state_dirs.clone(),
        );
    }
    let hot_previews = if include_preview {
        hot_preview_snapshots_for_global_items(resolver, &ordered)
    } else {
        BTreeMap::new()
    };
    let tones = assign_worktree_tones(&ordered, "/");
    let items = ordered
        .iter()
        .map(|item| {
            serialize_global_expose_item(
                item,
                &tones,
                preview_key_for_item(item).and_then(|key| hot_previews.get(&key)),
            )
        })
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "items": items }))
}

pub fn expose_focus_route(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    request: ExposeFocusRequest,
) -> Result<Value, String> {
    let mut runtime = SystemDaemonExposeFocusRuntime;
    expose_focus_route_with_runtime(resolver, session_prefix_for_project, request, &mut runtime)
}

pub fn expose_focus_route_with_runtime<R: DaemonExposeFocusRuntime>(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    request: ExposeFocusRequest,
    runtime: &mut R,
) -> Result<Value, String> {
    let items = list_all_projects_expose_items(resolver, session_prefix_for_project)?;
    let project_root = request.project_root.as_deref().map(normalize_path_string);
    let Some(item) = items.iter().find(|candidate| {
        target_string_field(&candidate.target, "windowId") == Some(request.window_id.as_str())
            && project_root.as_deref().is_none_or(|root| {
                candidate.project_root.as_deref().map(normalize_path_string)
                    == Some(root.to_owned())
            })
    }) else {
        return Err("window not found".to_owned());
    };
    let target = tmux_target_from_value(&item.target)?;
    let focus_result = open_target_for_client(
        runtime,
        &target,
        request.current_client_session.as_deref(),
        request.client_tty.as_deref(),
    )?;
    Ok(json!({
        "ok": true,
        "action": "expose-focus",
        "focused": focus_result.get("focused").and_then(Value::as_bool).unwrap_or(true),
        "focusMode": focus_result.get("focusMode").and_then(Value::as_str).unwrap_or("open-target"),
        "itemId": item.id,
        "projectId": item.project_id,
        "projectName": item.project_name,
        "projectRoot": item.project_root,
        "target": item.target,
    }))
}

pub fn open_target_for_client<R: DaemonExposeFocusRuntime>(
    runtime: &mut R,
    target: &TmuxTarget,
    current_client_session: Option<&str>,
    client_tty: Option<&str>,
) -> Result<Value, String> {
    let live_client_tty =
        match resolve_live_client_tty(runtime, current_client_session, client_tty)? {
            Some(client_tty) => Some(client_tty),
            None => attached_client_for_target(runtime, target)?,
        };
    if let Some(live_client_tty) = live_client_tty {
        runtime.switch_client_to_target(&live_client_tty, &target.window_id)?;
        runtime.refresh_status();
        send_dashboard_focus_in(runtime, target)?;
        return Ok(json!({ "focused": true, "focusMode": "client-tty" }));
    }
    if let Some(current_client_session) = current_client_session
        && let Some(linked_target) =
            runtime.target_by_window_id(current_client_session, &target.window_id)?
    {
        runtime.switch_client(current_client_session, linked_target.window_index)?;
        runtime.refresh_status();
        send_dashboard_focus_in(runtime, &linked_target)?;
        return Ok(json!({ "focused": true, "focusMode": "linked-client-session" }));
    }
    runtime.attach_session(&target.session_name, Some(target.window_index))?;
    runtime.refresh_status();
    Ok(json!({ "focused": true, "focusMode": "open-target" }))
}

fn resolve_live_client_tty<R: DaemonExposeFocusRuntime>(
    runtime: &mut R,
    current_client_session: Option<&str>,
    preferred_client_tty: Option<&str>,
) -> Result<Option<String>, String> {
    let clients = runtime.list_clients()?;
    if let Some(normalized_tty) = preferred_client_tty
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && clients.iter().any(|client| client.tty == normalized_tty)
    {
        return Ok(Some(normalized_tty.to_owned()));
    }
    let Some(normalized_session) = current_client_session
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    Ok(clients
        .into_iter()
        .find(|client| client.session_name == normalized_session)
        .map(|client| client.tty))
}

fn attached_client_for_target<R: DaemonExposeFocusRuntime>(
    runtime: &mut R,
    target: &TmuxTarget,
) -> Result<Option<String>, String> {
    let clients = runtime
        .list_clients()?
        .into_iter()
        .filter(|client| {
            client.session_name == target.session_name
                || is_tmux_client_session_for_host(&client.session_name, &target.session_name)
        })
        .collect::<Vec<_>>();
    Ok(clients
        .iter()
        .find(|client| client.window_id == target.window_id)
        .or_else(|| clients.first())
        .map(|client| client.tty.clone()))
}

fn send_dashboard_focus_in<R: DaemonExposeFocusRuntime>(
    runtime: &mut R,
    target: &TmuxTarget,
) -> Result<(), String> {
    if is_dashboard_window_name(&target.window_name) {
        runtime.send_focus_in(&target.window_id)?;
    }
    Ok(())
}

pub fn list_all_projects_expose_items(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
) -> Result<Vec<crate::project_service::switchable_agents::SwitchableAgentItem>, String> {
    let entries = resolver
        .list_projects()
        .map_err(|error| format!("failed to list projects: {error}"))?;
    let tmp_dirs = hidden_project_tmp_dirs(std::env::temp_dir());
    let projects = list_registered_desktop_projects(&entries, &tmp_dirs, |entry| {
        session_prefix_for_project(&entry.repo_root)
    });
    let mut items = Vec::new();
    for project in projects {
        let project_state_dir = resolver.project_state_dir_for(&project.path);
        let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
        if topology
            .get("sessions")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
            && topology
                .get("services")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            continue;
        }
        let metadata = load_metadata_state(&project_state_dir);
        let entries = topology_switchable_entries(&topology, &metadata.sessions);
        if entries.is_empty() {
            continue;
        }
        let last_used = load_last_used_state(&project_state_dir);
        let context = SwitchableContext {
            project_root: project.path.clone(),
            current_path: Some(project.path.clone()),
            current_window: None,
            current_window_id: None,
            current_client_session: None,
        };
        let options = SwitchableListOptions {
            scope: AgentListScope::All,
            raw_labels: true,
            ..SwitchableListOptions::default()
        };
        let mut project_items = list_switchable_agent_items(
            &entries,
            &metadata.sessions,
            &context,
            &options,
            &last_used,
        );
        for item in &mut project_items {
            item.project_id = Some(project.id.clone());
            item.project_name = Some(project.name.clone());
            item.project_root = Some(project.path.clone());
        }
        items.extend(project_items);
    }
    Ok(items)
}

fn order_global_expose_items(
    resolver: &mut PathResolver,
    items: Vec<crate::project_service::switchable_agents::SwitchableAgentItem>,
) -> Vec<crate::project_service::switchable_agents::SwitchableAgentItem> {
    let mut options = ExposeOrderingOptions::default();
    for item in &items {
        let Some(project_root) = item.project_root.as_deref() else {
            continue;
        };
        if options
            .worktree_order_by_project_root
            .contains_key(&normalize_path_string(project_root))
        {
            continue;
        }
        let topology_path = runtime_topology_path(resolver.project_state_dir_for(project_root));
        if let Ok(topology) = read_runtime_topology(topology_path) {
            options.worktree_order_by_project_root.insert(
                normalize_path_string(project_root),
                dashboard_worktree_order_paths(project_root, &topology),
            );
        }
    }
    order_expose_items(&items, "/", ExposeSublabel::ProjectWorktree, &options)
}

fn serialize_global_expose_item(
    item: &crate::project_service::switchable_agents::SwitchableAgentItem,
    tones: &BTreeMap<String, i64>,
    preview_snapshot: Option<&Value>,
) -> Value {
    let mut serialized = serialize_fast_control_item(item);
    if let Value::Object(map) = &mut serialized {
        if let Some(preview_snapshot) = preview_snapshot {
            map.insert("previewSnapshot".into(), preview_snapshot.clone());
        }
        map.insert(
            "exposeContext".into(),
            expose_tile_context_for_item(item, ExposeSublabel::ProjectWorktree, "/", tones),
        );
        if let Some(chip) = agent_status_chip(&item.metadata) {
            map.insert("exposeStatus".into(), chip);
        }
    }
    serialized
}

fn project_state_dirs_by_id(
    resolver: &mut PathResolver,
    projects: &[ProjectsRouteProject],
) -> BTreeMap<String, PathBuf> {
    projects
        .iter()
        .map(|project| {
            (
                project.id.clone(),
                resolver.project_state_dir_for(&project.path),
            )
        })
        .collect()
}

fn hot_preview_snapshots_for_global_items(
    resolver: &mut PathResolver,
    items: &[crate::project_service::switchable_agents::SwitchableAgentItem],
) -> BTreeMap<String, Value> {
    let mut previews = BTreeMap::new();
    let mut roots = items
        .iter()
        .filter_map(|item| item.project_root.as_deref())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    for project_root in roots {
        let project_state_dir = resolver.project_state_dir_for(&project_root);
        let Some(view) = read_hot_expose_scope_view(
            project_state_dir,
            &HotExposeScopeKey {
                project_root: project_root.clone(),
                scope: ExposeScope::Project,
                worktree_key: None,
                launch_window_id: None,
            },
        ) else {
            continue;
        };
        insert_hot_preview_snapshots(&mut previews, &project_root, &view);
    }
    previews
}

fn insert_hot_preview_snapshots(
    previews: &mut BTreeMap<String, Value>,
    project_root: &str,
    view: &ExposeScopeView,
) {
    for item in &view.items {
        let Some(window_id) = item
            .get("target")
            .and_then(|target| target.get("windowId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(preview) = item.get("previewSnapshot") else {
            continue;
        };
        previews.insert(global_preview_key(project_root, window_id), preview.clone());
    }
}

fn preview_key_for_item(
    item: &crate::project_service::switchable_agents::SwitchableAgentItem,
) -> Option<String> {
    let project_root = item.project_root.as_deref()?;
    let window_id = item.target.get("windowId").and_then(Value::as_str)?;
    Some(global_preview_key(project_root, window_id))
}

fn global_preview_key(project_root: &str, window_id: &str) -> String {
    format!("{project_root}\0{window_id}")
}

fn worker_projects(projects: &[ProjectsRouteProject]) -> Vec<ExposeHotSnapshotWorkerProject> {
    projects
        .iter()
        .map(|project| ExposeHotSnapshotWorkerProject {
            id: project.id.clone(),
            name: project.name.clone(),
            path: project.path.clone(),
            service_alive: project.service_alive,
        })
        .collect()
}

fn default_global_client_id(kind: &str) -> &str {
    match kind {
        "tui" => "tui:global",
        "web" => "web:global",
        "mobile" => "mobile:global",
        "expose" => "expose:global",
        _ => "api:global",
    }
}

fn current_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn normalize_path_string(path: &str) -> String {
    normalize_path(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut result = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn target_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn target_number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value as i64))
    })
}

fn tmux_target_from_value(value: &Value) -> Result<TmuxTarget, String> {
    Ok(TmuxTarget {
        session_name: target_string_field(value, "sessionName")
            .ok_or_else(|| "target session name is missing".to_owned())?
            .to_owned(),
        window_id: target_string_field(value, "windowId")
            .ok_or_else(|| "target window id is missing".to_owned())?
            .to_owned(),
        window_index: target_number_field(value, "windowIndex")
            .ok_or_else(|| "target window index is missing".to_owned())?,
        window_name: target_string_field(value, "windowName")
            .ok_or_else(|| "target window name is missing".to_owned())?
            .to_owned(),
        pane_dead: value.get("paneDead").and_then(Value::as_bool),
    })
}

fn parse_tmux_clients(raw: &str) -> Vec<TmuxClientInfo> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            TmuxClientInfo {
                tty: parts.next().unwrap_or_default().to_owned(),
                session_name: parts.next().unwrap_or_default().to_owned(),
                window_id: parts.next().unwrap_or_default().to_owned(),
                name: parts.next().unwrap_or_default().to_owned(),
            }
        })
        .collect()
}

fn parse_tmux_windows(raw: &str) -> Vec<TmuxWindowInfo> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            TmuxWindowInfo {
                id: parts.next().unwrap_or_default().to_owned(),
                index: parts
                    .next()
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or_default(),
                name: parts.next().unwrap_or_default().to_owned(),
                pane_dead: parts.nth(2) == Some("1"),
            }
        })
        .collect()
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    run_tmux_argv_output(argv, fallback_error).map(|_| ())
}

fn run_tmux_argv_output(argv: Vec<String>, fallback_error: String) -> Result<String, String> {
    let output = Command::new("tmux").args(argv).output();
    match output {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}
