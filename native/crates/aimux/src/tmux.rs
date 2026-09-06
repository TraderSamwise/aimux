use crate::paths::{basename_like_node_posix, compute_project_id};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

pub const TMUX_SEND_TEXT_CHUNK_BYTES: usize = 4_000;
pub const WINDOW_TARGET_FORMAT: &str = "#{window_id}\t#{window_index}\t#{window_name}";
pub const WINDOW_LIST_FORMAT: &str = "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}";
pub const MANAGED_TMUX_TERMINAL_FEATURES: [&str; 5] = [
    "xterm*:ccolour",
    "xterm*:cstyle",
    "xterm*:RGB",
    "xterm*:extkeys",
    "xterm*:hyperlinks",
];
pub const TMUX_RUNTIME_OWNER_OPTION: &str = "@aimux-runtime-owner";
pub const TMUX_DASHBOARD_OWNER_OPTION: &str = "@aimux-dashboard-owner";
pub const TMUX_DASHBOARD_READY_OPTION: &str = "@aimux-dashboard-ready";
pub const TMUX_DASHBOARD_BUILD_OPTION: &str = "@aimux-dashboard-build";
pub const TMUX_RUNTIME_CONTRACT_OPTION: &str = "@aimux-runtime-contract";
pub const AIMUX_TMUX_RUNTIME_CONTRACT_VERSION: &str = "2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedTmuxSessionOptions {
    pub prefix: &'static str,
    pub prefix2: &'static str,
    pub mouse: &'static str,
    pub window_size: &'static str,
    pub history_limit: &'static str,
    pub extended_keys: &'static str,
    pub extended_keys_format: &'static str,
    pub focus_events: &'static str,
}

pub const MANAGED_TMUX_SESSION_OPTIONS: ManagedTmuxSessionOptions = ManagedTmuxSessionOptions {
    prefix: "C-a",
    prefix2: "C-b",
    mouse: "on",
    window_size: "latest",
    history_limit: "20000",
    extended_keys: "always",
    extended_keys_format: "csi-u",
    focus_events: "off",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedTmuxAgentWindowOptions {
    pub allow_passthrough: &'static str,
    pub aggressive_resize: &'static str,
}

pub const MANAGED_TMUX_AGENT_WINDOW_OPTIONS: ManagedTmuxAgentWindowOptions =
    ManagedTmuxAgentWindowOptions {
        allow_passthrough: "on",
        aggressive_resize: "on",
    };

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxSessionRef {
    pub project_root: String,
    pub project_id: String,
    pub session_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxTarget {
    pub session_name: String,
    pub window_id: String,
    pub window_index: i64,
    pub window_name: String,
    pub pane_dead: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxWindowInfo {
    pub id: String,
    pub index: i64,
    pub name: String,
    pub active: bool,
    pub activity: Option<i64>,
    pub pane_dead: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxClientInfo {
    pub tty: String,
    pub session_name: String,
    pub window_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmuxManagedWindow {
    pub target: TmuxTarget,
    pub metadata: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxExecOptions {
    pub cwd: Option<String>,
}

type TmuxExecFn = dyn FnMut(&[String], Option<&TmuxExecOptions>) -> Result<String, String>;

pub struct TmuxRuntimeManager {
    session_prefix: String,
    exec: Box<TmuxExecFn>,
}

impl TmuxRuntimeManager {
    pub fn new() -> Self {
        Self::with_exec(|args, options| {
            let mut command = Command::new("tmux");
            command.args(args);
            if let Some(cwd) = options.and_then(|options| options.cwd.as_deref()) {
                command.current_dir(cwd);
            }
            let output = command
                .output()
                .map_err(|error| format!("failed to run tmux: {error}"))?;
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            Err(if stderr.is_empty() {
                format!("tmux exited with {}", output.status)
            } else {
                stderr
            })
        })
    }

    pub fn with_exec(
        exec: impl FnMut(&[String], Option<&TmuxExecOptions>) -> Result<String, String> + 'static,
    ) -> Self {
        Self {
            session_prefix: "aimux".to_owned(),
            exec: Box::new(exec),
        }
    }

    pub fn with_session_prefix(mut self, session_prefix: impl Into<String>) -> Self {
        self.session_prefix = session_prefix.into();
        self
    }

    pub fn is_available(&mut self) -> bool {
        self.exec_tmux(&["-V"]).is_ok()
    }

    pub fn get_version(&mut self) -> Option<String> {
        self.exec_tmux(&["-V"]).ok()
    }

    pub fn get_project_session(&self, project_root: impl AsRef<Path>) -> TmuxSessionRef {
        project_session(project_root, &self.session_prefix)
    }

    pub fn is_managed_session_name(&self, session_name: &str) -> bool {
        session_name.starts_with(&format!("{}-", self.session_prefix))
    }

    pub fn repair_legacy_project_session_names(
        &mut self,
        project_root: impl AsRef<Path>,
        session_names: Option<Vec<String>>,
    ) -> TmuxSessionRef {
        let project_root = project_root.as_ref();
        let session = self.get_project_session(project_root);
        let legacy_session_name = legacy_project_session_name(project_root, &self.session_prefix);
        if legacy_session_name == session.session_name {
            return session;
        }
        let mut known_names: BTreeSet<String> = session_names
            .unwrap_or_else(|| self.list_session_names())
            .into_iter()
            .collect();
        self.rename_known_session(
            &mut known_names,
            &legacy_session_name,
            &session.session_name,
        );
        let names: Vec<String> = known_names.iter().cloned().collect();
        for name in names {
            if !is_tmux_client_session_for_host(&name, &legacy_session_name) {
                continue;
            }
            let suffix = &name[legacy_session_name.len()..];
            self.rename_known_session(
                &mut known_names,
                &name,
                &format!("{}{}", session.session_name, suffix),
            );
        }
        session
    }

    pub fn has_session(&mut self, session_name: &str) -> bool {
        self.exec_tmux(&["has-session", "-t", session_name]).is_ok()
    }

    pub fn list_session_names(&mut self) -> Vec<String> {
        let Ok(raw) = self.exec_tmux(&["list-sessions", "-F", "#{session_name}"]) else {
            return Vec::new();
        };
        raw.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    }

    pub fn list_windows(&mut self, session_name: &str) -> Vec<TmuxWindowInfo> {
        let Ok(raw) = self.exec_owned(list_windows_argv(session_name), None) else {
            return Vec::new();
        };
        parse_tmux_windows(&raw)
    }

    pub fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        let window = self
            .list_windows(session_name)
            .into_iter()
            .find(|entry| entry.id == window_id)?;
        Some(TmuxTarget {
            session_name: session_name.to_owned(),
            window_id: window.id,
            window_index: window.index,
            window_name: window.name,
            pane_dead: window.pane_dead,
        })
    }

    pub fn has_window(&mut self, target: &TmuxTarget) -> bool {
        self.get_target_by_window_id(&target.session_name, &target.window_id)
            .is_some()
    }

    pub fn is_window_alive(&mut self, target: &TmuxTarget) -> bool {
        let Ok(pane_dead) = self.display_message("#{pane_dead}", Some(&target.window_id)) else {
            return false;
        };
        pane_dead.trim() != "1"
    }

    pub fn is_window_active(&mut self, target: &TmuxTarget) -> bool {
        self.display_message("#{window_active}", Some(&target.window_id))
            .is_ok_and(|value| value.trim() == "1")
    }

    pub fn list_clients(&mut self) -> Vec<TmuxClientInfo> {
        let Ok(raw) = self.exec_owned(list_clients_argv(), None) else {
            return Vec::new();
        };
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

    pub fn find_client_by_tty(&mut self, client_tty: &str) -> Option<TmuxClientInfo> {
        let normalized = client_tty.trim();
        if normalized.is_empty() {
            return None;
        }
        self.list_clients()
            .into_iter()
            .find(|client| client.tty == normalized)
    }

    pub fn get_attached_client_for_target(
        &mut self,
        target: &TmuxTarget,
    ) -> Option<TmuxClientInfo> {
        let clients: Vec<TmuxClientInfo> = self
            .list_clients()
            .into_iter()
            .filter(|client| {
                client.session_name == target.session_name
                    || is_tmux_client_session_for_host(&client.session_name, &target.session_name)
            })
            .collect();
        clients
            .iter()
            .find(|client| client.window_id == target.window_id)
            .cloned()
            .or_else(|| clients.first().cloned())
    }

    pub fn get_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
        self.exec_tmux(&["show-options", "-v", "-t", session_name, key])
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    pub fn get_window_metadata(&mut self, window_id: &str) -> Option<Value> {
        let raw = self
            .exec_tmux(&["show-window-options", "-v", "-t", window_id, "@aimux-meta"])
            .ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn list_managed_windows(&mut self, session_name: &str) -> Vec<TmuxManagedWindow> {
        let Ok(raw) = self.exec_tmux(&[
            "list-windows",
            "-t",
            session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ]) else {
            return Vec::new();
        };
        parse_tmux_managed_windows(session_name, &raw)
    }

    pub fn list_project_managed_windows(
        &mut self,
        project_root: impl AsRef<Path>,
    ) -> Vec<TmuxManagedWindow> {
        let project_root = project_root.as_ref();
        let host_session = self.get_project_session(project_root).session_name;
        let all_session_names = self.list_session_names();
        self.repair_legacy_project_session_names(project_root, Some(all_session_names));
        let requested_root = canonicalize_filesystem_path(project_root);
        let session_names: Vec<String> = self
            .list_session_names()
            .into_iter()
            .filter(|name| {
                if name == &host_session || is_tmux_client_session_for_host(name, &host_session) {
                    return true;
                }
                if !self.is_managed_session_name(name) {
                    return false;
                }
                self.get_session_option(name, "@aimux-project-root")
                    .is_some_and(|stored_root| {
                        canonicalize_filesystem_path(stored_root) == requested_root
                    })
            })
            .collect();
        let mut seen_window_ids = BTreeSet::new();
        let mut managed = Vec::new();
        for session_name in session_names {
            for entry in self.list_managed_windows(&session_name) {
                if seen_window_ids.insert(entry.target.window_id.clone()) {
                    managed.push(entry);
                }
            }
        }
        managed
    }

    pub fn find_managed_window(
        &mut self,
        session_name: &str,
        session_id: Option<&str>,
        backend_session_id: Option<&str>,
    ) -> Option<TmuxManagedWindow> {
        if session_id.is_none() && backend_session_id.is_none() {
            return None;
        }
        self.list_managed_windows(session_name)
            .into_iter()
            .find(|entry| {
                session_id
                    .is_some_and(|id| metadata_string(&entry.metadata, "sessionId") == Some(id))
                    || backend_session_id.is_some_and(|id| {
                        metadata_string(&entry.metadata, "backendSessionId") == Some(id)
                    })
            })
    }

    fn display_message(&mut self, format: &str, target: Option<&str>) -> Result<String, String> {
        let argv = match target {
            Some(target) => vec![
                "display-message".to_owned(),
                "-p".to_owned(),
                "-t".to_owned(),
                target.to_owned(),
                format.to_owned(),
            ],
            None => vec![
                "display-message".to_owned(),
                "-p".to_owned(),
                format.to_owned(),
            ],
        };
        self.exec_owned(argv, None)
    }

    fn rename_known_session(&mut self, known_names: &mut BTreeSet<String>, from: &str, to: &str) {
        if !known_names.contains(from) || known_names.contains(to) {
            return;
        }
        if self.exec_tmux(&["rename-session", "-t", from, to]).is_ok() {
            known_names.remove(from);
            known_names.insert(to.to_owned());
        }
    }

    fn exec_tmux(&mut self, args: &[&str]) -> Result<String, String> {
        self.exec_owned(args.iter().map(|arg| (*arg).to_owned()).collect(), None)
    }

    fn exec_owned(
        &mut self,
        args: Vec<String>,
        options: Option<TmuxExecOptions>,
    ) -> Result<String, String> {
        (self.exec)(&args, options.as_ref())
    }
}

impl Default for TmuxRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxCommandSpec {
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct CapturePaneOptions {
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub include_escapes: bool,
}

pub fn is_tmux_client_session_name(session_name: &str) -> bool {
    session_name
        .rsplit_once("-client-")
        .is_some_and(|(_, suffix)| is_lower_hex_8(suffix))
}

pub fn is_tmux_client_session_for_host(session_name: &str, host_session_name: &str) -> bool {
    session_name
        .strip_prefix(&format!("{host_session_name}-client-"))
        .is_some_and(is_lower_hex_8)
}

pub fn is_dashboard_window_name(name: &str) -> bool {
    name == "dashboard" || name.starts_with("dashboard-")
}

pub fn is_meta_dashboard_window_name(name: &str) -> bool {
    name == "meta-dashboard" || name.starts_with("meta-dashboard-")
}

pub fn project_session(project_root: impl AsRef<Path>, session_prefix: &str) -> TmuxSessionRef {
    let project_root = project_root.as_ref().to_string_lossy().into_owned();
    let project_id = compute_project_id(&project_root);
    TmuxSessionRef {
        session_name: format!("{session_prefix}-{project_id}"),
        project_root,
        project_id,
    }
}

pub fn legacy_project_session_name(project_root: impl AsRef<Path>, session_prefix: &str) -> String {
    let project_root = project_root.as_ref().to_string_lossy();
    let project_id = format!("{:x}", Sha1::digest(project_root.as_bytes()));
    let slug = slugify_project_name(basename_like_node_posix(&project_root));
    let slug = if slug.is_empty() {
        "project".to_owned()
    } else {
        slug
    };
    format!("{session_prefix}-{slug}-{}", &project_id[..10])
}

pub fn project_client_session_name(host_session_name: &str, client_suffix: &str) -> String {
    format!("{host_session_name}-client-{client_suffix}")
}

pub fn session_window_target(session_name: &str, window_index: i64) -> String {
    format!("{session_name}:{window_index}")
}

pub fn session_window_id_target(session_name: &str, window_id: &str) -> String {
    format!("{session_name}:{window_id}")
}

pub fn split_text_for_tmux_send_keys(text: &str, max_bytes: usize) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_bytes = 0;
    for character in text.chars() {
        let character_bytes = character.len_utf8();
        if !current.is_empty() && current_bytes + character_bytes > max_bytes {
            chunks.push(current);
            current = String::new();
            current_bytes = 0;
        }
        current.push(character);
        current_bytes += character_bytes;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn packed_argv_bytes(argv: &[String]) -> usize {
    argv.iter().map(|arg| arg.len() + 1).sum()
}

pub fn build_default_root_mouse_bindings_config(
    open_pane_link_command: &str,
    open_status_pr_command: &str,
) -> String {
    [
        format!(r#"bind-key -T root MouseDown1Pane if-shell "{open_pane_link_command}" "" "select-pane -t = \; send-keys -M""#),
        "bind-key -T root MouseDrag1Pane if-shell -F \"#{||:#{pane_in_mode},#{mouse_any_flag}}\" { send-keys -M } { copy-mode -M }".to_owned(),
        "bind-key -T root WheelUpPane if-shell -F \"#{&&:#{!=:#{alternate_on},1},#{!=:#{mouse_any_flag},1}}\" \"copy-mode -e \\; send-keys -X -N 1 scroll-up\" \"send-keys -M\"".to_owned(),
        "bind-key -T root WheelDownPane if-shell -F \"#{||:#{alternate_on},#{mouse_any_flag}}\" { send-keys -M } { send-keys -M }".to_owned(),
        format!(r#"bind-key -T root DoubleClick1Pane if-shell "{open_pane_link_command}" "" "send-keys -M""#),
        format!(r#"bind-key -T root MouseDown1Status if-shell "{open_status_pr_command}" "" """#),
        format!(r#"bind-key -T root DoubleClick1Status if-shell "{open_status_pr_command}" "" """#),
        format!(r#"bind-key -T root MouseDown1StatusDefault if-shell "{open_status_pr_command}" "" """#),
        format!(r#"bind-key -T root DoubleClick1StatusDefault if-shell "{open_status_pr_command}" "" """#),
        "bind-key -T copy-mode WheelUpPane send-keys -X -N 1 scroll-up".to_owned(),
        "bind-key -T copy-mode WheelDownPane send-keys -X -N 1 scroll-down".to_owned(),
        "bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 1 scroll-up".to_owned(),
        "bind-key -T copy-mode-vi WheelDownPane send-keys -X -N 1 scroll-down".to_owned(),
        "bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel".to_owned(),
        "bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel".to_owned(),
        String::new(),
    ]
    .join("\n")
}

pub fn new_session_argv(
    session_name: &str,
    project_root: &str,
    dashboard_command: Option<&TmuxCommandSpec>,
) -> Vec<String> {
    let (cwd, command) = dashboard_command
        .map(|spec| (spec.cwd.as_str(), spec.command.as_str()))
        .unwrap_or((project_root, "sh"));
    let mut argv = vec![
        "new-session".to_owned(),
        "-d".to_owned(),
        "-s".to_owned(),
        session_name.to_owned(),
        "-c".to_owned(),
        cwd.to_owned(),
        "-n".to_owned(),
        "dashboard".to_owned(),
        command.to_owned(),
    ];
    match dashboard_command {
        Some(spec) => argv.extend(spec.args.iter().cloned()),
        None => argv.extend(["-lc".to_owned(), "tail -f /dev/null".to_owned()]),
    }
    argv
}

pub fn new_dashboard_window_argv(
    session_name: &str,
    project_root: &str,
    dashboard_name: &str,
    dashboard_command: Option<&TmuxCommandSpec>,
) -> Vec<String> {
    let (cwd, command) = dashboard_command
        .map(|spec| (spec.cwd.as_str(), spec.command.as_str()))
        .unwrap_or((project_root, "sh"));
    let mut argv = vec![
        "new-window".to_owned(),
        "-d".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        "-c".to_owned(),
        cwd.to_owned(),
        "-n".to_owned(),
        dashboard_name.to_owned(),
        command.to_owned(),
    ];
    match dashboard_command {
        Some(spec) => argv.extend(spec.args.iter().cloned()),
        None => argv.extend(["-lc".to_owned(), "tail -f /dev/null".to_owned()]),
    }
    argv
}

pub fn new_window_argv(
    session_name: &str,
    name: &str,
    cwd: &str,
    command: &str,
    args: &[String],
    detached: bool,
) -> Vec<String> {
    let mut argv = vec!["new-window".to_owned()];
    if detached {
        argv.push("-d".to_owned());
    }
    argv.extend([
        "-P".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        "-c".to_owned(),
        cwd.to_owned(),
        "-n".to_owned(),
        name.to_owned(),
        "-F".to_owned(),
        WINDOW_TARGET_FORMAT.to_owned(),
        command.to_owned(),
    ]);
    argv.extend(args.iter().cloned());
    argv
}

pub fn capture_pane_argv(window_id: &str, options: CapturePaneOptions) -> Vec<String> {
    let mut argv = vec![
        "capture-pane".to_owned(),
        "-p".to_owned(),
        "-J".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-S".to_owned(),
        options
            .start_line
            .map_or_else(|| "-".to_owned(), |line| line.to_string()),
    ];
    if let Some(end_line) = options.end_line {
        argv.extend(["-E".to_owned(), end_line.to_string()]);
    }
    if options.include_escapes {
        argv.insert(3, "-e".to_owned());
    }
    argv
}

pub fn start_pane_pipe_argv(
    window_id: &str,
    command: &str,
    only_if_not_piped: bool,
) -> Vec<String> {
    let mut argv = vec![
        "pipe-pane".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ];
    if only_if_not_piped {
        argv.push("-o".to_owned());
    }
    argv.push(command.to_owned());
    argv
}

pub fn stop_pane_pipe_argv(window_id: &str) -> Vec<String> {
    vec![
        "pipe-pane".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ]
}

pub fn resize_window_argv(window_id: &str, cols: i64, rows: i64) -> Vec<String> {
    vec![
        "resize-window".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-x".to_owned(),
        cols.to_string(),
        "-y".to_owned(),
        rows.to_string(),
    ]
}

pub fn send_text_argv(window_id: &str, text: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-l".to_owned(),
        text.to_owned(),
    ]
}

pub fn send_enter_argv(window_id: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "Enter".to_owned(),
    ]
}

pub fn send_client_enter_argv(client_tty: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-K".to_owned(),
        "-c".to_owned(),
        client_tty.to_owned(),
        "Enter".to_owned(),
    ]
}

pub fn send_client_carriage_return_argv(client_tty: &str, window_id: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-c".to_owned(),
        client_tty.to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-H".to_owned(),
        "0d".to_owned(),
    ]
}

pub fn send_carriage_return_argv(window_id: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-H".to_owned(),
        "0d".to_owned(),
    ]
}

pub fn send_escape_argv(window_id: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-H".to_owned(),
        "1b".to_owned(),
    ]
}

pub fn send_focus_in_argv(window_id: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-H".to_owned(),
        "1b".to_owned(),
        "5b".to_owned(),
        "49".to_owned(),
    ]
}

pub fn send_modified_enter_argv(window_id: &str) -> Vec<String> {
    [
        "send-keys",
        "-t",
        window_id,
        "-H",
        "1b",
        "5b",
        "31",
        "33",
        "3b",
        "32",
        "75",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub fn send_key_argv(window_id: &str, key: &str) -> Vec<String> {
    vec![
        "send-keys".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        key.to_owned(),
    ]
}

pub fn respawn_window_argv(window_id: &str, spec: &TmuxCommandSpec) -> Vec<String> {
    let mut argv = vec![
        "respawn-window".to_owned(),
        "-k".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        "-c".to_owned(),
        spec.cwd.clone(),
        spec.command.clone(),
    ];
    argv.extend(spec.args.iter().cloned());
    argv
}

pub fn switch_client_argv(
    session_name: &str,
    window_index: i64,
    client_tty: Option<&str>,
) -> Vec<String> {
    let mut argv = vec!["switch-client".to_owned()];
    if let Some(client_tty) = client_tty.filter(|tty| !tty.is_empty()) {
        argv.extend(["-c".to_owned(), client_tty.to_owned()]);
    }
    argv.extend([
        "-t".to_owned(),
        session_window_target(session_name, window_index),
    ]);
    argv
}

pub fn switch_client_to_target_argv(client_tty: &str, window_id: &str) -> Vec<String> {
    vec![
        "switch-client".to_owned(),
        "-c".to_owned(),
        client_tty.to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ]
}

pub fn list_clients_argv() -> Vec<String> {
    vec![
        "list-clients".to_owned(),
        "-F".to_owned(),
        "#{client_tty}\t#{session_name}\t#{window_id}\t#{client_name}".to_owned(),
    ]
}

pub fn list_windows_argv(session_name: &str) -> Vec<String> {
    vec![
        "list-windows".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        "-F".to_owned(),
        WINDOW_LIST_FORMAT.to_owned(),
    ]
}

pub fn refresh_status_argv() -> Vec<String> {
    vec!["refresh-client".to_owned(), "-S".to_owned()]
}

pub fn link_window_argv(window_id: &str, destination: &str) -> Vec<String> {
    vec![
        "link-window".to_owned(),
        "-d".to_owned(),
        "-s".to_owned(),
        window_id.to_owned(),
        "-t".to_owned(),
        destination.to_owned(),
    ]
}

pub fn move_window_argv(session_name: &str, window_id: &str, window_index: i64) -> Vec<String> {
    vec![
        "move-window".to_owned(),
        "-s".to_owned(),
        session_window_id_target(session_name, window_id),
        "-t".to_owned(),
        session_window_target(session_name, window_index),
    ]
}

pub fn swap_window_argv(session_name: &str, window_id: &str, window_index: i64) -> Vec<String> {
    vec![
        "swap-window".to_owned(),
        "-s".to_owned(),
        session_window_id_target(session_name, window_id),
        "-t".to_owned(),
        session_window_target(session_name, window_index),
    ]
}

pub fn set_session_option_argv(session_name: &str, key: &str, value: &str) -> Vec<String> {
    vec![
        "set-option".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        key.to_owned(),
        value.to_owned(),
    ]
}

pub fn append_session_option_argv(session_name: &str, key: &str, value: &str) -> Vec<String> {
    vec![
        "set-option".to_owned(),
        "-as".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        key.to_owned(),
        value.to_owned(),
    ]
}

pub fn rename_session_argv(from: &str, to: &str) -> Vec<String> {
    vec![
        "rename-session".to_owned(),
        "-t".to_owned(),
        from.to_owned(),
        to.to_owned(),
    ]
}

pub fn attach_session_argv(session_name: &str, window_index: Option<i64>) -> Vec<String> {
    let target = window_index.map_or_else(
        || session_name.to_owned(),
        |index| session_window_target(session_name, index),
    );
    vec!["attach-session".to_owned(), "-t".to_owned(), target]
}

pub fn kill_session_argv(session_name: &str) -> Vec<String> {
    vec![
        "kill-session".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
    ]
}

pub fn unlink_window_argv(session_name: &str, window_id: &str) -> Vec<String> {
    vec![
        "unlink-window".to_owned(),
        "-t".to_owned(),
        session_window_id_target(session_name, window_id),
    ]
}

pub fn kill_window_argv(window_id: &str) -> Vec<String> {
    vec![
        "kill-window".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ]
}

pub fn rename_window_argv(window_id: &str, name: &str) -> Vec<String> {
    vec![
        "rename-window".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        name.to_owned(),
    ]
}

pub fn set_window_option_argv(window_id: &str, key: &str, value: &str) -> Vec<String> {
    vec![
        "set-window-option".to_owned(),
        "-q".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
        key.to_owned(),
        value.to_owned(),
    ]
}

pub fn clear_history_argv(window_id: &str) -> Vec<String> {
    vec![
        "clear-history".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ]
}

pub fn select_window_argv(window_id: &str) -> Vec<String> {
    vec![
        "select-window".to_owned(),
        "-t".to_owned(),
        window_id.to_owned(),
    ]
}

fn is_lower_hex_8(value: &str) -> bool {
    value.len() == 8
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_tmux_windows(raw: &str) -> Vec<TmuxWindowInfo> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            TmuxWindowInfo {
                id: parts.next().unwrap_or_default().to_owned(),
                index: parse_i64_or_zero(parts.next()),
                name: parts.next().unwrap_or_default().to_owned(),
                active: parts.next() == Some("1"),
                activity: parse_optional_i64(parts.next()),
                pane_dead: Some(parts.next() == Some("1")),
            }
        })
        .collect()
}

fn parse_tmux_managed_windows(session_name: &str, raw: &str) -> Vec<TmuxManagedWindow> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let window_id = parts.next().unwrap_or_default().to_owned();
            let window_index = parse_i64_or_zero(parts.next());
            let window_name = parts.next().unwrap_or_default().to_owned();
            let _active = parts.next();
            let _activity = parts.next();
            let pane_dead = Some(parts.next() == Some("1"));
            let metadata_raw = parts.next().unwrap_or_default();
            let metadata = serde_json::from_str(metadata_raw).ok()?;
            Some(TmuxManagedWindow {
                target: TmuxTarget {
                    session_name: session_name.to_owned(),
                    window_id,
                    window_index,
                    window_name,
                    pane_dead,
                },
                metadata,
            })
        })
        .collect()
}

fn parse_i64_or_zero(value: Option<&str>) -> i64 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_optional_i64(value: Option<&str>) -> Option<i64> {
    let value = value?;
    if value.is_empty() {
        None
    } else {
        value.parse().ok()
    }
}

fn metadata_string<'a>(metadata: &'a Value, key: &str) -> Option<&'a str> {
    metadata.get(key).and_then(Value::as_str)
}

fn canonicalize_filesystem_path(path: impl AsRef<Path>) -> String {
    fs::canonicalize(path.as_ref())
        .unwrap_or_else(|_| path.as_ref().to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn slugify_project_name(name: &str) -> String {
    let mut slug = String::new();
    let mut in_replacement = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            slug.push(character);
            in_replacement = false;
        } else if !in_replacement {
            slug.push('-');
            in_replacement = true;
        }
    }
    slug
}
