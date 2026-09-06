use aimux::tmux::{
    TmuxClientInfo, TmuxRuntimeManager, TmuxTarget, TmuxWindowInfo, project_session,
};
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;

#[test]
fn treats_missing_tmux_server_state_as_empty_lists() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        match args.join(" ").as_str() {
            "-V" => Ok("tmux 3.5a".to_owned()),
            "list-sessions -F #{session_name}" => {
                Err("error connecting to /private/tmp/tmux-501/default".to_owned())
            }
            command if command.starts_with("list-windows -t aimux-mobile-abc ") => {
                Err("error connecting to /private/tmp/tmux-501/default".to_owned())
            }
            _ => Ok(String::new()),
        }
    });

    assert!(manager.is_available());
    assert_eq!(manager.list_session_names(), Vec::<String>::new());
    assert_eq!(
        manager.list_windows("aimux-mobile-abc"),
        Vec::<TmuxWindowInfo>::new()
    );
    assert_eq!(calls.borrow()[0], vec!["-V"]);
}

#[test]
fn lists_windows_and_resolves_window_targets() {
    let mut manager = TmuxRuntimeManager::with_exec(|args, _options| {
        if args.first().map(String::as_str) == Some("list-windows") {
            return Ok("@3\t3\tcodex\t1\t100\t0\n@4\t4\tdashboard\t0\t\t1".to_owned());
        }
        Ok(String::new())
    });

    assert_eq!(
        manager.list_windows("aimux-mobile-abc"),
        vec![
            TmuxWindowInfo {
                id: "@3".to_owned(),
                index: 3,
                name: "codex".to_owned(),
                active: true,
                activity: Some(100),
                pane_dead: Some(false),
            },
            TmuxWindowInfo {
                id: "@4".to_owned(),
                index: 4,
                name: "dashboard".to_owned(),
                active: false,
                activity: None,
                pane_dead: Some(true),
            },
        ]
    );
    assert_eq!(
        manager.get_target_by_window_id("aimux-mobile-abc", "@3"),
        Some(TmuxTarget {
            session_name: "aimux-mobile-abc".to_owned(),
            window_id: "@3".to_owned(),
            window_index: 3,
            window_name: "codex".to_owned(),
            pane_dead: Some(false),
        })
    );
    assert!(
        manager
            .get_target_by_window_id("aimux-mobile-abc", "@9")
            .is_none()
    );
}

#[test]
fn ignores_malformed_client_sessions_when_finding_attached_client() {
    let mut manager = TmuxRuntimeManager::with_exec(|args, _options| {
        if args.join(" ")
            == "list-clients -F #{client_tty}\t#{session_name}\t#{window_id}\t#{client_name}"
        {
            return Ok([
                "/dev/ttys100\taimux-mobile-abc-client-live\t@3\tbad",
                "/dev/ttys101\taimux-mobile-abc-client-deadbeef\t@9\tgood",
            ]
            .join("\n"));
        }
        Ok(String::new())
    });

    assert_eq!(
        manager.get_attached_client_for_target(&TmuxTarget {
            session_name: "aimux-mobile-abc".to_owned(),
            window_id: "@3".to_owned(),
            window_index: 3,
            window_name: "codex".to_owned(),
            pane_dead: None,
        }),
        Some(TmuxClientInfo {
            tty: "/dev/ttys101".to_owned(),
            session_name: "aimux-mobile-abc-client-deadbeef".to_owned(),
            window_id: "@9".to_owned(),
            name: "good".to_owned(),
        })
    );
}

#[test]
fn repairs_legacy_project_and_client_session_names() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        Ok(String::new())
    });

    let session = manager.repair_legacy_project_session_names(
        "/repo/mobile",
        Some(vec![
            "aimux-mobile-7a62ea91ca".to_owned(),
            "aimux-mobile-7a62ea91ca-client-12345678".to_owned(),
        ]),
    );

    assert_eq!(session, project_session("/repo/mobile", "aimux"));
    assert!(calls.borrow().contains(&vec![
        "rename-session".to_owned(),
        "-t".to_owned(),
        "aimux-mobile-7a62ea91ca".to_owned(),
        "aimux-mobile-078d0ecd20ec".to_owned(),
    ]));
    assert!(calls.borrow().contains(&vec![
        "rename-session".to_owned(),
        "-t".to_owned(),
        "aimux-mobile-7a62ea91ca-client-12345678".to_owned(),
        "aimux-mobile-078d0ecd20ec-client-12345678".to_owned(),
    ]));
}

#[test]
fn lists_project_managed_windows_after_legacy_repair() {
    let repaired = Rc::new(RefCell::new(false));
    let repaired_for_exec = repaired.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        let joined = args.join(" ");
        if joined == "list-sessions -F #{session_name}" {
            return if *repaired_for_exec.borrow() {
                Ok(
                    "aimux-mobile-078d0ecd20ec\naimux-mobile-078d0ecd20ec-client-12345678"
                        .to_owned(),
                )
            } else {
                Ok("aimux-mobile-7a62ea91ca\naimux-mobile-7a62ea91ca-client-12345678".to_owned())
            };
        }
        if joined.starts_with("rename-session -t aimux-mobile-7a62ea91ca") {
            *repaired_for_exec.borrow_mut() = true;
            return Ok(String::new());
        }
        if joined.starts_with("list-windows -t aimux-mobile-078d0ecd20ec -F ") {
            return Ok(format!(
                "@3\t3\tcodex\t1\t100\t0\t{}",
                json!({
                    "kind": "agent",
                    "sessionId": "codex-legacy",
                    "command": "codex",
                    "args": [],
                    "toolConfigKey": "codex",
                    "worktreePath": "/repo/mobile"
                })
            ));
        }
        if joined.starts_with("list-windows -t aimux-mobile-078d0ecd20ec-client-12345678 -F ") {
            return Ok(String::new());
        }
        Ok(String::new())
    });

    let windows = manager.list_project_managed_windows("/repo/mobile");

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].target.window_id, "@3");
    assert_eq!(windows[0].target.window_index, 3);
    assert_eq!(windows[0].target.pane_dead, Some(false));
    assert_eq!(windows[0].metadata["sessionId"], "codex-legacy");
    assert_eq!(windows[0].metadata["toolConfigKey"], "codex");
}

#[test]
fn filters_managed_sessions_by_stored_project_root() {
    let mut manager = TmuxRuntimeManager::with_exec(|args, _options| {
        let joined = args.join(" ");
        if joined == "list-sessions -F #{session_name}" {
            return Ok("aimux-mobile-078d0ecd20ec\naimux-other-session\nuser-shell".to_owned());
        }
        if joined == "show-options -v -t aimux-other-session @aimux-project-root" {
            return Ok("/repo/mobile".to_owned());
        }
        if joined.starts_with("list-windows -t aimux-mobile-078d0ecd20ec -F ") {
            return Ok(format!(
                "@3\t3\tcodex\t1\t100\t0\t{}",
                json!({ "sessionId": "codex-host", "command": "codex", "args": [], "toolConfigKey": "codex" })
            ));
        }
        if joined.starts_with("list-windows -t aimux-other-session -F ") {
            return Ok(format!(
                "@4\t4\tclaude\t0\t99\t0\t{}",
                json!({ "sessionId": "claude-other", "command": "claude", "args": [], "toolConfigKey": "claude" })
            ));
        }
        Ok(String::new())
    });

    let windows = manager.list_project_managed_windows("/repo/mobile");

    assert_eq!(
        windows
            .iter()
            .map(|entry| entry.metadata["sessionId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["codex-host", "claude-other"]
    );
}
