use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::{DaemonRouteResponse, local_cli_text_routes};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::project_content::{
    DaemonProjectContentTextRuntime, route_project_content_text_request,
};
use serde_json::{Value, json};

struct Runtime {
    result: ProjectServiceJsonResult,
    calls: Vec<(String, String)>,
}

impl DaemonProjectContentTextRuntime for Runtime {
    fn get_project_service_json(&mut self, project: &str, path: &str) -> ProjectServiceJsonResult {
        self.calls.push((project.into(), path.into()));
        self.result.clone()
    }
    fn post_project_service_json(
        &mut self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<u64>,
    ) -> ProjectServiceJsonResult {
        panic!("usage must read shared service state");
    }
}

fn runtime(snapshot: Value) -> Runtime {
    Runtime {
        result: ProjectServiceJsonResult::ok("/other project", snapshot),
        calls: Vec::new(),
    }
}

fn body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(text) => text,
        other => panic!("expected CLI text, got {other:?}"),
    }
}

fn request(runtime: &mut Runtime, suffix: &str) -> DaemonRouteResponse {
    route_project_content_text_request(
        runtime,
        "GET",
        &format!("/core/usage-text?project=%2Fother%20project{suffix}"),
        None,
    )
    .expect("usage route")
}

#[test]
fn usage_cli_renders_server_lines_verbatim_and_preserves_full_json() {
    let snapshot = json!({
        "ok": true, "state": "known",
        "tools": [{"tool": "claude", "windows": []}, {"tool": "codex", "windows": [{"id": "weekly", "state": "absent"}]}],
        "displayLines": ["Claude: 5-hour 17%", "Codex: weekly unknown; 117 billed-equivalent tokens"]
    });
    let mut runtime = runtime(snapshot.clone());
    let text = request(&mut runtime, "");
    assert_eq!(text.status, 200);
    assert_eq!(
        body(text),
        "Claude: 5-hour 17%\nCodex: weekly unknown; 117 billed-equivalent tokens\n"
    );
    let json = request(&mut runtime, "&json=1");
    assert_eq!(json.status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body(json)).expect("usage JSON"),
        snapshot
    );
    assert_eq!(
        runtime.calls,
        vec![("/other project".into(), "/usage".into()); 2]
    );
    assert!(local_cli_text_routes().contains(&"/core/usage-text"));
}

#[test]
fn usage_cli_refresh_only_requests_a_cached_service_refresh() {
    let mut runtime = runtime(
        json!({"ok": true, "state": "absent", "tools": [], "displayLines": ["Usage: unknown; collection pending"]}),
    );
    let response = request(&mut runtime, "&refresh=1");
    assert_eq!(response.status, 200);
    assert_eq!(
        runtime.calls,
        vec![("/other project".into(), "/usage?refresh=1".into())]
    );
    assert!(body(response).contains("unknown; collection pending"));
}

#[test]
fn usage_cli_keeps_collection_errors_visible_in_text_and_json() {
    let snapshot = json!({"ok": true, "state": "error", "tools": [{"tool": "codex", "state": "error", "error": "open rollout: permission denied"}], "displayLines": ["Codex: ERROR open rollout: permission denied"]});
    let mut runtime = runtime(snapshot.clone());
    let text = request(&mut runtime, "");
    assert_eq!(text.status, 200);
    assert_eq!(body(text), "Codex: ERROR open rollout: permission denied\n");
    assert_eq!(
        serde_json::from_str::<Value>(&body(request(&mut runtime, "&json=1")))
            .expect("error snapshot"),
        snapshot
    );

    runtime.result = ProjectServiceJsonResult::ok(
        "/other project",
        json!({"ok": false, "error": "usage cache lock poisoned"}),
    );
    let text = request(&mut runtime, "");
    assert_eq!(text.status, 502);
    assert!(body(text).contains("usage cache lock poisoned"));
    let json = request(&mut runtime, "&json=1");
    assert_eq!(json.status, 502);
    assert_eq!(
        serde_json::from_str::<Value>(&body(json)).expect("failed usage JSON")["error"],
        "usage cache lock poisoned"
    );
}

#[test]
fn usage_cli_never_turns_transport_or_malformed_output_into_an_empty_report() {
    let mut runtime = runtime(json!({"ok": true, "displayLines": []}));
    for lines in [json!([]), json!(["", " "]), json!([null]), Value::Null] {
        runtime.result = ProjectServiceJsonResult::ok(
            "/other project",
            json!({"ok": true, "displayLines": lines}),
        );
        let response = request(&mut runtime, "");
        assert_eq!(response.status, 502);
        assert!(body(response).contains("invalid usage response"));
    }
    runtime.result = ProjectServiceJsonResult::error(DaemonRouteResponse::text(
        503,
        "usage project service request: connection refused\n",
    ));
    let response = request(&mut runtime, "");
    assert_eq!(response.status, 503);
    assert_eq!(
        body(response),
        "usage project service request: connection refused\n"
    );
}
