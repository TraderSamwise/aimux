//! The `copy-command` behind every aimux-managed tmux session.
//!
//! tmux hands the selection on stdin. We put it on the clipboard of the
//! terminal the user is actually sitting at, and — on a Mac — on the host
//! clipboard too, since that is free and someone working locally expects it.

use std::io::Read;
use std::process::{Command, Stdio};

use crate::tmux::tmux_program_from_env;
use crate::tmux_clipboard::{clipboard_payload, write_clipboard_to_client_ttys};

pub fn run_tmux_clipboard_copy() -> Result<(), String> {
    let mut selection = Vec::new();
    std::io::stdin()
        .read_to_end(&mut selection)
        .map_err(|error| format!("reading the selection failed: {error}"))?;
    if selection.is_empty() {
        return Ok(());
    }
    let payload = clipboard_payload(&selection);
    // Best effort and never fatal: a Mac with no pbcopy, or a Linux box with no
    // clipboard at all, must not stop the sequence reaching the real terminal.
    copy_to_host_clipboard(payload);
    let ttys = attached_client_ttys()?;
    write_clipboard_to_client_ttys(&ttys, payload).map(|_| ())
}

fn attached_client_ttys() -> Result<Vec<String>, String> {
    let tmux = tmux_program_from_env()?;
    let output = Command::new(tmux)
        .args(["list-clients", "-F", "#{client_tty}"])
        .output()
        .map_err(|error| format!("tmux list-clients failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "tmux list-clients failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn copy_to_host_clipboard(payload: &[u8]) {
    let Some(command) = host_clipboard_command() else {
        return;
    };
    let Ok(mut child) = Command::new(command.0)
        .args(command.1)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(payload);
    }
    let _ = child.wait();
}

/// Only a clipboard that actually exists on this host. A headless Linux box has
/// none, and spawning one that fails on every copy is pure subprocess churn.
fn host_clipboard_command() -> Option<(&'static str, &'static [&'static str])> {
    if cfg!(target_os = "macos") {
        return Some(("pbcopy", &[]));
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Some(("wl-copy", &[]));
    }
    if std::env::var_os("DISPLAY").is_some() {
        return Some(("xclip", &["-selection", "clipboard"]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_headless_linux_host_spawns_no_clipboard_process() {
        if cfg!(target_os = "macos") {
            assert_eq!(
                host_clipboard_command().map(|command| command.0),
                Some("pbcopy")
            );
            return;
        }
        // SAFETY: single-threaded test process, and both vars are restored by
        // the assertions below being the only readers.
        unsafe {
            std::env::remove_var("WAYLAND_DISPLAY");
            std::env::remove_var("DISPLAY");
        }
        assert_eq!(
            host_clipboard_command(),
            None,
            "a box with no display server has no clipboard to copy into"
        );
    }
}
