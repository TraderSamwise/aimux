use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::text::system::{
    DaemonSystemTextRuntime, OpenFocusRequest, project_root_text_param, route_system_text_request,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
struct FakeSystemRuntime {
    calls: Vec<String>,
    log_output: String,
    log_path_error: Option<String>,
    log_read_error: Option<String>,
    clear_error: Option<String>,
    open_focus: Option<OpenFocusRequest>,
}

impl DaemonSystemTextRuntime for FakeSystemRuntime {
    fn selected_log_path(
        &mut self,
        daemon: bool,
        project: Option<&str>,
    ) -> Result<PathBuf, String> {
        self.calls
            .push(format!("log-path:{daemon}:{}", project.unwrap_or("")));
        if let Some(error) = self.log_path_error.as_ref() {
            return Err(error.clone());
        }
        if daemon {
            Ok(PathBuf::from("/logs/daemon.jsonl"))
        } else if let Some(project) = project {
            Ok(PathBuf::from(format!("/logs/{project}/aimux.jsonl")))
        } else {
            Ok(PathBuf::from("/logs/current/aimux.jsonl"))
        }
    }

    fn read_last_log_lines(&self, _path: &Path, _lines: usize) -> Result<String, String> {
        if let Some(error) = self.log_read_error.as_ref() {
            return Err(error.clone());
        }
        Ok(self.log_output.clone())
    }

    fn clear_log_file(&mut self, path: &Path) -> Result<(), String> {
        self.calls.push(format!("clear:{}", path.to_string_lossy()));
        if let Some(error) = self.clear_error.as_ref() {
            return Err(error.clone());
        }
        Ok(())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            format!("/resolved/{value}")
        }
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9200 }))
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.calls.push(format!("stop:{project_root}:{force}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9200 }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
        open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String> {
        self.calls
            .push(format!("restart:{project_root}:{serve_only}"));
        self.open_focus = open_focus;
        Ok(json!({
            "projectRoot": project_root,
            "project": { "projectRoot": project_root, "pid": 9201 },
            "dashboardSessionName": if serve_only { Value::Null } else { json!("aimux-repo") },
            "dashboardTarget": if serve_only { Value::Null } else { json!({ "sessionName": "aimux-repo", "windowIndex": 1 }) }
        }))
    }
}

fn text_body(response: aimux::daemon::routing::DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

#[test]
fn log_text_routes_match_daemon_output_contracts() {
    let mut runtime = FakeSystemRuntime {
        log_output: "one\ntwo".into(),
        ..FakeSystemRuntime::default()
    };

    let path = route_system_text_request(
        &mut runtime,
        "GET",
        &format!("{}?daemon=1", CORE_API_ROUTES.logs_path_text),
        None,
    )
    .expect("logs path route");
    assert_eq!(text_body(path), "/logs/daemon.jsonl\n");

    let tail = route_system_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=abc&lines=2", CORE_API_ROUTES.logs_tail_text),
        None,
    )
    .expect("logs tail route");
    assert_eq!(text_body(tail), "one\ntwo\n");

    let clear =
        route_system_text_request(&mut runtime, "POST", CORE_API_ROUTES.logs_clear_text, None)
            .expect("logs clear route");
    assert_eq!(text_body(clear), "Cleared /logs/current/aimux.jsonl\n");
    assert!(
        runtime
            .calls
            .contains(&"clear:/logs/current/aimux.jsonl".into())
    );
}

#[test]
fn log_tail_reports_missing_and_io_errors_like_daemon() {
    let mut empty = FakeSystemRuntime::default();
    let missing =
        route_system_text_request(&mut empty, "GET", CORE_API_ROUTES.logs_tail_text, None)
            .expect("logs tail route");
    assert_eq!(missing.status, 404);
    assert_eq!(
        text_body(missing),
        "No log entries at /logs/current/aimux.jsonl\n"
    );

    let mut failed = FakeSystemRuntime {
        log_read_error: Some("denied".into()),
        ..FakeSystemRuntime::default()
    };
    let response =
        route_system_text_request(&mut failed, "GET", CORE_API_ROUTES.logs_tail_text, None)
            .expect("logs tail route");
    assert_eq!(response.status, 500);
    assert_eq!(text_body(response), "Error: denied\n");
}

#[test]
fn project_lifecycle_text_routes_resolve_project_and_render_text() {
    let mut runtime = FakeSystemRuntime::default();

    let serve = route_system_text_request(
        &mut runtime,
        "POST",
        &format!("{}?project=.", CORE_API_ROUTES.project_serve_text),
        None,
    )
    .expect("project serve");
    assert_eq!(
        text_body(serve),
        "aimux serve: daemon managing /repo (service pid 9200)\n"
    );

    let stop = route_system_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.project_stop_text,
        Some(&json!({ "project": "abc" })),
    )
    .expect("project stop");
    assert_eq!(text_body(stop), "Stopped project service pid 9200\n");

    let kill = route_system_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.project_kill_text,
        Some(&json!({ "project": "abc" })),
    )
    .expect("project kill");
    assert_eq!(text_body(kill), "Killed project service pid 9200\n");

    assert_eq!(
        runtime.calls,
        [
            "ensure:/repo",
            "stop:/resolved/abc:false",
            "stop:/resolved/abc:true"
        ]
    );
}

#[test]
fn project_restart_preserves_serve_and_open_focus_rules() {
    let mut runtime = FakeSystemRuntime::default();
    let response = route_system_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&open=1&currentClientSession=origin-client-deadbeef&clientTty=%2Fdev%2Fttys001",
            CORE_API_ROUTES.project_restart_text
        ),
        None,
    )
    .expect("project restart");
    assert_eq!(
        text_body(response),
        "Restarted project service for aimux-repo\n"
    );
    assert_eq!(
        runtime.open_focus,
        Some(OpenFocusRequest {
            current_client_session: Some("origin-client-deadbeef".into()),
            client_tty: Some("/dev/ttys001".into()),
        })
    );

    let serve_only = route_system_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&serve=1&open=1",
            CORE_API_ROUTES.project_restart_text
        ),
        None,
    )
    .expect("project restart serve only");
    assert_eq!(
        text_body(serve_only),
        "Restarted project service for /repo\n"
    );
    assert_eq!(runtime.open_focus, None);
    assert_eq!(runtime.calls, ["restart:/repo:false", "restart:/repo:true"]);
}

#[test]
fn project_text_routes_validate_required_project_like_daemon() {
    let mut runtime = FakeSystemRuntime::default();
    let response = route_system_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.project_serve_text,
        Some(&json!({ "project": " " })),
    )
    .expect("project serve");
    assert_eq!(response.status, 400);
    assert_eq!(text_body(response), "project is required\n");

    let route_url = aimux::daemon::routing::DaemonRouteUrl::parse("/route?project=.");
    assert_eq!(
        project_root_text_param(&runtime, &route_url, None).unwrap(),
        "/repo"
    );
}

#[test]
fn unrelated_routes_are_left_for_other_text_modules() {
    let mut runtime = FakeSystemRuntime::default();
    assert!(
        route_system_text_request(&mut runtime, "GET", CORE_API_ROUTES.task_list_text, None)
            .is_none()
    );
}
