use crate::cli_launcher::{
    AimuxCliLaunchOptions, get_aimux_current_cli_identity, is_cargo_test_aimux_binary,
};
use crate::paths::{PathResolver, basename_like_node_posix, compute_project_id};
use crate::tmux_exec_metrics::{TmuxExecMode, record_tmux_exec};
use crate::tmux_query_memo::{
    is_non_caching_tmux_read, is_read_only_tmux_verb, memoized_tmux_query, reset_tmux_query_memo,
    tmux_query_key,
};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::BTreeSet;
use std::fs;
use std::io::IsTerminal;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

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
pub const TMUX_RUNTIME_REBUILD_REQUIRED_OPTION: &str = "@aimux-runtime-rebuild-required";
pub const AIMUX_TMUX_RUNTIME_CONTRACT_VERSION: &str = "2";
pub const AIMUX_TMUX_SOCKET_PATH_ENV: &str = "AIMUX_TMUX_SOCKET_PATH";
static TMUX_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
pub struct TmuxPersistedCommandText {
    pub text: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenTargetOptions {
    pub inside_tmux: bool,
    pub already_resolved: bool,
    pub client_tty: Option<String>,
    pub client_suffix: Option<String>,
    pub return_session_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanePipeFileOwnership {
    pub token: String,
    pub token_file_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PanePipeFileOptions {
    pub only_if_not_piped: bool,
    pub ownership: Option<PanePipeFileOwnership>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxExecOptions {
    pub cwd: Option<String>,
}

type TmuxExecFn = dyn FnMut(&[String], Option<&TmuxExecOptions>) -> Result<String, String>;
type TmuxInteractiveExecFn = dyn FnMut(&[String], Option<&TmuxExecOptions>) -> Result<(), String>;

pub struct TmuxRuntimeManager {
    session_prefix: String,
    exec: Box<TmuxExecFn>,
    interactive_exec: Box<TmuxInteractiveExecFn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxRuntimeConfig {
    pub project_state_dir: String,
    pub control_script_command: String,
    pub statusline_command: TmuxCommandSpec,
    pub runtime_owner_id: String,
}

impl TmuxRuntimeManager {
    pub fn new() -> Self {
        Self::with_exec(|args, options| {
            let started_at = Instant::now();
            let mut command = tmux_command_from_env();
            command.args(args);
            command.env_remove("TMUX");
            command.env_remove("TMUX_PANE");
            if let Some(cwd) = options.and_then(|options| options.cwd.as_deref()) {
                command.current_dir(cwd);
            }
            let result = command
                .output()
                .map_err(|error| format!("failed to run tmux: {error}"))?;
            let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
            record_tmux_exec(args, elapsed_ms, TmuxExecMode::Sync);
            if result.status.success() {
                return Ok(String::from_utf8_lossy(&result.stdout).trim().to_owned());
            }
            let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
            Err(if stderr.is_empty() {
                format!("tmux exited with {}", result.status)
            } else {
                stderr
            })
        })
    }

    pub fn with_exec(
        exec: impl FnMut(&[String], Option<&TmuxExecOptions>) -> Result<String, String> + 'static,
    ) -> Self {
        Self::with_exec_and_interactive(exec, default_interactive_exec)
    }

    pub fn with_exec_and_interactive(
        exec: impl FnMut(&[String], Option<&TmuxExecOptions>) -> Result<String, String> + 'static,
        interactive_exec: impl FnMut(&[String], Option<&TmuxExecOptions>) -> Result<(), String>
        + 'static,
    ) -> Self {
        Self {
            session_prefix: "aimux".to_owned(),
            exec: Box::new(exec),
            interactive_exec: Box::new(interactive_exec),
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
            .unwrap_or_else(|| self.list_session_names().unwrap_or_default())
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

    pub fn get_project_client_session_name(
        &self,
        host_session_name: &str,
        client_suffix: &str,
    ) -> String {
        project_client_session_name(host_session_name, client_suffix)
    }

    pub fn is_client_session_name(&self, session_name: &str) -> bool {
        is_tmux_client_session_name(session_name)
    }

    pub fn is_inside_tmux(&self) -> bool {
        std::env::var_os("TMUX").is_some()
    }

    pub fn get_open_session_name(&mut self, session_name: &str, inside_tmux: bool) -> String {
        self.resolve_open_session_name(session_name, inside_tmux, None, None)
            .unwrap_or_else(|_| session_name.to_owned())
    }

    pub fn peek_open_session_name(&mut self, session_name: &str, inside_tmux: bool) -> String {
        if !self.is_managed_session_name(session_name) || self.is_client_session_name(session_name)
        {
            return session_name.to_owned();
        }
        let Some(client_suffix) = self.resolve_client_suffix(inside_tmux, None) else {
            return session_name.to_owned();
        };
        self.get_project_client_session_name(session_name, &client_suffix)
    }

    pub fn has_session(&mut self, session_name: &str) -> bool {
        self.exec_tmux(&["has-session", "-t", session_name]).is_ok()
    }

    pub async fn has_session_async(&mut self, session_name: &str) -> bool {
        self.has_session(session_name)
    }

    pub fn ensure_project_session(
        &mut self,
        project_root: impl AsRef<Path>,
        dashboard_command: Option<&TmuxCommandSpec>,
        config: Option<TmuxRuntimeConfig>,
    ) -> Result<TmuxSessionRef, String> {
        let project_root = project_root.as_ref();
        let project_root_text = project_root.to_string_lossy().into_owned();
        let session = self.get_project_session(project_root);
        for attempt in 0..2 {
            let mut exists = self.has_session(&session.session_name);
            if !exists {
                let before = match self.list_session_names() {
                    Ok(names) => names,
                    Err(error) if tmux_list_sessions_failed_because_no_server(&error) => Vec::new(),
                    Err(error) => return Err(error),
                };
                self.repair_legacy_project_session_names(project_root, Some(before));
                exists = self.has_session(&session.session_name);
            }
            let current_runtime_contract = if exists {
                self.get_session_option(&session.session_name, TMUX_RUNTIME_CONTRACT_OPTION)
            } else {
                None
            };
            if !exists {
                self.exec_owned(
                    new_session_argv(&session.session_name, &project_root_text, dashboard_command),
                    Some(TmuxExecOptions {
                        cwd: Some(project_root_text.clone()),
                    }),
                )?;
                if !self.wait_for_session(&session.session_name, Duration::from_millis(500)) {
                    return Err(format!(
                        "tmux session {} was not visible after creation",
                        session.session_name
                    ));
                }
            }
            let configure_result = (|| {
                if !exists {
                    self.set_current_runtime_contract(&session.session_name)?;
                }
                self.configure_managed_session(
                    &session.session_name,
                    &project_root_text,
                    config.clone().unwrap_or_else(|| {
                        default_runtime_config(project_root, &project_root_text)
                    }),
                )
            })();
            match configure_result {
                Ok(()) => {}
                Err(error) if attempt == 0 && is_no_such_session_error(&error) => continue,
                Err(error) => return Err(error),
            }
            if !exists || current_runtime_contract.is_none() {
                self.set_current_runtime_contract(&session.session_name)?;
            }
            return Ok(session);
        }
        Ok(session)
    }

    fn wait_for_session(&mut self, session_name: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.has_session(session_name) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.has_session(session_name)
    }

    pub async fn ensure_project_session_async(
        &mut self,
        project_root: impl AsRef<Path>,
        config: Option<TmuxRuntimeConfig>,
    ) -> Result<TmuxSessionRef, String> {
        self.ensure_project_session(project_root, None, config)
    }

    pub fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        let raw = self.exec_tmux(&["list-sessions", "-F", "#{session_name}"])?;
        Ok(raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    pub fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        let raw = self.exec_owned(list_windows_argv(session_name), None)?;
        Ok(parse_tmux_windows(&raw))
    }

    pub fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        let window = self
            .list_windows(session_name)
            .ok()?
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

    /// Window ids that currently exist across every tmux session on this server.
    /// One call, so a caller validating many sessions does not spawn tmux per session.
    pub fn try_live_window_ids(&mut self) -> Result<std::collections::BTreeSet<String>, String> {
        let raw = self.exec_owned(list_all_window_ids_argv(), None)?;
        Ok(raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>())
    }

    pub fn has_window(&mut self, target: &TmuxTarget) -> bool {
        self.get_target_by_window_id(&target.session_name, &target.window_id)
            .is_some()
    }

    pub fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        let pane_dead = self.display_message_raw("#{pane_dead}", Some(&target.window_id))?;
        Ok(pane_dead.trim() != "1")
    }

    pub fn is_window_active(&mut self, target: &TmuxTarget) -> bool {
        self.display_message_raw("#{window_active}", Some(&target.window_id))
            .is_ok_and(|value| value.trim() == "1")
    }

    pub fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        let argv = new_window_argv(session_name, name, cwd, command, args, detached);
        let argv_bytes = packed_argv_bytes(&argv);
        let raw = self
            .exec_owned(
                argv,
                Some(TmuxExecOptions {
                    cwd: Some(cwd.to_owned()),
                }),
            )
            .map_err(|_| {
                format!(
                    "tmux failed to create window \"{name}\" in session {session_name} ({argv_bytes}-byte command)"
                )
            })?;
        parse_window_target(session_name, &raw)
    }

    pub async fn create_window_async(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        self.create_window(session_name, name, cwd, command, args, detached)
    }

    pub fn kill_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(kill_window_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub async fn kill_window_async(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.kill_window(target)
    }

    pub fn unlink_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(
            unlink_window_argv(&target.session_name, &target.window_id),
            None,
        )
        .map(|_| ())
    }

    pub fn kill_session(&mut self, session_name: &str) -> Result<(), String> {
        self.exec_owned(kill_session_argv(session_name), None)
            .map(|_| ())
    }

    pub fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.exec_owned(rename_window_argv(window_id, name), None)
            .map(|_| ())
    }

    pub fn ensure_dashboard_window(
        &mut self,
        session_name: &str,
        project_root: &str,
        dashboard_command: Option<&TmuxCommandSpec>,
    ) -> Result<TmuxTarget, String> {
        let dashboard_name = "dashboard";
        if let Some(existing) = self
            .list_windows(session_name)?
            .into_iter()
            .find(|window| is_dashboard_window_name(&window.name))
        {
            self.rename_window(&existing.id, dashboard_name)?;
            return Ok(TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: existing.id,
                window_index: existing.index,
                window_name: dashboard_name.to_owned(),
                pane_dead: None,
            });
        }
        self.exec_owned(
            new_dashboard_window_argv(
                session_name,
                project_root,
                dashboard_name,
                dashboard_command,
            ),
            Some(TmuxExecOptions {
                cwd: Some(project_root.to_owned()),
            }),
        )?;
        self.list_windows(session_name)?
            .into_iter()
            .find(|window| window.name == dashboard_name)
            .map(|created| TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: created.id,
                window_index: created.index,
                window_name: created.name,
                pane_dead: None,
            })
            .ok_or_else(|| {
                format!("Failed to create dashboard window in tmux session {session_name}")
            })
    }

    pub fn respawn_window(
        &mut self,
        target: &TmuxTarget,
        spec: &TmuxCommandSpec,
    ) -> Result<(), String> {
        self.exec_owned(
            respawn_window_argv(&target.window_id, spec),
            Some(TmuxExecOptions {
                cwd: Some(spec.cwd.clone()),
            }),
        )
        .map(|_| ())
    }

    pub fn clear_target_history(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(clear_history_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub async fn clear_target_history_async(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.clear_target_history(target)
    }

    pub fn replace_window_when_ready(
        &mut self,
        target: &TmuxTarget,
        spec: &TmuxCommandSpec,
        readiness_option: &str,
        readiness_value: &str,
        timeout_ms: u64,
    ) -> Result<TmuxTarget, String> {
        let was_active = self.is_window_active(target);
        let replacement_name = format!(
            "aimux-reload-{}-{}",
            target
                .window_id
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
                .collect::<String>(),
            now_millis_base36()
        );
        let replacement = self.create_window(
            &target.session_name,
            &replacement_name,
            &spec.cwd,
            &spec.command,
            &spec.args,
            true,
        )?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            if self
                .get_window_option(&replacement.window_id, readiness_option)
                .as_deref()
                == Some(readiness_value)
            {
                let old_name = format!("{}-old", target.window_name);
                let mut original_renamed = false;
                let mut replacement_renamed = false;
                let swap_result = (|| {
                    self.rename_window(&target.window_id, &old_name)?;
                    original_renamed = true;
                    self.rename_window(&replacement.window_id, &target.window_name)?;
                    replacement_renamed = true;
                    self.exec_owned(
                        vec![
                            "swap-window".to_owned(),
                            "-d".to_owned(),
                            "-s".to_owned(),
                            replacement.window_id.clone(),
                            "-t".to_owned(),
                            target.window_id.clone(),
                        ],
                        None,
                    )
                    .map(|_| ())
                })();
                if let Err(error) = swap_result {
                    if replacement_renamed {
                        let _ = self.rename_window(&replacement.window_id, &replacement_name);
                    }
                    if original_renamed {
                        let _ = self.rename_window(&target.window_id, &target.window_name);
                    }
                    let _ = self.kill_window(&replacement);
                    return Err(error);
                }
                let swapped = self
                    .get_target_by_window_id(&target.session_name, &replacement.window_id)
                    .unwrap_or(replacement);
                let _ = self.kill_window(target);
                if was_active {
                    self.select_window(&swapped)?;
                }
                return Ok(swapped);
            }
            if !self.is_window_alive(&replacement)? {
                let output = self
                    .capture_target(
                        &replacement,
                        CapturePaneOptions {
                            start_line: Some(-80),
                            ..CapturePaneOptions::default()
                        },
                    )
                    .unwrap_or_default();
                let _ = self.kill_window(&replacement);
                let output = output.trim();
                return Err(if output.is_empty() {
                    format!(
                        "Replacement tmux window {} exited before dashboard readiness",
                        replacement.window_id
                    )
                } else {
                    format!(
                        "Replacement tmux window {} exited before dashboard readiness:\n{}",
                        replacement.window_id, output
                    )
                });
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = self.kill_window(&replacement);
        Err(format!(
            "Timed out waiting for replacement tmux window {} to become ready",
            replacement.window_id
        ))
    }

    pub fn select_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(select_window_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn cancel_copy_mode(&mut self, target: impl AsRef<str>) -> Result<(), String> {
        let target = target.as_ref();
        if self
            .display_message("#{pane_in_mode}", Some(target))
            .as_deref()
            != Some("1")
        {
            return Ok(());
        }
        self.exec_owned(
            vec![
                "send-keys".to_owned(),
                "-t".to_owned(),
                target.to_owned(),
                "-X".to_owned(),
                "cancel".to_owned(),
            ],
            None,
        )
        .map(|_| ())
    }

    pub fn switch_client_to_target(
        &mut self,
        client_tty: &str,
        target: &TmuxTarget,
    ) -> Result<(), String> {
        self.exec_owned(
            switch_client_to_target_argv(client_tty, &target.window_id),
            None,
        )
        .map(|_| ())
    }

    pub fn capture_target(
        &mut self,
        target: &TmuxTarget,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.exec_owned(capture_pane_argv(&target.window_id, options), None)
    }

    pub async fn capture_target_async(
        &mut self,
        target: &TmuxTarget,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.capture_target(target, options)
    }

    pub fn start_pane_pipe(
        &mut self,
        target: &TmuxTarget,
        command: &str,
        only_if_not_piped: bool,
    ) -> Result<(), String> {
        self.exec_owned(
            start_pane_pipe_argv(&target.window_id, command, only_if_not_piped),
            None,
        )
        .map(|_| ())
    }

    pub fn stop_pane_pipe(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(stop_pane_pipe_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &str,
        options: PanePipeFileOptions,
    ) -> Result<(), String> {
        let command = options.ownership.as_ref().map_or_else(
            || format!("cat >> {}", shell_quote(file_path)),
            |ownership| {
                [
                    "sh".to_owned(),
                    "-c".to_owned(),
                    shell_quote(pane_pipe_ownership_script()),
                    "aimux-pane-tap".to_owned(),
                    shell_quote(&ownership.token),
                    shell_quote(&ownership.token_file_path),
                    shell_quote(file_path),
                ]
                .join(" ")
            },
        );
        self.start_pane_pipe(target, &command, options.only_if_not_piped)
    }

    pub fn is_pane_piped(&mut self, target: &TmuxTarget) -> bool {
        self.display_message("#{pane_pipe}", Some(&target.window_id))
            .as_deref()
            == Some("1")
    }

    pub fn resize_target(
        &mut self,
        target: &TmuxTarget,
        cols: i64,
        rows: i64,
    ) -> Result<(), String> {
        self.exec_owned(resize_window_argv(&target.window_id, cols, rows), None)
            .map(|_| ())
    }

    pub fn send_text(&mut self, target: &TmuxTarget, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        for chunk in split_text_for_tmux_send_keys(text, TMUX_SEND_TEXT_CHUNK_BYTES) {
            self.exec_owned(send_text_argv(&target.window_id, &chunk), None)?;
        }
        Ok(())
    }

    pub fn send_enter(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(send_enter_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn send_client_enter(&mut self, client_tty: &str) -> Result<(), String> {
        self.exec_owned(send_client_enter_argv(client_tty), None)
            .map(|_| ())
    }

    pub fn send_client_carriage_return(
        &mut self,
        client_tty: &str,
        target: &TmuxTarget,
    ) -> Result<(), String> {
        self.exec_owned(
            send_client_carriage_return_argv(client_tty, &target.window_id),
            None,
        )
        .map(|_| ())
    }

    pub fn send_carriage_return(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(send_carriage_return_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn send_escape(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(send_escape_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn send_focus_in(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(send_focus_in_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn send_modified_enter(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.exec_owned(send_modified_enter_argv(&target.window_id), None)
            .map(|_| ())
    }

    pub fn send_key(&mut self, target: &TmuxTarget, key: &str) -> Result<(), String> {
        self.exec_owned(send_key_argv(&target.window_id, key), None)
            .map(|_| ())
    }

    pub fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        let value = serde_json::to_string(metadata)
            .map_err(|error| format!("failed to serialize tmux window metadata: {error}"))?;
        self.set_window_option(window_id, "@aimux-meta", &value)
    }

    pub async fn set_window_metadata_async(
        &mut self,
        window_id: &str,
        metadata: &Value,
    ) -> Result<(), String> {
        self.set_window_metadata(window_id, metadata)
    }

    pub fn set_window_option(
        &mut self,
        window_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.exec_owned(set_window_option_argv(window_id, key, value), None)
            .map(|_| ())
    }

    pub async fn set_window_option_async(
        &mut self,
        window_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.set_window_option(window_id, key, value)
    }

    pub fn set_session_option(
        &mut self,
        session_name: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.exec_owned(set_session_option_argv(session_name, key, value), None)
            .map(|_| ())
    }

    pub async fn set_session_option_async(
        &mut self,
        session_name: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.set_session_option(session_name, key, value)
    }

    pub fn configure_managed_session(
        &mut self,
        session_name: &str,
        project_root: &str,
        config: TmuxRuntimeConfig,
    ) -> Result<(), String> {
        let config = sanitize_persistent_runtime_config(config);
        let control_context_args = [
            "--current-client-session #{q:client_session}",
            "--client-tty #{q:client_tty}",
            "--current-window #{q:window_name}",
            "--current-window-id #{q:window_id}",
            "--current-path #{q:pane_current_path}",
            "--pane-id #{q:pane_id}",
        ]
        .join(" ");
        let control_command = |action: &str, args: &str| {
            let suffix = if args.is_empty() {
                String::new()
            } else {
                format!(" {args}")
            };
            format!(
                "{} {action}{suffix} {control_context_args} >/dev/null 2>&1",
                config.control_script_command
            )
        };

        self.set_session_option(session_name, "@aimux-project-root", project_root)?;
        self.set_session_option(
            session_name,
            "@aimux-project-state-dir",
            &config.project_state_dir,
        )?;
        self.set_session_option(
            session_name,
            TMUX_RUNTIME_OWNER_OPTION,
            &config.runtime_owner_id,
        )?;
        self.set_session_option(session_name, "prefix", MANAGED_TMUX_SESSION_OPTIONS.prefix)?;
        self.set_session_option(
            session_name,
            "prefix2",
            MANAGED_TMUX_SESSION_OPTIONS.prefix2,
        )?;
        self.set_session_option(session_name, "mouse", MANAGED_TMUX_SESSION_OPTIONS.mouse)?;
        self.set_session_option(
            session_name,
            "window-size",
            MANAGED_TMUX_SESSION_OPTIONS.window_size,
        )?;
        self.set_session_option(
            session_name,
            "history-limit",
            MANAGED_TMUX_SESSION_OPTIONS.history_limit,
        )?;
        self.set_session_option(session_name, "set-clipboard", "external")?;
        self.set_session_option(session_name, "copy-command", "pbcopy")?;
        self.set_session_option(session_name, "repeat-time", "300")?;
        self.set_session_option(
            session_name,
            "focus-events",
            MANAGED_TMUX_SESSION_OPTIONS.focus_events,
        )?;
        self.exec_owned(
            vec![
                "set-hook".to_owned(),
                "-t".to_owned(),
                session_name.to_owned(),
                "pane-focus-in".to_owned(),
                format!(
                    "run-shell -b {}",
                    shell_quote(&control_command("active", ""))
                ),
            ],
            None,
        )?;
        self.set_session_option(session_name, "bell-action", "none")?;
        self.exec_owned(
            vec![
                "set-window-option".to_owned(),
                "-t".to_owned(),
                session_name.to_owned(),
                "monitor-bell".to_owned(),
                "off".to_owned(),
            ],
            None,
        )?;
        self.exec_owned(
            vec![
                "set-window-option".to_owned(),
                "-t".to_owned(),
                session_name.to_owned(),
                "aggressive-resize".to_owned(),
                MANAGED_TMUX_AGENT_WINDOW_OPTIONS
                    .aggressive_resize
                    .to_owned(),
            ],
            None,
        )?;
        self.set_option_if_supported(set_session_option_argv(
            session_name,
            "extended-keys",
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys,
        ))?;
        self.set_option_if_supported(set_session_option_argv(
            session_name,
            "extended-keys-format",
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys_format,
        ))?;
        for feature in MANAGED_TMUX_TERMINAL_FEATURES {
            self.ensure_terminal_feature(session_name, feature)?;
        }

        for key in [
            "C-j",
            "S-Enter",
            "MouseDown1Pane",
            "MouseDrag1Pane",
            "WheelUpPane",
            "WheelDownPane",
        ] {
            self.unbind_key("root", key)?;
        }
        self.apply_default_root_mouse_bindings(&config)?;
        self.bind_modified_enter(session_name, "C-j", "send-keys C-j")?;
        self.bind_modified_enter(session_name, "S-Enter", "send-keys S-Enter")?;

        for key in ["s", "n", "p", "d", "u", "e", "g", "m", "O", "K"] {
            self.unbind_key("prefix", key)?;
        }
        for digit in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] {
            self.unbind_key("prefix", digit)?;
        }
        self.unbind_key("prefix", "Any")?;
        self.exec_owned(
            vec![
                "bind-key".to_owned(),
                "-T".to_owned(),
                "prefix".to_owned(),
                "C-a".to_owned(),
                "send-prefix".to_owned(),
            ],
            None,
        )?;
        self.exec_owned(
            vec![
                "bind-key".to_owned(),
                "-T".to_owned(),
                "prefix".to_owned(),
                "0".to_owned(),
                "run-shell".to_owned(),
                "-b".to_owned(),
                "true".to_owned(),
            ],
            None,
        )?;
        for digit in ["1", "2", "3", "4", "5", "6", "7", "8", "9"] {
            self.bind_control_command(
                "prefix",
                digit,
                false,
                &control_command("window", &format!("--index {digit}")),
            )?;
        }
        self.bind_control_command("prefix", "n", true, &control_command("next", ""))?;
        self.bind_control_command("prefix", "p", true, &control_command("prev", ""))?;
        self.bind_control_command("prefix", "s", false, &control_command("menu", ""))?;
        self.bind_control_command("prefix", "u", false, &control_command("attention", ""))?;
        let control_plane_args = control_plane_args();
        self.bind_control_command(
            "prefix",
            "g",
            false,
            &control_command("expose", &control_plane_args),
        )?;
        self.bind_control_command(
            "prefix",
            "m",
            false,
            &control_command("meta", &control_plane_args),
        )?;
        self.bind_control_command("prefix", "e", false, &control_command("team", ""))?;
        self.bind_control_command("prefix", "O", false, &control_command("overseer", ""))?;
        self.bind_control_command("prefix", "d", false, &control_command("dashboard", ""))?;
        self.bind_control_command("prefix", "i", false, &control_command("coordination", ""))?;
        for key in ["K", "L"] {
            self.exec_owned(
                vec![
                    "bind-key".to_owned(),
                    "-T".to_owned(),
                    "prefix".to_owned(),
                    key.to_owned(),
                    "clear-history".to_owned(),
                    "\\;".to_owned(),
                    "send-keys".to_owned(),
                    "C-l".to_owned(),
                ],
                None,
            )?;
        }
        self.exec_owned(
            vec![
                "bind-key".to_owned(),
                "-T".to_owned(),
                "prefix".to_owned(),
                "q".to_owned(),
                "if-shell".to_owned(),
                "-F".to_owned(),
                "#{@aimux-project-root}".to_owned(),
                "switch-client -T root".to_owned(),
                "display-panes".to_owned(),
            ],
            None,
        )?;
        self.exec_owned(
            vec![
                "bind-key".to_owned(),
                "-T".to_owned(),
                "prefix".to_owned(),
                "Any".to_owned(),
                "switch-client".to_owned(),
                "-T".to_owned(),
                "root".to_owned(),
            ],
            None,
        )?;

        self.set_session_option(session_name, "status", "2")?;
        self.set_session_option(session_name, "status-interval", "0")?;
        self.set_session_option(session_name, "status-style", "bg=colour236,fg=colour252")?;
        self.set_session_option(
            session_name,
            "message-style",
            "bg=colour24,fg=colour255,bold",
        )?;
        self.set_session_option(
            session_name,
            "message-command-style",
            "bg=colour24,fg=colour255",
        )?;
        self.set_session_option(session_name, "window-status-separator", " ")?;
        self.set_session_option(session_name, "window-status-format", "")?;
        self.set_session_option(session_name, "window-status-current-format", "")?;
        let status_prefix = format!(
            "{} {}",
            config.statusline_command.command,
            config
                .statusline_command
                .args
                .iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let top = format!(
            "{status_prefix} --line top --project-state-dir {} --current-session '#{{session_name}}' --current-window '#{{window_name}}' --current-window-id '#{{window_id}}'",
            shell_quote(&config.project_state_dir)
        );
        let bottom = format!(
            "{status_prefix} --line bottom --project-state-dir {} --current-session '#{{session_name}}' --current-window '#{{window_name}}' --current-window-id '#{{window_id}}'",
            shell_quote(&config.project_state_dir)
        );
        self.set_session_option(session_name, "status-left", "")?;
        self.set_session_option(session_name, "status-right", "")?;
        self.set_session_option(
            session_name,
            "status-format[0]",
            &format!(
                "#[bg=colour236,fg=colour255,bold] #({top})#[default]#{{?pane_in_mode, #[fg=colour214,bold]scroll#[default],}}"
            ),
        )?;
        self.set_session_option(
            session_name,
            "status-format[1]",
            &format!("#[bg=colour236,fg=colour252] #({bottom}) #[default]"),
        )?;
        Ok(())
    }

    pub fn get_window_option(&mut self, window_id: &str, key: &str) -> Option<String> {
        self.exec_tmux(&["show-window-options", "-v", "-t", window_id, key])
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    pub fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        self.set_window_option(window_id, "@aimux-tool", tool_config_key)?;
        self.set_window_option(
            window_id,
            "allow-passthrough",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
        )?;
        self.set_window_option(
            window_id,
            "aggressive-resize",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
        )
    }

    pub async fn apply_managed_agent_window_policy_async(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        self.apply_managed_agent_window_policy(window_id, tool_config_key)
    }

    pub fn list_clients(&mut self) -> Result<Vec<TmuxClientInfo>, String> {
        let raw = self.exec_owned(list_clients_argv(), None)?;
        Ok(raw
            .lines()
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
            .collect())
    }

    pub fn find_client_by_tty(&mut self, client_tty: &str) -> Option<TmuxClientInfo> {
        let normalized = client_tty.trim();
        if normalized.is_empty() {
            return None;
        }
        self.list_clients()
            .ok()?
            .into_iter()
            .find(|client| client.tty == normalized)
    }

    pub fn get_attached_client_for_target(
        &mut self,
        target: &TmuxTarget,
    ) -> Option<TmuxClientInfo> {
        let clients: Vec<TmuxClientInfo> = self
            .list_clients()
            .ok()?
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

    pub fn list_persisted_command_text(&mut self) -> TmuxPersistedCommandText {
        let mut complete = true;
        let mut text = Vec::new();
        for args in [
            vec!["list-panes", "-a", "-F", "#{pane_start_command}"],
            vec!["list-keys"],
            vec!["show-options", "-g"],
        ] {
            match self.exec_tmux(&args) {
                Ok(value) if !value.is_empty() => text.push(value),
                Ok(_) => {}
                Err(_) => complete = false,
            }
        }
        match self.list_session_names() {
            Ok(session_names) => {
                for session_name in session_names {
                    for args in [
                        vec!["show-options", "-t", session_name.as_str()],
                        vec!["show-options", "-w", "-t", session_name.as_str()],
                        vec!["show-hooks", "-t", session_name.as_str()],
                    ] {
                        match self.exec_tmux(&args) {
                            Ok(value) if !value.is_empty() => text.push(value),
                            Ok(_) => {}
                            Err(_) => complete = false,
                        }
                    }
                }
            }
            Err(_) => complete = false,
        }
        TmuxPersistedCommandText { text, complete }
    }

    pub fn current_client_session(&mut self) -> Option<String> {
        self.display_message("#{client_session}", None)
    }

    pub fn display_message(&mut self, format: &str, target: Option<&str>) -> Option<String> {
        self.display_message_raw(format, target)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    pub fn get_pane_start_command(&mut self, window_id: &str) -> Option<String> {
        self.display_message("#{pane_start_command}", Some(window_id))
    }

    pub fn set_return_session(
        &mut self,
        session_name: &str,
        return_session_name: &str,
    ) -> Result<(), String> {
        self.set_session_option(session_name, "@aimux-return-session", return_session_name)
    }

    pub fn get_return_session(&mut self, session_name: &str) -> Option<String> {
        self.get_session_option(session_name, "@aimux-return-session")
    }

    pub fn refresh_status(&mut self) {
        let _ = self.exec_owned(refresh_status_argv(), None);
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

    pub fn list_managed_windows(
        &mut self,
        session_name: &str,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        let raw = self.exec_tmux(&[
            "list-windows",
            "-t",
            session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ])?;
        Ok(parse_tmux_managed_windows(session_name, &raw))
    }

    pub fn list_project_managed_windows(
        &mut self,
        project_root: impl AsRef<Path>,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        let project_root = project_root.as_ref();
        let host_session = self.get_project_session(project_root).session_name;
        let all_session_names = self.list_session_names()?;
        self.repair_legacy_project_session_names(project_root, Some(all_session_names));
        let requested_root = canonicalize_filesystem_path(project_root);
        let session_names: Vec<String> = self
            .list_session_names()?
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
            for entry in self.list_managed_windows(&session_name)? {
                if seen_window_ids.insert(entry.target.window_id.clone()) {
                    managed.push(entry);
                }
            }
        }
        Ok(managed)
    }

    pub fn find_managed_window(
        &mut self,
        session_name: &str,
        session_id: Option<&str>,
        backend_session_id: Option<&str>,
    ) -> Result<Option<TmuxManagedWindow>, String> {
        if session_id.is_none() && backend_session_id.is_none() {
            return Ok(None);
        }
        Ok(self
            .list_managed_windows(session_name)?
            .into_iter()
            .find(|entry| {
                session_id
                    .is_some_and(|id| metadata_string(&entry.metadata, "sessionId") == Some(id))
                    || backend_session_id.is_some_and(|id| {
                        metadata_string(&entry.metadata, "backendSessionId") == Some(id)
                    })
            }))
    }

    pub fn attach_session(
        &mut self,
        session_name: &str,
        window_index: Option<i64>,
    ) -> Result<(), String> {
        let target = window_index.map_or_else(
            || session_name.to_owned(),
            |index| session_window_target(session_name, index),
        );
        if !has_interactive_terminal() {
            return Err(format!(
                "cannot attach to tmux session {target} without a terminal; run \"tmux attach -t {target}\" yourself"
            ));
        }
        self.exec_interactive_owned(attach_session_argv(session_name, window_index), None)
    }

    pub fn detach_client(&mut self) -> Result<(), String> {
        self.exec_interactive_owned(vec!["detach-client".to_owned()], None)
    }

    pub fn switch_to_last_client_session(&mut self) -> Result<(), String> {
        self.exec_interactive_owned(vec!["switch-client".to_owned(), "-l".to_owned()], None)
    }

    pub fn leave_managed_session(
        &mut self,
        inside_tmux: bool,
        session_name: Option<&str>,
    ) -> Result<(), String> {
        let active_session = if inside_tmux {
            self.current_client_session()
                .or_else(|| session_name.map(str::to_owned))
        } else {
            session_name.map(str::to_owned)
        };
        if inside_tmux && let Some(active_session) = active_session.as_deref() {
            let return_session = self.get_return_session(active_session);
            let managed_prefix = format!("{}-", self.session_prefix);
            let is_external_return = return_session.as_deref().is_some_and(|return_session| {
                return_session != active_session && !return_session.starts_with(&managed_prefix)
            });
            if is_external_return
                && self
                    .exec_interactive_owned(
                        vec![
                            "switch-client".to_owned(),
                            "-t".to_owned(),
                            return_session.unwrap_or_default(),
                        ],
                        None,
                    )
                    .is_ok()
            {
                return Ok(());
            }
        }
        self.detach_client()
    }

    pub fn switch_client(
        &mut self,
        session_name: &str,
        window_index: i64,
        client_tty: Option<&str>,
    ) -> Result<(), String> {
        self.exec_interactive_owned(
            switch_client_argv(session_name, window_index, client_tty),
            None,
        )
    }

    pub fn link_window_to_session(
        &mut self,
        client_session_name: &str,
        target: &TmuxTarget,
        window_index: Option<i64>,
    ) -> Result<TmuxTarget, String> {
        self.ensure_linked_window(client_session_name, target, window_index)
    }

    pub fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<TmuxTarget, String> {
        let target_host_session =
            if options.inside_tmux && self.is_client_session_name(&target.session_name) {
                self.get_session_option(&target.session_name, "@aimux-host-session")
            } else {
                None
            };
        let open_session_name = target_host_session
            .as_deref()
            .unwrap_or(&target.session_name)
            .to_owned();
        let open_project_root =
            if options.inside_tmux && !self.is_client_session_name(&open_session_name) {
                self.get_session_option(&open_session_name, "@aimux-project-root")
            } else {
                None
            };
        let target_server_has_client_tty = options
            .client_tty
            .as_deref()
            .is_some_and(|client_tty| self.find_client_by_tty(client_tty).is_some());
        let target_server_missing_client_tty = options
            .client_tty
            .as_deref()
            .is_some_and(|client_tty| !client_tty.is_empty() && !target_server_has_client_tty);
        let resolve_inside_tmux = options.inside_tmux && !target_server_missing_client_tty;
        let should_resolve_managed_client = resolve_inside_tmux
            && !self.is_client_session_name(&open_session_name)
            && (self.is_managed_session_name(&open_session_name) || open_project_root.is_some());
        let session_name = if should_resolve_managed_client {
            self.resolve_open_session_name(
                &open_session_name,
                true,
                options.client_suffix.as_deref(),
                options.client_tty.as_deref(),
            )?
        } else if options.already_resolved {
            open_session_name.clone()
        } else {
            self.resolve_open_session_name(
                &open_session_name,
                resolve_inside_tmux,
                options.client_suffix.as_deref(),
                options.client_tty.as_deref(),
            )?
        };
        let effective_target = if session_name != target.session_name {
            self.ensure_linked_window(
                &session_name,
                target,
                if is_dashboard_window_name(&target.window_name) {
                    Some(0)
                } else {
                    None
                },
            )?
        } else {
            let mut target = target.clone();
            target.session_name = session_name.clone();
            target
        };
        if is_dashboard_window_name(&effective_target.window_name) {
            self.cancel_copy_mode(&effective_target.window_id)?;
        }
        let current_client_session = if options.inside_tmux {
            self.current_client_session()
        } else {
            None
        };
        let can_switch_client = options.inside_tmux
            && !target_server_missing_client_tty
            && (options.client_suffix.is_some()
                || current_client_session.is_some()
                || target_server_has_client_tty);
        if can_switch_client {
            let current = options.return_session_name.or(current_client_session);
            if current
                .as_deref()
                .is_some_and(|current| current != session_name)
            {
                self.set_return_session(&session_name, current.as_deref().unwrap_or_default())?;
            }
            self.switch_client(
                &session_name,
                effective_target.window_index,
                options.client_tty.as_deref(),
            )?;
            Ok(effective_target)
        } else {
            let mut attach_target = target.clone();
            attach_target.session_name = open_session_name;
            self.attach_session(
                &attach_target.session_name,
                Some(attach_target.window_index),
            )?;
            Ok(attach_target)
        }
    }

    fn resolve_open_session_name(
        &mut self,
        session_name: &str,
        inside_tmux: bool,
        suffix_override: Option<&str>,
        client_tty: Option<&str>,
    ) -> Result<String, String> {
        if self.is_client_session_name(session_name) {
            return Ok(session_name.to_owned());
        }
        let managed = self.is_managed_session_name(session_name);
        let project_root = if managed || inside_tmux {
            self.get_session_option(session_name, "@aimux-project-root")
        } else {
            None
        };
        if !managed && project_root.is_none() {
            return Ok(session_name.to_owned());
        }
        let client_suffix = suffix_override
            .map(|value| self.normalize_client_suffix(value))
            .or_else(|| self.resolve_client_suffix(inside_tmux, client_tty));
        let Some(client_suffix) = client_suffix else {
            return Ok(session_name.to_owned());
        };
        let client_session_name =
            self.get_project_client_session_name(session_name, &client_suffix);
        if let Some(project_root) = project_root {
            self.ensure_client_session(session_name, &client_session_name, &project_root)?;
        }
        Ok(client_session_name)
    }

    fn ensure_client_session(
        &mut self,
        host_session_name: &str,
        client_session_name: &str,
        project_root: &str,
    ) -> Result<(), String> {
        let dashboard_name = "dashboard";
        let client_session_exists = self.has_session(client_session_name);
        let runtime_build_stamp = managed_runtime_build_stamp();
        let client_windows = if client_session_exists {
            self.list_windows(client_session_name)?
        } else {
            Vec::new()
        };
        let existing_dashboard = client_windows
            .iter()
            .find(|window| is_dashboard_window_name(&window.name))
            .cloned();
        let current_host_session = if client_session_exists {
            self.get_session_option(client_session_name, "@aimux-host-session")
        } else {
            None
        };
        let current_project_root = if client_session_exists {
            self.get_session_option(client_session_name, "@aimux-project-root")
        } else {
            None
        };
        let current_runtime_build = if client_session_exists {
            self.get_session_option(client_session_name, "@aimux-runtime-build")
        } else {
            None
        };
        let dashboard_at_zero = client_windows
            .iter()
            .find(|window| window.index == 0)
            .cloned();
        let needs_repair = client_session_exists
            && (existing_dashboard.is_none()
                || existing_dashboard
                    .as_ref()
                    .is_some_and(|window| window.index != 0)
                || dashboard_at_zero
                    .as_ref()
                    .zip(existing_dashboard.as_ref())
                    .is_none_or(|(zero, dashboard)| zero.id != dashboard.id)
                || current_host_session.as_deref() != Some(host_session_name)
                || current_project_root.as_deref() != Some(project_root)
                || current_runtime_build.as_deref() != Some(runtime_build_stamp.as_str()));
        if !client_session_exists {
            self.exec_owned(
                new_session_argv(client_session_name, project_root, None),
                Some(TmuxExecOptions {
                    cwd: Some(project_root.to_owned()),
                }),
            )?;
            self.set_current_runtime_contract(client_session_name)?;
            self.configure_managed_session(
                client_session_name,
                project_root,
                default_runtime_config(Path::new(project_root), project_root),
            )?;
            self.set_current_runtime_contract(client_session_name)?;
            self.set_session_option(
                client_session_name,
                "@aimux-host-session",
                host_session_name,
            )?;
            self.set_session_option(
                client_session_name,
                "@aimux-runtime-build",
                &runtime_build_stamp,
            )?;
            return Ok(());
        }
        if needs_repair {
            if let Some(existing) = existing_dashboard
                .as_ref()
                .filter(|window| window.index != 0 && dashboard_at_zero.is_none())
            {
                self.exec_owned(
                    vec![
                        "move-window".to_owned(),
                        "-s".to_owned(),
                        existing.id.clone(),
                        "-t".to_owned(),
                        format!("{client_session_name}:0"),
                    ],
                    None,
                )?;
            } else if existing_dashboard.is_none() {
                let target = if dashboard_at_zero.is_some() {
                    client_session_name.to_owned()
                } else {
                    format!("{client_session_name}:0")
                };
                self.exec_owned(
                    vec![
                        "new-window".to_owned(),
                        "-d".to_owned(),
                        "-t".to_owned(),
                        target,
                        "-c".to_owned(),
                        project_root.to_owned(),
                        "-n".to_owned(),
                        dashboard_name.to_owned(),
                        "sh".to_owned(),
                        "-lc".to_owned(),
                        "tail -f /dev/null".to_owned(),
                    ],
                    Some(TmuxExecOptions {
                        cwd: Some(project_root.to_owned()),
                    }),
                )?;
            }
        }
        self.configure_managed_session(
            client_session_name,
            project_root,
            default_runtime_config(Path::new(project_root), project_root),
        )?;
        self.set_current_runtime_contract(client_session_name)?;
        self.set_session_option(
            client_session_name,
            "@aimux-host-session",
            host_session_name,
        )?;
        self.set_session_option(
            client_session_name,
            "@aimux-runtime-build",
            &runtime_build_stamp,
        )
    }

    fn ensure_linked_window(
        &mut self,
        client_session_name: &str,
        target: &TmuxTarget,
        window_index: Option<i64>,
    ) -> Result<TmuxTarget, String> {
        let existing = self.get_target_by_window_id(client_session_name, &target.window_id);
        if let Some(existing) = existing.as_ref()
            && window_index.is_none_or(|index| existing.window_index == index)
        {
            return Ok(existing.clone());
        }
        let mut occupying_dashboard = None;
        let mut original_renumber_windows = None;
        if let Some(window_index) = window_index {
            let windows = self.list_windows(client_session_name)?;
            let occupying = windows
                .into_iter()
                .find(|window| window.index == window_index);
            if let Some(occupying) = occupying.filter(|window| window.id != target.window_id) {
                if !is_dashboard_window_name(&occupying.name) {
                    return Err(format!(
                        "Cannot replace non-dashboard tmux window {} at {}:{}",
                        occupying.id, client_session_name, window_index
                    ));
                }
                occupying_dashboard = Some(occupying);
                original_renumber_windows = Some(
                    self.get_session_option(client_session_name, "renumber-windows")
                        .unwrap_or_else(|| "off".to_owned()),
                );
            }
        }
        let destination = if occupying_dashboard.is_some() || window_index.is_none() {
            client_session_name.to_owned()
        } else {
            format!(
                "{}:{}",
                client_session_name,
                window_index.unwrap_or_default()
            )
        };
        let result = (|| {
            if original_renumber_windows.is_some() {
                self.set_session_option(client_session_name, "renumber-windows", "off")?;
            }
            let linked_in_this_call = existing.is_none();
            if existing.is_none() {
                self.exec_owned(link_window_argv(&target.window_id, &destination), None)?;
            }
            let linked = self
                .get_target_by_window_id(client_session_name, &target.window_id)
                .ok_or_else(|| {
                    format!(
                        "Failed to link window {} into tmux session {}",
                        target.window_id, client_session_name
                    )
                })?;
            if let Some(window_index) = window_index
                && linked.window_index != window_index
            {
                let move_result = if occupying_dashboard.is_some() {
                    self.exec_owned(
                        swap_window_argv(client_session_name, &linked.window_id, window_index),
                        None,
                    )
                } else {
                    self.exec_owned(
                        move_window_argv(client_session_name, &linked.window_id, window_index),
                        None,
                    )
                };
                if let Err(error) = move_result {
                    if linked_in_this_call {
                        let _ = self.unlink_window(&linked);
                    }
                    return Err(error);
                }
                let replaced = self
                    .get_target_by_window_id(client_session_name, &target.window_id)
                    .ok_or_else(|| {
                        format!(
                            "Failed to replace dashboard slot {client_session_name}:{window_index}"
                        )
                    })?;
                if replaced.window_index != window_index {
                    if linked_in_this_call
                        && let Some(linked_after_failure) =
                            self.get_target_by_window_id(client_session_name, &target.window_id)
                    {
                        let _ = self.unlink_window(&linked_after_failure);
                    }
                    return Err(format!(
                        "Failed to replace dashboard slot {client_session_name}:{window_index}"
                    ));
                }
                if let Some(stale) = occupying_dashboard.as_ref().and_then(|dashboard| {
                    self.get_target_by_window_id(client_session_name, &dashboard.id)
                }) {
                    let _ = self.unlink_window(&stale);
                }
                return Ok(replaced);
            }
            Ok(linked)
        })();
        if let Some(original) = original_renumber_windows {
            let _ = self.set_session_option(client_session_name, "renumber-windows", &original);
        }
        result
    }

    fn normalize_client_suffix(&self, value: &str) -> String {
        if is_lower_hex_8(value) {
            return value.to_owned();
        }
        let mut hasher = Sha1::new();
        hasher.update(value.as_bytes());
        format!("{:x}", hasher.finalize())[..8].to_owned()
    }

    fn resolve_client_suffix(
        &mut self,
        inside_tmux: bool,
        client_tty_override: Option<&str>,
    ) -> Option<String> {
        if let Ok(value) = std::env::var("AIMUX_CLIENT_KEY") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(self.normalize_client_suffix(value));
            }
        }
        if inside_tmux {
            if let Some(client_tty) = client_tty_override.filter(|value| !value.is_empty()) {
                return Some(self.normalize_client_suffix(client_tty));
            }
            if let Some(current_session) = self.current_client_session()
                && let Some((_, suffix)) = current_session.rsplit_once("-client-")
                && is_lower_hex_8(suffix)
            {
                return Some(suffix.to_owned());
            }
            let client_tty = self.display_message("#{client_tty}", None);
            let client_pid = self.display_message("#{client_pid}", None);
            if client_tty.is_some() || client_pid.is_some() {
                return Some(self.normalize_client_suffix(&format!(
                    "{}:{}",
                    client_tty.as_deref().unwrap_or("tty"),
                    client_pid.as_deref().unwrap_or("pid")
                )));
            }
            return None;
        }
        command_output("tty", &[])
            .ok()
            .map(|tty| self.normalize_client_suffix(tty.trim()))
            .filter(|suffix| !suffix.is_empty())
    }

    fn display_message_raw(
        &mut self,
        format: &str,
        target: Option<&str>,
    ) -> Result<String, String> {
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
        let verb = args.first().map(String::as_str).unwrap_or("");
        if is_read_only_tmux_verb(verb) {
            let key = tmux_query_key(
                &args,
                options.as_ref().and_then(|options| options.cwd.as_deref()),
            );
            return memoized_tmux_query(key, || (self.exec)(&args, options.as_ref()));
        }
        if is_non_caching_tmux_read(&args) {
            return (self.exec)(&args, options.as_ref());
        }
        reset_tmux_query_memo();
        (self.exec)(&args, options.as_ref())
    }

    fn exec_interactive_owned(
        &mut self,
        args: Vec<String>,
        options: Option<TmuxExecOptions>,
    ) -> Result<(), String> {
        reset_tmux_query_memo();
        (self.interactive_exec)(&args, options.as_ref())
    }

    fn set_current_runtime_contract(&mut self, session_name: &str) -> Result<(), String> {
        self.set_session_option(
            session_name,
            TMUX_RUNTIME_CONTRACT_OPTION,
            AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
        )
    }

    fn set_option_if_supported(&mut self, args: Vec<String>) -> Result<(), String> {
        match self.exec_owned(args, None) {
            Ok(_) => Ok(()),
            Err(error) if is_unsupported_tmux_option_error(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn ensure_terminal_feature(&mut self, session_name: &str, feature: &str) -> Result<(), String> {
        let current = self.get_session_option(session_name, "terminal-features");
        let features = current
            .as_deref()
            .map(|current| {
                current
                    .lines()
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if features.contains(&feature) {
            return Ok(());
        }
        self.exec_owned(
            append_session_option_argv(session_name, "terminal-features", &format!(",{feature}")),
            None,
        )
        .map(|_| ())
    }

    fn unbind_key(&mut self, table: &str, key: &str) -> Result<(), String> {
        self.exec_owned(
            vec![
                "unbind-key".to_owned(),
                "-T".to_owned(),
                table.to_owned(),
                key.to_owned(),
            ],
            None,
        )
        .map(|_| ())
    }

    fn bind_modified_enter(
        &mut self,
        session_name: &str,
        key: &str,
        fallback: &str,
    ) -> Result<(), String> {
        let _ = session_name;
        self.exec_owned(
            vec![
                "bind-key".to_owned(),
                "-T".to_owned(),
                "root".to_owned(),
                key.to_owned(),
                "if-shell".to_owned(),
                "-F".to_owned(),
                "#{m/r:^(claude|codex)$,#{@aimux-tool}}".to_owned(),
                "send-keys -H 1b 5b 31 33 3b 32 75".to_owned(),
                fallback.to_owned(),
            ],
            None,
        )
        .map(|_| ())
    }

    fn bind_control_command(
        &mut self,
        table: &str,
        key: &str,
        repeat: bool,
        command: &str,
    ) -> Result<(), String> {
        let mut argv = vec!["bind-key".to_owned()];
        if repeat {
            argv.push("-r".to_owned());
        }
        argv.extend([
            "-T".to_owned(),
            table.to_owned(),
            key.to_owned(),
            "run-shell".to_owned(),
            "-b".to_owned(),
            command.to_owned(),
        ]);
        self.exec_owned(argv, None).map(|_| ())
    }

    fn apply_default_root_mouse_bindings(
        &mut self,
        config: &TmuxRuntimeConfig,
    ) -> Result<(), String> {
        let dir = std::env::temp_dir().join(format!(
            "aimux-tmux-{}-{}-{}",
            std::process::id(),
            now_millis(),
            TMUX_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).map_err(|error| format!("create tmux config dir: {error}"))?;
        let file = dir.join("mouse-bindings.conf");
        let bindings = if config
            .control_script_command
            .contains("__tmux-control-internal")
        {
            build_default_root_mouse_bindings_install_config_for_command(
                &config.project_state_dir,
                &default_open_hyperlink_command(),
            )
        } else {
            build_default_root_mouse_bindings_install_config(
                &config.project_state_dir,
                &repo_script_path("tmux-open-hyperlink.sh"),
            )
        };
        let write_result = fs::write(&file, bindings)
            .map_err(|error| format!("write tmux mouse bindings: {error}"));
        let exec_result = write_result.and_then(|_| {
            self.exec_owned(
                vec![
                    "source-file".to_owned(),
                    file.to_string_lossy().into_owned(),
                ],
                None,
            )
            .map(|_| ())
        });
        let _ = fs::remove_dir_all(&dir);
        exec_result
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

pub fn build_default_root_mouse_bindings_install_config(
    project_state_dir: &str,
    open_hyperlink_script: &str,
) -> String {
    let open_hyperlink_script = shell_quote(open_hyperlink_script);
    let open_pane_link_command = format!(
        "AIMUX_HYPERLINK=#{{q:mouse_hyperlink}} AIMUX_MOUSE_WORD=#{{q:mouse_word}} AIMUX_MOUSE_LINE=#{{q:mouse_line}} sh {open_hyperlink_script} >/dev/null 2>&1"
    );
    let open_status_pr_command = format!(
        "AIMUX_STATUS_LINE=#{{q:mouse_status_line}} AIMUX_PROJECT_STATE_DIR={} AIMUX_CURRENT_WINDOW_ID=#{{q:window_id}} sh {open_hyperlink_script} >/dev/null 2>&1",
        shell_quote(project_state_dir)
    );
    build_default_root_mouse_bindings_config(&open_pane_link_command, &open_status_pr_command)
}

pub fn build_default_root_mouse_bindings_install_config_for_command(
    project_state_dir: &str,
    open_hyperlink_command: &str,
) -> String {
    let open_pane_link_command = format!(
        "AIMUX_HYPERLINK=#{{q:mouse_hyperlink}} AIMUX_MOUSE_WORD=#{{q:mouse_word}} AIMUX_MOUSE_LINE=#{{q:mouse_line}} {open_hyperlink_command} >/dev/null 2>&1"
    );
    let open_status_pr_command = format!(
        "AIMUX_STATUS_LINE=#{{q:mouse_status_line}} AIMUX_PROJECT_STATE_DIR={} AIMUX_CURRENT_WINDOW_ID=#{{q:window_id}} {open_hyperlink_command} >/dev/null 2>&1",
        shell_quote(project_state_dir)
    );
    build_default_root_mouse_bindings_config(&open_pane_link_command, &open_status_pr_command)
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

pub(crate) fn pane_pipe_ownership_script() -> &'static str {
    "token_file=$2; printf \"%s\\t%s\\n\" \"$$\" \"$1\" > \"$token_file\"; trap \"rm -f \\\"$token_file\\\"\" EXIT; cat >> \"$3\""
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

pub fn list_all_window_ids_argv() -> Vec<String> {
    vec![
        "list-windows".to_owned(),
        "-a".to_owned(),
        "-F".to_owned(),
        "#{window_id}".to_owned(),
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
                pane_dead: parts.next().map(|value| value == "1"),
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

fn parse_window_target(session_name: &str, raw: &str) -> Result<TmuxTarget, String> {
    let line = raw.lines().next().unwrap_or_default();
    let mut parts = line.split('\t');
    let window_id = parts.next().unwrap_or_default();
    let window_index = parts.next().unwrap_or_default();
    let window_name = parts.next().unwrap_or_default();
    if window_id.is_empty() || window_index.is_empty() || window_name.is_empty() {
        return Err(format!("invalid tmux target output: {raw:?}"));
    }
    Ok(TmuxTarget {
        session_name: session_name.to_owned(),
        window_id: window_id.to_owned(),
        window_index: window_index.parse().unwrap_or(0),
        window_name: window_name.to_owned(),
        pane_dead: None,
    })
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

fn default_runtime_config(project_root: &Path, project_root_text: &str) -> TmuxRuntimeConfig {
    let mut resolver = PathResolver::from_env();
    let project_state_dir = resolver
        .project_state_dir_for(project_root)
        .to_string_lossy()
        .into_owned();
    let executable = persistent_aimux_executable();
    TmuxRuntimeConfig {
        project_state_dir,
        control_script_command: persistent_aimux_control_script_command_from(&executable),
        statusline_command: TmuxCommandSpec {
            cwd: project_root_text.to_owned(),
            command: executable,
            args: vec!["__tmux-statusline-internal".to_owned()],
        },
        runtime_owner_id: runtime_owner_id(&mut resolver),
    }
}

fn repo_script_path(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("scripts")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn default_open_hyperlink_command() -> String {
    format!(
        "{} __tmux-open-hyperlink-internal",
        shell_quote(&persistent_aimux_executable())
    )
}

fn sanitize_persistent_runtime_config(mut config: TmuxRuntimeConfig) -> TmuxRuntimeConfig {
    if contains_cargo_test_aimux_binary_text(&config.control_script_command) {
        config.control_script_command = persistent_aimux_control_script_command();
    }
    if is_cargo_test_aimux_binary(&config.statusline_command.command) {
        config.statusline_command.command = persistent_aimux_executable();
    }
    config
}

fn contains_cargo_test_aimux_binary_text(value: &str) -> bool {
    value
        .split(|ch: char| ch.is_whitespace() || ch == '\'' || ch == '"')
        .any(is_cargo_test_aimux_binary)
}

fn persistent_aimux_control_script_command() -> String {
    persistent_aimux_control_script_command_from(&persistent_aimux_executable())
}

fn persistent_aimux_control_script_command_from(executable: &str) -> String {
    format!("{} __tmux-control-internal", shell_quote(executable))
}

fn runtime_owner_id(resolver: &mut PathResolver) -> String {
    json_compact(&serde_json::json!({
        "home": resolver.global_aimux_dir().to_string_lossy(),
        "port": std::env::var("AIMUX_DAEMON_PORT")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "43190".to_owned()),
    }))
}

fn managed_runtime_build_stamp() -> String {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        paths.push(exe);
    }
    paths
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            format!("{name}:{}", file_mtime_millis(&path).unwrap_or(0))
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn file_mtime_millis(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn json_compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn control_plane_args() -> String {
    [
        env_control_arg("AIMUX_HOME", "--aimux-home"),
        env_control_arg("AIMUX_DAEMON_HOST", "--daemon-host"),
        env_control_arg("AIMUX_DAEMON_PORT", "--daemon-port"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
}

fn env_control_arg(env_name: &str, flag: &str) -> Option<String> {
    std::env::var(env_name)
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| format!("{flag} {}", shell_quote(&value)))
}

fn is_no_such_session_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("no such session") || normalized.contains("can't find session")
}

fn tmux_list_sessions_failed_because_no_server(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("no server running")
        || (error.contains("error connecting to")
            && (error.contains("no such file or directory")
                || error.contains("connection refused")))
}

fn is_unsupported_tmux_option_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("invalid option") || normalized.contains("unknown option")
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn now_millis_base36() -> String {
    let mut value = now_millis();
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

fn has_interactive_terminal() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = if program == "tmux" {
        tmux_command_from_env()
    } else {
        Command::new(program)
    };
    let output = command
        .args(args)
        .output()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if stderr.is_empty() {
        format!("{program} exited with {}", output.status)
    } else {
        stderr
    })
}

fn default_interactive_exec(
    args: &[String],
    options: Option<&TmuxExecOptions>,
) -> Result<(), String> {
    let mut command = tmux_command_from_env();
    command.args(args);
    if args.first().map(String::as_str) == Some("attach-session") {
        command.env_remove("TMUX");
        command.env_remove("TMUX_PANE");
    }
    if let Some(cwd) = options.and_then(|options| options.cwd.as_deref()) {
        command.current_dir(cwd);
    }
    let status = command
        .status()
        .map_err(|error| format!("failed to run tmux: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("tmux {} failed", args.join(" ")))
    }
}

pub fn tmux_command_from_env() -> Command {
    let mut command = Command::new("tmux");
    if let Some(socket_path) =
        std::env::var_os(AIMUX_TMUX_SOCKET_PATH_ENV).filter(|value| !value.is_empty())
    {
        command.arg("-S").arg(socket_path);
    }
    command
}

fn persistent_aimux_executable() -> String {
    let current_exe = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    persistent_aimux_executable_from(
        current_exe.clone(),
        std::env::args().next(),
        current_exe,
        std::env::vars().collect(),
        None,
    )
}

fn persistent_aimux_executable_from(
    current_entry_path: Option<String>,
    current_argv_entry: Option<String>,
    process_exec_path: Option<String>,
    env: std::collections::BTreeMap<String, String>,
    home_dir: Option<std::path::PathBuf>,
) -> String {
    let launch = get_aimux_current_cli_identity(AimuxCliLaunchOptions {
        env,
        current_argv_entry,
        current_entry_path,
        process_exec_path,
        home_dir,
    });
    if is_cargo_test_aimux_binary(&launch.command) {
        "aimux".to_owned()
    } else {
        launch.command
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn configure_managed_session_never_writes_cargo_test_harness_binary() {
        let bad_executable =
            "/tmp/aimux/native/target/debug/deps/aimux-cd3121d0832153b2".to_owned();
        let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
        let captured = Rc::clone(&calls);
        let mut runtime = TmuxRuntimeManager::with_exec(move |args, _options| {
            captured.borrow_mut().push(args.to_owned());
            Ok(String::new())
        });

        runtime
            .configure_managed_session(
                "aimux-test",
                "/tmp/aimux",
                TmuxRuntimeConfig {
                    project_state_dir: "/tmp/aimux/.aimux".to_owned(),
                    control_script_command: format!(
                        "{} __tmux-control-internal",
                        shell_quote(&bad_executable)
                    ),
                    statusline_command: TmuxCommandSpec {
                        cwd: "/tmp/aimux".to_owned(),
                        command: bad_executable.clone(),
                        args: vec!["__tmux-statusline-internal".to_owned()],
                    },
                    runtime_owner_id: "test-owner".to_owned(),
                },
            )
            .expect("configure managed session");

        let persisted_commands = calls
            .borrow()
            .iter()
            .map(|args| args.join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !persisted_commands.contains("target/debug/deps"),
            "{persisted_commands}"
        );
        assert!(
            !persisted_commands.contains("aimux-cd3121d0832153b2"),
            "{persisted_commands}"
        );
        assert!(
            persisted_commands.contains("__tmux-control-internal"),
            "{persisted_commands}"
        );
    }
}
