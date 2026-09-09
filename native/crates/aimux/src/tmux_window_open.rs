use crate::tmux::{
    OpenTargetOptions, TmuxClientInfo, TmuxManagedWindow, TmuxRuntimeManager, TmuxTarget,
    is_dashboard_window_name,
};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmuxFocusMode {
    ClientTty,
    LinkedClientSession,
    OpenTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TmuxFocusResult {
    pub focused: bool,
    pub focus_mode: TmuxFocusMode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxFocusContext {
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxServiceTarget {
    pub id: String,
    pub tmux_window_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxSessionWindowEntry {
    pub id: String,
    pub backend_session_id: Option<String>,
    pub tmux_window_id: Option<String>,
}

pub trait TmuxWindowOpenRuntime {
    fn is_inside_tmux(&mut self) -> bool;
    fn current_client_session(&mut self) -> Option<String>;
    fn list_project_managed_windows(&mut self, project_root: &str) -> Vec<TmuxManagedWindow>;
    fn is_window_alive(&mut self, target: &TmuxTarget) -> bool;
    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String>;
    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget>;
    fn select_window(&mut self, target: &TmuxTarget) -> Result<(), String>;
    fn find_client_by_tty(&mut self, client_tty: &str) -> Option<TmuxClientInfo>;
    fn list_clients(&mut self) -> Vec<TmuxClientInfo>;
    fn get_attached_client_for_target(&mut self, target: &TmuxTarget) -> Option<TmuxClientInfo>;
    fn switch_client_to_target(
        &mut self,
        client_tty: &str,
        target: &TmuxTarget,
    ) -> Result<(), String>;
    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String>;
    fn refresh_status(&mut self);
    fn send_focus_in(&mut self, target: &TmuxTarget) -> Result<(), String>;
}

impl TmuxWindowOpenRuntime for TmuxRuntimeManager {
    fn is_inside_tmux(&mut self) -> bool {
        TmuxRuntimeManager::is_inside_tmux(self)
    }

    fn current_client_session(&mut self) -> Option<String> {
        TmuxRuntimeManager::current_client_session(self)
    }

    fn list_project_managed_windows(&mut self, project_root: &str) -> Vec<TmuxManagedWindow> {
        TmuxRuntimeManager::list_project_managed_windows(self, project_root)
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> bool {
        TmuxRuntimeManager::is_window_alive(self, target)
    }

    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String> {
        TmuxRuntimeManager::open_target(self, target, options).map(|_| ())
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        TmuxRuntimeManager::get_target_by_window_id(self, session_name, window_id)
    }

    fn select_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        TmuxRuntimeManager::select_window(self, target)
    }

    fn find_client_by_tty(&mut self, client_tty: &str) -> Option<TmuxClientInfo> {
        TmuxRuntimeManager::find_client_by_tty(self, client_tty)
    }

    fn list_clients(&mut self) -> Vec<TmuxClientInfo> {
        TmuxRuntimeManager::list_clients(self)
    }

    fn get_attached_client_for_target(&mut self, target: &TmuxTarget) -> Option<TmuxClientInfo> {
        TmuxRuntimeManager::get_attached_client_for_target(self, target)
    }

    fn switch_client_to_target(
        &mut self,
        client_tty: &str,
        target: &TmuxTarget,
    ) -> Result<(), String> {
        TmuxRuntimeManager::switch_client_to_target(self, client_tty, target)
    }

    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String> {
        TmuxRuntimeManager::switch_client(self, session_name, window_index, None)
    }

    fn refresh_status(&mut self) {
        TmuxRuntimeManager::refresh_status(self)
    }

    fn send_focus_in(&mut self, target: &TmuxTarget) -> Result<(), String> {
        TmuxRuntimeManager::send_focus_in(self, target)
    }
}

pub fn resolve_live_client_tty<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    current_client_session: Option<&str>,
    preferred_client_tty: Option<&str>,
) -> Option<String> {
    let normalized_tty = preferred_client_tty
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(normalized_tty) = normalized_tty
        && tmux.find_client_by_tty(normalized_tty).is_some()
    {
        return Some(normalized_tty.to_owned());
    }
    let normalized_session = current_client_session
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    tmux.list_clients()
        .into_iter()
        .find(|client| client.session_name == normalized_session)
        .map(|client| client.tty)
}

pub fn open_target_for_client<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    target: &TmuxTarget,
    current_client_session: Option<&str>,
    client_tty: Option<&str>,
) -> Result<TmuxFocusResult, String> {
    let live_client_tty = resolve_live_client_tty(tmux, current_client_session, client_tty)
        .or_else(|| {
            tmux.get_attached_client_for_target(target)
                .map(|client| client.tty)
        });
    if let Some(live_client_tty) = live_client_tty {
        tmux.switch_client_to_target(&live_client_tty, target)?;
        tmux.refresh_status();
        send_dashboard_focus_in(tmux, target)?;
        return Ok(TmuxFocusResult {
            focused: true,
            focus_mode: TmuxFocusMode::ClientTty,
        });
    }
    if let Some(current_client_session) = current_client_session
        && let Some(linked_target) =
            tmux.get_target_by_window_id(current_client_session, &target.window_id)
    {
        tmux.switch_client(current_client_session, linked_target.window_index)?;
        tmux.refresh_status();
        send_dashboard_focus_in(tmux, &linked_target)?;
        return Ok(TmuxFocusResult {
            focused: true,
            focus_mode: TmuxFocusMode::LinkedClientSession,
        });
    }
    tmux.open_target(
        target,
        OpenTargetOptions {
            inside_tmux: current_client_session.is_some(),
            ..OpenTargetOptions::default()
        },
    )?;
    tmux.refresh_status();
    Ok(TmuxFocusResult {
        focused: true,
        focus_mode: TmuxFocusMode::OpenTarget,
    })
}

pub fn select_linked_or_open_target<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    target: &TmuxTarget,
) -> Result<(), String> {
    let inside_tmux = tmux.is_inside_tmux();
    if inside_tmux
        && let Some(current_client_session) = tmux.current_client_session()
        && let Some(linked_target) =
            tmux.get_target_by_window_id(&current_client_session, &target.window_id)
    {
        tmux.select_window(&linked_target)?;
        return Ok(());
    }
    tmux.open_target(
        target,
        OpenTargetOptions {
            inside_tmux,
            ..OpenTargetOptions::default()
        },
    )
}

pub fn open_managed_session_window<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    project_root: &str,
    entry: &TmuxSessionWindowEntry,
    focus_context: Option<&TmuxFocusContext>,
) -> Result<Option<TmuxTarget>, String> {
    let candidates = tmux
        .list_project_managed_windows(project_root)
        .into_iter()
        .filter(|candidate| metadata_kind(&candidate.metadata) == Some("agent"))
        .filter(|candidate| tmux.is_window_alive(&candidate.target))
        .collect::<Vec<_>>();
    let Some(match_window) = exact_window_match(&candidates, entry.tmux_window_id.as_deref())
        .or_else(|| {
            candidates.iter().find(|candidate| {
                metadata_string(&candidate.metadata, "sessionId") == Some(entry.id.as_str())
                    || entry
                        .backend_session_id
                        .as_deref()
                        .is_some_and(|backend_id| {
                            metadata_string(&candidate.metadata, "backendSessionId")
                                == Some(backend_id)
                        })
            })
        })
    else {
        return Ok(None);
    };
    open_selected_window(tmux, &match_window.target, focus_context)?;
    Ok(Some(match_window.target.clone()))
}

pub fn open_managed_service_window<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    project_root: &str,
    service: &TmuxServiceTarget,
    focus_context: Option<&TmuxFocusContext>,
) -> Result<Option<TmuxTarget>, String> {
    let candidates = tmux
        .list_project_managed_windows(project_root)
        .into_iter()
        .filter(|candidate| metadata_kind(&candidate.metadata) == Some("service"))
        .filter(|candidate| tmux.is_window_alive(&candidate.target))
        .collect::<Vec<_>>();
    let Some(match_window) = exact_window_match(&candidates, service.tmux_window_id.as_deref())
        .or_else(|| {
            candidates.iter().find(|candidate| {
                metadata_string(&candidate.metadata, "sessionId") == Some(service.id.as_str())
            })
        })
    else {
        return Ok(None);
    };
    open_selected_window(tmux, &match_window.target, focus_context)?;
    Ok(Some(match_window.target.clone()))
}

pub fn tmux_window_open_contract(api: &str, input: &Value) -> Value {
    let mut runtime = ContractWindowOpenRuntime::from_input(input);
    let project_root = input["projectRoot"].as_str().unwrap_or_default();
    let focus = focus_context_from_input(input);
    let result = match api {
        "openManagedSessionWindow" => {
            let entry = session_entry_from_value(&input["entry"]);
            open_managed_session_window(&mut runtime, project_root, &entry, focus.as_ref())
        }
        "openManagedServiceWindow" => {
            let service = service_target_from_value(&input["service"]);
            open_managed_service_window(&mut runtime, project_root, &service, focus.as_ref())
        }
        "openTargetForClient" => open_target_for_client(
            &mut runtime,
            &target_from_value(&input["target"]),
            input["currentClientSession"].as_str(),
            input["clientTty"].as_str(),
        )
        .map(|_| Some(target_from_value(&input["target"]))),
        _ => Err(format!("unknown tmux window open api: {api}")),
    };
    json!({
        "target": result.ok().flatten().map(target_to_value),
        "calls": runtime.calls,
    })
}

fn open_selected_window<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    target: &TmuxTarget,
    focus_context: Option<&TmuxFocusContext>,
) -> Result<(), String> {
    if let Some(focus_context) = focus_context {
        open_target_for_client(
            tmux,
            target,
            focus_context.current_client_session.as_deref(),
            focus_context.client_tty.as_deref(),
        )?;
    } else {
        select_linked_or_open_target(tmux, target)?;
    }
    Ok(())
}

fn send_dashboard_focus_in<R: TmuxWindowOpenRuntime>(
    tmux: &mut R,
    target: &TmuxTarget,
) -> Result<(), String> {
    if is_dashboard_window_name(&target.window_name) {
        tmux.send_focus_in(target)?;
    }
    Ok(())
}

fn exact_window_match<'a>(
    candidates: &'a [TmuxManagedWindow],
    tmux_window_id: Option<&str>,
) -> Option<&'a TmuxManagedWindow> {
    tmux_window_id.and_then(|window_id| {
        candidates
            .iter()
            .find(|candidate| candidate.target.window_id == window_id)
    })
}

fn metadata_kind(metadata: &Value) -> Option<&str> {
    metadata_string(metadata, "kind")
}

fn metadata_string<'a>(metadata: &'a Value, key: &str) -> Option<&'a str> {
    metadata.get(key).and_then(Value::as_str)
}

fn session_entry_from_value(value: &Value) -> TmuxSessionWindowEntry {
    TmuxSessionWindowEntry {
        id: value["id"].as_str().unwrap_or_default().to_owned(),
        backend_session_id: value["backendSessionId"].as_str().map(str::to_owned),
        tmux_window_id: value["tmuxWindowId"].as_str().map(str::to_owned),
    }
}

fn service_target_from_value(value: &Value) -> TmuxServiceTarget {
    if let Some(id) = value.as_str() {
        return TmuxServiceTarget {
            id: id.to_owned(),
            tmux_window_id: None,
        };
    }
    TmuxServiceTarget {
        id: value["id"].as_str().unwrap_or_default().to_owned(),
        tmux_window_id: value["tmuxWindowId"].as_str().map(str::to_owned),
    }
}

fn target_from_value(value: &Value) -> TmuxTarget {
    TmuxTarget {
        session_name: value["sessionName"].as_str().unwrap_or_default().to_owned(),
        window_id: value["windowId"].as_str().unwrap_or_default().to_owned(),
        window_index: value["windowIndex"].as_i64().unwrap_or_default(),
        window_name: value["windowName"].as_str().unwrap_or_default().to_owned(),
        pane_dead: value["paneDead"].as_bool(),
    }
}

fn focus_context_from_input(input: &Value) -> Option<TmuxFocusContext> {
    let focus = input.get("focusContext")?;
    if focus.is_null() {
        return None;
    }
    Some(TmuxFocusContext {
        current_client_session: focus["currentClientSession"].as_str().map(str::to_owned),
        client_tty: focus["clientTty"].as_str().map(str::to_owned),
    })
}

fn target_to_value(target: TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

#[derive(Debug, Default)]
struct ContractWindowOpenRuntime {
    inside_tmux: bool,
    current_client_session: Option<String>,
    managed_windows: Vec<TmuxManagedWindow>,
    live_window_ids: Vec<String>,
    linked_targets: Vec<TmuxTarget>,
    clients: Vec<TmuxClientInfo>,
    attached_client: Option<TmuxClientInfo>,
    calls: Vec<Value>,
}

impl ContractWindowOpenRuntime {
    fn from_input(input: &Value) -> Self {
        let managed_windows = input["managedWindows"]
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| TmuxManagedWindow {
                        target: target_from_value(&entry["target"]),
                        metadata: entry["metadata"].clone(),
                    })
                    .collect()
            })
            .unwrap_or_else(default_managed_windows);
        Self {
            inside_tmux: input["insideTmux"].as_bool().unwrap_or_default(),
            current_client_session: input["runtimeCurrentClientSession"]
                .as_str()
                .map(str::to_owned),
            managed_windows,
            live_window_ids: input["liveWindowIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            linked_targets: input["linkedTargets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(target_from_value)
                .collect(),
            clients: input["clients"]
                .as_array()
                .into_iter()
                .flatten()
                .map(client_from_value)
                .collect(),
            attached_client: input
                .get("attachedClient")
                .filter(|value| !value.is_null())
                .map(client_from_value),
            calls: Vec::new(),
        }
    }

    fn push_call(&mut self, name: &str, args: Value) {
        self.calls.push(json!({ "name": name, "args": args }));
    }
}

fn default_managed_windows() -> Vec<TmuxManagedWindow> {
    vec![
        TmuxManagedWindow {
            target: TmuxTarget {
                session_name: "project-client-1".to_owned(),
                window_id: "@agent".to_owned(),
                window_index: 3,
                window_name: "codex".to_owned(),
                pane_dead: None,
            },
            metadata: json!({
                "kind": "agent",
                "sessionId": "codex-1",
                "backendSessionId": "backend-1",
                "command": "codex",
                "args": [],
                "toolConfigKey": "codex",
            }),
        },
        TmuxManagedWindow {
            target: TmuxTarget {
                session_name: "project-client-1".to_owned(),
                window_id: "@service".to_owned(),
                window_index: 4,
                window_name: "shell".to_owned(),
                pane_dead: None,
            },
            metadata: json!({
                "kind": "service",
                "sessionId": "service-1",
                "command": "shell",
                "args": [],
                "toolConfigKey": "shell",
            }),
        },
    ]
}

impl TmuxWindowOpenRuntime for ContractWindowOpenRuntime {
    fn is_inside_tmux(&mut self) -> bool {
        self.push_call("isInsideTmux", json!([]));
        self.inside_tmux
    }

    fn current_client_session(&mut self) -> Option<String> {
        self.push_call("currentClientSession", json!([]));
        self.current_client_session.clone()
    }

    fn list_project_managed_windows(&mut self, project_root: &str) -> Vec<TmuxManagedWindow> {
        self.push_call("listProjectManagedWindows", json!([project_root]));
        self.managed_windows.clone()
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> bool {
        self.push_call("isWindowAlive", json!([target_to_value(target.clone())]));
        self.live_window_ids.is_empty() || self.live_window_ids.contains(&target.window_id)
    }

    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String> {
        self.push_call(
            "openTarget",
            json!([
                target_to_value(target.clone()),
                open_target_options_to_value(options)
            ]),
        );
        Ok(())
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        self.push_call("getTargetByWindowId", json!([session_name, window_id]));
        self.linked_targets
            .iter()
            .find(|target| target.session_name == session_name && target.window_id == window_id)
            .cloned()
    }

    fn select_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.push_call("selectWindow", json!([target_to_value(target.clone())]));
        Ok(())
    }

    fn find_client_by_tty(&mut self, client_tty: &str) -> Option<TmuxClientInfo> {
        self.push_call("findClientByTty", json!([client_tty]));
        self.clients
            .iter()
            .find(|client| client.tty == client_tty)
            .cloned()
    }

    fn list_clients(&mut self) -> Vec<TmuxClientInfo> {
        self.push_call("listClients", json!([]));
        self.clients.clone()
    }

    fn get_attached_client_for_target(&mut self, target: &TmuxTarget) -> Option<TmuxClientInfo> {
        self.push_call(
            "getAttachedClientForTarget",
            json!([target_to_value(target.clone())]),
        );
        self.attached_client.clone()
    }

    fn switch_client_to_target(
        &mut self,
        client_tty: &str,
        target: &TmuxTarget,
    ) -> Result<(), String> {
        self.push_call(
            "switchClientToTarget",
            json!([client_tty, target_to_value(target.clone())]),
        );
        Ok(())
    }

    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String> {
        self.push_call("switchClient", json!([session_name, window_index]));
        Ok(())
    }

    fn refresh_status(&mut self) {
        self.push_call("refreshStatus", json!([]));
    }

    fn send_focus_in(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.push_call("sendFocusIn", json!([target_to_value(target.clone())]));
        Ok(())
    }
}

fn client_from_value(value: &Value) -> TmuxClientInfo {
    TmuxClientInfo {
        tty: value["tty"].as_str().unwrap_or_default().to_owned(),
        session_name: value["sessionName"].as_str().unwrap_or_default().to_owned(),
        window_id: value["windowId"].as_str().unwrap_or_default().to_owned(),
        name: value["name"].as_str().unwrap_or_default().to_owned(),
    }
}

fn open_target_options_to_value(options: OpenTargetOptions) -> Value {
    let mut value = serde_json::Map::new();
    value.insert("insideTmux".into(), Value::Bool(options.inside_tmux));
    if options.already_resolved {
        value.insert("alreadyResolved".into(), Value::Bool(true));
    }
    if let Some(client_tty) = options.client_tty {
        value.insert("clientTty".into(), Value::String(client_tty));
    }
    if let Some(client_suffix) = options.client_suffix {
        value.insert("clientSuffix".into(), Value::String(client_suffix));
    }
    if let Some(return_session_name) = options.return_session_name {
        value.insert(
            "returnSessionName".into(),
            Value::String(return_session_name),
        );
    }
    Value::Object(value)
}
