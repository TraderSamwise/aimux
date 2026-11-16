use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::jobs::DaemonJobRouteRuntime;
use aimux::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, PROXY_MAX_BINARY_BYTES, PROXY_TIMEOUT_MS,
    ProxyBinaryResponse, ProxyJsonResponse, resolve_project_event_stream,
    route_json_daemon_request,
};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState};
use aimux::jobs::{JobCancelReport, JobRecord, JobSpec, JobStatus, JobStore, JobStoreError};
use aimux::notification_delivery_guard::{
    TEST_NOTIFICATION_SOURCE_FIELD, TEST_NOTIFICATION_SOURCE_VALUE,
};
use aimux::paths::PathResolver;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct FakeJsonRuntime {
    credentials: bool,
    relay: Value,
    binary: ProxyBinaryResponse,
    proxy_error: Option<String>,
    calls: Vec<String>,
    projects: Vec<ProjectsRouteProject>,
    projects_error: Option<String>,
    /// Recorded SEPARATELY from `calls`, which many tests assert on exactly.
    /// The headers are the whole point of the peer input route -- it is the
    /// one place a stamp is minted rather than forwarded -- so they need
    /// asserting, and widening the call strings would have rewritten every
    /// other expectation in this file.
    proxy_json_headers: Vec<BTreeMap<String, String>>,
}

impl Default for FakeJsonRuntime {
    fn default() -> Self {
        Self {
            credentials: true,
            relay: json!({ "status": "connected" }),
            binary: ProxyBinaryResponse {
                status: 200,
                body: vec![137, 80, 78, 71],
                content_type: Some("image/png".into()),
            },
            proxy_error: None,
            calls: Vec::new(),
            projects: Vec::new(),
            projects_error: None,
            proxy_json_headers: Vec::new(),
        }
    }
}

impl DaemonStatusRuntime for FakeJsonRuntime {
    fn current_daemon_info(&self, _issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 1,
            port: 43190,
            started_at: "then".into(),
            updated_at: "now".into(),
        }
    }

    fn project_service_info(&self) -> Value {
        json!({})
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        self.projects.clone()
    }

    fn try_list_projects_for_route(&self) -> Result<Vec<ProjectsRouteProject>, String> {
        match &self.projects_error {
            Some(error) => Err(error.clone()),
            None => Ok(self.projects.clone()),
        }
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: None,
            projects: Map::new(),
        }
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }
}

impl DaemonCoreCommandRuntime for FakeJsonRuntime {
    fn next_core_command_id(&self) -> String {
        "id".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(json!({ "projectRoot": project_root, "pid": 10 }))
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.calls.push(format!("stop:{project_root}:{force}"));
        Ok(json!({ "projectRoot": project_root }))
    }

    fn restart_project_service(
        &mut self,
        _project_root: &str,
        _serve_only: bool,
    ) -> Result<Value, String> {
        Ok(json!({}))
    }

    fn overseer_watch(
        &mut self,
        _project_root: &str,
        _session_id: &str,
        _overseer_session_id: Option<&str>,
        _goal: Option<&str>,
        _instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        Ok(json!({}))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        Ok(json!({}))
    }

    fn has_remote_credentials(&self) -> bool {
        self.credentials
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        self.calls.push("relay-enable".into());
        self.relay.clone()
    }

    fn disable_relay(&mut self) -> Value {
        self.calls.push("relay-disable".into());
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        relay
            .get("lastError")
            .and_then(Value::as_str)
            .unwrap_or("auth failed")
            .into()
    }
}

impl DaemonJsonRouteRuntime for FakeJsonRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value {
        self.calls.push(format!("push:{payload}"));
        json!({ "ok": true, "pushed": true })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true, "pid": 1, "budget": { "ok": true } })
    }

    fn expose_items(&mut self, path: &str) -> Result<Value, String> {
        self.calls.push(format!("expose-items:{path}"));
        Ok(json!({ "ok": true, "items": [] }))
    }

    fn expose_focus(&mut self, request: ExposeFocusRequest) -> Result<Value, String> {
        self.calls.push(format!(
            "expose-focus:{}:{:?}:{:?}:{:?}",
            request.window_id,
            request.project_root,
            request.current_client_session,
            request.client_tty
        ));
        Ok(json!({ "ok": true, "action": "expose-focus", "itemId": "item-1" }))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        self.proxy_json_headers.push(headers.clone());
        self.calls
            .push(format!("json:{method}:{target_url}:{timeout_ms}:{body:?}"));
        if let Some(error) = &self.proxy_error {
            return Err(error.clone());
        }
        Ok(ProxyJsonResponse {
            status: 202,
            json: json!({ "ok": true, "target": target_url }),
        })
    }

    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String> {
        self.calls.push(format!(
            "binary:{method}:{target_url}:{timeout_ms}:{max_bytes}"
        ));
        if let Some(error) = &self.proxy_error {
            return Err(error.clone());
        }
        Ok(self.binary.clone())
    }
}

impl DaemonJobRouteRuntime for FakeJsonRuntime {
    fn job_store(&self) -> JobStore {
        JobStore::new(
            std::env::temp_dir().join(format!("aimux-daemon-json-jobs-{}", std::process::id())),
        )
    }

    fn job_path_resolver(&self) -> PathResolver {
        let root =
            std::env::temp_dir().join(format!("aimux-daemon-json-paths-{}", std::process::id()));
        PathResolver::new(&root, root.join("home"), None)
    }

    fn start_created_job(
        &mut self,
        _store: &JobStore,
        record: JobRecord,
        _spec: &JobSpec,
    ) -> Result<JobRecord, JobStoreError> {
        Ok(record)
    }

    fn cancel_running_job(
        &mut self,
        store: &JobStore,
        record: &JobRecord,
    ) -> Result<JobCancelReport, JobStoreError> {
        store.finish(
            &record.id,
            JobStatus::Cancelled,
            None,
            "cancelled by SIGTERM",
            Some("SIGTERM".to_owned()),
        )?;
        Ok(JobCancelReport {
            signal: "SIGTERM".to_owned(),
            pid: None,
        })
    }
}

fn served_project(path: &str, port: u64, live: bool) -> ProjectsRouteProject {
    ProjectsRouteProject {
        id: path.replace('/', "-"),
        name: path.into(),
        path: path.into(),
        last_seen: None,
        dashboard_session_name: "aimux-test".into(),
        service: None,
        service_alive: live,
        dashboard_alive: None,
        service_endpoint: Some(json!({ "host": "127.0.0.1", "port": port })),
        online_agent_count: None,
    }
}

fn peer_input_headers() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("x-aimux-actor-role".to_owned(), "peer".to_owned()),
        ("x-aimux-peer-machine-id".to_owned(), "mbp".to_owned()),
        // The noise a real request carries, none of which may cross.
        ("host".to_owned(), "127.0.0.1:43190".to_owned()),
        ("content-length".to_owned(), "64".to_owned()),
        ("x-aimux-share-id".to_owned(), "share-1".to_owned()),
    ])
}

/// The peer input route mints the stamp it forwards; it never passes one on.
///
/// This is the whole reason the route exists in this shape. The relay strips a
/// client's `x-aimux-*` before stamping its own, and nothing strips them from a
/// request that arrived on loopback -- so forwarding the incoming map would
/// hand the project service whatever a local caller wrote. Exactly four
/// headers cross, and the two that matter come from `parse_remote_actor`.
#[test]
fn peer_agent_input_forwards_a_minted_stamp_and_nothing_else() {
    let mut runtime = FakeJsonRuntime {
        projects: vec![served_project("/repo", 43210, true)],
        ..Default::default()
    };

    let response = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/peer/agents/input",
        Some(&json!({
            "project": "/repo",
            "sessionId": "codex-1",
            "text": "look at the shard numbers",
            "from": "claude-utymep",
            "task": "task-1"
        })),
        &peer_input_headers(),
        true,
    )
    .expect("the peer input route answered");

    assert_eq!(response.status, 202);
    assert_eq!(
        runtime.calls,
        vec![format!(
            "json:POST:http://127.0.0.1:43210/agents/input:{PROXY_TIMEOUT_MS}:{:?}",
            Some(json!({
                "sessionId": "codex-1",
                "text": "look at the shard numbers",
                "from": "claude-utymep",
                "task": "task-1"
            }))
        )],
        "the project supplies the address, and the body is rebuilt"
    );
    assert_eq!(
        runtime.proxy_json_headers,
        vec![BTreeMap::from([
            ("accept".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
            ("x-aimux-actor-role".to_owned(), "peer".to_owned()),
            ("x-aimux-peer-machine-id".to_owned(), "mbp".to_owned()),
        ])],
        "only four headers may cross, and `host`/`content-length`/`x-aimux-share-id` are not among them"
    );
}

/// This door is peer-only, and that is a REFUSAL rather than a quiet
/// downgrade.
///
/// The access decision does not establish that the caller is a peer: an owner
/// is allowed unconditionally and a caller with no actor is allowed
/// unconditionally. Both reached the handler, which rebuilds the body -- so
/// the owner's own app, posting `sharedChatActor`, had it dropped and its text
/// delivered with no author at all, where the same request through the proxy
/// door is labelled. Two routes to one pane, disagreeing about who spoke.
#[test]
fn peer_agent_input_is_refused_to_everyone_who_is_not_a_stamped_peer() {
    for headers in [
        // Nobody.
        BTreeMap::new(),
        // The owner's own app, which the access decision allows outright.
        BTreeMap::from([("x-aimux-actor-role".to_owned(), "owner".to_owned())]),
        // A role with no machine, and a machine that is not an id: neither is
        // evidence of a peer.
        BTreeMap::from([("x-aimux-actor-role".to_owned(), "peer".to_owned())]),
        BTreeMap::from([
            ("x-aimux-actor-role".to_owned(), "peer".to_owned()),
            ("x-aimux-peer-machine-id".to_owned(), "Mbp".to_owned()),
        ]),
        BTreeMap::from([
            ("x-aimux-actor-role".to_owned(), "peer".to_owned()),
            (
                "x-aimux-peer-machine-id".to_owned(),
                "unidentified".to_owned(),
            ),
        ]),
    ] {
        let mut runtime = FakeJsonRuntime {
            projects: vec![served_project("/repo", 43210, true)],
            ..Default::default()
        };
        let refused = route_json_daemon_request(
            &mut runtime,
            "POST",
            "/peer/agents/input",
            Some(&json!({
                "project": "/repo",
                "sessionId": "codex-1",
                "text": "hi",
                "sharedChatActor": { "role": "owner", "displayName": "Sam" }
            })),
            &headers,
            true,
        )
        .expect("answered");
        assert_eq!(refused.status, 403, "{headers:?}");
        assert_eq!(
            json_body(refused)["error"],
            "this route is for a peer machine, and this request is not from one",
            "{headers:?}"
        );
        assert!(
            runtime.calls.is_empty(),
            "{headers:?} must not reach the project service: {:?}",
            runtime.calls
        );
    }
}

/// This machine supplies the address, so it answers for the cases where it has
/// none -- each as its own outcome rather than as a 404.
#[test]
fn peer_agent_input_says_which_thing_it_could_not_find() {
    // A project this daemon does not run.
    let mut runtime = FakeJsonRuntime {
        projects: vec![served_project("/repo", 43210, true)],
        ..Default::default()
    };
    let stranger = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/peer/agents/input",
        Some(&json!({ "project": "/elsewhere", "sessionId": "codex-1", "text": "hi" })),
        &peer_input_headers(),
        true,
    )
    .expect("answered");
    assert_eq!(stranger.status, 503);
    assert!(runtime.calls.is_empty(), "{:?}", runtime.calls);

    // A project it runs but is not serving.
    let mut runtime = FakeJsonRuntime {
        projects: vec![served_project("/repo", 43210, false)],
        ..Default::default()
    };
    let not_serving = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/peer/agents/input",
        Some(&json!({ "project": "/repo", "sessionId": "codex-1", "text": "hi" })),
        &peer_input_headers(),
        true,
    )
    .expect("answered");
    assert_eq!(not_serving.status, 503);
    assert!(runtime.calls.is_empty(), "{:?}", runtime.calls);

    // A listing that FAILED is not a listing that is empty.
    let mut runtime = FakeJsonRuntime {
        projects: vec![served_project("/repo", 43210, true)],
        projects_error: Some("registry unreadable".into()),
        ..Default::default()
    };
    let unreadable = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/peer/agents/input",
        Some(&json!({ "project": "/repo", "sessionId": "codex-1", "text": "hi" })),
        &peer_input_headers(),
        true,
    )
    .expect("answered");
    assert_eq!(
        unreadable.status, 500,
        "could-not-ask must not read as is-not-there"
    );
    assert!(runtime.calls.is_empty(), "{:?}", runtime.calls);

    // And the two required fields.
    for body in [
        json!({ "sessionId": "codex-1", "text": "hi" }),
        json!({ "project": "   ", "sessionId": "codex-1", "text": "hi" }),
        json!({ "project": "/repo", "text": "hi" }),
        json!({ "project": "/repo", "sessionId": "  ", "text": "hi" }),
    ] {
        let mut runtime = FakeJsonRuntime {
            projects: vec![served_project("/repo", 43210, true)],
            ..Default::default()
        };
        let refused = route_json_daemon_request(
            &mut runtime,
            "POST",
            "/peer/agents/input",
            Some(&body),
            &peer_input_headers(),
            true,
        )
        .expect("answered");
        assert_eq!(refused.status, 400, "{body:?}");
        assert!(runtime.calls.is_empty(), "{body:?}: {:?}", runtime.calls);
    }
}

/// A trailing slash is one checkout, because the relay's own key folds exactly
/// that much -- so a lookup that folded differently would miss the project the
/// owner record names.
#[test]
fn peer_agent_input_folds_a_project_root_the_way_the_relay_does() {
    // Two roots differing only PAST the cap, which the relay keys identically.
    // This proves the truncation happens -- without it the two keys differ and
    // the lookup refuses a project the owner record names.
    let prefix = format!("/{}/", "a".repeat(598));
    let long_served = format!("{prefix}xxx");
    let long_named = format!("{prefix}yyy");
    // And the case that proves the ORDER, which the pair above cannot: both of
    // those go through this same function, so swapping truncate and fold moves
    // both keys together and they still match.
    //
    // This one is CROSS-SIDE. The served root is a real local path whose six
    // hundredth character is a slash; the named root is the relay's own
    // already-folded key for it, five hundred and ninety nine characters with
    // the slash gone. Truncate-then-fold makes them equal. Fold-then-truncate
    // leaves the served one ending in the slash and they never match -- which
    // is the unmatchable root the relay's own comment warns about.
    let order_served = format!("/{}/xxx", "a".repeat(598));
    let order_named = format!("/{}", "a".repeat(598));
    for (served, named) in [
        ("/repo", "/repo/"),
        ("/repo/", "/repo"),
        ("/repo", "/repo"),
        // EVERY trailing slash, not one: the relay strips the lot, so one
        // stripped here keyed `/repo//` as `/repo/` and missed the project.
        ("/repo", "/repo//"),
        ("/repo//", "/repo"),
        ("/repo///", "/repo//"),
        // Whitespace, which the relay trims first.
        ("/repo", "  /repo/  "),
        // And past the cap, where the relay keys the truncated prefix. Both
        // sides must truncate before folding or a root whose last kept
        // character is a slash becomes unmatchable.
        (long_served.as_str(), long_named.as_str()),
        (order_served.as_str(), order_named.as_str()),
        // A root that is nothing but slashes keeps them rather than folding to
        // the empty key, which would match every other such root. The relay's
        // `|| stored` is this case.
        ("///", "///"),
        ("/", "/"),
    ] {
        let mut runtime = FakeJsonRuntime {
            projects: vec![served_project(served, 43210, true)],
            ..Default::default()
        };
        let response = route_json_daemon_request(
            &mut runtime,
            "POST",
            "/peer/agents/input",
            Some(&json!({ "project": named, "sessionId": "codex-1", "text": "hi" })),
            &peer_input_headers(),
            true,
        )
        .expect("answered");
        assert_eq!(response.status, 202, "{served} served, {named} named");
        assert_eq!(runtime.calls.len(), 1, "{served} served, {named} named");
    }
}

#[test]
fn fake_json_runtime_jobs_store_is_sandboxed() {
    let runtime = FakeJsonRuntime::default();
    assert!(runtime.job_store().root().starts_with(std::env::temp_dir()));
}

fn json_body(response: DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected json, got {other:?}"),
    }
}

fn bytes_body(response: DaemonRouteResponse) -> Vec<u8> {
    match response.body {
        DaemonResponseBody::Bytes(value) => value,
        other => panic!("expected bytes, got {other:?}"),
    }
}

#[test]
fn relay_json_routes_match_daemon_contract() {
    let mut runtime = FakeJsonRuntime::default();

    let status = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/relay/status",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay status");
    assert_eq!(
        json_body(status),
        json!({ "ok": true, "relay": { "status": "off" } })
    );

    let enable = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay enable");
    assert_eq!(json_body(enable)["relay"]["status"], "connected");

    let disable = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/relay/disable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay disable");
    assert_eq!(
        json_body(disable),
        json!({ "ok": true, "relay": { "status": "off" } })
    );
}

#[test]
fn relay_enable_preserves_missing_credentials_and_auth_failed_shapes() {
    let mut missing = FakeJsonRuntime {
        credentials: false,
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut missing,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("missing creds");
    assert_eq!(response.status, 401);
    assert_eq!(
        json_body(response)["error"],
        "Not logged in. Run `aimux login` first."
    );

    let mut failed = FakeJsonRuntime {
        relay: json!({ "status": "auth_failed", "lastError": "bad token" }),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut failed,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("auth failed");
    assert_eq!(response.status, 401);
    assert_eq!(
        json_body(response),
        json!({ "ok": false, "error": "bad token", "relay": { "status": "auth_failed", "lastError": "bad token" } })
    );
}

#[test]
fn internal_push_and_diagnostics_are_loopback_only() {
    let mut runtime = FakeJsonRuntime::default();
    let blocked = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({ "title": "hello" })),
        &BTreeMap::new(),
        true,
    )
    .expect("internal push");
    assert_eq!(blocked.status, 403);

    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("internal push");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "title is required");

    let truthy_non_string = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({ "title": ["allowed like JS"] })),
        &BTreeMap::new(),
        false,
    )
    .expect("internal push");
    assert_eq!(truthy_non_string.status, 200);
    let calls_before_test_push = runtime.calls.len();

    let test_push = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({
            "title": "test alert",
            TEST_NOTIFICATION_SOURCE_FIELD: TEST_NOTIFICATION_SOURCE_VALUE
        })),
        &BTreeMap::new(),
        false,
    )
    .expect("internal push");
    assert_eq!(
        json_body(test_push),
        json!({ "ok": true, "suppressed": true, "reason": "cargo test harness" })
    );
    assert_eq!(runtime.calls.len(), calls_before_test_push);

    let diagnostics = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/diagnostics/loop",
        None,
        &BTreeMap::new(),
        true,
    )
    .expect("diagnostics");
    assert_eq!(diagnostics.status, 403);
}

#[test]
fn expose_focus_validates_body_before_runtime_focus() {
    let mut runtime = FakeJsonRuntime::default();
    let bad = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({ "windowId": 7 })),
        &BTreeMap::new(),
        false,
    )
    .expect("bad focus");
    assert_eq!(bad.status, 400);
    assert_eq!(json_body(bad)["error"], "windowId must be a string");

    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("missing focus");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "windowId is required");

    let ok = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({ "windowId": "  @1  ", "projectRoot": " /repo ", "currentClientSession": " ", "clientTty": " /dev/ttys001 " })),
        &BTreeMap::new(),
        false,
    )
    .expect("focus");
    assert_eq!(json_body(ok)["action"], "expose-focus");
    assert_eq!(
        runtime.calls.last().unwrap(),
        "expose-focus:@1:Some(\"/repo\"):None:Some(\"/dev/ttys001\")"
    );
}

#[test]
fn project_mutation_json_routes_require_project_root() {
    let mut runtime = FakeJsonRuntime::default();
    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/projects/ensure",
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("ensure");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "projectRoot is required");

    let ok = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/projects/ensure",
        Some(&json!({ "projectRoot": "/repo" })),
        &BTreeMap::new(),
        false,
    )
    .expect("ensure");
    assert_eq!(json_body(ok)["project"]["projectRoot"], "/repo");
}

#[test]
fn proxy_json_preserves_raw_query_and_timeout_contract() {
    let mut runtime = FakeJsonRuntime::default();
    let response = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1&text=a%20b",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 202);
    assert_eq!(
        json_body(response)["target"],
        "http://127.0.0.1:4321/agents/output?sessionId=claude-1&text=a%20b"
    );
    assert!(runtime.calls[0].contains(&format!(":{PROXY_TIMEOUT_MS}:")));
}

#[test]
fn proxy_rejects_non_loopback_hosts_before_transport() {
    let mut runtime = FakeJsonRuntime::default();
    let response = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/evil.example.com/4321/state",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 403);
    assert_eq!(json_body(response)["error"], "proxy host not allowed");
    assert!(runtime.calls.is_empty());
}

#[test]
fn proxy_attachment_content_as_bytes_or_json_error() {
    let mut runtime = FakeJsonRuntime::default();
    let image = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_abc/content?sessionId=claude-1",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("image proxy");
    assert_eq!(image.status, 200);
    assert_eq!(image.content_type.as_deref(), Some("image/png"));
    assert_eq!(bytes_body(image), vec![137, 80, 78, 71]);
    assert!(runtime.calls[0].contains(&format!(":{PROXY_TIMEOUT_MS}:{PROXY_MAX_BINARY_BYTES}")));

    runtime.binary = ProxyBinaryResponse {
        status: 404,
        body: br#"{"ok":false,"error":"attachment not found"}"#.to_vec(),
        content_type: Some("application/json".into()),
    };
    let json_error = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_missing/content?sessionId=claude-1",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("json proxy");
    assert_eq!(json_error.status, 404);
    assert_eq!(json_body(json_error)["error"], "attachment not found");

    runtime.binary = ProxyBinaryResponse {
        status: 204,
        body: Vec::new(),
        content_type: Some("application/json".into()),
    };
    let empty = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_empty/content",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("empty json proxy");
    assert_eq!(empty.status, 204);
    assert_eq!(json_body(empty), Value::Null);
}

#[test]
fn proxy_errors_map_timeout_to_504_and_other_errors_to_502() {
    let mut timeout = FakeJsonRuntime {
        proxy_error: Some("request timed out after 10000ms".into()),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut timeout,
        "GET",
        "/proxy/127.0.0.1/4321/slow",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 504);

    let mut failed = FakeJsonRuntime {
        proxy_error: Some("connection refused".into()),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut failed,
        "GET",
        "/proxy/127.0.0.1/4321/state",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 502);
}

#[test]
fn project_event_stream_resolution_preserves_headers_and_rejects_non_event_routes() {
    let headers = BTreeMap::from([("x-aimux-actor-role".into(), "guest".into())]);
    let resolved =
        resolve_project_event_stream("/proxy/127.0.0.1/4321/events?sessionId=claude-1", &headers)
            .expect("stream");
    assert_eq!(
        resolved.url,
        "http://127.0.0.1:4321/events?sessionId=claude-1"
    );
    assert_eq!(resolved.headers, headers);

    let output = resolve_project_event_stream(
        "/proxy/127.0.0.1/4321/agents/output/stream?sessionId=claude-1",
        &BTreeMap::new(),
    )
    .expect("output stream");
    assert_eq!(
        output.url,
        "http://127.0.0.1:4321/agents/output/stream?sessionId=claude-1"
    );

    let interaction = resolve_project_event_stream(
        "/proxy/127.0.0.1/4321/agents/interaction/stream",
        &BTreeMap::new(),
    )
    .expect("interaction stream");
    assert_eq!(
        interaction.url,
        "http://127.0.0.1:4321/agents/interaction/stream"
    );

    let missing = resolve_project_event_stream("/health", &BTreeMap::new()).unwrap_err();
    assert_eq!(missing.status, 404);

    let wrong_route =
        resolve_project_event_stream("/proxy/127.0.0.1/4321/state", &BTreeMap::new()).unwrap_err();
    assert_eq!(wrong_route.status, 403);
}
