use crate::tmux::{OpenTargetOptions, TmuxRuntimeManager, TmuxTarget};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmuxSessionStatus {
    Running,
    Exited,
}

pub trait TmuxSessionTransportRuntime {
    fn send_text(&mut self, target: &TmuxTarget, text: &str) -> Result<(), String>;
    fn send_enter(&mut self, target: &TmuxTarget) -> Result<(), String>;
    fn send_key(&mut self, target: &TmuxTarget, key: &str) -> Result<(), String>;
    fn resize_target(&mut self, target: &TmuxTarget, cols: i64, rows: i64) -> Result<(), String>;
    fn kill_window(&mut self, target: &TmuxTarget) -> Result<(), String>;
    fn kill_window_async(&mut self, target: &TmuxTarget) -> Result<(), String>;
    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String>;
    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String>;
    fn is_inside_tmux(&self) -> bool;
    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget>;
}

impl TmuxSessionTransportRuntime for TmuxRuntimeManager {
    fn send_text(&mut self, target: &TmuxTarget, text: &str) -> Result<(), String> {
        self.send_text(target, text)
    }

    fn send_enter(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.send_enter(target)
    }

    fn send_key(&mut self, target: &TmuxTarget, key: &str) -> Result<(), String> {
        self.send_key(target, key)
    }

    fn resize_target(&mut self, target: &TmuxTarget, cols: i64, rows: i64) -> Result<(), String> {
        self.resize_target(target, cols, rows)
    }

    fn kill_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.kill_window(target)
    }

    fn kill_window_async(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.kill_window(target)
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.rename_window(window_id, name)
    }

    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String> {
        self.open_target(target, options).map(|_| ())
    }

    fn is_inside_tmux(&self) -> bool {
        self.is_inside_tmux()
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        self.get_target_by_window_id(session_name, window_id)
    }
}

pub struct TmuxSessionTransport<R: TmuxSessionTransportRuntime> {
    pub id: String,
    pub command: String,
    backend_session_id: Option<String>,
    exited: bool,
    exit_code: Option<i32>,
    exit_listeners: Vec<Box<dyn FnMut(i32)>>,
    target: TmuxTarget,
    manager: R,
    cols: i64,
    rows: i64,
}

impl<R: TmuxSessionTransportRuntime> TmuxSessionTransport<R> {
    pub fn new(
        id: impl Into<String>,
        command: impl Into<String>,
        target: TmuxTarget,
        manager: R,
        cols: i64,
        rows: i64,
    ) -> Self {
        Self {
            id: id.into(),
            command: command.into(),
            backend_session_id: None,
            exited: false,
            exit_code: None,
            exit_listeners: Vec::new(),
            target,
            manager,
            cols,
            rows,
        }
    }

    pub fn exited(&self) -> bool {
        self.exited
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub fn status(&self) -> TmuxSessionStatus {
        if self.exited {
            TmuxSessionStatus::Exited
        } else {
            TmuxSessionStatus::Running
        }
    }

    pub fn tmux_target(&self) -> &TmuxTarget {
        &self.target
    }

    pub fn backend_session_id(&self) -> Option<&str> {
        self.backend_session_id.as_deref()
    }

    pub fn set_backend_session_id(&mut self, backend_session_id: Option<String>) {
        self.backend_session_id = backend_session_id;
    }

    pub fn dimensions(&self) -> (i64, i64) {
        (self.cols, self.rows)
    }

    pub fn manager(&self) -> &R {
        &self.manager
    }

    pub fn manager_mut(&mut self) -> &mut R {
        &mut self.manager
    }

    pub fn retarget(&mut self, target: TmuxTarget) {
        self.target = target;
    }

    pub fn write(&mut self, data: &str) -> Result<(), String> {
        if self.exited || data.is_empty() {
            return Ok(());
        }
        let mut text_buffer = String::new();
        for ch in data.chars() {
            match ch {
                '\r' => {
                    self.flush_text(&mut text_buffer)?;
                    self.manager.send_enter(&self.target)?;
                }
                '\n' => {
                    self.flush_text(&mut text_buffer)?;
                    self.manager.send_key(&self.target, "C-j")?;
                }
                _ => text_buffer.push(ch),
            }
        }
        self.flush_text(&mut text_buffer)
    }

    pub fn resize(&mut self, cols: i64, rows: i64) -> Result<(), String> {
        self.manager.resize_target(&self.target, cols, rows)?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn on_exit(&mut self, cb: impl FnMut(i32) + 'static) {
        self.exit_listeners.push(Box::new(cb));
    }

    pub fn kill(&mut self) {
        if self.exited {
            return;
        }
        let _ = self.manager.kill_window(&self.target);
        self.mark_exited(0);
    }

    pub fn kill_async(&mut self) {
        if self.exited {
            return;
        }
        let _ = self.manager.kill_window_async(&self.target);
        self.mark_exited(0);
    }

    pub fn destroy(&mut self) {}

    pub fn rename_window(&mut self, name: &str) -> Result<(), String> {
        self.manager.rename_window(&self.target.window_id, name)?;
        self.target.window_name = name.to_owned();
        Ok(())
    }

    pub fn open(&mut self) -> Result<(), String> {
        self.manager.open_target(
            &self.target,
            OpenTargetOptions {
                inside_tmux: self.manager.is_inside_tmux(),
                ..OpenTargetOptions::default()
            },
        )
    }

    pub fn poll_liveness(&mut self) {
        if self.exited {
            return;
        }
        let Some(resolved) = self
            .manager
            .get_target_by_window_id(&self.target.session_name, &self.target.window_id)
        else {
            self.mark_exited(0);
            return;
        };
        self.target = resolved;
        if self.target.pane_dead == Some(true) {
            self.mark_exited(0);
        }
    }

    fn flush_text(&mut self, text_buffer: &mut String) -> Result<(), String> {
        if text_buffer.is_empty() {
            return Ok(());
        }
        self.manager.send_text(&self.target, text_buffer)?;
        text_buffer.clear();
        Ok(())
    }

    fn mark_exited(&mut self, code: i32) {
        if self.exited {
            return;
        }
        self.exited = true;
        self.exit_code = Some(code);
        for listener in &mut self.exit_listeners {
            listener(code);
        }
    }
}
