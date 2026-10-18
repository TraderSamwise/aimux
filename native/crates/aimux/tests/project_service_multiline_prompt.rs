#![cfg(unix)]

mod support;

use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    route_agent_output_request, route_agent_output_request_async,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use support::TestIsolation;

#[derive(Clone, Copy)]
enum RecordedCommand {
    Tool,
    Explicit(&'static str),
    Missing,
    Null,
}

#[derive(Clone, Copy)]
enum FixtureInput {
    Mixed,
    BareCr,
    Delimiter(&'static str, bool),
    Printable,
    MissingCapability,
}

#[test]
fn one_submit_after_the_whole_multiline_body_lands() {
    let isolation = TestIsolation::new("multiline-composer");
    let tmux = resolve_program("tmux");
    let python = resolve_program("python3");
    let race_path = isolation.root().join("paste-race.json");
    let legacy_raw_path = isolation.root().join("legacy-raw-paste.json");
    let wrapper = install_tmux_wrapper(
        isolation.root(),
        &tmux,
        &python,
        &race_path,
        &legacy_raw_path,
    );
    let _wrapper_env = TmuxBinaryOverride::set(&wrapper);
    assert_eq!(
        aimux::tmux::tmux_program_from_env().expect("resolve production tmux wrapper once"),
        wrapper.as_os_str().to_os_string()
    );
    let mut server = PrivateServer::start(isolation.root(), tmux.into_os_string());
    let paste_usage = server.run(&["list-commands", "paste-buffer"]);
    let paste_flags = paste_usage
        .split_once('[')
        .and_then(|(_, flags)| flags.split_once(']'))
        .map(|(flags, _)| flags)
        .expect("paste-buffer advertises its flags");
    let supports_raw_paste_flag = paste_flags.contains('S');
    let peer_path = isolation.root().join("composer.py");
    fs::write(&peer_path, COMPOSER).expect("write controlled raw-terminal composer");
    aimux::async_runtime::init_process_runtime().expect("test process runtime");
    let (input, expected) = multiline_prompt();
    let bare_cr_input = format!("{}\r", expected.replace('\n', "\r"));
    assert!(!bare_cr_input.contains('\n'));
    assert!(expected.len() > 4_000, "exercise the old chunk boundary");
    let mut cases = 0;
    let mut checked_stale_frame_cleanup = false;
    let mut capability_format_available = None;

    let normal_cases = [
        (
            "claude-remapped-lf",
            Some("claude"),
            RecordedCommand::Tool,
            true,
            true,
            true,
        ),
        (
            "codex-remapped-lf",
            Some("codex"),
            RecordedCommand::Tool,
            true,
            true,
            false,
        ),
        (
            "claude",
            Some("claude"),
            RecordedCommand::Tool,
            true,
            false,
            false,
        ),
        (
            "codex",
            Some("codex"),
            RecordedCommand::Tool,
            true,
            false,
            false,
        ),
        (
            "shell",
            Some("shell"),
            RecordedCommand::Tool,
            false,
            true,
            false,
        ),
        (
            "custom",
            Some("custom"),
            RecordedCommand::Tool,
            false,
            true,
            false,
        ),
        (
            "missing-tool",
            None,
            RecordedCommand::Missing,
            false,
            true,
            false,
        ),
        (
            "claude-label-shell",
            Some("claude"),
            RecordedCommand::Explicit("/bin/sh"),
            false,
            true,
            false,
        ),
        (
            "claude-missing-command",
            Some("claude"),
            RecordedCommand::Missing,
            false,
            true,
            false,
        ),
        (
            "claude-null-command",
            Some("claude"),
            RecordedCommand::Null,
            false,
            true,
            false,
        ),
        (
            "alias-claude",
            Some("claude-fast"),
            RecordedCommand::Explicit("/installed/claude"),
            true,
            false,
            false,
        ),
        (
            "alias-codex",
            Some("codex-fast"),
            RecordedCommand::Explicit("/installed/codex"),
            true,
            false,
            false,
        ),
    ];
    let mut fixtures = vec![(
        "custom-missing-capability".to_owned(),
        Some("custom"),
        RecordedCommand::Tool,
        false,
        true,
        FixtureInput::MissingCapability,
    )];
    for (name, delimiter, multiline) in [
        ("esc-close-multi", "\u{1b}[201~", true),
        ("esc-open-multi", "\u{1b}[200~", true),
        ("c1-close-multi", "\u{9b}201~", true),
        ("c1-open-multi", "\u{9b}200~", true),
        ("esc-close-single", "\u{1b}[201~", false),
        ("esc-open-single", "\u{1b}[200~", false),
        ("c1-close-single", "\u{9b}201~", false),
        ("c1-open-single", "\u{9b}200~", false),
    ] {
        for (tool, framed) in [("claude", true), ("custom", false)] {
            fixtures.push((
                format!("{tool}-{name}"),
                Some(tool),
                RecordedCommand::Tool,
                framed,
                true,
                FixtureInput::Delimiter(delimiter, multiline),
            ));
        }
    }
    fixtures.extend(normal_cases.into_iter().map(
        |(name, tool, command, framed, lf_submits, bare_cr)| {
            (
                name.to_owned(),
                tool,
                command,
                framed,
                lf_submits,
                if bare_cr {
                    FixtureInput::BareCr
                } else {
                    FixtureInput::Mixed
                },
            )
        },
    ));
    for (tool, framed) in [("claude", true), ("custom", false)] {
        fixtures.push((
            format!("{tool}-printable-delimiters"),
            Some(tool),
            RecordedCommand::Tool,
            framed,
            true,
            FixtureInput::Printable,
        ));
    }
    for executor in ["sync", "async"] {
        for (
            tool_name,
            tool,
            command_override,
            supports_explicit_framing,
            peer_lf_submits,
            input_kind,
        ) in fixtures.clone()
        {
            for (route_name, route) in [
                ("agents", routes::agents::INPUT),
                ("pane", routes::live_pane::INPUT),
            ] {
                for (bracketed, race) in [(false, false), (true, false), (true, true)] {
                    let unsafe_delimiter = matches!(input_kind, FixtureInput::Delimiter(..));
                    let emulate_missing_capability =
                        matches!(input_kind, FixtureInput::MissingCapability);
                    if race && !matches!(tool_name.as_str(), "shell" | "custom") {
                        continue;
                    }
                    if !supports_explicit_framing
                        && !bracketed
                        && matches!(
                            input_kind,
                            FixtureInput::Delimiter(..) | FixtureInput::Printable
                        )
                    {
                        continue;
                    }
                    cases += 1;
                    let (case_input, expected) = match input_kind {
                        FixtureInput::Mixed | FixtureInput::MissingCapability => {
                            (input.clone(), expected.clone())
                        }
                        FixtureInput::BareCr => (bare_cr_input.clone(), expected.clone()),
                        FixtureInput::Delimiter(marker, multiline) => {
                            let body = format!(
                                "prefix café\t{marker}{}rest 界🙂",
                                if multiline { "\n" } else { " " }
                            );
                            (format!("{body}\n"), body)
                        }
                        FixtureInput::Printable => {
                            let body = format!(
                                "{expected}\nLiteral \\x1b[200~ \\x1b[201~ \\u009b200~ \\u009b201~"
                            );
                            (format!("{body}\r\n"), body)
                        }
                    };
                    let label = format!(
                        "{executor}-{tool_name}-{route_name}-{bracketed}{}",
                        if race { "-race" } else { "" }
                    );
                    let root = isolation.root().join(&label);
                    fs::create_dir(&root).expect("create composer case");
                    let observation_path = root.join("observation.json");
                    let config_path = root.join("config.json");
                    fs::write(
                        &config_path,
                        json!({
                            "observation": observation_path,
                            "expected": expected,
                            "bracketed": bracketed,
                            "lfSubmits": peer_lf_submits,
                        })
                        .to_string(),
                    )
                    .expect("write peer expectation");
                    let peer_command = format!(
                        "exec {} {} {} 2>{}",
                        quote(&python.to_string_lossy()),
                        quote(&peer_path.to_string_lossy()),
                        quote(&config_path.to_string_lossy()),
                        quote(&root.join("peer.stderr").to_string_lossy())
                    );
                    let window = server.run(&[
                        "new-session",
                        "-d",
                        "-P",
                        "-F",
                        "#{window_id}",
                        "-s",
                        &label,
                        "-x",
                        "160",
                        "-y",
                        "40",
                        &peer_command,
                    ]);
                    let window = window.trim();
                    let ready = server.wait_for_peer(&observation_path, "peer startup", |value| {
                        value["ready"] == true
                    });
                    server
                        .peer_pids
                        .push(ready["pid"].as_u64().expect("peer pid") as i32);
                    if capability_format_available.is_none() {
                        let value = server.run(&[
                            "display-message",
                            "-p",
                            "-t",
                            window,
                            "#{bracket_paste_flag}",
                        ]);
                        capability_format_available = Some(match value.trim() {
                            "0" | "1" => true,
                            "" => false,
                            other => panic!("{label}: invalid bracket mode format value {other:?}"),
                        });
                    }
                    let format_available = capability_format_available.expect("capability probe");
                    let unavailable = !supports_explicit_framing
                        && (!format_available || emulate_missing_capability);
                    let unsupported =
                        !supports_explicit_framing && (!bracketed || race || unavailable);
                    let expected_mode = if bracketed { "1" } else { "0" };
                    let mode_deadline = Instant::now() + Duration::from_secs(3);
                    if format_available {
                        loop {
                            let mode = server.run(&[
                                "display-message",
                                "-p",
                                "-t",
                                window,
                                "#{bracket_paste_flag}",
                            ]);
                            if mode.trim() == expected_mode {
                                break;
                            }
                            assert!(
                                Instant::now() < mode_deadline,
                                "{label}: pane bracketed-paste mode was {mode:?}, expected {expected_mode}"
                            );
                            thread::sleep(Duration::from_millis(10));
                        }
                    }
                    let buffer_artifact = root.join("loaded-buffer.txt");
                    if race {
                        fs::write(
                            &race_path,
                            json!({
                                "pid": ready["pid"], "observation": observation_path,
                                "window": window, "socket": server.socket,
                                "bufferArtifact": buffer_artifact,
                                "formatAvailable": format_available,
                            })
                            .to_string(),
                        )
                        .expect("arm deterministic paste-mode race");
                    }
                    let context = route_context(&root, &label, window, tool, command_override);
                    if unsafe_delimiter || emulate_missing_capability {
                        fs::write(
                            &legacy_raw_path,
                            json!({
                                "addRawFlag": unsafe_delimiter && supports_raw_paste_flag,
                                "missingFormat": emulate_missing_capability,
                            })
                            .to_string(),
                        )
                        .expect("arm legacy raw body transport");
                    }
                    let body = json!({"sessionId":"receiver", "text":case_input, "force":true});
                    let response = if executor == "sync" {
                        route_agent_output_request(&context, "POST", route, Some(&body))
                    } else {
                        // aimux-async-seam: test - sync test drives the production async route
                        aimux::async_runtime::block_on_named("multiline-route", async {
                            route_agent_output_request_async(
                                &context,
                                "POST",
                                route,
                                Some(&body),
                                None,
                            )
                            .await
                        })
                    }
                    .expect("input route exists");
                    if unsafe_delimiter || emulate_missing_capability {
                        fs::remove_file(&legacy_raw_path)
                            .expect("disarm private transport emulation");
                    }
                    if unsafe_delimiter {
                        let observed = server.wait_for_peer(
                            &observation_path,
                            "delimiter refusal leaves composer untouched",
                            |value| value["ready"] == true,
                        );
                        assert_eq!(
                            observed["inputBytes"], 0,
                            "{label}: unsafe delimiter reached receiver: {observed}; route={}",
                            response.body
                        );
                        assert_eq!(
                            observed["submits"],
                            json!([]),
                            "{label}: delimiter submitted: {observed}"
                        );
                        assert_eq!(observed["draft"], "", "{label}: delimiter left a draft");
                        assert_eq!(response.status, 500, "{label}: {}", response.body);
                        let cause = response.body["error"]
                            .as_str()
                            .expect("visible delimiter refusal");
                        assert!(
                            cause.contains("terminal paste delimiter"),
                            "{label}: unrelated refusal: {cause}"
                        );
                        server.run(&["kill-session", "-t", &label]);
                        server.wait_for_peer(&observation_path, "peer shutdown", |value| {
                            value["stopped"] == true
                        });
                        server.peer_pids.clear();
                        continue;
                    }
                    if race {
                        fs::remove_file(&race_path).expect("disarm paste-mode race");
                    }
                    if unsupported {
                        let observed = server.wait_for_peer(
                            &observation_path,
                            "refused composer remains untouched",
                            |value| value["ready"] == true,
                        );
                        if race {
                            assert_eq!(
                                observed["modeDisabled"], true,
                                "{label}: load seam never disabled paste mode"
                            );
                            let buffer = fs::read_to_string(&buffer_artifact)
                                .expect("race wrapper recorded the successfully loaded buffer");
                            assert!(
                                buffer.starts_with("aimux-prompt-"),
                                "{label}: unexpected buffer identity {buffer:?}"
                            );
                            let buffers = server.run(&["list-buffers", "-F", "#{buffer_name}"]);
                            assert!(
                                !buffers.lines().any(|name| name == buffer),
                                "{label}: refused paste leaked its loaded buffer {buffer}; present={buffers:?}"
                            );
                        }
                        assert_eq!(
                            observed["inputBytes"], 0,
                            "{label}: refusal still sent input: {observed}; route={}",
                            response.body
                        );
                        assert_eq!(
                            observed["submits"],
                            json!([]),
                            "{label}: refusal still submitted: {observed}"
                        );
                        assert_eq!(observed["draft"], "", "{label}: refusal left a draft");
                        assert_eq!(
                            response.status, 500,
                            "{label}: unsupported multiline must fail before paste: {}",
                            response.body
                        );
                        let cause = response.body["error"]
                            .as_str()
                            .expect("explicit refusal cause");
                        assert!(
                            cause.contains("multiline") && cause.contains("bracketed paste"),
                            "{label}: unrelated error cannot prove multiline refusal: {cause}"
                        );
                        assert_eq!(
                            cause.contains("cannot query bracketed paste capability"),
                            unavailable,
                            "{label}: missing capability and mode-off must differ: {cause}"
                        );
                        server.run(&["kill-session", "-t", &label]);
                        server.wait_for_peer(&observation_path, "peer shutdown", |value| {
                            value["stopped"] == true
                        });
                        server.peer_pids.clear();
                        continue;
                    }
                    let observed = server.wait_for_peer(
                        &observation_path,
                        &format!(
                            "{label}: route status={} body={}",
                            response.status, response.body
                        ),
                        |value| {
                            !value["submits"]
                                .as_array()
                                .expect("submit events")
                                .is_empty()
                        },
                    );
                    assert_eq!(
                        observed["earlySubmits"], 0,
                        "{label}: embedded newline submitted before the full body: {observed}; route={}",
                        response.body
                    );
                    let submits = observed["submits"].as_array().expect("submit events");
                    assert_eq!(
                        submits.len(),
                        1,
                        "{label}: expected one final submit, received {observed}"
                    );
                    assert_eq!(
                        submits[0]["body"], expected,
                        "{label}: receiver body changed"
                    );
                    assert_eq!(
                        submits[0]["insidePaste"], false,
                        "{label}: submit preceded paste end"
                    );
                    assert_eq!(observed["draft"], "", "{label}: body remained in composer");
                    let expected_pastes = usize::from(supports_explicit_framing || bracketed);
                    assert_eq!(observed["pasteStarts"], expected_pastes, "{label}");
                    assert_eq!(observed["pasteEnds"], expected_pastes, "{label}");
                    let complete_at = observed["fullBodyAtNs"]
                        .as_u64()
                        .expect("full body observed");
                    let submit_at = submits[0]["atNs"].as_u64().expect("submit observed");
                    assert!(
                        submit_at >= complete_at,
                        "{label}: submit preceded full body"
                    );
                    assert_eq!(response.status, 200, "{label}: {}", response.body);
                    assert_eq!(
                        response.body["accepted"], true,
                        "{label}: {}",
                        response.body
                    );
                    if supports_explicit_framing && !checked_stale_frame_cleanup {
                        let frame = server.run(&[
                            "display-message",
                            "-p",
                            "-t",
                            window,
                            "#{@aimux-input-paste-frame}",
                        ]);
                        assert_eq!(
                            frame.trim(),
                            "",
                            "{label}: successful paste retained its open-frame token"
                        );
                        let stale_cleanup =
                            aimux::tmux::close_paste_frame_argv(window, "stale-test-frame");
                        let stale_cleanup: Vec<&str> =
                            stale_cleanup.iter().map(String::as_str).collect();
                        server.run(&stale_cleanup);
                        thread::sleep(Duration::from_millis(100));
                        let after_cleanup = server.wait_for_peer(
                            &observation_path,
                            "stale frame cleanup leaves the submitted composer untouched",
                            |value| value["ready"] == true,
                        );
                        for field in ["inputBytes", "pasteStarts", "pasteEnds", "submits"] {
                            assert_eq!(
                                after_cleanup[field], observed[field],
                                "{label}: stale cleanup changed {field}: before={observed}; after={after_cleanup}"
                            );
                        }
                        checked_stale_frame_cleanup = true;
                    }
                    server.run(&["kill-session", "-t", &label]);
                    server.wait_for_peer(&observation_path, "peer shutdown", |value| {
                        value["stopped"] == true
                    });
                    server.peer_pids.clear();
                }
            }
        }
    }
    assert_eq!(
        cases, 220,
        "retain all identity, keymap, route, and race cases"
    );
    assert!(
        checked_stale_frame_cleanup,
        "exercise stale cleanup after a successful explicitly framed paste"
    );
    server.shutdown();
}

fn multiline_prompt() -> (String, String) {
    let mut lines = vec!["1. Preserve the header".to_owned(), String::new()];
    lines.extend((2..=90).map(|index| format!(
        "  {index}. Preserve café 界🙂, indentation and\ttabs; the full body must land before submit."
    )));
    let expected = lines.join("\n");
    let mut input = String::new();
    for (index, line) in lines.iter().enumerate() {
        input.push_str(line);
        input.push_str(match index % 3 {
            0 => "\r\n",
            1 => "\r",
            _ => "\n",
        });
    }
    (input, expected)
}

fn route_context(
    root: &Path,
    session: &str,
    window: &str,
    tool: Option<&str>,
    command_override: RecordedCommand,
) -> ProjectServiceRequestContext {
    let project = root.join("project");
    let state = root.join("state");
    fs::create_dir_all(&project).expect("create project");
    fs::create_dir_all(&state).expect("create state");
    let stamp = "2026-10-18T00:00:00.000Z";
    let command = match command_override {
        RecordedCommand::Tool => tool,
        RecordedCommand::Explicit(command) => Some(command),
        RecordedCommand::Missing | RecordedCommand::Null => None,
    };
    let mut source = json!({
        "version":1, "generatedAt":stamp,
        "rigs":[{"id":"rig", "name":"private", "projectRoot":project, "createdAt":stamp, "updatedAt":stamp}],
        "nodes":[{"id":"node", "rigId":"rig", "logicalId":"receiver", "toolConfigKey":tool, "createdAt":stamp}],
        "bindings":[{"id":"binding", "nodeId":"node", "tmuxSession":session, "tmuxWindowId":window, "tmuxWindowIndex":0, "updatedAt":stamp}],
        "sessions":[{"id":"receiver", "nodeId":"node", "status":"running", "toolConfigKey":tool, "command":command, "createdAt":stamp, "updatedAt":stamp}]
    });
    if tool.is_none() {
        source["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("toolConfigKey");
        source["sessions"][0]
            .as_object_mut()
            .unwrap()
            .remove("toolConfigKey");
    }
    if matches!(command_override, RecordedCommand::Missing) {
        source["sessions"][0]
            .as_object_mut()
            .unwrap()
            .remove("command");
    }
    let mut topology = coerce_runtime_topology(&source).expect("valid receiver topology");
    if matches!(command_override, RecordedCommand::Null) {
        topology["sessions"][0]["command"] = Value::Null;
    }
    fs::write(
        runtime_topology_path(&state),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .expect("write topology");
    save_metadata_state(
        &state,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .expect("write metadata");
    ProjectServiceRequestContext::with_project_state_dir(&project, &state)
}

fn resolve_program(name: &str) -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH for fixture executable");
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        match candidate.metadata() {
            Ok(metadata) if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 => {
                return fs::canonicalize(&candidate).expect("canonical fixture executable");
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => panic!(
                "inspect fixture executable {}: {error}",
                candidate.display()
            ),
        }
    }
    panic!("cannot resolve {name} from PATH {path:?}");
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn install_tmux_wrapper(
    root: &Path,
    tmux: &Path,
    python: &Path,
    race: &Path,
    legacy_raw: &Path,
) -> PathBuf {
    let script = root.join("tmux-wrapper.py");
    fs::write(
        &script,
        format!(
            "REAL = {}\nRACE = {}\nLEGACY_RAW = {}\nSOCKET = {}\n{TMUX_WRAPPER}",
            json!(tmux.to_str().expect("real tmux path UTF-8")),
            json!(race.to_str().expect("race path UTF-8")),
            json!(legacy_raw.to_str().expect("legacy raw marker path UTF-8")),
            json!(root.join("tmux.sock").to_str().expect("socket path UTF-8")),
        ),
    )
    .expect("write deterministic tmux race wrapper");
    let wrapper = root.join("tmux-wrapper");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quote(&python.to_string_lossy()),
            quote(&script.to_string_lossy()),
        ),
    )
    .expect("write absolute-interpreter wrapper launcher");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))
        .expect("make owned wrapper executable");
    wrapper
}

struct TmuxBinaryOverride(Option<OsString>);

impl TmuxBinaryOverride {
    fn set(path: &Path) -> Self {
        let previous = std::env::var_os("AIMUX_TMUX_BIN");
        // SAFETY: This test holds TestIsolation's process environment lock.
        unsafe {
            std::env::set_var("AIMUX_TMUX_BIN", path);
        }
        Self(previous)
    }
}

impl Drop for TmuxBinaryOverride {
    fn drop(&mut self) {
        // SAFETY: The enclosing TestIsolation still holds its environment lock.
        unsafe {
            match &self.0 {
                Some(value) => std::env::set_var("AIMUX_TMUX_BIN", value),
                None => std::env::remove_var("AIMUX_TMUX_BIN"),
            }
        }
    }
}

struct PrivateServer {
    root: PathBuf,
    tmux: OsString,
    socket: PathBuf,
    child: Child,
    command_sequence: usize,
    peer_pids: Vec<i32>,
    stopped: bool,
}

impl PrivateServer {
    fn start(root: &Path, tmux: OsString) -> Self {
        let socket = root.join("tmux.sock");
        let child = Command::new(&tmux)
            .args([
                "-S",
                socket.to_str().expect("socket UTF-8"),
                "-f",
                "/dev/null",
                "-D",
            ])
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .stdin(Stdio::null())
            .stdout(Stdio::from(
                fs::File::create(root.join("server.stdout")).unwrap(),
            ))
            .stderr(Stdio::from(
                fs::File::create(root.join("server.stderr")).unwrap(),
            ))
            .spawn()
            .expect("start owned foreground tmux server");
        let mut server = Self {
            root: root.to_owned(),
            tmux,
            socket,
            child,
            command_sequence: 0,
            peer_pids: Vec::new(),
            stopped: false,
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !server.socket.exists() {
            server.assert_alive("server startup");
            assert!(
                Instant::now() < deadline,
                "private tmux socket not ready: {}",
                server.diagnostics()
            );
            thread::sleep(Duration::from_millis(10));
        }
        server
    }

    fn diagnostics(&self) -> String {
        match fs::read_to_string(self.root.join("server.stderr")) {
            Ok(text) => text,
            Err(error) => format!("cannot read private tmux stderr: {error}"),
        }
    }

    fn assert_alive(&mut self, operation: &str) {
        let status = self.child.try_wait().expect("poll owned tmux server");
        assert!(
            status.is_none(),
            "{operation}: private tmux exited {status:?}: {}",
            self.diagnostics()
        );
    }

    fn run(&mut self, args: &[&str]) -> String {
        self.command_sequence += 1;
        let output = self
            .root
            .join(format!("command-{}.stdout", self.command_sequence));
        let errors = self
            .root
            .join(format!("command-{}.stderr", self.command_sequence));
        let mut child = Command::new(&self.tmux)
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .stdin(Stdio::null())
            .stdout(Stdio::from(fs::File::create(&output).unwrap()))
            .stderr(Stdio::from(fs::File::create(&errors).unwrap()))
            .spawn()
            .expect("start private tmux command");
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                outcome => {
                    let killed = child.kill();
                    let reaped = child.wait();
                    panic!(
                        "private tmux {args:?} did not complete: {outcome:?}; kill={killed:?}; wait={reaped:?}; stderr={:?}",
                        fs::read_to_string(&errors)
                    );
                }
            }
        };
        assert!(
            status.success(),
            "private tmux {args:?} failed {status}: {:?}",
            fs::read_to_string(&errors)
        );
        fs::read_to_string(output).expect("read private tmux output")
    }

    fn wait_for_peer(
        &mut self,
        path: &Path,
        operation: &str,
        ready: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let observed = match fs::read(path) {
                Ok(bytes) => {
                    Some(serde_json::from_slice::<Value>(&bytes).expect("atomic peer JSON"))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => panic!(
                    "{operation}: read peer observation {}: {error}",
                    path.display()
                ),
            };
            if let Some(value) = observed.as_ref().filter(|value| ready(value)) {
                return value.clone();
            }
            self.assert_alive(operation);
            assert!(
                Instant::now() < deadline,
                "{operation}: peer not ready; observed={observed:?}; peer stderr={:?}; server={}",
                fs::read_to_string(path.parent().unwrap().join("peer.stderr")),
                self.diagnostics()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn shutdown(&mut self) {
        if self.stopped {
            return;
        }
        for &pid in &self.peer_pids {
            if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    eprintln!("terminate private peer {pid}: {error}");
                }
            }
        }
        if unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("terminate owned private tmux server: {error}");
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                outcome => {
                    eprintln!(
                        "private tmux did not shut down gracefully: {outcome:?}; {}",
                        self.diagnostics()
                    );
                    if let Err(error) = self.child.kill() {
                        eprintln!("kill owned private tmux server: {error}");
                    }
                    if let Err(error) = self.child.wait() {
                        eprintln!("reap owned private tmux server: {error}");
                    }
                    break;
                }
            }
        }
        self.stopped = true;
    }
}

impl Drop for PrivateServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

const COMPOSER: &str = r#"import json, os, signal, sys, termios, time, tty
config = json.load(open(sys.argv[1], encoding='utf-8'))
path = config['observation']
expected = config['expected'].encode('utf-8')
fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
state = dict(pid=os.getpid(), ready=True, stopped=False, modeDisabled=False, earlySubmits=0, inputBytes=0,
             submits=[], draft='', pasteStarts=0, pasteEnds=0, fullBodyAtNs=None)
draft = bytearray()
pending = bytearray()
inside = False
def publish():
    state['draft'] = bytes(draft).decode('utf-8', 'replace')
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as output:
        json.dump(state, output)
    os.replace(temporary, path)
def stop(signum, frame):
    state['stopped'] = True
    publish()
    termios.tcsetattr(fd, termios.TCSANOW, saved)
    sys.exit(0)
def disable_paste_mode(signum, frame):
    os.write(1, b'\x1b[?2004l')
    state['modeDisabled'] = True
    publish()
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGUSR1, disable_paste_mode)
os.write(1, b'\x1b[?2004h' if config['bracketed'] else b'\x1b[?2004l')
os.write(1, '\r\x1b[2K› '.encode())
publish()
try:
    while True:
        data = os.read(fd, 4096)
        if not data:
            raise RuntimeError('composer stdin closed unexpectedly')
        state['inputBytes'] += len(data)
        pending.extend(data)
        while pending:
            if pending[0] == 27:
                markers = [(b'\x1b[200~', True), (b'\x1b[201~', False)]
                matched = False
                for marker, opening in markers:
                    if pending.startswith(marker):
                        del pending[:len(marker)]
                        inside = opening
                        state['pasteStarts' if opening else 'pasteEnds'] += 1
                        matched = True
                        break
                if matched:
                    continue
                if any(marker.startswith(bytes(pending)) for marker, _ in markers):
                    break
            byte = pending.pop(0)
            if (byte == 13 or (byte == 10 and config['lfSubmits'])) and not inside:
                complete = bytes(draft) == expected
                state['earlySubmits'] += not complete
                state['submits'].append(dict(body=bytes(draft).decode('utf-8', 'replace'),
                                             insidePaste=inside, atNs=time.monotonic_ns()))
                draft.clear()
            else:
                draft.append(byte)
                if bytes(draft) == expected and state['fullBodyAtNs'] is None:
                    state['fullBodyAtNs'] = time.monotonic_ns()
        os.write(1, ('\r\x1b[2K› ' + ('[Pasted Content %d chars]' % len(draft) if draft else '')).encode())
        publish()
finally:
    termios.tcsetattr(fd, termios.TCSANOW, saved)
"#;

const TMUX_WRAPPER: &str = r#"import json, os, signal, subprocess, sys, time
args = sys.argv[1:]
if len(args) < 3 or args[0] != '-S' or args[1] != SOCKET:
    raise RuntimeError('fixture wrapper refuses a tmux command outside its private socket: %r' % args)
if os.path.exists(LEGACY_RAW):
    with open(LEGACY_RAW, encoding='utf-8') as source:
        legacy = json.load(source)
    if legacy['addRawFlag'] and 'paste-buffer' in args:
        args.insert(args.index('paste-buffer') + 1, '-S')
    if legacy['missingFormat']:
        args = [arg.replace('#{bracket_paste_flag}', '#{aimux_fixture_missing_bracket_paste_flag}')
                for arg in args]
if args[2] != 'load-buffer' or not os.path.exists(RACE):
    os.execv(REAL, [REAL] + args)
loaded = subprocess.run([REAL] + args, capture_output=True, timeout=5)
if loaded.returncode != 0:
    sys.stdout.buffer.write(loaded.stdout)
    sys.stderr.buffer.write(loaded.stderr)
    sys.exit(loaded.returncode if loaded.returncode > 0 else 128 - loaded.returncode)
with open(RACE, encoding='utf-8') as source:
    race = json.load(source)
if race['socket'] != SOCKET:
    raise RuntimeError('fixture race addresses a foreign socket')
buffer_name = args[args.index('-b') + 1]
with open(race['bufferArtifact'], 'w', encoding='utf-8') as artifact:
    artifact.write(buffer_name)
os.kill(race['pid'], signal.SIGUSR1)
deadline = time.monotonic() + 4
observation = None
mode = None
while True:
    with open(race['observation'], encoding='utf-8') as source:
        observation = json.load(source)
    if observation.get('modeDisabled'):
        if not race['formatAvailable']:
            break
        mode = subprocess.run([REAL, '-S', SOCKET, 'display-message', '-p', '-t', race['window'],
                               '#{bracket_paste_flag}'], capture_output=True, timeout=1)
        if mode.returncode != 0:
            raise RuntimeError('fixture mode probe failed: %r' % mode.stderr)
        if mode.stdout.strip() == b'0':
            break
    if time.monotonic() >= deadline:
        raise RuntimeError('fixture load/paste race did not disable mode: observation=%r mode=%r' %
                           (observation, None if mode is None else mode.stdout))
    time.sleep(0.01)
sys.stdout.buffer.write(loaded.stdout)
sys.stderr.buffer.write(loaded.stderr)
"#;
