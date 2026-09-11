use crate::cli_launcher::{
    AimuxCliLaunchOptions, get_aimux_current_cli_identity, is_cargo_test_aimux_binary,
};
use crate::tmux::tmux_command_from_env;
use crate::tmux_expose::expose_project_control_flag_from_metadata;
use anyhow::Result;
use serde_json::{Map, Value};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxControlOptions {
    pub action: String,
    pub project_root: String,
    pub project_state_dir: String,
    pub current_client_session: String,
    pub client_tty: String,
    pub current_window: String,
    pub current_window_id: String,
    pub current_path: String,
    pub window_id: String,
    pub pane_id: String,
    pub item_index: String,
    pub aimux_home: String,
    pub daemon_host: String,
    pub daemon_port: String,
    pub self_command: Option<String>,
}

pub fn parse_tmux_control_args(args: &[String]) -> Result<TmuxControlOptions, String> {
    let mut options = TmuxControlOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "next" | "prev" | "attention" | "dashboard" | "coordination" | "overseer" | "menu"
            | "expose" | "meta" | "window" | "active" | "team" => {
                options.action = args[index].clone();
                index += 1;
            }
            "--aimux-home" => {
                options.aimux_home = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--daemon-host" => {
                options.daemon_host = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--daemon-port" => {
                options.daemon_port = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--project-state-dir" => {
                options.project_state_dir = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--project-root" => {
                options.project_root = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-client-session" => {
                options.current_client_session = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--client-tty" => {
                options.client_tty = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-window" => {
                options.current_window = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-window-id" => {
                options.current_window_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-path" => {
                options.current_path = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--pane-id" => {
                options.pane_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--window-id" => {
                options.window_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--index" => {
                options.item_index = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--self-command" => {
                options.self_command = Some(args.get(index + 1).cloned().unwrap_or_default());
                index += 2;
            }
            _ => index += 1,
        }
    }
    Ok(options)
}

pub fn run_tmux_control(options: TmuxControlOptions) -> i32 {
    if options.action.is_empty() {
        return 1;
    }
    let mut control = TmuxControl::new(options);
    control.hydrate_from_tmux_pane();
    control.hydrate_project_context();
    if control.options.project_state_dir.is_empty() {
        return 1;
    }
    if control.fallback_local_control() {
        return 0;
    }
    control.report_control_failure("no local tmux target available");
    0
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveClient {
    tty: String,
    session: String,
    window_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowRow {
    id: String,
    index: i64,
    name: String,
    pane_dead: String,
}

#[derive(Debug, Clone)]
struct NavItem {
    window_id: String,
    window_index: i64,
    kind: String,
    session_id: String,
    worktree_path: String,
    project_control: bool,
    attention: String,
    unseen_count: i64,
    status_text: String,
    team: Value,
    created_at: String,
    alive: bool,
}

struct TmuxControl {
    options: TmuxControlOptions,
    live_client: Option<LiveClient>,
    dashboard_session: String,
    dashboard_index: String,
    dashboard_window_id: String,
    debug_log: PathBuf,
}

impl TmuxControl {
    fn new(options: TmuxControlOptions) -> Self {
        let debug_root = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        Self {
            options,
            live_client: None,
            dashboard_session: String::new(),
            dashboard_index: String::new(),
            dashboard_window_id: String::new(),
            debug_log: debug_root.join("aimux-debug.log"),
        }
    }

    fn fallback_local_control(&mut self) -> bool {
        match self.options.action.as_str() {
            "dashboard" => {
                self.append_debug_line(&format!(
                    "aimux: tmux dashboard fallback for session={} window={}",
                    default_unknown(&self.options.current_client_session),
                    default_unknown(&self.options.current_window_id)
                ));
                self.switch_local_dashboard()
                    || (self.dashboard_candidate_needs_reload() && self.reload_local_dashboard())
            }
            "coordination" => self.show_local_coordination(),
            "overseer" => self.show_local_overseer(),
            "menu" => self.show_local_switcher(),
            "expose" => self.show_local_expose(),
            "meta" => self.show_local_meta(),
            "active" => true,
            "next" | "prev" | "attention" | "window" => match self.resolve_local_target() {
                TargetResolution::Target(window_id) => {
                    self.live_client = None;
                    self.switch_local_window(&window_id)
                }
                TargetResolution::Noop => true,
                TargetResolution::Failed => false,
            },
            "team" => {
                self.debug_log_line(&format!(
                    "team requested session={} window={} path={} pane={}",
                    default_unknown(&self.options.current_client_session),
                    default_unknown(&self.options.current_window_id),
                    default_unknown(&self.options.current_path),
                    default_unknown(&self.options.pane_id)
                ));
                match self.resolve_local_target() {
                    TargetResolution::Target(window_id) => {
                        self.live_client = None;
                        self.switch_local_window(&window_id)
                    }
                    TargetResolution::Noop => true,
                    TargetResolution::Failed => {
                        self.debug_log_line(&format!(
                            "team no live target session={} window={} path={}",
                            default_unknown(&self.options.current_client_session),
                            default_unknown(&self.options.current_window_id),
                            default_unknown(&self.options.current_path)
                        ));
                        self.show_local_message("aimux: no live teammate target");
                        true
                    }
                }
            }
            _ => false,
        }
    }

    fn hydrate_from_tmux_pane(&mut self) -> bool {
        let pane_target = if self.options.pane_id.is_empty() {
            std::env::var("TMUX_PANE").unwrap_or_default()
        } else {
            self.options.pane_id.clone()
        };
        if pane_target.is_empty() {
            return false;
        }
        let Some(context) = self.tmux_output(&[
            "display-message",
            "-p",
            "-t",
            &pane_target,
            "#{session_name}|#{window_id}|#{window_name}|#{client_tty}|#{pane_current_path}",
        ]) else {
            return false;
        };
        if context.is_empty() {
            return false;
        }
        let mut parts = context.splitn(5, '|');
        let pane_session = parts.next().unwrap_or_default().to_owned();
        let pane_window_id = parts.next().unwrap_or_default().to_owned();
        let pane_window_name = parts.next().unwrap_or_default().to_owned();
        let pane_client_tty = parts.next().unwrap_or_default().to_owned();
        let pane_current_path = parts.next().unwrap_or_default().to_owned();
        if pane_session.is_empty() {
            return false;
        }
        if self.options.action == "expose" {
            if self.options.current_client_session.is_empty() {
                self.options.current_client_session = pane_session;
            }
            if self.options.current_window_id.is_empty() {
                self.options.current_window_id = pane_window_id;
            }
            if self.options.current_window.is_empty() {
                self.options.current_window = pane_window_name;
            }
            if self.options.client_tty.is_empty() {
                self.options.client_tty = pane_client_tty;
            }
            if self.options.current_path.is_empty() {
                self.options.current_path = pane_current_path;
            }
        } else {
            self.options.current_client_session = pane_session;
            if !pane_window_id.is_empty() {
                self.options.current_window_id = pane_window_id;
            }
            if !pane_window_name.is_empty() {
                self.options.current_window = pane_window_name;
            }
            if !pane_client_tty.is_empty() {
                self.options.client_tty = pane_client_tty;
            }
            if !pane_current_path.is_empty() {
                self.options.current_path = pane_current_path;
            }
        }
        true
    }

    fn hydrate_project_context(&mut self) {
        let Some(context_session) = self.project_context_session() else {
            return;
        };
        if self.options.project_root.is_empty()
            && let Some(project_root) = self.tmux_output(&[
                "show-options",
                "-v",
                "-t",
                &context_session,
                "@aimux-project-root",
            ])
        {
            self.options.project_root = project_root;
        }
        if self.options.project_state_dir.is_empty()
            && let Some(project_state_dir) = self.tmux_output(&[
                "show-options",
                "-v",
                "-t",
                &context_session,
                "@aimux-project-state-dir",
            ])
        {
            self.options.project_state_dir = project_state_dir;
        }
    }

    fn project_context_session(&self) -> Option<String> {
        let session = self.options.current_client_session.as_str();
        if session.is_empty() {
            return None;
        }
        Some(strip_client_suffix(session).to_owned())
    }

    fn resolve_live_client(&mut self) -> bool {
        if !self.options.client_tty.is_empty()
            && let Some(client) = self
                .list_clients()
                .into_iter()
                .find(|client| client.tty == self.options.client_tty)
        {
            self.live_client = Some(client.clone());
            return true;
        }
        if !self.options.current_window_id.is_empty()
            && let Some(client) = self
                .list_clients()
                .into_iter()
                .find(|client| client.window_id == self.options.current_window_id)
        {
            self.live_client = Some(client.clone());
            return true;
        }
        if !self.options.current_client_session.is_empty()
            && let Some(client) = self
                .list_clients()
                .into_iter()
                .find(|client| client.session == self.options.current_client_session)
        {
            self.live_client = Some(client.clone());
            return true;
        }
        false
    }

    fn switch_fast_current_session_dashboard(&mut self) -> bool {
        let current_client_session = self.options.current_client_session.clone();
        let client_tty = self.options.client_tty.clone();
        if current_client_session.is_empty() {
            return false;
        }
        let Some(index) = self.find_dashboard_index(&current_client_session) else {
            return false;
        };
        if !self.validate_dashboard_target(&current_client_session, &index) {
            return false;
        }
        let target = format!("{current_client_session}:{index}");
        if !self.switch_client_to_target(&target, &client_tty) {
            return false;
        }
        self.refresh_navigation_client(&client_tty);
        self.tmux_status(&["send-keys", "-t", &target, "-H", "1b", "5b", "49"]);
        true
    }

    fn focus_local_dashboard_target(&mut self) -> bool {
        self.resolve_live_client();
        if !self.find_dashboard_candidate() {
            return false;
        }
        let session = self.dashboard_session.clone();
        let index = self.dashboard_index.clone();
        self.validate_dashboard_target(&session, &index)
    }

    fn switch_local_dashboard(&mut self) -> bool {
        if self.switch_fast_current_session_dashboard() {
            return true;
        }
        if !self.focus_local_dashboard_target() {
            return false;
        }
        let target = format!("{}:{}", self.dashboard_session, self.dashboard_index);
        let tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .filter(|tty| !tty.is_empty())
            .unwrap_or(&self.options.client_tty)
            .to_owned();
        if !self.switch_client_to_target(&target, &tty) {
            return false;
        }
        self.refresh_navigation_client(&tty);
        self.tmux_status(&["send-keys", "-t", &target, "-H", "1b", "5b", "49"]);
        true
    }

    fn reload_local_dashboard(&mut self) -> bool {
        if self.options.project_root.is_empty() {
            return false;
        }
        self.debug_log_line(&format!(
            "dashboard reload fallback project_root={}",
            self.options.project_root
        ));
        self.show_local_message("#[fg=colour220,bold]aimux#[default] reloading dashboard");
        let tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .filter(|tty| !tty.is_empty())
            .unwrap_or(&self.options.client_tty);
        let session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session);
        let body = json_object(&[
            ("focus", JsonPart::Bool(true)),
            ("forceReload", JsonPart::Bool(true)),
            ("clientTty", JsonPart::OptionalString(tty)),
            ("currentClientSession", JsonPart::OptionalString(session)),
            (
                "currentWindowId",
                JsonPart::OptionalString(&self.options.current_window_id),
            ),
        ]);
        let mut attempted_endpoint = false;
        if let Some(metadata_api) = self.read_metadata_api() {
            attempted_endpoint = true;
            let endpoint = format!(
                "{}/control/open-dashboard",
                metadata_api.trim_end_matches('/')
            );
            if self.curl_post(&endpoint, &body, "8").is_some() {
                return true;
            }
            self.debug_log_line(&format!(
                "dashboard reload api failed endpoint={metadata_api}"
            ));
        } else {
            self.debug_log_line("dashboard reload api unavailable: missing metadata-api.txt");
        }
        if let Some(metadata_api) = self.resolve_metadata_api_from_daemon() {
            attempted_endpoint = true;
            let endpoint = format!(
                "{}/control/open-dashboard",
                metadata_api.trim_end_matches('/')
            );
            if self.curl_post(&endpoint, &body, "8").is_some() {
                return true;
            }
            self.debug_log_line(&format!(
                "dashboard reload api failed daemon_resolved_endpoint={metadata_api}"
            ));
        }
        if attempted_endpoint {
            self.show_local_message(
                "#[fg=colour203,bold]aimux#[default] dashboard reload failed - couldn't contact project service endpoint",
            );
        } else {
            self.show_local_message(
                "#[fg=colour203,bold]aimux#[default] dashboard reload failed - project service endpoint unavailable",
            );
        }
        true
    }

    fn show_local_coordination(&mut self) -> bool {
        if self.live_client.is_none() {
            self.resolve_live_client();
        }
        let session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session)
            .to_owned();
        let _ = self.persist_dashboard_screen(&session, "coordination");
        self.switch_local_dashboard()
            || (self.dashboard_candidate_needs_reload() && self.reload_local_dashboard())
    }

    fn show_local_overseer(&mut self) -> bool {
        if let Some(overseer_window_id) = self.resolve_live_overseer_window_id()
            && self.focus_project_window_via_api(&overseer_window_id)
        {
            return true;
        }
        let mut opened_via_api = false;
        if !self.focus_local_dashboard_target() {
            if !self.open_dashboard_via_api() {
                return false;
            }
            opened_via_api = true;
        }
        if !opened_via_api {
            let target = format!("{}:{}", self.dashboard_session, self.dashboard_index);
            let tty = self
                .live_client
                .as_ref()
                .map(|client| client.tty.as_str())
                .filter(|tty| !tty.is_empty())
                .unwrap_or(&self.options.client_tty)
                .to_owned();
            if !self.switch_client_to_target(&target, &tty) {
                return false;
            }
            self.refresh_navigation_client(&tty);
        }
        let target = format!("{}:{}", self.dashboard_session, self.dashboard_index);
        self.tmux_status(&["send-keys", "-t", &target, "-H", "1b", "5b", "49"]);
        self.tmux_status(&["send-keys", "-t", &target, "O"]);
        true
    }

    fn resolve_live_overseer_window_id(&mut self) -> Option<String> {
        let endpoint = self.read_metadata_api()?;
        let params = vec![
            ("scope", "all".to_owned()),
            ("labelFormat", "raw".to_owned()),
            ("includePreview", "1".to_owned()),
            ("includeOverseer", "1".to_owned()),
            (
                "currentClientSession",
                self.options.current_client_session.clone(),
            ),
            ("currentWindow", self.options.current_window.clone()),
            ("currentWindowId", self.options.current_window_id.clone()),
            ("currentPath", self.options.current_path.clone()),
        ];
        let url = url_with_query(
            &format!(
                "{}/control/switchable-agents",
                endpoint.trim_end_matches('/')
            ),
            &params,
        );
        let raw = self.curl_get(&url, "4")?;
        let payload: Value = serde_json::from_str(&raw).ok()?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let items = payload.get("items")?.as_array()?;
        for item in items {
            if item.get("overseer").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let Some(target) = item.get("target").and_then(Value::as_object) else {
                continue;
            };
            let window_id = target
                .get("windowId")
                .or_else(|| target.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !window_id.is_empty() {
                return Some(window_id.to_owned());
            }
        }
        None
    }

    fn focus_project_window_via_api(&mut self, window_id: &str) -> bool {
        if window_id.is_empty() {
            return false;
        }
        let Some(metadata_api) = self.read_metadata_api() else {
            return false;
        };
        let body = json_object(&[
            ("windowId", JsonPart::String(window_id)),
            ("focus", JsonPart::Bool(true)),
            (
                "currentClientSession",
                JsonPart::OptionalString(&self.options.current_client_session),
            ),
            (
                "clientTty",
                JsonPart::OptionalString(&self.options.client_tty),
            ),
        ]);
        self.curl_post(
            &format!(
                "{}/control/focus-window",
                metadata_api.trim_end_matches('/')
            ),
            &body,
            "4",
        )
        .is_some()
    }

    fn open_dashboard_via_api(&mut self) -> bool {
        if self.options.project_root.is_empty() {
            return false;
        }
        let Some(metadata_api) = self.read_metadata_api() else {
            return false;
        };
        let tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .filter(|tty| !tty.is_empty())
            .unwrap_or(&self.options.client_tty);
        let session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session);
        let body = json_object(&[
            ("focus", JsonPart::Bool(true)),
            ("forceReload", JsonPart::Bool(true)),
            ("clientTty", JsonPart::OptionalString(tty)),
            ("currentClientSession", JsonPart::OptionalString(session)),
            (
                "currentWindowId",
                JsonPart::OptionalString(&self.options.current_window_id),
            ),
        ]);
        let raw = self.curl_post(
            &format!(
                "{}/control/open-dashboard",
                metadata_api.trim_end_matches('/')
            ),
            &body,
            "8",
        );
        let Some(payload) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            return false;
        };
        let Some(target) = payload.get("target").and_then(Value::as_object) else {
            return false;
        };
        let Some(session) = target.get("sessionName").and_then(Value::as_str) else {
            return false;
        };
        let Some(index) = target.get("windowIndex").and_then(Value::as_i64) else {
            return false;
        };
        if session.is_empty() {
            return false;
        }
        self.dashboard_session = session.to_owned();
        self.dashboard_index = index.to_string();
        true
    }

    fn show_local_switcher(&mut self) -> bool {
        self.show_metadata_menu("worktree", "aimux")
    }

    fn show_local_meta(&mut self) -> bool {
        self.show_metadata_menu("all", "aimux project")
    }

    fn show_metadata_menu(&mut self, scope: &str, title: &str) -> bool {
        if self.live_client.is_none() {
            self.resolve_live_client();
        }
        let menu_session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session)
            .to_owned();
        let menu_client_tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .filter(|tty| !tty.is_empty())
            .unwrap_or(&self.options.client_tty)
            .to_owned();
        let Some(endpoint) = self.read_metadata_api() else {
            return false;
        };
        let params = vec![
            ("scope", scope.to_owned()),
            ("currentClientSession", menu_session.clone()),
            ("currentWindow", self.options.current_window.clone()),
            ("currentWindowId", self.options.current_window_id.clone()),
            ("currentPath", self.options.current_path.clone()),
        ];
        let url = url_with_query(
            &format!(
                "{}/control/switchable-agents",
                endpoint.trim_end_matches('/')
            ),
            &params,
        );
        let Some(raw) = self.curl_get(&url, "4") else {
            return false;
        };
        let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
            return false;
        };
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return false;
        }
        let Some(items) = payload.get("items").and_then(Value::as_array) else {
            return false;
        };
        if items.is_empty() {
            return false;
        }
        let mut args = vec!["display-menu".to_owned()];
        if !menu_client_tty.is_empty() {
            args.push("-c".to_owned());
            args.push(menu_client_tty.clone());
        }
        args.push("-T".to_owned());
        args.push(title.to_owned());
        let keys = "123456789abcdefghijklmnopqrstuvwxyz"
            .chars()
            .collect::<Vec<_>>();
        for (idx, item) in items.iter().take(keys.len()).enumerate() {
            let target = item.get("target").and_then(Value::as_object);
            let metadata = item.get("metadata").and_then(Value::as_object);
            let window_id = target
                .and_then(|target| target.get("windowId").or_else(|| target.get("id")))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if window_id.is_empty() {
                continue;
            }
            let worktree = metadata
                .and_then(|metadata| metadata.get("worktreePath"))
                .and_then(Value::as_str)
                .unwrap_or(&self.options.project_root);
            let basename = basename_for_menu(worktree);
            let label_text = item
                .get("label")
                .or_else(|| metadata.and_then(|metadata| metadata.get("label")))
                .or_else(|| metadata.and_then(|metadata| metadata.get("command")))
                .or_else(|| target.and_then(|target| target.get("windowName")))
                .and_then(Value::as_str)
                .unwrap_or(window_id);
            let marker = if window_id == self.options.current_window_id {
                "* "
            } else {
                ""
            };
            let label = safe_label(&format!("{marker}{basename} - {label_text}"), 64);
            let mut command = vec![
                "window".to_owned(),
                "--project-state-dir".to_owned(),
                self.options.project_state_dir.clone(),
                "--current-client-session".to_owned(),
                menu_session.clone(),
                "--client-tty".to_owned(),
                menu_client_tty.clone(),
                "--current-window".to_owned(),
                self.options.current_window.clone(),
                "--current-window-id".to_owned(),
                self.options.current_window_id.clone(),
                "--current-path".to_owned(),
                self.options.current_path.clone(),
            ];
            if !self.options.pane_id.is_empty() {
                command.push("--pane-id".to_owned());
                command.push(self.options.pane_id.clone());
            }
            command.push("--window-id".to_owned());
            command.push(window_id.to_owned());
            let command_suffix = command
                .iter()
                .map(|part| shlex_quote(part))
                .collect::<Vec<_>>()
                .join(" ");
            let shell_command = format!("{} {command_suffix}", self.self_command());
            args.push(label);
            args.push(keys[idx].to_string());
            args.push(format!("run-shell -b {}", shlex_quote(&shell_command)));
        }
        if args.len() <= 3 {
            return false;
        }
        self.tmux_success(&args.iter().map(String::as_str).collect::<Vec<_>>())
    }

    fn show_local_expose(&mut self) -> bool {
        if self.live_client.is_none() {
            self.resolve_live_client();
        }
        let popup_client_tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .filter(|tty| !tty.is_empty())
            .unwrap_or(&self.options.client_tty)
            .to_owned();
        let popup_session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session)
            .to_owned();
        let mut expose_socket = Path::new(&self.options.project_state_dir).join("expose.sock");
        let expose_socket_file =
            Path::new(&self.options.project_state_dir).join("expose.sock.path");
        if let Ok(contents) = fs::read_to_string(&expose_socket_file) {
            let resolved = contents.lines().next().unwrap_or_default().trim();
            if !resolved.is_empty() {
                expose_socket = PathBuf::from(resolved);
            }
        }
        if !expose_socket.exists() {
            return false;
        }
        let expose_daemon_endpoint =
            if self.options.daemon_host.is_empty() || self.options.daemon_port.is_empty() {
                String::new()
            } else {
                format!(
                    "http://{}:{}",
                    self.options.daemon_host, self.options.daemon_port
                )
            };
        let current_project_control = self.current_window_project_control();
        let mut popup_retry_count = 0;
        let mut selected_expose_window = String::new();
        let popup_status = loop {
            let Some(expose_status) = create_temp_file() else {
                return false;
            };
            let Some(expose_context) = create_temp_file() else {
                let _ = fs::remove_file(&expose_status);
                return false;
            };
            let Some(expose_selection) = create_temp_file() else {
                let _ = fs::remove_file(&expose_status);
                let _ = fs::remove_file(&expose_context);
                return false;
            };
            let (client_cols, client_rows) = self.client_size(&popup_client_tty);
            let context = [
                self.options.project_root.clone(),
                self.options.project_state_dir.clone(),
                popup_session.clone(),
                popup_client_tty.clone(),
                self.options.current_window.clone(),
                self.options.current_window_id.clone(),
                self.options.current_path.clone(),
                self.options.pane_id.clone(),
                self.options.aimux_home.clone(),
                current_project_control
                    .map(|value| if value { "1" } else { "0" }.to_owned())
                    .unwrap_or_default(),
                expose_status.to_string_lossy().into_owned(),
                client_cols,
                client_rows,
                expose_daemon_endpoint.clone(),
                expose_selection.to_string_lossy().into_owned(),
            ]
            .join("\n");
            let _ = fs::write(&expose_context, format!("{context}\n"));
            let expose_cmd = expose_popup_command(&expose_context, &expose_socket);
            let mut args = vec!["display-popup".to_owned()];
            if !popup_client_tty.is_empty() {
                args.push("-c".to_owned());
                args.push(popup_client_tty.clone());
            }
            args.extend([
                "-T".to_owned(),
                "aimux exposé".to_owned(),
                "-x".to_owned(),
                "C".to_owned(),
                "-y".to_owned(),
                "C".to_owned(),
                "-w".to_owned(),
                "100%".to_owned(),
                "-h".to_owned(),
                "100%".to_owned(),
                "-B".to_owned(),
                "-E".to_owned(),
                expose_cmd,
            ]);
            let mut status = self.tmux_status(&args.iter().map(String::as_str).collect::<Vec<_>>());
            if let Ok(contents) = fs::read_to_string(&expose_status) {
                let file_status = contents.trim();
                if !file_status.is_empty() {
                    status = file_status.parse::<i32>().unwrap_or(status);
                }
            }
            selected_expose_window.clear();
            if status == 0
                && let Ok(contents) = fs::read_to_string(&expose_selection)
            {
                selected_expose_window = contents.lines().next().unwrap_or_default().to_owned();
            }
            let _ = fs::remove_file(&expose_context);
            let _ = fs::remove_file(&expose_status);
            let _ = fs::remove_file(&expose_selection);
            if status == 75 && popup_retry_count < 3 {
                popup_retry_count += 1;
                continue;
            }
            break status;
        };
        if popup_status == 76 {
            let _ = self.switch_local_dashboard()
                || (self.dashboard_candidate_needs_reload() && self.reload_local_dashboard());
            return false;
        }
        if popup_status != 0 {
            return false;
        }
        if !selected_expose_window.is_empty() {
            return self.switch_local_window(&selected_expose_window);
        }
        true
    }

    fn current_window_project_control(&mut self) -> Option<bool> {
        let window_id = self.options.current_window_id.trim().to_owned();
        if window_id.is_empty() {
            return None;
        }
        let raw =
            self.tmux_output(&["show-window-options", "-v", "-t", &window_id, "@aimux-meta"])?;
        let metadata = serde_json::from_str::<Value>(&raw).ok()?;
        Some(expose_project_control_flag_from_metadata(&metadata))
    }

    fn resolve_local_target(&mut self) -> TargetResolution {
        self.resolve_live_client();
        let Some(host_session) = self.resolve_host_session_name() else {
            return TargetResolution::Failed;
        };
        if !self.options.window_id.is_empty() {
            if self.options.action == "team" {
                self.team_log(&format!("explicit target {}", self.options.window_id));
            }
            return TargetResolution::Target(self.options.window_id.clone());
        }
        let Some(windows_raw) = self.tmux_output(&[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}|#{window_index}|#{window_name}|#{pane_dead}",
        ]) else {
            if self.options.action == "team" {
                self.team_log(&format!(
                    "list windows failed host={host_session:?} error=Command '['tmux', 'list-windows', '-t', '{host_session}', '-F', '#{{window_id}}|#{{window_index}}|#{{window_name}}|#{{pane_dead}}']' returned non-zero exit status 1."
                ));
            }
            return TargetResolution::Failed;
        };
        if self.options.action == "team" {
            self.team_log(&format!(
                "start host={} currentWindowId={} currentPath={} windows={}",
                py_string_repr(&host_session),
                py_string_repr(&self.options.current_window_id),
                py_string_repr(&self.options.current_path),
                windows_raw.lines().filter(|line| !line.is_empty()).count()
            ));
        }
        let mut items = Vec::new();
        for line in windows_raw.lines() {
            let parts = line.splitn(4, '|').collect::<Vec<_>>();
            if parts.len() != 4 {
                if self.options.action == "team" {
                    self.team_log(&format!("skip malformed window line={line:?}"));
                }
                continue;
            }
            let window_id = parts[0];
            let raw =
                self.tmux_output(&["show-window-options", "-v", "-t", window_id, "@aimux-meta"]);
            let Some(raw) = raw else {
                if self.options.action == "team" {
                    self.team_log(&format!(
                        "skip window={window_id:?} name={:?} no/invalid meta error=Command '['tmux', 'show-window-options', '-v', '-t', '{window_id}', '@aimux-meta']' returned non-zero exit status 1.",
                        parts[2]
                    ));
                }
                continue;
            };
            let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
                if self.options.action == "team" {
                    self.team_log(&format!(
                        "skip window={window_id:?} name={:?} no/invalid meta error=Expecting value: line 1 column 1 (char 0)",
                        parts[2]
                    ));
                }
                continue;
            };
            let team = meta
                .get("team")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            let worktree = meta
                .get("worktreePath")
                .and_then(Value::as_str)
                .unwrap_or(&self.options.project_root)
                .to_owned();
            let project_control = is_project_control_meta(&meta, &team);
            items.push(NavItem {
                window_id: window_id.to_owned(),
                window_index: parts[1].parse().unwrap_or(0),
                kind: meta
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("agent")
                    .to_owned(),
                session_id: meta
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                worktree_path: worktree,
                project_control,
                attention: meta
                    .get("attention")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                unseen_count: meta.get("unseenCount").and_then(value_as_i64).unwrap_or(0),
                status_text: meta
                    .get("statusText")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                team: if team.is_object() {
                    team
                } else {
                    Value::Object(Default::default())
                },
                created_at: meta
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                alive: parts[3] != "1",
            });
        }
        if items.is_empty() {
            if self.options.action == "team" {
                self.team_log("no metadata candidates after filtering");
            }
            return TargetResolution::Failed;
        }
        let mut current_worktree = None;
        for item in &items {
            if item.window_id == self.options.current_window_id {
                current_worktree = Some(item.worktree_path.clone());
                break;
            }
        }
        items.retain(|item| item.alive || item.window_id == self.options.current_window_id);
        if self.options.action == "team" {
            let rendered = items
                .iter()
                .map(|item| {
                    format!(
                        "{}:{}:{}:{}:{}:{}",
                        item.window_id,
                        item.session_id,
                        item.kind,
                        team_parent_id(&item.team).unwrap_or("-"),
                        if item.status_text.is_empty() {
                            "-"
                        } else {
                            &item.status_text
                        },
                        if item.alive { "live" } else { "dead" }
                    )
                })
                .collect::<Vec<_>>();
            self.team_log(&format!("items={}", py_list_repr(&rendered)));
        }
        if items.is_empty() {
            if self.options.action == "team" {
                self.team_log("no live metadata candidates");
            }
            return TargetResolution::Failed;
        }
        let current = items
            .iter()
            .find(|item| item.window_id == self.options.current_window_id)
            .cloned();
        if self.options.action == "team" {
            return self.resolve_team_target(items, current);
        }
        if let Some(current_worktree) = current_worktree {
            items.retain(|item| item.worktree_path == current_worktree);
        } else {
            items.retain(|item| {
                is_same_or_child_path(&self.options.current_path, &item.worktree_path)
            });
        }
        items.sort_by_key(|item| (if item.kind == "agent" { 0 } else { 1 }, item.window_index));
        if items.is_empty() {
            if self.options.action == "team" {
                self.team_log("no metadata candidates in current worktree");
            }
            return TargetResolution::Failed;
        }
        let current = items
            .iter()
            .find(|item| item.window_id == self.options.current_window_id)
            .cloned();
        if current.as_ref().is_some_and(|item| item.project_control)
            && matches!(self.options.action.as_str(), "next" | "prev")
        {
            return TargetResolution::Noop;
        }
        if let Some(parent_id) = current
            .as_ref()
            .and_then(|item| team_parent_id(&item.team))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
        {
            items.retain(|item| team_parent_id(&item.team) == Some(parent_id.as_str()));
            sort_teammates(&mut items);
        } else {
            items.retain(|item| {
                !item.project_control
                    && team_parent_id(&item.team)
                        .map(str::is_empty)
                        .unwrap_or(true)
            });
            items.sort_by_key(|item| {
                if item.kind == "agent" {
                    (0, item.window_index)
                } else {
                    (1, item.window_index)
                }
            });
        }
        if items.is_empty() {
            return TargetResolution::Failed;
        }
        let current_index = items
            .iter()
            .position(|item| item.window_id == self.options.current_window_id)
            .unwrap_or(0);
        match self.options.action.as_str() {
            "next" => {
                for offset in 1..=items.len() {
                    let target = &items[(current_index + offset) % items.len()];
                    if target.alive {
                        return TargetResolution::Target(target.window_id.clone());
                    }
                }
                TargetResolution::Failed
            }
            "prev" => {
                for offset in 1..=items.len() {
                    let index = (current_index + items.len() - offset) % items.len();
                    let target = &items[index];
                    if target.alive {
                        return TargetResolution::Target(target.window_id.clone());
                    }
                }
                TargetResolution::Failed
            }
            "attention" => {
                let mut ranked = items
                    .into_iter()
                    .filter(|item| item.alive)
                    .collect::<Vec<_>>();
                ranked.sort_by_key(|item| std::cmp::Reverse(attention_rank(item)));
                let Some(best) = ranked.first() else {
                    return TargetResolution::Failed;
                };
                if attention_rank(best) == (0, 0, 0) {
                    return TargetResolution::Failed;
                }
                TargetResolution::Target(best.window_id.clone())
            }
            "window" => {
                let Ok(index) = self.options.item_index.parse::<usize>() else {
                    return TargetResolution::Failed;
                };
                let live_items = items
                    .into_iter()
                    .filter(|item| item.alive)
                    .collect::<Vec<_>>();
                if index < 1 || index > live_items.len() {
                    return TargetResolution::Failed;
                }
                TargetResolution::Target(live_items[index - 1].window_id.clone())
            }
            _ => TargetResolution::Failed,
        }
    }

    fn resolve_team_target(
        &mut self,
        items: Vec<NavItem>,
        current: Option<NavItem>,
    ) -> TargetResolution {
        let Some(current) = current else {
            self.team_log(&format!(
                "current metadata item not found currentWindowId={}",
                py_string_repr(&self.options.current_window_id)
            ));
            return TargetResolution::Failed;
        };
        let parent_id = team_parent_id(&current.team);
        self.team_log(&format!(
            "current id={} parentId={} window={}",
            py_string_repr(&current.session_id),
            py_optional_string_repr(parent_id),
            py_string_repr(&current.window_id)
        ));
        if let Some(parent_id) = parent_id.filter(|value| !value.is_empty()) {
            let parent = items.iter().find(|item| {
                item.alive
                    && item.session_id == parent_id
                    && team_parent_id(&item.team)
                        .map(str::is_empty)
                        .unwrap_or(true)
            });
            let Some(parent) = parent else {
                self.team_log(&format!(
                    "parent metadata target missing parentId={}",
                    py_string_repr(parent_id)
                ));
                return TargetResolution::Failed;
            };
            self.team_log(&format!(
                "target parent window={}",
                py_string_repr(&parent.window_id)
            ));
            return TargetResolution::Target(parent.window_id.clone());
        }
        if current.session_id.is_empty() {
            self.team_log("current metadata item has no session id");
            return TargetResolution::Failed;
        }
        let mut direct = items
            .into_iter()
            .filter(|item| {
                item.alive && team_parent_id(&item.team) == Some(current.session_id.as_str())
            })
            .collect::<Vec<_>>();
        let rendered = direct
            .iter()
            .map(|item| {
                format!(
                    "{}:{}:{}",
                    item.window_id,
                    item.session_id,
                    if item.status_text.is_empty() {
                        "-"
                    } else {
                        &item.status_text
                    }
                )
            })
            .collect::<Vec<_>>();
        self.team_log(&format!("direct candidates={}", py_list_repr(&rendered)));
        sort_teammates(&mut direct);
        let Some(target) = direct.first() else {
            self.team_log(&format!(
                "no direct live teammate metadata candidates currentId={}",
                py_string_repr(&current.session_id)
            ));
            return TargetResolution::Failed;
        };
        self.team_log(&format!(
            "target teammate window={} id={}",
            py_string_repr(&target.window_id),
            py_string_repr(&target.session_id)
        ));
        TargetResolution::Target(target.window_id.clone())
    }

    fn resolve_host_session_name(&self) -> Option<String> {
        let session = self
            .live_client
            .as_ref()
            .map(|client| client.session.as_str())
            .filter(|session| !session.is_empty())
            .unwrap_or(&self.options.current_client_session);
        if session.is_empty() {
            return None;
        }
        Some(strip_client_suffix(session).to_owned())
    }

    fn switch_local_window(&mut self, target_window_id: &str) -> bool {
        if self.live_client.is_none() {
            self.resolve_live_client();
        }
        if !self.is_live_window(target_window_id) {
            return false;
        }
        let Some(index) = self.ensure_linked_window(target_window_id) else {
            return false;
        };
        let Some(session) = self
            .live_client
            .as_ref()
            .map(|client| client.session.clone())
        else {
            return false;
        };
        let tty = self
            .live_client
            .as_ref()
            .map(|client| client.tty.as_str())
            .unwrap_or_default()
            .to_owned();
        let target = format!("{session}:{index}");
        if !tty.is_empty() {
            if !self.tmux_success(&["switch-client", "-c", &tty, "-t", &target]) {
                return false;
            }
        } else if !self.tmux_success(&["switch-client", "-t", &target]) {
            return false;
        }
        if !tty.is_empty() {
            self.tmux_status(&["refresh-client", "-t", &tty, "-S"]);
        } else if !self.options.client_tty.is_empty() {
            let client_tty = self.options.client_tty.clone();
            self.tmux_status(&["refresh-client", "-t", &client_tty, "-S"]);
        } else {
            self.tmux_status(&["refresh-client", "-S"]);
        }
        true
    }

    fn ensure_linked_window(&mut self, target_window_id: &str) -> Option<String> {
        let target_session = self.live_client.as_ref()?.session.clone();
        let find =
            |control: &mut Self| control.find_window_index_by_id(&target_session, target_window_id);
        if let Some(index) = find(self) {
            return Some(index);
        }
        if !self.tmux_success(&[
            "link-window",
            "-d",
            "-s",
            target_window_id,
            "-t",
            &target_session,
        ]) {
            return None;
        }
        find(self)
    }

    fn is_live_window(&mut self, target_window_id: &str) -> bool {
        if target_window_id.is_empty() {
            return false;
        }
        let Some(pane_dead) = self.tmux_output(&[
            "display-message",
            "-p",
            "-t",
            target_window_id,
            "#{pane_dead}",
        ]) else {
            return false;
        };
        !pane_dead.is_empty() && pane_dead != "1"
    }

    fn dashboard_candidate_needs_reload(&mut self) -> bool {
        if !self.find_dashboard_candidate() {
            return true;
        }
        let session = self.dashboard_session.clone();
        let index = self.dashboard_index.clone();
        let Some(row) = self.dashboard_row(&session, &index) else {
            return true;
        };
        self.dashboard_window_id = row.id.clone();
        if row.pane_dead == "1" || row.pane_dead.is_empty() {
            return true;
        }
        let validate_host_session = strip_client_suffix(&session);
        let expected_build = self
            .tmux_output(&[
                "show-options",
                "-v",
                "-t",
                validate_host_session,
                "@aimux-dashboard-build",
            ])
            .unwrap_or_default();
        let dashboard_build = self
            .tmux_output(&[
                "show-window-options",
                "-v",
                "-t",
                &row.id,
                "@aimux-dashboard-build",
            ])
            .unwrap_or_default();
        if expected_build.is_empty() || dashboard_build.is_empty() {
            return true;
        }
        if dashboard_build != expected_build {
            return true;
        }
        if !self.dashboard_ready_for_build(&row.id, &expected_build) {
            return true;
        }
        let preview = self
            .tmux_output(&["capture-pane", "-p", "-t", &row.id, "-S", "-80"])
            .unwrap_or_default();
        preview.contains("aimux dashboard failed to start.")
    }

    fn find_dashboard_candidate(&mut self) -> bool {
        self.dashboard_session.clear();
        self.dashboard_index.clear();
        let live_session = self
            .live_client
            .as_ref()
            .map(|client| client.session.clone());
        if let Some(live_session) = live_session
            && let Some(index) = self.find_dashboard_index(&live_session)
        {
            self.dashboard_session = live_session;
            self.dashboard_index = index;
        }
        if self.dashboard_session.is_empty() && !self.options.current_client_session.is_empty() {
            let current_client_session = self.options.current_client_session.clone();
            if let Some(index) = self.find_dashboard_index(&current_client_session) {
                self.dashboard_session = current_client_session;
                self.dashboard_index = index;
            }
        }
        if self.dashboard_session.is_empty() {
            let prefix = strip_client_suffix(&self.options.current_client_session).to_owned();
            if let Some(target) = self.find_dashboard_in_all_windows(&prefix) {
                self.dashboard_session = target.0;
                self.dashboard_index = target.1;
            }
        }
        !self.dashboard_session.is_empty() && !self.dashboard_index.is_empty()
    }

    fn validate_dashboard_target(&mut self, session: &str, index: &str) -> bool {
        let Some(row) = self.dashboard_row(session, index) else {
            return false;
        };
        self.dashboard_window_id = row.id.clone();
        if row.pane_dead == "1" || row.pane_dead.is_empty() {
            return false;
        }
        let validate_host_session = strip_client_suffix(session);
        let target_project_root = self
            .tmux_output(&[
                "show-options",
                "-v",
                "-t",
                validate_host_session,
                "@aimux-project-root",
            ])
            .unwrap_or_default();
        if self.options.project_root.is_empty() || target_project_root != self.options.project_root
        {
            return false;
        }
        let expected_build = self
            .tmux_output(&[
                "show-options",
                "-v",
                "-t",
                validate_host_session,
                "@aimux-dashboard-build",
            ])
            .unwrap_or_default();
        let dashboard_build = self
            .tmux_output(&[
                "show-window-options",
                "-v",
                "-t",
                &row.id,
                "@aimux-dashboard-build",
            ])
            .unwrap_or_default();
        if expected_build.is_empty() || dashboard_build != expected_build {
            return false;
        }
        if !self.dashboard_ready_for_build(&row.id, &expected_build) {
            return false;
        }
        let expected_owner = self
            .tmux_output(&[
                "show-options",
                "-v",
                "-t",
                validate_host_session,
                "@aimux-runtime-owner",
            ])
            .unwrap_or_default();
        let target_owner = self
            .tmux_output(&["show-options", "-v", "-t", session, "@aimux-runtime-owner"])
            .unwrap_or_default();
        let dashboard_owner = self
            .tmux_output(&[
                "show-window-options",
                "-v",
                "-t",
                &row.id,
                "@aimux-dashboard-owner",
            ])
            .unwrap_or_default();
        if expected_owner.is_empty()
            || target_owner != expected_owner
            || dashboard_owner != expected_owner
        {
            return false;
        }
        if self
            .tmux_output(&["display-message", "-p", "-t", &row.id, "#{pane_in_mode}"])
            .unwrap_or_else(|| "0".to_owned())
            == "1"
        {
            self.tmux_status(&["send-keys", "-t", &row.id, "-X", "cancel"]);
        }
        if let Some("cat" | "tail") = self
            .tmux_output(&[
                "display-message",
                "-p",
                "-t",
                &row.id,
                "#{pane_current_command}",
            ])
            .as_deref()
        {
            return false;
        }
        let preview = self
            .tmux_output(&["capture-pane", "-p", "-t", &row.id, "-S", "-80"])
            .unwrap_or_default();
        !preview.contains("aimux dashboard failed to start.")
    }

    fn dashboard_ready_for_build(&mut self, window_id: &str, build: &str) -> bool {
        if build.is_empty() {
            return false;
        }
        self.tmux_output(&[
            "show-window-options",
            "-v",
            "-t",
            window_id,
            "@aimux-dashboard-ready",
        ])
        .is_some_and(|value| value == build)
    }

    fn dashboard_row(&mut self, session: &str, index: &str) -> Option<WindowRow> {
        let raw = self.tmux_output(&[
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}|#{window_id}|#{window_name}|#{pane_dead}",
        ])?;
        raw.lines().find_map(|line| {
            let parts = line.splitn(4, '|').collect::<Vec<_>>();
            if parts.len() != 4 || parts[0] != index {
                return None;
            }
            Some(WindowRow {
                id: parts[1].to_owned(),
                index: parts[0].parse().unwrap_or(0),
                name: parts[2].to_owned(),
                pane_dead: parts[3].to_owned(),
            })
        })
    }

    fn find_dashboard_index(&mut self, session: &str) -> Option<String> {
        let raw = self.tmux_output(&[
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}|#{window_name}",
        ])?;
        raw.lines().find_map(|line| {
            let (index, name) = line.split_once('|')?;
            if name == "dashboard" || name.starts_with("dashboard") {
                Some(index.to_owned())
            } else {
                None
            }
        })
    }

    fn find_dashboard_in_all_windows(&mut self, prefix: &str) -> Option<(String, String)> {
        let raw = self.tmux_output(&[
            "list-windows",
            "-a",
            "-F",
            "#{session_name}|#{window_index}|#{window_name}",
        ])?;
        raw.lines().find_map(|line| {
            let parts = line.splitn(3, '|').collect::<Vec<_>>();
            if parts.len() != 3 {
                return None;
            }
            if is_same_host_or_client_session(parts[0], prefix)
                && (parts[2] == "dashboard" || parts[2].starts_with("dashboard"))
            {
                Some((parts[0].to_owned(), parts[1].to_owned()))
            } else {
                None
            }
        })
    }

    fn find_window_index_by_id(&mut self, session: &str, window_id: &str) -> Option<String> {
        let raw = self.tmux_output(&[
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}|#{window_id}",
        ])?;
        raw.lines().find_map(|line| {
            let (index, id) = line.split_once('|')?;
            if id == window_id {
                Some(index.to_owned())
            } else {
                None
            }
        })
    }

    fn list_clients(&mut self) -> Vec<LiveClient> {
        let Some(raw) = self.tmux_output(&[
            "list-clients",
            "-F",
            "#{client_tty}|#{session_name}|#{window_id}",
        ]) else {
            return Vec::new();
        };
        raw.lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '|');
                Some(LiveClient {
                    tty: parts.next()?.to_owned(),
                    session: parts.next()?.to_owned(),
                    window_id: parts.next()?.to_owned(),
                })
            })
            .collect()
    }

    fn client_size(&mut self, tty: &str) -> (String, String) {
        if tty.is_empty() {
            return (String::new(), String::new());
        }
        let Some(raw) = self.tmux_output(&[
            "list-clients",
            "-F",
            "#{client_tty} #{client_width}|#{client_height}",
        ]) else {
            return (String::new(), String::new());
        };
        for line in raw.lines() {
            let Some((line_tty, size)) = line.split_once(' ') else {
                continue;
            };
            if line_tty == tty {
                let (cols, rows) = size.split_once('|').unwrap_or((size, ""));
                return (cols.to_owned(), rows.to_owned());
            }
        }
        (String::new(), String::new())
    }

    fn persist_dashboard_screen(&self, session: &str, screen: &str) -> Result<()> {
        if self.options.project_state_dir.is_empty() || session.is_empty() {
            return Ok(());
        }
        let client_key = session
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let path = Path::new(&self.options.project_state_dir)
            .join(format!("dashboard-ui-client-{client_key}.json"));
        let mut snapshot = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| Value::Object(Default::default()));
        if !snapshot.is_object() {
            snapshot = Value::Object(Default::default());
        }
        snapshot["screen"] = Value::String(screen.to_owned());
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, python_json_dumps(&snapshot)?)?;
        fs::rename(tmp, path)?;
        Ok(())
    }

    fn show_local_message(&mut self, message: &str) {
        if !self.options.pane_id.is_empty() {
            let pane_id = self.options.pane_id.clone();
            self.tmux_status(&["display-message", "-t", &pane_id, message]);
        } else {
            self.tmux_status(&["display-message", message]);
        }
    }

    fn report_control_failure(&mut self, reason: &str) {
        let action_label = match self.options.action.as_str() {
            "next" | "prev" | "window" => "switch window",
            "attention" => "jump to attention",
            "dashboard" => "open dashboard",
            "coordination" => "open coordination",
            "overseer" => "open overseer",
            "menu" => "open switcher",
            "expose" => "expose sessions",
            "meta" => "open meta",
            "team" => "reach teammate",
            other => other,
        };
        self.debug_log_line(&format!(
            "control failure action={} reason={reason}",
            self.options.action
        ));
        self.show_local_message(&format!(
            "#[fg=colour203,bold]aimux#[default] couldn't {action_label} - {reason}"
        ));
    }

    fn read_metadata_api(&self) -> Option<String> {
        let path = Path::new(&self.options.project_state_dir).join("metadata-api.txt");
        fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    fn resolve_metadata_api_from_daemon(&mut self) -> Option<String> {
        let daemon_base = self.daemon_base_url()?;
        let raw = self.curl_get(
            &format!("{}/projects", daemon_base.trim_end_matches('/')),
            "4",
        )?;
        let payload: Value = serde_json::from_str(&raw).ok()?;
        let projects = payload.get("projects")?.as_array()?;
        let project = projects.iter().find(|project| {
            string_value(project, "projectRoot")
                .or_else(|| string_value(project, "path"))
                .as_deref()
                == Some(self.options.project_root.as_str())
        })?;
        let endpoint = project.get("serviceEndpoint")?;
        let host = string_value(endpoint, "host")
            .filter(|host| host == "127.0.0.1" || host == "localhost")?;
        let port = endpoint.get("port").and_then(Value::as_u64)?;
        let port = u16::try_from(port).ok()?;
        Some(format!("http://{host}:{port}"))
    }

    fn daemon_base_url(&self) -> Option<String> {
        let env_host = std::env::var("AIMUX_DAEMON_HOST").unwrap_or_default();
        let host = if !self.options.daemon_host.trim().is_empty() {
            self.options.daemon_host.trim()
        } else if !env_host.trim().is_empty() {
            env_host.trim()
        } else {
            "127.0.0.1"
        };
        if host != "127.0.0.1" && host != "localhost" {
            return None;
        }
        let env_port = std::env::var("AIMUX_DAEMON_PORT").unwrap_or_default();
        let port = if !self.options.daemon_port.trim().is_empty() {
            self.options.daemon_port.trim()
        } else if !env_port.trim().is_empty() {
            env_port.trim()
        } else {
            return None;
        };
        if port.parse::<u16>().ok()? == 0 {
            return None;
        }
        Some(format!("http://{host}:{port}"))
    }

    fn debug_log_line(&self, line: &str) {
        self.append_debug_line(&format!("aimux-control: {line}"));
    }

    fn team_log(&self, line: &str) {
        if self.options.action == "team" {
            self.append_debug_line(&format!("aimux-control team metadata: {line}"));
        }
    }

    fn append_debug_line(&self, line: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.debug_log)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    fn self_command(&self) -> String {
        if let Some(command) = self
            .options
            .self_command
            .clone()
            .or_else(|| std::env::var("AIMUX_TMUX_CONTROL_COMMAND").ok())
            .filter(|value| !value.trim().is_empty())
        {
            return command;
        }
        format!(
            "{} __tmux-control-internal",
            shell_quote(&persistent_aimux_executable())
        )
    }

    fn curl_get(&mut self, url: &str, timeout: &str) -> Option<String> {
        command_output("curl", ["-fsS", "--max-time", timeout, url])
    }

    fn curl_post(&mut self, url: &str, body: &str, timeout: &str) -> Option<String> {
        let mut args = vec![
            "-fsS".to_owned(),
            "--max-time".to_owned(),
            timeout.to_owned(),
            "-H".to_owned(),
            "content-type: application/json".to_owned(),
        ];
        if let Some((name, value)) =
            crate::runtime_safety_guard::daemon_test_harness_header_for_url(url)
        {
            args.push("-H".to_owned());
            args.push(format!("{name}: {value}"));
        }
        args.extend(["--data-binary".to_owned(), body.to_owned(), url.to_owned()]);
        command_output("curl", args)
    }

    fn tmux_output(&mut self, args: &[&str]) -> Option<String> {
        command_output("tmux", args.iter().copied()).map(|value| value.trim().to_owned())
    }

    fn tmux_success(&mut self, args: &[&str]) -> bool {
        command_status("tmux", args.iter().copied()) == 0
    }

    fn tmux_status(&mut self, args: &[&str]) -> i32 {
        command_status("tmux", args.iter().copied())
    }

    fn switch_client_to_target(&mut self, target: &str, tty: &str) -> bool {
        if !tty.is_empty() {
            self.tmux_success(&["switch-client", "-c", tty, "-t", target])
        } else {
            self.tmux_success(&["switch-client", "-t", target])
        }
    }

    fn refresh_navigation_client(&mut self, tty: &str) {
        if !tty.is_empty() {
            self.tmux_status(&["refresh-client", "-t", tty, "-S"]);
        } else {
            self.tmux_status(&["refresh-client", "-S"]);
        }
    }
}

enum TargetResolution {
    Target(String),
    Noop,
    Failed,
}

enum JsonPart<'a> {
    String(&'a str),
    OptionalString(&'a str),
    Bool(bool),
}

fn json_object(parts: &[(&str, JsonPart<'_>)]) -> String {
    let mut fields = Vec::new();
    for (key, part) in parts {
        match part {
            JsonPart::String(value) => {
                fields.push(format!("{}: {}", json_string(key), json_string(value)));
            }
            JsonPart::OptionalString(value) if !value.is_empty() => {
                fields.push(format!("{}: {}", json_string(key), json_string(value)));
            }
            JsonPart::OptionalString(_) => {}
            JsonPart::Bool(value) => {
                fields.push(format!("{}: {value}", json_string(key)));
            }
        }
    }
    format!("{{{}}}", fields.join(", "))
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn python_json_dumps(value: &Value) -> Result<String> {
    let compact = serde_json::to_string(value)?;
    Ok(compact.replace("\":", "\": ").replace(",\"", ", \""))
}

fn py_string_repr(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn py_optional_string_repr(value: Option<&str>) -> String {
    value
        .map(py_string_repr)
        .unwrap_or_else(|| "None".to_owned())
}

fn py_list_repr(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| py_string_repr(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn command_output<I, S>(program: &str, args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = if program == "tmux" {
        tmux_command_from_env()
    } else {
        Command::new(program)
    };
    let output = command.args(args).stderr(Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn command_status<I, S>(program: &str, args: I) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = if program == "tmux" {
        tmux_command_from_env()
    } else {
        Command::new(program)
    };
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1)
}

fn persistent_aimux_executable() -> String {
    let current_exe = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let launch = get_aimux_current_cli_identity(AimuxCliLaunchOptions {
        env: std::env::vars().collect(),
        current_argv_entry: std::env::args().next(),
        current_entry_path: current_exe.clone(),
        process_exec_path: current_exe,
        home_dir: None,
    });
    if is_cargo_test_aimux_binary(&launch.command) {
        "aimux".to_owned()
    } else {
        launch.command
    }
}

fn strip_client_suffix(session: &str) -> &str {
    let Some((prefix, suffix)) = session.rsplit_once("-client-") else {
        return session;
    };
    if suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_hexdigit()) {
        prefix
    } else {
        session
    }
}

fn is_same_host_or_client_session(session: &str, prefix: &str) -> bool {
    session == prefix || session.strip_prefix(prefix).is_some_and(is_client_suffix)
}

fn is_client_suffix(value: &str) -> bool {
    value
        .strip_prefix("-client-")
        .is_some_and(|suffix| suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn is_same_or_child_path(path: &str, parent: &str) -> bool {
    let path = path.trim_end_matches('/');
    let parent = parent.trim_end_matches('/');
    !path.is_empty()
        && !parent.is_empty()
        && (path == parent || path.starts_with(&format!("{parent}/")))
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| {
            if value.as_bool().is_some() {
                None
            } else {
                value.as_f64().map(|value| value as i64)
            }
        })
}

fn is_project_control_meta(meta: &Value, team: &Value) -> bool {
    let mut probe = meta.as_object().cloned().unwrap_or_else(Map::new);
    probe.insert("team".into(), team.clone());
    expose_project_control_flag_from_metadata(&Value::Object(probe))
}

fn team_parent_id(team: &Value) -> Option<&str> {
    team.get("parentSessionId").and_then(Value::as_str)
}

fn team_order(item: &NavItem) -> i64 {
    let Some(value) = item.team.get("order") else {
        return i64::MAX;
    };
    if value.as_bool().is_some() {
        return i64::MAX;
    }
    value_as_i64(value).unwrap_or(i64::MAX)
}

fn sort_teammates(items: &mut [NavItem]) {
    items.sort_by_key(|item| {
        (
            team_order(item),
            item.window_index,
            item.created_at.clone(),
            item.session_id.clone(),
        )
    });
}

fn attention_rank(item: &NavItem) -> (i64, i64, i64) {
    let attention_score = match item.attention.as_str() {
        "error" => 5,
        "needs_input" | "needs_response" => 4,
        "blocked" => 3,
        _ => 0,
    };
    (
        attention_score,
        item.unseen_count,
        if item.status_text == "blocked" { 1 } else { 0 },
    )
}

fn default_unknown(value: &str) -> &str {
    if value.is_empty() { "unknown" } else { value }
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn basename_for_menu(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_owned())
}

fn safe_label(value: &str, limit: usize) -> String {
    let cleaned = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.len() > limit {
        format!("{}...", &cleaned[..limit.saturating_sub(3)])
    } else {
        cleaned
    }
}

fn shlex_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "@%_+=:,./-".contains(ch))
    {
        return value.to_owned();
    }
    shell_quote(value)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn url_with_query(base: &str, params: &[(&str, String)]) -> String {
    let query = params
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("{}={}", quote_plus(key), quote_plus(value)))
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        base.to_owned()
    } else {
        format!("{base}?{query}")
    }
}

fn quote_plus(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' => {
                output.push(byte as char);
            }
            b' ' => output.push('+'),
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn create_temp_file() -> Option<PathBuf> {
    let tmpdir = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    for attempt in 0..100 {
        let path = tmpdir.join(format!(
            "tmp.{}{}",
            std::process::id(),
            attempt + randish_counter()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Some(path),
            Err(_) => continue,
        }
    }
    None
}

fn randish_counter() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn expose_popup_command(context: &Path, socket: &Path) -> String {
    format!(
        "old_stty=$(stty -g 2>/dev/null || true); stty raw -echo 2>/dev/null || true; pipe=$(mktemp \"${{TMPDIR:-/tmp}}/aimux-expose-stdin.XXXXXX\") || exit 1; rm -f \"$pipe\"; mkfifo \"$pipe\" || exit 1; feeder=; cleanup() {{ [ -n \"$feeder\" ] && kill \"$feeder\" 2>/dev/null || true; [ -n \"$feeder\" ] && wait \"$feeder\" 2>/dev/null || true; rm -f \"$pipe\"; if [ -n \"$old_stty\" ]; then stty \"$old_stty\" 2>/dev/null || true; else stty sane 2>/dev/null || true; fi; }}; trap cleanup EXIT HUP INT TERM; {{ cat {}; cat /dev/tty; }} >\"$pipe\" & feeder=$!; nc -U {} <\"$pipe\"; nc_status=$?; exit $nc_status",
        shell_quote(&context.to_string_lossy()),
        shell_quote(&socket.to_string_lossy())
    )
}
