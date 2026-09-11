use aimux::paths::PathResolver;
use aimux::runtime_coherence::{
    RuntimeCoherenceHealth, RuntimeCoherenceHealthProbe, RuntimeCoherenceInput,
    RuntimeCoherenceTmux, RuntimeCoherenceTmuxWindow, build_runtime_coherence_report_with_resolver,
    render_runtime_coherence_report,
};
use aimux::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_CONTRACT_OPTION,
    TMUX_RUNTIME_OWNER_OPTION, project_session,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const RUNTIME_COHERENCE: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-coherence/report.json");

#[test]
fn fixture_runtime_coherence_cases_match_typescript_contract() {
    let contract: Value =
        serde_json::from_str(RUNTIME_COHERENCE).expect("valid runtime-coherence fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("runtime coherence cases");
    assert_eq!(cases.len(), 15, "unexpected runtime-coherence case count");

    let mut failures = Vec::new();
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let mut resolver = fixture_resolver();
        let actual_report = build_runtime_coherence_report_with_resolver(
            scenario_input(id, &case["input"]),
            &mut resolver,
        );
        let mut actual = json!({
            "report": actual_report,
            "rendered": render_runtime_coherence_report(&actual_report),
        });
        if case["output"].get("requestLog").is_some() {
            actual["requestLog"] = request_log_for_case(id, &case["input"]);
        }
        if actual != case["output"] {
            failures.push(json!({
                "id": id,
                "name": case["name"],
                "actual": actual,
                "expected": case["output"],
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} runtime-coherence parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn runtime_coherence_uses_resolver_for_expected_project_state_dir() {
    let project_root = "/Users/samuelsteady/cs/mini-project";
    let mut state_resolver = PathResolver::new("/", "/Users/samuelsteady", None);
    let expected_state_dir = state_resolver
        .project_state_dir_for(project_root)
        .to_string_lossy()
        .into_owned();
    let mut daemon_projects = BTreeMap::new();
    daemon_projects.insert(
        "mini".into(),
        json!({
            "projectId": "mini",
            "projectRoot": project_root,
            "pid": 4242,
            "startedAt": "then",
            "updatedAt": "now",
        }),
    );
    let expected_project_service = expected_manifest();
    let mut health = BTreeMap::new();
    health.insert(
        "127.0.0.1:43211".into(),
        vec![RuntimeCoherenceHealthProbe::Ok(RuntimeCoherenceHealth {
            status: 200,
            body: json!({
                "ok": true,
                "pid": 4242,
                "projectStateDir": expected_state_dir,
                "serviceInfo": expected_project_service,
            }),
        })],
    );
    let mut resolver = PathResolver::new("/", "/Users/samuelsteady", None);
    let report = build_runtime_coherence_report_with_resolver(
        RuntimeCoherenceInput {
            generated_at: "2026-06-20T00:00:00.000Z".into(),
            cli_version: "0.1.34".into(),
            build_profile: "full".into(),
            cli_launch: cli_launch(),
            expected_project_service: expected_manifest(),
            expected_runtime_owner: "owner-new".into(),
            daemon_info: Some(json!({
                "pid": 9001,
                "port": 43190,
                "startedAt": "then",
                "updatedAt": "now",
            })),
            daemon_projects,
            endpoints: [(
                project_root.to_owned(),
                Some(json!({
                    "host": "127.0.0.1",
                    "port": 43211,
                    "pid": 4242,
                    "updatedAt": "now",
                })),
            )]
            .into_iter()
            .collect(),
            health,
            tmux: RuntimeCoherenceTmux {
                available: false,
                version: None,
                ..RuntimeCoherenceTmux::default()
            },
            dashboard_build_stamps: [(project_root.to_owned(), "dashboard-new".to_owned())]
                .into_iter()
                .collect(),
            process_args: BTreeMap::new(),
            process_list: Vec::new(),
        },
        &mut resolver,
    );

    assert_eq!(
        report.pointer("/summary/ok").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        report
            .pointer("/summary/needsRestart")
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        report
            .pointer("/projects/0/service/status")
            .and_then(Value::as_str),
        Some("ok")
    );
    assert!(
        !serde_json::to_string(&report)
            .expect("serialize report")
            .contains("/Users/sam/.aimux")
    );
}

#[test]
fn runtime_coherence_reports_real_computed_tmux_session_names() {
    let project_root = "/Users/samuelsteady/cs/tealstreet-next";
    let session_name = project_session(project_root, "aimux").session_name;
    let expected_project_service = expected_manifest();
    let mut state_resolver = PathResolver::new("/", "/Users/samuelsteady", None);
    let expected_state_dir = state_resolver
        .project_state_dir_for(project_root)
        .to_string_lossy()
        .into_owned();
    let mut session_options = BTreeMap::new();
    session_options.insert(
        session_name.clone(),
        [
            (
                "@aimux-project-root".to_owned(),
                Some(project_root.to_owned()),
            ),
            (
                TMUX_RUNTIME_OWNER_OPTION.to_owned(),
                Some("owner-new".to_owned()),
            ),
            (
                TMUX_RUNTIME_CONTRACT_OPTION.to_owned(),
                Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned()),
            ),
        ]
        .into_iter()
        .collect(),
    );
    let mut windows = BTreeMap::new();
    windows.insert(
        session_name.clone(),
        vec![RuntimeCoherenceTmuxWindow {
            id: "@73".to_owned(),
            index: 0,
            name: "dashboard".to_owned(),
            active: true,
        }],
    );
    let mut window_options = BTreeMap::new();
    window_options.insert(
        "@73".to_owned(),
        [
            (
                "@aimux-dashboard-build".to_owned(),
                Some("dashboard-new".to_owned()),
            ),
            (
                TMUX_DASHBOARD_OWNER_OPTION.to_owned(),
                Some("owner-new".to_owned()),
            ),
        ]
        .into_iter()
        .collect(),
    );
    let mut resolver = PathResolver::new("/", "/Users/samuelsteady", None);
    let report = build_runtime_coherence_report_with_resolver(
        RuntimeCoherenceInput {
            generated_at: "2026-09-10T00:00:00.000Z".into(),
            cli_version: "0.1.34".into(),
            build_profile: "full".into(),
            cli_launch: cli_launch(),
            expected_project_service: expected_project_service.clone(),
            expected_runtime_owner: "owner-new".into(),
            daemon_info: Some(
                json!({ "pid": 9001, "port": 43190, "startedAt": "then", "updatedAt": "now" }),
            ),
            daemon_projects: [(
                "tealstreet-next".to_owned(),
                json!({
                    "projectId": "tealstreet-next",
                    "projectRoot": project_root,
                    "pid": 4242,
                    "startedAt": "then",
                    "updatedAt": "now",
                }),
            )]
            .into_iter()
            .collect(),
            endpoints: [(
                project_root.to_owned(),
                Some(json!({
                    "host": "127.0.0.1",
                    "port": 43211,
                    "pid": 4242,
                    "updatedAt": "now",
                })),
            )]
            .into_iter()
            .collect(),
            health: [(
                "127.0.0.1:43211".to_owned(),
                vec![RuntimeCoherenceHealthProbe::Ok(RuntimeCoherenceHealth {
                    status: 200,
                    body: json!({
                        "ok": true,
                        "pid": 4242,
                        "projectStateDir": expected_state_dir,
                        "serviceInfo": expected_project_service,
                    }),
                })],
            )]
            .into_iter()
            .collect(),
            tmux: RuntimeCoherenceTmux {
                available: true,
                version: Some("tmux 3.6b".to_owned()),
                session_names: vec![session_name.clone()],
                session_options,
                windows,
                window_options,
                window_alive: [("@73".to_owned(), true)].into_iter().collect(),
                pane_start_commands: BTreeMap::new(),
            },
            dashboard_build_stamps: [(project_root.to_owned(), "dashboard-new".to_owned())]
                .into_iter()
                .collect(),
            process_args: BTreeMap::new(),
            process_list: Vec::new(),
        },
        &mut resolver,
    );

    assert_eq!(
        report
            .pointer("/projects/0/runtime/sessionName")
            .and_then(Value::as_str),
        Some(session_name.as_str())
    );
    assert_eq!(
        report
            .pointer("/projects/0/dashboards/0/sessionName")
            .and_then(Value::as_str),
        Some(session_name.as_str())
    );
    assert_eq!(
        report
            .pointer("/summary/needsRestart")
            .and_then(Value::as_u64),
        Some(0)
    );
}

#[test]
fn runtime_coherence_counts_deliberately_stopped_services_separately() {
    let mut input = scenario_input(
        "runtime-coherence-008",
        &json!({ "daemonProjects": ["/repo/beta"] }),
    );
    let service = input
        .daemon_projects
        .get_mut("beta")
        .expect("beta daemon project");
    service["status"] = json!("stopped");
    service["lastExit"] = json!({
        "at": "2026-09-10T08:18:44.179Z",
        "code": null,
        "signal": "SIGTERM",
        "expected": true,
    });
    input.endpoints.insert("/repo/beta".into(), None);
    input.health.clear();

    let mut resolver = fixture_resolver();
    let report = build_runtime_coherence_report_with_resolver(input, &mut resolver);
    let rendered = render_runtime_coherence_report(&report);

    assert_eq!(report["projects"][0]["status"], json!("stopped"));
    assert_eq!(report["summary"]["stopped"], json!(1));
    assert_eq!(report["summary"]["needsAttention"], json!(0));
    assert_eq!(report["summary"]["needsRestart"], json!(0));
    assert!(rendered.contains(
        "projects: 1 (0 ok, 1 stopped, 0 inactive, 0 need attention, 0 need runtime rebuild)"
    ));
    assert!(rendered.contains("Project stopped: /repo/beta"));
}

#[test]
fn runtime_coherence_keeps_unreachable_running_services_actionable() {
    let mut resolver = fixture_resolver();
    let report = build_runtime_coherence_report_with_resolver(
        scenario_input(
            "runtime-coherence-004",
            &json!({ "daemonProjects": ["/repo/alpha"], "serviceError": "connection refused" }),
        ),
        &mut resolver,
    );

    assert_eq!(report["projects"][0]["status"], json!("needs-attention"));
    assert_eq!(report["summary"]["needsAttention"], json!(1));
    assert_eq!(report["summary"]["needsRestart"], json!(1));
    assert_eq!(report["summary"]["stopped"], json!(0));
}

#[test]
fn runtime_coherence_keeps_unexpected_stopped_services_actionable() {
    let mut input = scenario_input(
        "runtime-coherence-008",
        &json!({ "daemonProjects": ["/repo/beta"] }),
    );
    let service = input
        .daemon_projects
        .get_mut("beta")
        .expect("beta daemon project");
    service["status"] = json!("stopped");
    service["lastExit"] = json!({
        "at": "2026-09-10T08:18:44.179Z",
        "code": 1,
        "signal": null,
        "expected": false,
    });
    input.endpoints.insert("/repo/beta".into(), None);
    input.health.clear();

    let mut resolver = fixture_resolver();
    let report = build_runtime_coherence_report_with_resolver(input, &mut resolver);

    assert_eq!(report["projects"][0]["status"], json!("needs-attention"));
    assert_eq!(report["summary"]["needsAttention"], json!(1));
    assert_eq!(report["summary"]["stopped"], json!(0));
}

#[test]
fn runtime_coherence_reports_tmux_only_residue_as_inactive() {
    let project_root = "/tmp/aimux-route-coverage";
    let session_name = project_session(project_root, "aimux").session_name;
    let mut session_options = BTreeMap::new();
    session_options.insert(
        session_name.clone(),
        [
            (
                "@aimux-project-root".to_owned(),
                Some(project_root.to_owned()),
            ),
            (
                TMUX_RUNTIME_OWNER_OPTION.to_owned(),
                Some("owner-new".to_owned()),
            ),
            (
                TMUX_RUNTIME_CONTRACT_OPTION.to_owned(),
                Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned()),
            ),
        ]
        .into_iter()
        .collect(),
    );
    let mut resolver = fixture_resolver();
    let report = build_runtime_coherence_report_with_resolver(
        RuntimeCoherenceInput {
            generated_at: "2026-09-10T00:00:00.000Z".into(),
            cli_version: "0.1.34".into(),
            build_profile: "full".into(),
            cli_launch: cli_launch(),
            expected_project_service: expected_manifest(),
            expected_runtime_owner: "owner-new".into(),
            daemon_info: Some(
                json!({ "pid": 9001, "port": 43190, "startedAt": "then", "updatedAt": "now" }),
            ),
            daemon_projects: BTreeMap::new(),
            endpoints: BTreeMap::new(),
            health: BTreeMap::new(),
            tmux: RuntimeCoherenceTmux {
                available: true,
                version: Some("tmux 3.6b".to_owned()),
                session_names: vec![session_name],
                session_options,
                windows: BTreeMap::new(),
                window_options: BTreeMap::new(),
                window_alive: BTreeMap::new(),
                pane_start_commands: BTreeMap::new(),
            },
            dashboard_build_stamps: BTreeMap::new(),
            process_args: BTreeMap::new(),
            process_list: Vec::new(),
        },
        &mut resolver,
    );

    assert_eq!(report["projects"][0]["status"], json!("inactive"));
    assert_eq!(report["summary"]["inactive"], json!(1));
    assert_eq!(report["summary"]["needsAttention"], json!(0));
}

fn fixture_resolver() -> PathResolver {
    PathResolver::new("/", "/Users/sam", None)
}

fn request_log_for_case(id: &str, input: &Value) -> Value {
    if id != "runtime-coherence-007" {
        return Value::Null;
    }
    let root = input["daemonProjects"][0].as_str().expect("daemon project");
    let port = if root.ends_with("alpha") {
        43211
    } else {
        43212
    };
    json!([
        {
            "url": format!("http://127.0.0.1:{port}/health"),
            "options": { "timeoutMs": 1000 },
        },
        {
            "url": format!("http://127.0.0.1:{port}/health"),
            "options": { "timeoutMs": 4000 },
        },
    ])
}

fn scenario_input(id: &str, input: &Value) -> RuntimeCoherenceInput {
    let tmux = tmux_for_case(id, input);
    let daemon_projects = daemon_projects_for_case(id, input);
    let mut roots = daemon_projects
        .values()
        .filter_map(|project| project.get("projectRoot").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if id == "runtime-coherence-001" {
        roots.push("/repo/beta".into());
    }
    if id == "runtime-coherence-003" {
        roots.push("/repo/legacy".into());
    }
    roots.sort();
    roots.dedup();

    RuntimeCoherenceInput {
        generated_at: "2026-06-20T00:00:00.000Z".into(),
        cli_version: "0.1.34".into(),
        build_profile: "full".into(),
        cli_launch: cli_launch(),
        expected_project_service: expected_manifest(),
        expected_runtime_owner: "owner-new".into(),
        daemon_info: Some(
            json!({ "pid": 9001, "port": 43190, "startedAt": "then", "updatedAt": "now" }),
        ),
        daemon_projects,
        endpoints: endpoints_for_roots(id, &roots),
        health: health_for_roots(id, input, &roots),
        dashboard_build_stamps: roots
            .iter()
            .map(|root| (root.clone(), "dashboard-new".to_owned()))
            .collect(),
        process_args: process_args_for_case(id, input),
        process_list: process_list_for_case(id, input),
        tmux,
    }
}

fn daemon_projects_for_case(id: &str, input: &Value) -> BTreeMap<String, Value> {
    let mut projects = BTreeMap::new();
    for root in input["daemonProjects"].as_array().into_iter().flatten() {
        let root = root.as_str().expect("daemon project root");
        let key = if root.ends_with("alpha") {
            "alpha"
        } else {
            "beta"
        };
        let pid = if root.ends_with("alpha") { 1001 } else { 1002 };
        let mut project = json!({
            "projectId": key,
            "projectRoot": root,
            "pid": pid,
            "startedAt": "then",
            "updatedAt": "now",
        });
        if id == "runtime-coherence-005" {
            project["status"] = json!("running");
            project["restartCount"] = json!(2);
            project["lastRestartAt"] = json!("2026-08-10T07:00:02.000Z");
            project["lastExit"] = json!({
                "at": "2026-08-10T07:00:00.000Z",
                "code": 1,
                "signal": null,
                "expected": false,
            });
        }
        projects.insert(key.into(), project);
    }
    projects
}

fn tmux_for_case(id: &str, input: &Value) -> RuntimeCoherenceTmux {
    let mut tmux = RuntimeCoherenceTmux {
        session_names: session_names_for_case(id, input),
        ..RuntimeCoherenceTmux::default()
    };
    let session_names = tmux.session_names.clone();
    for session_name in &session_names {
        let mut options = BTreeMap::new();
        options.insert(
            "@aimux-project-root".into(),
            project_root_for_session(session_name),
        );
        options.insert(
            TMUX_RUNTIME_OWNER_OPTION.into(),
            runtime_owner_for_session(id, input, session_name),
        );
        options.insert(
            TMUX_RUNTIME_CONTRACT_OPTION.into(),
            runtime_contract_for_session(id, session_name),
        );
        tmux.session_options.insert(session_name.clone(), options);
        tmux.windows
            .insert(session_name.clone(), windows_for_session(id, session_name));
    }
    for window in tmux.windows.values().flatten() {
        tmux.window_alive.insert(window.id.clone(), true);
        let mut options = BTreeMap::new();
        options.insert(
            "@aimux-dashboard-build".into(),
            dashboard_build_for_window(id, &window.id),
        );
        options.insert(
            TMUX_DASHBOARD_OWNER_OPTION.into(),
            dashboard_owner_for_window(id, &window.id),
        );
        tmux.window_options.insert(window.id.clone(), options);
        tmux.pane_start_commands.insert(
            window.id.clone(),
            Some(pane_start_command_for_window(id, &window.id)),
        );
    }
    tmux
}

fn session_names_for_case(id: &str, input: &Value) -> Vec<String> {
    if let Some(value) = input.get("tmuxSessions") {
        if value.as_str() == Some("default") {
            return vec![
                "aimux-alpha-111".into(),
                "aimux-alpha-111-client-deadbeef".into(),
                "aimux-beta-222".into(),
            ];
        }
        return value
            .as_array()
            .expect("tmux sessions")
            .iter()
            .map(|entry| entry.as_str().expect("session name").to_owned())
            .collect();
    }
    match id {
        "runtime-coherence-008" | "runtime-coherence-009" | "runtime-coherence-015" => {
            vec!["aimux-beta-222".into()]
        }
        "runtime-coherence-010" | "runtime-coherence-013" => {
            vec![
                "aimux-beta-222".into(),
                "aimux-beta-222-client-deadbeef".into(),
            ]
        }
        "runtime-coherence-011" => {
            vec![
                "aimux-beta-222".into(),
                "aimux-beta-222-client-aaaaaaaa".into(),
            ]
        }
        "runtime-coherence-012" => {
            vec![
                "aimux-beta-222".into(),
                "aimux-beta-222-client-stale".into(),
            ]
        }
        _ => Vec::new(),
    }
}

fn windows_for_session(id: &str, session_name: &str) -> Vec<RuntimeCoherenceTmuxWindow> {
    if id == "runtime-coherence-013" && session_name == "aimux-beta-222-client-deadbeef" {
        return vec![
            window("@2", 0, "dashboard", true),
            window("@3", 1, "dashboard", false),
        ];
    }
    if session_name == "aimux-alpha-111" {
        return vec![window("@1", 0, "dashboard", true)];
    }
    if session_name == "aimux-alpha-111-client-deadbeef" {
        return vec![window("@1", 0, "dashboard", true)];
    }
    if session_name == "aimux-beta-222" {
        return vec![window("@2", 0, "dashboard", true)];
    }
    if session_name == "aimux-foreign-333" || session_name == "aimux-legacy-333" {
        return vec![window("@3", 0, "dashboard", true)];
    }
    Vec::new()
}

fn endpoints_for_roots(id: &str, roots: &[String]) -> BTreeMap<String, Option<Value>> {
    roots
        .iter()
        .map(|root| {
            let (port, pid) = if root.ends_with("alpha") {
                (43211, 1001)
            } else {
                (43212, 1002)
            };
            let updated_at = if id == "runtime-coherence-005" {
                "2026-08-10T07:00:02.000Z"
            } else {
                "2026-06-20T00:00:00.000Z"
            };
            (
                root.clone(),
                Some(json!({
                    "host": "127.0.0.1",
                    "port": port,
                    "pid": pid,
                    "updatedAt": updated_at,
                })),
            )
        })
        .collect()
}

fn health_for_roots(
    id: &str,
    input: &Value,
    roots: &[String],
) -> BTreeMap<String, Vec<RuntimeCoherenceHealthProbe>> {
    let mut health = BTreeMap::new();
    for root in roots {
        let (port, pid) = if root.ends_with("alpha") {
            (43211, 1001)
        } else if root.ends_with("legacy") {
            (43212, 1001)
        } else {
            (43212, 1002)
        };
        let key = format!("127.0.0.1:{port}");
        let probes = if input.get("serviceError").is_some() {
            vec![
                RuntimeCoherenceHealthProbe::Err("connection refused".into()),
                RuntimeCoherenceHealthProbe::Err("connection refused".into()),
            ]
        } else if id == "runtime-coherence-007" {
            vec![
                RuntimeCoherenceHealthProbe::Err("request timed out after 1000ms".into()),
                RuntimeCoherenceHealthProbe::Ok(RuntimeCoherenceHealth {
                    status: 200,
                    body: service_health(root, pid, &expected_manifest()),
                }),
            ]
        } else {
            let health_root = input
                .get("healthProjectRoot")
                .and_then(Value::as_str)
                .unwrap_or(root);
            let mut manifest = expected_manifest();
            if id == "runtime-coherence-001" && root.ends_with("alpha") {
                manifest["buildStamp"] = json!("service-old");
            }
            vec![RuntimeCoherenceHealthProbe::Ok(RuntimeCoherenceHealth {
                status: 200,
                body: service_health(health_root, pid, &manifest),
            })]
        };
        health.insert(key, probes);
    }
    health
}

fn process_args_for_case(id: &str, input: &Value) -> BTreeMap<i64, Option<String>> {
    if input.get("staleNativePath").is_none() || id != "runtime-coherence-015" {
        return [(9001, None), (1001, None), (1002, None)]
            .into_iter()
            .collect();
    }
    [
        (
            9001,
            Some("/opt/aimux/native/local-current/bin/aimux daemon run".into()),
        ),
        (
            1002,
            Some("/opt/aimux/native/local-old/dist/main.js __project-service-internal".into()),
        ),
    ]
    .into_iter()
    .collect()
}

fn process_list_for_case(id: &str, input: &Value) -> Vec<Value> {
    if input.get("staleNativePath").is_none() || id != "runtime-coherence-015" {
        return Vec::new();
    }
    vec![json!({
        "pid": 77,
        "args": "/Users/sam/.volta/bin/claude --settings command='/opt/aimux/native/local-old/dist/main.js' claude-hook stop --project /repo/alpha",
    })]
}

fn service_health(project_root: &str, pid: i64, service_info: &Value) -> Value {
    json!({
        "ok": true,
        "pid": pid,
        "projectStateDir": project_state_dir_for(project_root),
        "serviceInfo": service_info,
    })
}

fn project_state_dir_for(project_root: &str) -> String {
    let mut resolver = fixture_resolver();
    resolver
        .project_state_dir_for(project_root)
        .to_string_lossy()
        .into_owned()
}

fn expected_manifest() -> Value {
    json!({
        "apiVersion": 4,
        "capabilities": { "parsedAgentOutput": true },
        "buildStamp": "service-new",
    })
}

fn cli_launch() -> Value {
    json!({
        "command": "/opt/aimux/bin/aimux",
        "args": [],
        "source": "stable-shim",
        "currentEntryPath": "/opt/aimux/native/local-current/dist/launcher-bin.js",
        "stableShimPath": "/opt/aimux/bin/aimux",
    })
}

fn project_root_for_session(session_name: &str) -> Option<String> {
    if session_name.starts_with("aimux-alpha-111") {
        Some("/repo/alpha".into())
    } else if session_name == "aimux-beta-222" {
        Some("/repo/beta".into())
    } else if session_name == "aimux-foreign-333" {
        Some("/repo/foreign".into())
    } else if session_name == "aimux-legacy-333" {
        Some("/repo/legacy".into())
    } else {
        None
    }
}

fn runtime_owner_for_session(id: &str, input: &Value, session_name: &str) -> Option<String> {
    if session_name == "aimux-foreign-333" {
        return Some("owner-foreign".into());
    }
    if session_name == "aimux-legacy-333" {
        return None;
    }
    Some(
        input
            .get("runtimeOwner")
            .and_then(Value::as_str)
            .unwrap_or("owner-new")
            .to_owned(),
    )
    .filter(|_| id != "runtime-coherence-003")
}

fn runtime_contract_for_session(id: &str, session_name: &str) -> Option<String> {
    match (id, session_name) {
        ("runtime-coherence-009", "aimux-beta-222") => Some("legacy-contract".into()),
        ("runtime-coherence-010", "aimux-beta-222-client-deadbeef") => {
            Some("legacy-contract".into())
        }
        ("runtime-coherence-011", "aimux-beta-222-client-aaaaaaaa") => None,
        ("runtime-coherence-012", "aimux-beta-222-client-stale") => Some("legacy-contract".into()),
        _ => Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.into()),
    }
}

fn dashboard_build_for_window(id: &str, window_id: &str) -> Option<String> {
    if id == "runtime-coherence-013" && window_id == "@3" {
        return None;
    }
    Some(
        if window_id == "@1" {
            "dashboard-old"
        } else {
            "dashboard-new"
        }
        .into(),
    )
}

fn dashboard_owner_for_window(id: &str, window_id: &str) -> Option<String> {
    if id == "runtime-coherence-013" && window_id == "@3" {
        None
    } else {
        Some("owner-new".into())
    }
}

fn pane_start_command_for_window(id: &str, window_id: &str) -> String {
    if id == "runtime-coherence-013" && window_id == "@3" {
        return "sh -lc tail -f /dev/null".into();
    }
    if id == "runtime-coherence-015" {
        return "/opt/aimux/native/local-old/dist/main.js --tmux-dashboard-internal".into();
    }
    "node /current/dist/launcher-bin.js --tmux-dashboard-internal".into()
}

fn window(id: &str, index: i64, name: &str, active: bool) -> RuntimeCoherenceTmuxWindow {
    RuntimeCoherenceTmuxWindow {
        id: id.into(),
        index,
        name: name.into(),
        active,
    }
}
