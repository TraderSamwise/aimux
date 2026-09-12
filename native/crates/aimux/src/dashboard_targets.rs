use crate::dashboard_command_spec::{
    DashboardCommandSpecOptions, get_dashboard_command_spec,
    get_dashboard_command_spec_with_options,
};
use crate::dashboard_readiness::{get_runtime_owner_id, runtime_owner_id_from_parts};
use crate::tmux::{
    CapturePaneOptions, TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION,
    TMUX_DASHBOARD_READY_OPTION, TMUX_RUNTIME_OWNER_OPTION, TmuxCommandSpec, TmuxRuntimeManager,
    TmuxSessionRef, TmuxTarget, TmuxWindowInfo, is_dashboard_window_name,
    is_tmux_client_session_for_host,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const DASHBOARD_REPLACEMENT_READY_TIMEOUT_MS: u64 = 20_000;
const CONTRACT_NODE_EXEC_PATH: &str = "/opt/homebrew/Cellar/node/25.8.1_1/bin/node";
const CONTRACT_HOME_DIR: &str = "/Users/sam";
const CONTRACT_PROJECT_ROOT: &str = "/Users/sam/cs/glyde-frontend";
const CONTRACT_OTHER_PROJECT_ROOT: &str = "/Users/sam/cs/tealstreet-next";
const CONTRACT_SESSION_NAME: &str = "aimux-glyde-frontend-abc123";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardTargetRef {
    pub dashboard_session: TmuxSessionRef,
    pub dashboard_target: TmuxTarget,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DashboardResolveOptions {
    pub force_reload: bool,
    pub open_in_host_session: bool,
}

#[derive(Debug, Clone)]
pub struct DashboardTargetContext {
    pub dashboard_build_stamp: String,
    pub dashboard_command: TmuxCommandSpec,
    pub runtime_owner_id: String,
}

pub trait DashboardTargetTmux {
    fn get_project_session(&mut self, project_root: &str) -> TmuxSessionRef;
    fn is_inside_tmux(&mut self) -> bool;
    fn get_open_session_name(&mut self, session_name: &str, inside_tmux: bool) -> String;
    fn current_client_session(&mut self) -> Option<String>;
    fn list_session_names(&mut self) -> Result<Vec<String>, String>;
    fn has_session(&mut self, session_name: &str) -> bool;
    fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String>;
    fn get_window_option(&mut self, target: &TmuxTarget, key: &str) -> Option<String>;
    fn get_session_option(&mut self, session_name: &str, key: &str) -> Option<String>;
    fn display_message(&mut self, format: &str, target: &str) -> Option<String>;
    fn capture_target(&mut self, target: &TmuxTarget, start_line: i64) -> Option<String>;
    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String>;
    fn ensure_project_session(
        &mut self,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<TmuxSessionRef, String>;
    fn ensure_dashboard_window(
        &mut self,
        session_name: &str,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<(TmuxTarget, bool), String>;
    fn replace_window_when_ready(
        &mut self,
        target: &TmuxTarget,
        dashboard_command: &TmuxCommandSpec,
        readiness_option: &str,
        readiness_value: &str,
        timeout_ms: u64,
    ) -> Result<TmuxTarget, String>;
    fn set_session_option(
        &mut self,
        session_name: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String>;
    fn set_window_option(
        &mut self,
        target: &TmuxTarget,
        key: &str,
        value: &str,
    ) -> Result<(), String>;
}

impl DashboardTargetContext {
    pub fn for_project(project_root: &str) -> Result<Self, String> {
        let spec = get_dashboard_command_spec(project_root).map_err(|error| error.to_string())?;
        Ok(Self {
            dashboard_build_stamp: spec.dashboard_build_stamp,
            dashboard_command: spec.dashboard_command,
            runtime_owner_id: get_runtime_owner_id(),
        })
    }
}

impl DashboardTargetTmux for TmuxRuntimeManager {
    fn get_project_session(&mut self, project_root: &str) -> TmuxSessionRef {
        TmuxRuntimeManager::get_project_session(self, project_root)
    }

    fn is_inside_tmux(&mut self) -> bool {
        TmuxRuntimeManager::is_inside_tmux(self)
    }

    fn get_open_session_name(&mut self, session_name: &str, inside_tmux: bool) -> String {
        TmuxRuntimeManager::get_open_session_name(self, session_name, inside_tmux)
    }

    fn current_client_session(&mut self) -> Option<String> {
        TmuxRuntimeManager::current_client_session(self)
    }

    fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        TmuxRuntimeManager::list_session_names(self)
    }

    fn has_session(&mut self, session_name: &str) -> bool {
        TmuxRuntimeManager::has_session(self, session_name)
    }

    fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        TmuxRuntimeManager::list_windows(self, session_name)
    }

    fn get_window_option(&mut self, target: &TmuxTarget, key: &str) -> Option<String> {
        TmuxRuntimeManager::get_window_option(self, &target.window_id, key)
    }

    fn get_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
        TmuxRuntimeManager::get_session_option(self, session_name, key)
    }

    fn display_message(&mut self, format: &str, target: &str) -> Option<String> {
        TmuxRuntimeManager::display_message(self, format, Some(target))
    }

    fn capture_target(&mut self, target: &TmuxTarget, start_line: i64) -> Option<String> {
        TmuxRuntimeManager::capture_target(
            self,
            target,
            CapturePaneOptions {
                start_line: Some(start_line),
                ..CapturePaneOptions::default()
            },
        )
        .ok()
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        TmuxRuntimeManager::is_window_alive(self, target)
    }

    fn ensure_project_session(
        &mut self,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<TmuxSessionRef, String> {
        TmuxRuntimeManager::ensure_project_session(
            self,
            project_root,
            Some(dashboard_command),
            None,
        )
    }

    fn ensure_dashboard_window(
        &mut self,
        session_name: &str,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<(TmuxTarget, bool), String> {
        let dashboard_existed = TmuxRuntimeManager::list_windows(self, session_name)?
            .into_iter()
            .any(|window| is_dashboard_window_name(&window.name));
        let target = TmuxRuntimeManager::ensure_dashboard_window(
            self,
            session_name,
            project_root,
            Some(dashboard_command),
        )?;
        Ok((target, !dashboard_existed))
    }

    fn replace_window_when_ready(
        &mut self,
        target: &TmuxTarget,
        dashboard_command: &TmuxCommandSpec,
        readiness_option: &str,
        readiness_value: &str,
        timeout_ms: u64,
    ) -> Result<TmuxTarget, String> {
        TmuxRuntimeManager::replace_window_when_ready(
            self,
            target,
            dashboard_command,
            readiness_option,
            readiness_value,
            timeout_ms,
        )
    }

    fn set_session_option(
        &mut self,
        session_name: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        TmuxRuntimeManager::set_session_option(self, session_name, key, value)
    }

    fn set_window_option(
        &mut self,
        target: &TmuxTarget,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        TmuxRuntimeManager::set_window_option(self, &target.window_id, key, value)
    }
}

pub fn find_live_dashboard_target(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
) -> Result<Option<DashboardTargetRef>, String> {
    let context = DashboardTargetContext::for_project(project_root)?;
    find_live_dashboard_target_with_context(project_root, tmux, &context)
}

pub fn resolve_dashboard_target(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    options: DashboardResolveOptions,
) -> Result<DashboardTargetRef, String> {
    let context = DashboardTargetContext::for_project(project_root)?;
    resolve_dashboard_target_with_context(project_root, tmux, options, &context)
}

pub fn resolve_dashboard_target_for_restart(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
) -> Result<DashboardTargetRef, String> {
    let context = DashboardTargetContext::for_project(project_root)?;
    resolve_dashboard_target_for_restart_with_context(project_root, tmux, &context)
}

pub fn resolve_dashboard_target_for_restart_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
) -> Result<DashboardTargetRef, String> {
    resolve_dashboard_target_with_context(
        project_root,
        tmux,
        DashboardResolveOptions {
            force_reload: false,
            open_in_host_session: true,
        },
        context,
    )
}

pub fn find_live_dashboard_target_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
) -> Result<Option<DashboardTargetRef>, String> {
    find_dashboard_target_with_context(project_root, tmux, context, true)
}

pub fn find_recoverable_dashboard_target_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
) -> Result<Option<DashboardTargetRef>, String> {
    find_dashboard_target_with_context(project_root, tmux, context, false)
}

fn find_dashboard_target_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
    require_current_build: bool,
) -> Result<Option<DashboardTargetRef>, String> {
    let dashboard_session = tmux.get_project_session(project_root);
    let inside_tmux = tmux.is_inside_tmux();
    let preferred_open_session =
        tmux.get_open_session_name(&dashboard_session.session_name, inside_tmux);
    let current_client_session = tmux.current_client_session();
    let same_project_current_client_session =
        current_client_session.clone().filter(|session_name| {
            session_name == &dashboard_session.session_name
                || is_tmux_client_session_for_host(session_name, &dashboard_session.session_name)
        });
    let mut seen = BTreeSet::new();
    let mut candidate_sessions = Vec::new();
    for session_name in [
        Some(preferred_open_session),
        same_project_current_client_session,
        Some(dashboard_session.session_name.clone()),
    ] {
        if let Some(session_name) = session_name
            && !session_name.is_empty()
            && seen.insert(session_name.clone())
        {
            candidate_sessions.push(session_name);
        }
    }
    for session_name in tmux.list_session_names()? {
        if is_tmux_client_session_for_host(&session_name, &dashboard_session.session_name)
            && seen.insert(session_name.clone())
        {
            candidate_sessions.push(session_name);
        }
    }
    for session_name in candidate_sessions {
        let has_session = tmux.has_session(&session_name);
        if !has_session {
            continue;
        }
        for window in tmux.list_windows(&session_name)? {
            if !is_dashboard_window_name(&window.name) {
                continue;
            }
            let dashboard_target = TmuxTarget {
                session_name: session_name.clone(),
                window_id: window.id,
                window_index: window.index,
                window_name: window.name,
                pane_dead: window.pane_dead,
            };
            if !is_usable_dashboard_target_with_context(
                project_root,
                tmux,
                context,
                &dashboard_target,
                require_current_build,
            )? {
                continue;
            }
            return Ok(Some(DashboardTargetRef {
                dashboard_session,
                dashboard_target,
            }));
        }
    }

    Ok(None)
}

pub fn resolve_dashboard_target_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    options: DashboardResolveOptions,
    context: &DashboardTargetContext,
) -> Result<DashboardTargetRef, String> {
    if !options.force_reload
        && let Some(live) = find_live_dashboard_target_with_context(project_root, tmux, context)?
    {
        tmux.set_session_option(
            &live.dashboard_session.session_name,
            TMUX_DASHBOARD_BUILD_OPTION,
            &context.dashboard_build_stamp,
        )?;
        return Ok(live);
    }

    let dashboard_session =
        tmux.ensure_project_session(project_root, &context.dashboard_command)?;
    let open_session_name = if options.open_in_host_session {
        dashboard_session.session_name.clone()
    } else {
        let inside_tmux = tmux.is_inside_tmux();
        tmux.get_open_session_name(&dashboard_session.session_name, inside_tmux)
    };
    let (mut dashboard_target, dashboard_created) =
        tmux.ensure_dashboard_window(&open_session_name, project_root, &context.dashboard_command)?;
    let current_build_stamp =
        tmux.get_window_option(&dashboard_target, TMUX_DASHBOARD_BUILD_OPTION);
    let current_ready_stamp =
        tmux.get_window_option(&dashboard_target, TMUX_DASHBOARD_READY_OPTION);
    let current_dashboard_owner =
        tmux.get_window_option(&dashboard_target, TMUX_DASHBOARD_OWNER_OPTION);
    let should_respawn = options.force_reload
        || !tmux.is_window_alive(&dashboard_target)?
        || current_build_stamp.as_deref() != Some(context.dashboard_build_stamp.as_str())
        || current_ready_stamp.as_deref() != Some(context.dashboard_build_stamp.as_str())
        || current_dashboard_owner.as_deref() != Some(context.runtime_owner_id.as_str());
    if dashboard_created {
        wait_for_dashboard_target_ready(
            tmux,
            &dashboard_target,
            &context.dashboard_build_stamp,
            DASHBOARD_REPLACEMENT_READY_TIMEOUT_MS,
        )?;
    } else if should_respawn {
        dashboard_target = tmux.replace_window_when_ready(
            &dashboard_target,
            &context.dashboard_command,
            TMUX_DASHBOARD_READY_OPTION,
            &context.dashboard_build_stamp,
            DASHBOARD_REPLACEMENT_READY_TIMEOUT_MS,
        )?;
    }
    tmux.set_session_option(
        &dashboard_session.session_name,
        TMUX_DASHBOARD_BUILD_OPTION,
        &context.dashboard_build_stamp,
    )?;
    tmux.set_window_option(
        &dashboard_target,
        TMUX_DASHBOARD_BUILD_OPTION,
        &context.dashboard_build_stamp,
    )?;
    tmux.set_window_option(
        &dashboard_target,
        TMUX_DASHBOARD_OWNER_OPTION,
        &context.runtime_owner_id,
    )?;
    Ok(DashboardTargetRef {
        dashboard_session,
        dashboard_target,
    })
}

fn wait_for_dashboard_target_ready(
    tmux: &mut impl DashboardTargetTmux,
    target: &TmuxTarget,
    readiness_value: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if tmux
            .get_window_option(target, TMUX_DASHBOARD_READY_OPTION)
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            return Ok(());
        }
        if !tmux.is_window_alive(target)? {
            return Err(dashboard_target_not_ready_error(
                tmux,
                target,
                format!(
                    "Dashboard window {} exited before becoming ready",
                    target.window_id
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(dashboard_target_not_ready_error(
        tmux,
        target,
        format!(
            "Timed out waiting {}ms for tmux window {} readiness option {}={}",
            timeout_ms, target.window_id, TMUX_DASHBOARD_READY_OPTION, readiness_value
        ),
    ))
}

fn dashboard_target_not_ready_error(
    tmux: &mut impl DashboardTargetTmux,
    target: &TmuxTarget,
    message: String,
) -> String {
    let output = tmux.capture_target(target, -80).unwrap_or_default();
    let output = output.trim();
    if output.is_empty() {
        message
    } else {
        format!("{message}:\n{output}")
    }
}

pub fn is_usable_dashboard_target(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
    dashboard_target: &TmuxTarget,
) -> Result<bool, String> {
    is_usable_dashboard_target_with_context(project_root, tmux, context, dashboard_target, true)
}

fn is_usable_dashboard_target_with_context(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
    context: &DashboardTargetContext,
    dashboard_target: &TmuxTarget,
    require_current_build: bool,
) -> Result<bool, String> {
    let current_build_stamp = tmux.get_window_option(dashboard_target, TMUX_DASHBOARD_BUILD_OPTION);
    let current_ready_stamp = tmux.get_window_option(dashboard_target, TMUX_DASHBOARD_READY_OPTION);
    let target_runtime_owner =
        tmux.get_session_option(&dashboard_target.session_name, TMUX_RUNTIME_OWNER_OPTION);
    let target_dashboard_owner =
        tmux.get_window_option(dashboard_target, TMUX_DASHBOARD_OWNER_OPTION);
    let target_project_root =
        tmux.get_session_option(&dashboard_target.session_name, "@aimux-project-root");
    let pane_command = tmux
        .display_message("#{pane_current_command}", &dashboard_target.window_id)
        .unwrap_or_default();
    let pane_tail = if pane_command == "bash" {
        tmux.capture_target(dashboard_target, -40)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let window_alive = tmux.is_window_alive(dashboard_target)?;
    let project_root_matches = target_project_root
        .as_deref()
        .is_some_and(|target_project_root| project_roots_match(project_root, target_project_root));
    let runtime_owner_matches =
        target_runtime_owner.as_deref() == Some(context.runtime_owner_id.as_str());
    let dashboard_owner_matches =
        target_dashboard_owner.as_deref() == Some(context.runtime_owner_id.as_str());
    let build_matches =
        current_build_stamp.as_deref() == Some(context.dashboard_build_stamp.as_str());
    let ready_matches =
        current_ready_stamp.as_deref() == Some(context.dashboard_build_stamp.as_str());
    let command_ok = pane_command != "cat" && pane_command != "tail";
    let tail_ok = !pane_tail.contains("aimux dashboard failed to start.");
    Ok(window_alive
        && project_root_matches
        && runtime_owner_matches
        && dashboard_owner_matches
        && (!require_current_build || (build_matches && ready_matches))
        && command_ok
        && tail_ok)
}

fn project_roots_match(expected: &str, actual: &str) -> bool {
    expected == actual || canonicalize_project_root(expected) == canonicalize_project_root(actual)
}

fn canonicalize_project_root(project_root: &str) -> String {
    fs::canonicalize(project_root)
        .unwrap_or_else(|_| PathBuf::from(project_root))
        .to_string_lossy()
        .into_owned()
}

pub fn run_dashboard_targets_contract_case(case_id: &str, input: &Value) -> Value {
    let context = contract_dashboard_context().expect("dashboard targets contract context");
    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or(CONTRACT_PROJECT_ROOT);
    let scenario = DashboardTargetsContractScenario::from_case_id(case_id)
        .unwrap_or(DashboardTargetsContractScenario::LiveCurrentOwner);
    let mut tmux = DashboardTargetsContractTmux::new(scenario, &context);
    match input.get("api").and_then(Value::as_str) {
        Some("findLiveDashboardTarget") => {
            let result = find_live_dashboard_target_with_context(project_root, &mut tmux, &context)
                .expect("contract findLiveDashboardTarget succeeds");
            json!({ "result": result.map(dashboard_target_ref_to_value), "calls": tmux.calls })
        }
        Some("resolveDashboardTarget") if case_id == "dashboard-targets-002" => {
            let find_result =
                find_live_dashboard_target_with_context(project_root, &mut tmux, &context)
                    .expect("contract findLiveDashboardTarget succeeds");
            let resolve_result = resolve_dashboard_target_with_context(
                project_root,
                &mut tmux,
                DashboardResolveOptions::default(),
                &context,
            )
            .expect("contract resolveDashboardTarget succeeds");
            json!({
                "findResult": find_result.map(dashboard_target_ref_to_value),
                "resolveResult": dashboard_target_ref_to_value(resolve_result),
                "calls": tmux.calls,
            })
        }
        Some("resolveDashboardTarget") => {
            let result = resolve_dashboard_target_with_context(
                project_root,
                &mut tmux,
                DashboardResolveOptions::default(),
                &context,
            )
            .expect("contract resolveDashboardTarget succeeds");
            json!({ "result": dashboard_target_ref_to_value(result), "calls": tmux.calls })
        }
        Some("resolveDashboardTargetForRestart") => {
            let result = resolve_dashboard_target_for_restart_with_context(
                project_root,
                &mut tmux,
                &context,
            )
            .expect("contract resolveDashboardTargetForRestart succeeds");
            json!({ "result": dashboard_target_ref_to_value(result), "calls": tmux.calls })
        }
        api => json!({ "error": format!("unsupported dashboard targets api {api:?}") }),
    }
}

fn contract_dashboard_context() -> Result<DashboardTargetContext, String> {
    let repo_root = std::env::temp_dir().join(format!(
        "aimux-dashboard-targets-contract-{}",
        std::process::id()
    ));
    let script_path = repo_root.join("dist/launcher-bin.js");
    let implementation_path = repo_root.join("dist/main.js");
    fs::create_dir_all(script_path.parent().expect("contract dist parent"))
        .map_err(|error| error.to_string())?;
    fs::write(&script_path, "launcher-one").map_err(|error| error.to_string())?;
    fs::write(&implementation_path, "main-one").map_err(|error| error.to_string())?;
    let spec = get_dashboard_command_spec_with_options(
        CONTRACT_PROJECT_ROOT,
        DashboardCommandSpecOptions {
            env: BTreeMap::from([
                ("AIMUX_HOME".to_owned(), "/Users/sam/.aimux".to_owned()),
                ("AIMUX_DAEMON_PORT".to_owned(), "43190".to_owned()),
                ("AIMUX_ENV".to_owned(), "production".to_owned()),
            ]),
            script_path,
            implementation_path,
            process_exec_path: CONTRACT_NODE_EXEC_PATH.to_owned(),
            home_dir: PathBuf::from(CONTRACT_HOME_DIR),
            platform: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(DashboardTargetContext {
        dashboard_build_stamp: spec.dashboard_build_stamp,
        dashboard_command: spec.dashboard_command,
        runtime_owner_id: runtime_owner_id_from_parts("/Users/sam/.aimux", "43190"),
    })
}

fn dashboard_target_ref_to_value(value: DashboardTargetRef) -> Value {
    json!({
        "dashboardSession": {
            "projectRoot": value.dashboard_session.project_root,
            "projectId": value.dashboard_session.project_id,
            "sessionName": value.dashboard_session.session_name,
        },
        "dashboardTarget": target_to_value(&value.dashboard_target),
    })
}

fn target_to_value(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DashboardTargetsContractScenario {
    LiveOtherProjectCurrentClient,
    LiveCurrentOwner,
    ReplaceOtherOwner,
    MissingReadyStamp,
}

impl DashboardTargetsContractScenario {
    fn from_case_id(case_id: &str) -> Option<Self> {
        match case_id {
            "dashboard-targets-001" => Some(Self::LiveOtherProjectCurrentClient),
            "dashboard-targets-003" => Some(Self::LiveCurrentOwner),
            "dashboard-targets-002" => Some(Self::ReplaceOtherOwner),
            "dashboard-targets-004" => Some(Self::MissingReadyStamp),
            _ => None,
        }
    }
}

struct DashboardTargetsContractTmux {
    scenario: DashboardTargetsContractScenario,
    dashboard_build_stamp: String,
    runtime_owner_id: String,
    calls: Vec<Value>,
}

impl DashboardTargetsContractTmux {
    fn new(scenario: DashboardTargetsContractScenario, context: &DashboardTargetContext) -> Self {
        Self {
            scenario,
            dashboard_build_stamp: context.dashboard_build_stamp.clone(),
            runtime_owner_id: context.runtime_owner_id.clone(),
            calls: Vec::new(),
        }
    }

    fn record(&mut self, method: &str, args: Value) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn dashboard_session(&self) -> TmuxSessionRef {
        TmuxSessionRef {
            project_root: CONTRACT_PROJECT_ROOT.to_owned(),
            project_id: "glyde".to_owned(),
            session_name: CONTRACT_SESSION_NAME.to_owned(),
        }
    }

    fn dashboard_target(&self, window_id: &str) -> TmuxTarget {
        TmuxTarget {
            session_name: CONTRACT_SESSION_NAME.to_owned(),
            window_id: window_id.to_owned(),
            window_index: 0,
            window_name: "dashboard".to_owned(),
            pane_dead: None,
        }
    }
}

impl DashboardTargetTmux for DashboardTargetsContractTmux {
    fn get_project_session(&mut self, project_root: &str) -> TmuxSessionRef {
        self.record("getProjectSession", json!([project_root]));
        self.dashboard_session()
    }

    fn is_inside_tmux(&mut self) -> bool {
        self.record("isInsideTmux", json!([]));
        self.scenario == DashboardTargetsContractScenario::LiveOtherProjectCurrentClient
    }

    fn get_open_session_name(&mut self, session_name: &str, inside_tmux: bool) -> String {
        self.record("getOpenSessionName", json!([session_name, inside_tmux]));
        CONTRACT_SESSION_NAME.to_owned()
    }

    fn current_client_session(&mut self) -> Option<String> {
        self.record("currentClientSession", json!([]));
        if self.scenario == DashboardTargetsContractScenario::LiveOtherProjectCurrentClient {
            Some("aimux-tealstreet-next-def456-client-deadbeef".to_owned())
        } else {
            None
        }
    }

    fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        self.record("listSessionNames", json!([]));
        Ok(match self.scenario {
            DashboardTargetsContractScenario::LiveOtherProjectCurrentClient => vec![
                CONTRACT_SESSION_NAME.to_owned(),
                "aimux-tealstreet-next-def456".to_owned(),
                "aimux-tealstreet-next-def456-client-deadbeef".to_owned(),
            ],
            DashboardTargetsContractScenario::LiveCurrentOwner
            | DashboardTargetsContractScenario::ReplaceOtherOwner
            | DashboardTargetsContractScenario::MissingReadyStamp => {
                vec![CONTRACT_SESSION_NAME.to_owned()]
            }
        })
    }

    fn has_session(&mut self, session_name: &str) -> bool {
        self.record("hasSession", json!([session_name]));
        session_name == CONTRACT_SESSION_NAME
    }

    fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        self.record("listWindows", json!([session_name]));
        let (id, name) = if session_name == CONTRACT_SESSION_NAME {
            ("@1", "dashboard")
        } else {
            ("@2", "dashboard")
        };
        Ok(vec![TmuxWindowInfo {
            id: id.to_owned(),
            index: 0,
            name: name.to_owned(),
            active: true,
            activity: None,
            pane_dead: None,
        }])
    }

    fn get_window_option(&mut self, target: &TmuxTarget, key: &str) -> Option<String> {
        self.record("getWindowOption", json!([target_to_value(target), key]));
        match key {
            TMUX_DASHBOARD_OWNER_OPTION
                if self.scenario == DashboardTargetsContractScenario::ReplaceOtherOwner =>
            {
                Some("other-owner".to_owned())
            }
            TMUX_DASHBOARD_OWNER_OPTION => Some(self.runtime_owner_id.clone()),
            TMUX_DASHBOARD_READY_OPTION
                if self.scenario == DashboardTargetsContractScenario::MissingReadyStamp =>
            {
                None
            }
            TMUX_DASHBOARD_BUILD_OPTION | TMUX_DASHBOARD_READY_OPTION => {
                Some(self.dashboard_build_stamp.clone())
            }
            _ => None,
        }
    }

    fn get_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
        self.record("getSessionOption", json!([session_name, key]));
        match key {
            TMUX_RUNTIME_OWNER_OPTION
                if self.scenario == DashboardTargetsContractScenario::ReplaceOtherOwner =>
            {
                Some("other-owner".to_owned())
            }
            TMUX_RUNTIME_OWNER_OPTION => Some(self.runtime_owner_id.clone()),
            "@aimux-project-root" if session_name == CONTRACT_SESSION_NAME => {
                Some(CONTRACT_PROJECT_ROOT.to_owned())
            }
            "@aimux-project-root" => Some(CONTRACT_OTHER_PROJECT_ROOT.to_owned()),
            _ => None,
        }
    }

    fn display_message(&mut self, format: &str, target: &str) -> Option<String> {
        self.record("displayMessage", json!([format, target]));
        Some("bash".to_owned())
    }

    fn capture_target(&mut self, target: &TmuxTarget, start_line: i64) -> Option<String> {
        self.record(
            "captureTarget",
            json!([target_to_value(target), { "startLine": start_line }]),
        );
        Some(String::new())
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        self.record("isWindowAlive", json!([target_to_value(target)]));
        Ok(true)
    }

    fn ensure_project_session(
        &mut self,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<TmuxSessionRef, String> {
        self.record(
            "ensureProjectSession",
            json!([project_root, command_spec_to_value(dashboard_command)]),
        );
        Ok(self.dashboard_session())
    }

    fn ensure_dashboard_window(
        &mut self,
        session_name: &str,
        project_root: &str,
        dashboard_command: &TmuxCommandSpec,
    ) -> Result<(TmuxTarget, bool), String> {
        self.record(
            "ensureDashboardWindow",
            json!([
                session_name,
                project_root,
                command_spec_to_value(dashboard_command)
            ]),
        );
        Ok((self.dashboard_target("@1"), false))
    }

    fn replace_window_when_ready(
        &mut self,
        target: &TmuxTarget,
        dashboard_command: &TmuxCommandSpec,
        readiness_option: &str,
        readiness_value: &str,
        timeout_ms: u64,
    ) -> Result<TmuxTarget, String> {
        self.record(
            "replaceWindowWhenReady",
            json!([
                target_to_value(target),
                command_spec_to_value(dashboard_command),
                {
                    "option": readiness_option,
                    "value": readiness_value,
                    "timeoutMs": timeout_ms,
                }
            ]),
        );
        Ok(self.dashboard_target("@2"))
    }

    fn set_session_option(
        &mut self,
        session_name: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.record("setSessionOption", json!([session_name, key, value]));
        Ok(())
    }

    fn set_window_option(
        &mut self,
        target: &TmuxTarget,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.record(
            "setWindowOption",
            json!([target_to_value(target), key, value]),
        );
        Ok(())
    }
}

fn command_spec_to_value(spec: &TmuxCommandSpec) -> Value {
    json!({
        "cwd": spec.cwd,
        "command": spec.command,
        "args": spec.args,
    })
}
