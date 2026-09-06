use aimux::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, CapturePaneOptions, TMUX_RUNTIME_CONTRACT_OPTION,
    TmuxClientInfo, TmuxCommandSpec, TmuxRuntimeConfig, TmuxRuntimeManager, TmuxTarget,
    TmuxWindowInfo, project_session,
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

#[test]
fn creates_window_with_cwd_and_parses_created_target() {
    let calls = Rc::new(RefCell::new(Vec::<(Vec<String>, Option<String>)>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push((
            args.to_vec(),
            options.and_then(|options| options.cwd.clone()),
        ));
        Ok("@9\t9\tcodex".to_owned())
    });

    let target = manager
        .create_window(
            "aimux-mobile-abc",
            "codex",
            "/repo/mobile",
            "codex",
            &["--dangerously-bypass-approvals".to_owned()],
            true,
        )
        .expect("created target");

    assert_eq!(
        target,
        TmuxTarget {
            session_name: "aimux-mobile-abc".to_owned(),
            window_id: "@9".to_owned(),
            window_index: 9,
            window_name: "codex".to_owned(),
            pane_dead: None,
        }
    );
    assert_eq!(calls.borrow()[0].1, Some("/repo/mobile".to_owned()));
    assert_eq!(
        calls.borrow()[0].0,
        vec![
            "new-window",
            "-d",
            "-P",
            "-t",
            "aimux-mobile-abc",
            "-c",
            "/repo/mobile",
            "-n",
            "codex",
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}",
            "codex",
            "--dangerously-bypass-approvals",
        ]
    );
}

#[test]
fn wraps_target_mutations_with_existing_argv_builders() {
    let calls = Rc::new(RefCell::new(Vec::<(Vec<String>, Option<String>)>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push((
            args.to_vec(),
            options.and_then(|options| options.cwd.clone()),
        ));
        Ok("captured output".to_owned())
    });
    let target = target();

    assert_eq!(
        manager
            .capture_target(
                &target,
                CapturePaneOptions {
                    start_line: Some(-50),
                    end_line: Some(-1),
                    include_escapes: true,
                },
            )
            .expect("capture"),
        "captured output"
    );
    manager.resize_target(&target, 120, 40).expect("resize");
    manager.send_enter(&target).expect("enter");
    manager
        .send_client_enter("/dev/ttys001")
        .expect("client enter");
    manager
        .send_client_carriage_return("/dev/ttys001", &target)
        .expect("client carriage return");
    manager
        .send_carriage_return(&target)
        .expect("carriage return");
    manager.send_escape(&target).expect("escape");
    manager.send_focus_in(&target).expect("focus in");
    manager
        .send_modified_enter(&target)
        .expect("modified enter");
    manager.send_key(&target, "C-c").expect("key");
    manager
        .start_pane_pipe(&target, "cat >> /tmp/out", true)
        .expect("pipe");
    manager.stop_pane_pipe(&target).expect("stop pipe");
    manager
        .clear_target_history(&target)
        .expect("clear history");
    manager.select_window(&target).expect("select");
    manager.unlink_window(&target).expect("unlink");
    manager.kill_window(&target).expect("kill window");
    manager
        .kill_session("aimux-mobile-abc")
        .expect("kill session");

    let calls = calls.borrow();
    assert_eq!(
        calls[0].0,
        vec![
            "capture-pane",
            "-p",
            "-J",
            "-e",
            "-t",
            "@9",
            "-S",
            "-50",
            "-E",
            "-1",
        ]
    );
    assert!(calls.iter().any(|(args, _)| args
        == &vec![
            "resize-window".to_owned(),
            "-t".to_owned(),
            "@9".to_owned(),
            "-x".to_owned(),
            "120".to_owned(),
            "-y".to_owned(),
            "40".to_owned(),
        ]));
    assert!(calls.iter().any(|(args, _)| args
        == &vec![
            "unlink-window".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-abc:@9".to_owned(),
        ]));
    assert!(calls.iter().any(|(args, _)| args
        == &vec![
            "kill-session".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-abc".to_owned(),
        ]));
}

#[test]
fn respawns_window_with_command_cwd() {
    let calls = Rc::new(RefCell::new(Vec::<(Vec<String>, Option<String>)>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push((
            args.to_vec(),
            options.and_then(|options| options.cwd.clone()),
        ));
        Ok(String::new())
    });

    manager
        .respawn_window(
            &target(),
            &TmuxCommandSpec {
                cwd: "/repo/mobile".to_owned(),
                command: "node".to_owned(),
                args: vec!["dist/main.js".to_owned()],
            },
        )
        .expect("respawn");

    assert_eq!(calls.borrow()[0].1, Some("/repo/mobile".to_owned()));
    assert_eq!(
        calls.borrow()[0].0,
        vec![
            "respawn-window",
            "-k",
            "-t",
            "@9",
            "-c",
            "/repo/mobile",
            "node",
            "dist/main.js",
        ]
    );
}

#[test]
fn sends_text_in_chunks_and_skips_empty_text() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        Ok(String::new())
    });
    let text = format!("{}🙂{}", "a".repeat(3999), "b".repeat(20));

    manager.send_text(&target(), "").expect("empty send");
    manager.send_text(&target(), &text).expect("send text");

    assert_eq!(calls.borrow().len(), 2);
    assert_eq!(calls.borrow()[0][..4], ["send-keys", "-t", "@9", "-l"]);
    assert_eq!(calls.borrow()[1][..4], ["send-keys", "-t", "@9", "-l"]);
    assert_eq!(
        format!("{}{}", calls.borrow()[0][4], calls.borrow()[1][4]),
        text
    );
}

#[test]
fn writes_window_metadata_and_agent_policy_options() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        Ok(String::new())
    });

    manager
        .set_window_metadata(
            "@9",
            &json!({
                "kind": "agent",
                "sessionId": "codex-1",
                "command": "codex",
                "args": []
            }),
        )
        .expect("metadata");
    manager
        .apply_managed_agent_window_policy("@9", "codex")
        .expect("policy");
    manager
        .set_session_option("aimux-mobile-abc", "@aimux-project-root", "/repo/mobile")
        .expect("session option");

    let calls = calls.borrow();
    assert_eq!(calls[0][0..4], ["set-window-option", "-q", "-t", "@9"]);
    assert_eq!(calls[0][4], "@aimux-meta");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&calls[0][5]).expect("metadata json")["sessionId"],
        "codex-1"
    );
    assert!(calls.iter().any(|args| args
        == &vec![
            "set-window-option".to_owned(),
            "-q".to_owned(),
            "-t".to_owned(),
            "@9".to_owned(),
            "@aimux-tool".to_owned(),
            "codex".to_owned(),
        ]));
    assert!(calls.iter().any(|args| args
        == &vec![
            "set-option".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-abc".to_owned(),
            "@aimux-project-root".to_owned(),
            "/repo/mobile".to_owned(),
        ]));
}

#[test]
fn ensure_project_session_creates_and_configures_missing_session() {
    let calls = Rc::new(RefCell::new(Vec::<(Vec<String>, Option<String>)>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push((
            args.to_vec(),
            options.and_then(|options| options.cwd.clone()),
        ));
        let joined = args.join(" ");
        if joined.starts_with("has-session") {
            return Err("no such session".to_owned());
        }
        if joined == "list-sessions -F #{session_name}" {
            return Ok(String::new());
        }
        if joined == "show-options -v -t aimux-mobile-078d0ecd20ec terminal-features" {
            return Ok(String::new());
        }
        Ok(String::new())
    });

    let session = manager
        .ensure_project_session("/repo/mobile", None, Some(test_runtime_config()))
        .expect("session");

    assert_eq!(session.session_name, "aimux-mobile-078d0ecd20ec");
    let calls = calls.borrow();
    let create_call = calls
        .iter()
        .find(|(args, _)| args.first().map(String::as_str) == Some("new-session"))
        .expect("new session");
    assert_eq!(create_call.1, Some("/repo/mobile".to_owned()));
    assert_eq!(
        create_call.0,
        vec![
            "new-session",
            "-d",
            "-s",
            "aimux-mobile-078d0ecd20ec",
            "-c",
            "/repo/mobile",
            "-n",
            "dashboard",
            "sh",
            "-lc",
            "tail -f /dev/null",
        ]
    );
    assert!(calls.iter().any(|(args, _)| args
        == &vec![
            "set-option".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-078d0ecd20ec".to_owned(),
            "@aimux-project-state-dir".to_owned(),
            "/state/mobile".to_owned(),
        ]));
    assert!(calls.iter().any(|(args, _)| args
        == &vec![
            "set-option".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-078d0ecd20ec".to_owned(),
            TMUX_RUNTIME_CONTRACT_OPTION.to_owned(),
            AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned(),
        ]));
    assert!(calls.iter().any(|(args, _)| {
        args.first().map(String::as_str) == Some("set-hook")
            && args.get(3).map(String::as_str) == Some("pane-focus-in")
            && args.get(4).is_some_and(|value| {
                value.contains("tmux-control.sh")
                    && value.contains(" active ")
                    && value.contains("--current-window-id #{q:window_id}")
                    && value.contains("--pane-id #{q:pane_id}")
            })
    }));
    assert!(calls.iter().any(|(args, _)| {
        args.first().map(String::as_str) == Some("bind-key")
            && args.get(3).map(String::as_str) == Some("d")
            && args.join(" ").contains("tmux-control.sh")
            && args
                .join(" ")
                .contains(" dashboard --current-client-session ")
    }));
    assert!(calls.iter().any(|(args, _)| {
        args.first().map(String::as_str) == Some("bind-key")
            && args.get(3).map(String::as_str) == Some("g")
            && args.join(" ").contains("tmux-control.sh")
            && args.join(" ").contains(" expose ")
    }));
    assert!(calls.iter().any(|(args, _)| {
        args.first().map(String::as_str) == Some("set-option")
            && args.get(3).map(String::as_str) == Some("status-format[0]")
            && args.get(4).is_some_and(|value| {
                value.contains("tmux-statusline.sh")
                    && value.contains("#{?pane_in_mode")
                    && value.contains("scroll")
            })
    }));
    assert!(calls.iter().any(|(args, _)| {
        args.first().map(String::as_str) == Some("source-file")
            && args
                .get(1)
                .is_some_and(|value| value.ends_with("mouse-bindings.conf"))
    }));
}

#[test]
fn ensure_project_session_uses_dashboard_command_and_skips_create_when_repaired() {
    let repaired = Rc::new(RefCell::new(false));
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let repaired_for_exec = repaired.clone();
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        let joined = args.join(" ");
        if joined == "has-session -t aimux-mobile-078d0ecd20ec" {
            return if *repaired_for_exec.borrow() {
                Ok(String::new())
            } else {
                Err("missing".to_owned())
            };
        }
        if joined == "list-sessions -F #{session_name}" {
            return Ok("aimux-mobile-7a62ea91ca".to_owned());
        }
        if joined == "rename-session -t aimux-mobile-7a62ea91ca aimux-mobile-078d0ecd20ec" {
            *repaired_for_exec.borrow_mut() = true;
            return Ok(String::new());
        }
        if joined == "show-options -v -t aimux-mobile-078d0ecd20ec terminal-features" {
            return Ok(String::new());
        }
        Ok(String::new())
    });

    manager
        .ensure_project_session(
            "/repo/mobile",
            Some(&TmuxCommandSpec {
                cwd: "/repo/mobile".to_owned(),
                command: "node".to_owned(),
                args: vec!["dist/main.js".to_owned()],
            }),
            Some(test_runtime_config()),
        )
        .expect("session");

    let calls = calls.borrow();
    assert!(calls.iter().any(|args| args
        == &vec![
            "rename-session".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-7a62ea91ca".to_owned(),
            "aimux-mobile-078d0ecd20ec".to_owned(),
        ]));
    assert!(
        !calls
            .iter()
            .any(|args| args.first().map(String::as_str) == Some("new-session"))
    );
}

#[test]
fn configure_managed_session_ignores_unsupported_extended_key_options() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let calls_for_exec = calls.clone();
    let mut manager = TmuxRuntimeManager::with_exec(move |args, _options| {
        calls_for_exec.borrow_mut().push(args.to_vec());
        let joined = args.join(" ");
        if joined.contains(" extended-keys ") || joined.contains(" extended-keys-format ") {
            return Err("invalid option: extended-keys".to_owned());
        }
        Ok(String::new())
    });

    manager
        .configure_managed_session(
            "aimux-mobile-078d0ecd20ec",
            "/repo/mobile",
            test_runtime_config(),
        )
        .expect("configure");

    assert!(calls.borrow().iter().any(|args| args
        == &vec![
            "set-option".to_owned(),
            "-as".to_owned(),
            "-t".to_owned(),
            "aimux-mobile-078d0ecd20ec".to_owned(),
            "terminal-features".to_owned(),
            ",xterm*:RGB".to_owned(),
        ]));
}

fn test_runtime_config() -> TmuxRuntimeConfig {
    TmuxRuntimeConfig {
        project_state_dir: "/state/mobile".to_owned(),
        control_script_command: "sh 'scripts/tmux-control.sh'".to_owned(),
        statusline_command: TmuxCommandSpec {
            cwd: "/repo/mobile".to_owned(),
            command: "sh".to_owned(),
            args: vec!["scripts/tmux-statusline.sh".to_owned()],
        },
        runtime_owner_id: r#"{"home":"/aimux","port":"43190"}"#.to_owned(),
    }
}

fn target() -> TmuxTarget {
    TmuxTarget {
        session_name: "aimux-mobile-abc".to_owned(),
        window_id: "@9".to_owned(),
        window_index: 9,
        window_name: "codex".to_owned(),
        pane_dead: None,
    }
}
