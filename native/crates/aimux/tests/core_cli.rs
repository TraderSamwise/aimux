use aimux::core_cli::{
    CORE_DIAGNOSTIC_TIMEOUT_MS, CoreCliAction, CoreCliContext, CoreCliFallback, CoreCliOperation,
    CoreCliOutputMode, CoreCliPlanError, CoreCommandResponseError, CoreHttpMethod,
    build_core_command_transport_request, classify_core_cli,
    classify_core_cli_with_project_resolver, validate_core_command_response,
};
use aimux::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use serde_json::{Value, json};

fn context(daemon_running: bool, has_credentials: bool) -> CoreCliContext {
    CoreCliContext {
        current_project_root: "/repo".into(),
        daemon_running,
        has_credentials,
    }
}

fn command_from(action: &CoreCliAction) -> (&str, Option<&Value>, bool, Option<u64>, bool) {
    let CoreCliAction::Command {
        request,
        open_dashboard_after,
    } = action
    else {
        panic!("expected command action, got {action:?}");
    };
    (
        request.command,
        request.payload.as_ref(),
        request.options.ensure_daemon,
        request.options.timeout_ms,
        *open_dashboard_after,
    )
}

#[test]
fn sidecar_owned_commands_map_to_authoritative_names_and_payloads() {
    let cases = [
        (
            vec!["host", "status"],
            CoreCliOperation::HostStatus,
            CORE_COMMAND_NAMES.status,
            None,
        ),
        (
            vec!["daemon", "ensure"],
            CoreCliOperation::DaemonEnsure,
            CORE_COMMAND_NAMES.status,
            None,
        ),
        (
            vec!["daemon", "projects"],
            CoreCliOperation::DaemonProjects,
            CORE_COMMAND_NAMES.projects_list,
            None,
        ),
        (
            vec!["projects", "list"],
            CoreCliOperation::ProjectsList,
            CORE_COMMAND_NAMES.projects_list,
            None,
        ),
        (
            vec!["serve"],
            CoreCliOperation::ProjectServe,
            CORE_COMMAND_NAMES.project_ensure,
            Some(json!({ "projectRoot": "/repo" })),
        ),
        (
            vec!["host", "stop"],
            CoreCliOperation::HostStop,
            CORE_COMMAND_NAMES.project_stop,
            Some(json!({ "projectRoot": "/repo" })),
        ),
        (
            vec!["host", "kill"],
            CoreCliOperation::HostKill,
            CORE_COMMAND_NAMES.project_kill,
            Some(json!({ "projectRoot": "/repo" })),
        ),
    ];

    for (args, operation, command, payload) in cases {
        let plan = classify_core_cli(&args, &context(true, true)).expect("valid plan");
        assert_eq!(plan.operation, operation, "{args:?}");
        let actual = command_from(&plan.action);
        assert_eq!(actual.0, command, "{args:?}");
        assert_eq!(actual.1, payload.as_ref(), "{args:?}");
        assert!(actual.2, "{args:?}");
        assert_eq!(actual.3, None, "{args:?}");
        assert!(!actual.4, "{args:?}");
    }
}

#[test]
fn project_ensure_and_restart_use_the_supplied_project_resolver() {
    let plan = classify_core_cli_with_project_resolver(
        &["daemon", "project-ensure", "--project", "./child", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("project ensure plan");
    assert_eq!(plan.output_mode, CoreCliOutputMode::Json);
    assert_eq!(
        command_from(&plan.action).1,
        Some(&json!({ "projectRoot": "/resolved/./child" }))
    );

    let restart = classify_core_cli_with_project_resolver(
        &["restart", "--project=./child"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("restart plan");
    assert_eq!(restart.operation, CoreCliOperation::Restart);
    assert_eq!(
        restart.action,
        CoreCliAction::RestartControlPlane {
            project_root: Some("/resolved/./child".into()),
        }
    );
}

#[test]
fn host_restart_always_sends_serve_and_preserves_open_as_a_local_followup() {
    for (args, serve, open) in [
        (vec!["host", "restart"], false, false),
        (vec!["host", "restart", "--serve"], true, false),
        (vec!["host", "restart", "--open"], false, true),
        (vec!["host", "restart", "--serve", "--open"], true, true),
    ] {
        let plan = classify_core_cli(&args, &context(true, true)).expect("host restart plan");
        let request = command_from(&plan.action);
        assert_eq!(request.0, CORE_COMMAND_NAMES.project_restart);
        assert_eq!(
            request.1,
            Some(&json!({ "projectRoot": "/repo", "serve": serve }))
        );
        assert_eq!(request.4, open);
        assert_eq!(
            plan.fallback,
            if open {
                CoreCliFallback::MissingDashboardTarget
            } else {
                CoreCliFallback::None
            }
        );
    }
}

#[test]
fn daemon_status_uses_a_bounded_existing_daemon_request_and_stored_state_fallback() {
    let plan = classify_core_cli(&["daemon", "status", "--json"], &context(false, false))
        .expect("daemon status plan");
    assert_eq!(plan.operation, CoreCliOperation::DaemonStatus);
    assert_eq!(plan.output_mode, CoreCliOutputMode::Json);
    assert_eq!(plan.fallback, CoreCliFallback::StoredDaemonStatus);
    let request = command_from(&plan.action);
    assert_eq!(request.0, CORE_COMMAND_NAMES.status);
    assert!(!request.2);
    assert_eq!(request.3, Some(CORE_DIAGNOSTIC_TIMEOUT_MS));
}

#[test]
fn local_diagnostics_and_restart_do_not_become_command_requests() {
    let logs = classify_core_cli(
        &["logs", "tail", "--project", "-foo", "-n", "-5"],
        &context(true, true),
    )
    .expect("logs plan");
    assert!(matches!(logs.action, CoreCliAction::Logs(_)));
    assert_eq!(logs.fallback, CoreCliFallback::EmptyLogTail);

    let daemon_restart = classify_core_cli(&["daemon", "restart", "--json"], &context(true, true))
        .expect("daemon restart plan");
    assert_eq!(daemon_restart.operation, CoreCliOperation::DaemonRestart);
    assert_eq!(daemon_restart.output_mode, CoreCliOutputMode::Json);
    assert_eq!(
        daemon_restart.action,
        CoreCliAction::RestartControlPlane { project_root: None }
    );
}

#[test]
fn remote_status_requests_the_relay_only_when_credentials_and_daemon_exist() {
    for (daemon, credentials, expects_request) in [
        (true, true, true),
        (true, false, false),
        (false, true, false),
        (false, false, false),
    ] {
        let plan = classify_core_cli(&["remote", "status"], &context(daemon, credentials))
            .expect("remote status plan");
        assert_eq!(plan.fallback, CoreCliFallback::RelayOff);
        let CoreCliAction::RemoteStatus { relay_request } = plan.action else {
            panic!("expected remote status action");
        };
        assert_eq!(relay_request.is_some(), expects_request);
        if let Some(request) = relay_request {
            assert_eq!(request.command, CORE_COMMAND_NAMES.relay_status);
            assert!(!request.options.ensure_daemon);
            assert_eq!(request.options.timeout_ms, Some(CORE_DIAGNOSTIC_TIMEOUT_MS));
        }
    }
}

#[test]
fn remote_enable_and_disable_preserve_credential_and_daemon_fallbacks() {
    let enable = classify_core_cli(&["remote", "enable"], &context(true, false))
        .expect("remote enable plan");
    assert_eq!(enable.fallback, CoreCliFallback::NotLoggedIn);
    assert!(matches!(
        enable.action,
        CoreCliAction::RemoteEnable {
            relay_request: None
        }
    ));

    let disable = classify_core_cli(&["remote", "disable"], &context(false, true))
        .expect("remote disable plan");
    assert_eq!(disable.fallback, CoreCliFallback::DisableRemoteLocally);
    assert!(matches!(
        disable.action,
        CoreCliAction::RemoteDisable {
            relay_request: None
        }
    ));

    let live_disable = classify_core_cli(&["remote", "disable"], &context(true, true))
        .expect("live remote disable plan");
    let CoreCliAction::RemoteDisable {
        relay_request: Some(request),
    } = live_disable.action
    else {
        panic!("expected relay disable request");
    };
    assert_eq!(request.command, CORE_COMMAND_NAMES.relay_disable);
    assert!(!request.options.ensure_daemon);
}

#[test]
fn auth_plans_capture_best_effort_relay_behavior() {
    let logout = classify_core_cli(&["logout"], &context(true, true)).expect("logout plan");
    assert_eq!(logout.fallback, CoreCliFallback::IgnoreRelayDisableFailure);
    assert!(matches!(
        logout.action,
        CoreCliAction::Logout {
            relay_disable: Some(_)
        }
    ));

    let login = classify_core_cli(&["login"], &context(true, false)).expect("login plan");
    assert_eq!(login.fallback, CoreCliFallback::RelayDisconnected);
    assert!(matches!(
        login.action,
        CoreCliAction::Login {
            security_unlock: false,
            relay_enable: Some(_)
        }
    ));

    let unlock = classify_core_cli(&["security", "unlock"], &context(false, false))
        .expect("security unlock plan");
    assert_eq!(
        unlock.fallback,
        CoreCliFallback::RelayDeferredUntilDaemonStart
    );
    assert!(matches!(
        unlock.action,
        CoreCliAction::Login {
            security_unlock: true,
            relay_enable: None
        }
    ));
}

#[test]
fn malformed_mutation_is_invalid_while_other_unknown_forms_are_unsupported() {
    let malformed = classify_core_cli(
        &["daemon", "project-ensure", "--project", "--json"],
        &context(true, true),
    )
    .expect_err("malformed project ensure must fail");
    assert_eq!(malformed.exit_code(), 1);
    assert!(matches!(
        malformed,
        CoreCliPlanError::InvalidArguments { .. }
    ));

    for args in [
        vec!["remote", "enable", "--json"],
        vec!["daemon", "status", "extra"],
        vec!["dashboard-reload"],
    ] {
        let error = classify_core_cli(&args, &context(true, true)).expect_err("unsupported form");
        assert_eq!(error.exit_code(), 2, "{args:?}");
        assert!(matches!(error, CoreCliPlanError::Unsupported { .. }));
    }
}

#[test]
fn direct_core_planning_strips_global_logging_args_like_run_core_cli() {
    let plan = classify_core_cli(
        &["--debug", "remote", "--log-level", "trace", "status"],
        &context(true, true),
    )
    .expect("normalized core plan");
    assert_eq!(plan.args, ["remote", "status"]);
}

#[test]
fn command_transport_contract_matches_posted_json_envelope() {
    let request = build_core_command_transport_request(
        CORE_COMMAND_NAMES.project_restart,
        Some(json!({ "projectRoot": "/repo", "serve": false })),
        Some(1_234),
    )
    .expect("serializable request");
    assert_eq!(request.route, CORE_API_ROUTES.commands);
    assert_eq!(request.method, CoreHttpMethod::Post);
    assert_eq!(request.method.as_str(), "POST");
    assert_eq!(
        request.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(request.timeout_ms, Some(1_234));
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).expect("JSON body"),
        json!({
            "command": "core.project.restart",
            "payload": { "projectRoot": "/repo", "serve": false }
        })
    );

    let no_payload = build_core_command_transport_request(CORE_COMMAND_NAMES.ping, None, None)
        .expect("serializable request");
    assert_eq!(
        serde_json::from_str::<Value>(&no_payload.body).expect("JSON body"),
        json!({ "command": "core.ping" })
    );
}

#[test]
fn command_response_validation_matches_error_and_mismatch_behavior() {
    let response = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({
            "ok": true,
            "id": "test",
            "command": "core.ping",
            "issuedAt": "1970-01-01T00:00:00.000Z",
            "result": { "pong": true }
        }),
    )
    .expect("matching response");
    assert_eq!(response.result, json!({ "pong": true }));

    let command_error = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({ "ok": false, "error": "bad command" }),
    )
    .expect_err("command error");
    assert_eq!(command_error.to_string(), "bad command");

    let mismatch = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({
            "ok": true,
            "id": "test",
            "command": "core.status",
            "issuedAt": "1970-01-01T00:00:00.000Z",
            "result": { "pong": true }
        }),
    )
    .expect_err("mismatched response");
    assert_eq!(
        mismatch,
        CoreCommandResponseError::CommandMismatch {
            expected: "core.ping".into(),
            actual: "core.status".into(),
        }
    );
    assert_eq!(
        mismatch.to_string(),
        "core command response mismatch: expected core.ping, got core.status"
    );
}
