use aimux::daemon::access::{
    build_daemon_route_context, build_hosted_daemon_route_context,
    resolve_authorized_project_event_stream, resolve_hosted_operator_stream,
};
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::request_actor::{
    RemoteAccessDecision, RemoteActor, RemoteActorRole, RemoteOperatorGrant,
    RemoteOperatorPrincipal,
};
use serde_json::json;
use std::collections::BTreeMap;

fn project(path: &str, port: u64, live: bool) -> ProjectsRouteProject {
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

fn operator(project_root: &str, session_id: &str) -> RemoteActor {
    RemoteActor {
        role: RemoteActorRole::Operator,
        declared_role: Some("operator".into()),
        user_id: None,
        display_name: None,
        email: None,
        share_id: None,
        share_session_id: None,
        peer_machine_id: None,
        principal: Some(RemoteOperatorPrincipal {
            id: "prn_1".into(),
            label: "one".into(),
            role: "operator".into(),
            revoked_at: None,
            grants: vec![RemoteOperatorGrant {
                project_root: project_root.into(),
                session_id: session_id.into(),
            }],
        }),
    }
}

fn decision(context: &aimux::daemon::router::DaemonRouteRequestContext) -> &RemoteAccessDecision {
    context.access_decision.as_ref().expect("access decision")
}

fn peer_headers(machine: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("x-aimux-actor-role".to_owned(), "peer".to_owned()),
        ("x-aimux-peer-machine-id".to_owned(), machine.to_owned()),
    ])
}

/// The project door's binding is resolved from the BODY, through the real
/// context builder.
///
/// Asserted here and not only on the allowlist, because an allowlist test
/// hands `project_root` in ready-made -- so deleting the resolution in
/// `build_daemon_route_context` left every allowlist test green while the
/// route refused every real request. The resolution and the rule that reads it
/// are two halves, and this is the half that was untested.
#[test]
fn a_peer_naming_a_project_is_bound_from_the_body_against_this_daemons_projects() {
    let projects = [project("/repo", 43210, true)];
    let decided = |body: serde_json::Value, projects: &[ProjectsRouteProject]| {
        build_daemon_route_context(
            "POST",
            "/peer/agents/input",
            Some(&body),
            peer_headers("mbp"),
            projects,
        )
        .access_decision
        .expect("a peer always gets a decision")
    };

    // A project this daemon serves: bound, so the route is allowed.
    let allowed = decided(
        json!({ "project": "/repo", "sessionId": "codex-1", "text": "hi" }),
        &projects,
    );
    assert!(allowed.ok, "{:?}", allowed.error);

    // The same request against a daemon that serves nothing. Nothing about
    // the request changed, so the projects slice is the only thing deciding.
    let unbound = decided(
        json!({ "project": "/repo", "sessionId": "codex-1", "text": "hi" }),
        &[],
    );
    assert!(!unbound.ok);
    assert_eq!(
        unbound.error.as_deref(),
        Some("peer machine mbp named a project this machine is not serving")
    );

    // A project it knows but is not serving, and a project it does not know.
    for projects in [
        vec![project("/repo", 43210, false)],
        vec![project("/elsewhere", 43210, true)],
    ] {
        let refused = decided(
            json!({ "project": "/repo", "sessionId": "codex-1", "text": "hi" }),
            &projects,
        );
        assert!(!refused.ok, "{projects:?}");
    }

    // No project named at all is not bound either.
    let nameless = decided(json!({ "sessionId": "codex-1", "text": "hi" }), &projects);
    assert!(!nameless.ok);
}

#[test]
fn local_context_allows_without_actor() {
    let context = build_daemon_route_context("GET", "/health", None, BTreeMap::new(), &[]);
    assert!(!context.actor_present);
    assert!(decision(&context).ok);
}

#[test]
fn owner_headers_are_allowed_but_still_mark_actor_present_for_loopback_guards() {
    let context = build_daemon_route_context(
        "GET",
        "/health",
        None,
        BTreeMap::from([("x-aimux-actor-role".into(), "owner".into())]),
        &[],
    );
    assert!(context.actor_present);
    assert!(decision(&context).ok);
}

#[test]
fn shared_guest_context_allows_only_its_shared_session() {
    let headers = BTreeMap::from([
        ("x-aimux-actor-role".into(), "guest".into()),
        ("x-aimux-share-id".into(), "share-1".into()),
        ("x-aimux-share-session-id".into(), "claude-1".into()),
    ]);
    let allowed = build_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        headers.clone(),
        &[],
    );
    assert!(allowed.actor_present);
    assert!(decision(&allowed).ok);

    let denied = build_daemon_route_context(
        "POST",
        "/projects/ensure",
        Some(&json!({ "projectRoot": "/repo" })),
        headers,
        &[],
    );
    assert!(!decision(&denied).ok);
    assert_eq!(
        decision(&denied).error.as_deref(),
        Some("shared guests cannot access daemon routes")
    );
}

#[test]
fn forged_operator_header_degrades_to_guest_before_access() {
    let context = build_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        BTreeMap::from([("x-aimux-actor-role".into(), "operator".into())]),
        &[],
    );
    assert!(context.actor_present);
    assert!(!decision(&context).ok);
    assert_eq!(
        decision(&context).error.as_deref(),
        Some("shared guest route requires an authorized share session")
    );
}

#[test]
fn operator_project_binding_uses_live_unique_service_endpoint() {
    let forged = build_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        BTreeMap::from([(
            "x-aimux-actor".into(),
            json!({
                "role": "operator",
                "principal": {
                    "id": "prn_1",
                    "label": "one",
                    "role": "operator",
                    "revokedAt": null,
                    "grants": [{ "projectRoot": "/repo", "sessionId": "claude-1" }]
                }
            })
            .to_string(),
        )]),
        &[project("/repo", 4321, true)],
    );
    assert!(!decision(&forged).ok);

    let hosted = build_hosted_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        &operator("/repo", "claude-1"),
        &[project("/repo", 4321, true)],
    );
    assert!(hosted.actor_present);
    assert!(hosted.headers.is_empty());
    assert!(decision(&hosted).ok);
}

#[test]
fn ambiguous_or_dead_project_binding_denies_operator_access() {
    let actor = operator("/repo", "claude-1");
    let dead = build_hosted_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        &actor,
        &[project("/repo", 4321, false)],
    );
    assert!(!decision(&dead).ok);
    assert_eq!(
        decision(&dead).error.as_deref(),
        Some("operator request could not be bound to a project")
    );

    let ambiguous = build_hosted_daemon_route_context(
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
        None,
        &actor,
        &[
            project("/repo-a", 4321, true),
            project("/repo-b", 4321, true),
        ],
    );
    assert!(!decision(&ambiguous).ok);
}

#[test]
fn authorized_event_stream_keeps_relay_headers_and_checks_guest_scope() {
    let headers = BTreeMap::from([
        ("x-aimux-actor-role".into(), "guest".into()),
        ("x-aimux-share-id".into(), "share-1".into()),
        ("x-aimux-share-session-id".into(), "claude-1".into()),
    ]);
    let resolved = resolve_authorized_project_event_stream(
        "/proxy/127.0.0.1/4321/events?sessionId=claude-1",
        &headers,
    )
    .expect("stream");
    assert_eq!(
        resolved.url,
        "http://127.0.0.1:4321/events?sessionId=claude-1"
    );
    assert_eq!(resolved.headers, headers);

    let denied = resolve_authorized_project_event_stream(
        "/proxy/127.0.0.1/4321/events?sessionId=other",
        &BTreeMap::from([
            ("x-aimux-actor-role".into(), "guest".into()),
            ("x-aimux-share-session-id".into(), "claude-1".into()),
        ]),
    )
    .unwrap_err();
    assert_eq!(denied.status, 403);
}

#[test]
fn hosted_operator_stream_is_bound_and_stream_only() {
    let actor = operator("/repo", "claude-1");
    let projects = [project("/repo", 4321, true)];
    let target = resolve_hosted_operator_stream(
        &actor,
        "GET",
        "/proxy/127.0.0.1/4321/agents/output/stream?sessionId=claude-1",
        &projects,
    )
    .expect("operator stream");
    assert_eq!(
        target.url,
        "http://127.0.0.1:4321/agents/output/stream?sessionId=claude-1"
    );
    assert_eq!(target.project_root, "/repo");

    let events = resolve_hosted_operator_stream(
        &actor,
        "GET",
        "/proxy/127.0.0.1/4321/events?sessionId=claude-1",
        &projects,
    )
    .unwrap_err();
    assert_eq!(
        events.error.as_deref(),
        Some("route is not available to operators")
    );

    let unbound = resolve_hosted_operator_stream(
        &actor,
        "GET",
        "/proxy/127.0.0.1/9999/agents/output/stream?sessionId=claude-1",
        &projects,
    )
    .unwrap_err();
    assert_eq!(
        unbound.error.as_deref(),
        Some("operator request could not be bound to a project")
    );
}

// An approved client reaching the daemon over the relay was refused as a shared
// guest and the GUI rendered that as "no projects". The relay is the only place
// that knows who the caller is, so a request it did not identify must say so
// rather than accuse the caller of being a guest.
#[test]
fn a_relay_request_with_no_actor_role_is_named_as_unidentified() {
    let unidentified = build_daemon_route_context(
        "GET",
        "/projects",
        None,
        BTreeMap::from([("x-aimux-relay-forwarded".into(), "1".into())]),
        &[],
    );
    assert!(!decision(&unidentified).ok);
    assert_eq!(
        decision(&unidentified).error.as_deref(),
        Some("relay request carried no actor role, so the caller could not be identified")
    );

    let unrecognized = build_daemon_route_context(
        "GET",
        "/projects",
        None,
        BTreeMap::from([
            ("x-aimux-relay-forwarded".into(), "1".into()),
            ("x-aimux-actor-role".into(), "superuser".into()),
        ]),
        &[],
    );
    assert_eq!(
        decision(&unrecognized).error.as_deref(),
        Some("relay request declared an unrecognized actor role: superuser"),
        "an unknown role must not pass silently as a shared guest"
    );

    let declared_guest = build_daemon_route_context(
        "GET",
        "/projects",
        None,
        BTreeMap::from([
            ("x-aimux-relay-forwarded".into(), "1".into()),
            ("x-aimux-actor-role".into(), "guest".into()),
        ]),
        &[],
    );
    assert_eq!(
        decision(&declared_guest).error.as_deref(),
        Some("shared guests cannot access daemon routes"),
        "a caller that declared guest is a guest, not an unidentified one"
    );
}

#[test]
fn an_owner_role_over_the_relay_reaches_daemon_routes() {
    let owner = build_daemon_route_context(
        "GET",
        "/projects",
        None,
        BTreeMap::from([
            ("x-aimux-relay-forwarded".into(), "1".into()),
            ("x-aimux-actor-role".into(), "owner".into()),
        ]),
        &[],
    );
    assert!(
        decision(&owner).ok,
        "the owner's own paired device must reach /projects over the relay"
    );
}
