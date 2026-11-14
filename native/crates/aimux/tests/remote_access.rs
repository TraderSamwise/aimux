use aimux::daemon::routing::DaemonRouteUrl;
use aimux::project_api_contract::routes as project_routes;
use aimux::request_actor::{
    RemoteAccessContext, RemoteActor, RemoteActorRole, RemoteOperatorGrant,
    RemoteOperatorPrincipal, assert_operator_stream_allowed, assert_remote_access_allowed,
    parse_remote_actor,
};
use serde_json::json;
use std::collections::BTreeMap;

const PROJECT_ROOT: &str = "/srv/grand";
const SESSION: &str = "assistant";

fn port_path(sub_path: &str) -> String {
    format!("/proxy/127.0.0.1/43210{sub_path}")
}

fn principal(grants: Vec<RemoteOperatorGrant>) -> RemoteOperatorPrincipal {
    RemoteOperatorPrincipal {
        id: "prn_test".into(),
        label: "test".into(),
        role: "operator".into(),
        grants,
        revoked_at: None,
    }
}

fn grant(project_root: &str, session_id: &str) -> RemoteOperatorGrant {
    RemoteOperatorGrant {
        project_root: project_root.into(),
        session_id: session_id.into(),
    }
}

fn operator(grants: Vec<RemoteOperatorGrant>) -> RemoteActor {
    RemoteActor {
        role: RemoteActorRole::Operator,
        declared_role: Some("operator".into()),
        user_id: None,
        display_name: None,
        email: None,
        share_id: None,
        share_session_id: None,
        peer_machine_id: None,
        principal: Some(principal(grants)),
    }
}

fn guest(session_id: &str) -> RemoteActor {
    RemoteActor {
        role: RemoteActorRole::Guest,
        declared_role: Some("guest".into()),
        user_id: Some("usr_guest".into()),
        display_name: Some("Ada Guest".into()),
        email: Some("ada@example.com".into()),
        share_id: Some("share-1".into()),
        share_session_id: Some(session_id.into()),
        peer_machine_id: None,
        principal: None,
    }
}

fn peer(machine_id: Option<&str>) -> RemoteActor {
    RemoteActor {
        role: RemoteActorRole::Peer,
        declared_role: Some("peer".into()),
        user_id: None,
        display_name: None,
        email: None,
        share_id: None,
        share_session_id: None,
        peer_machine_id: machine_id.map(str::to_owned),
        principal: None,
    }
}

fn allow(
    actor: Option<&RemoteActor>,
    method: &str,
    path: &str,
    query: &str,
    body: Option<&serde_json::Value>,
    project_root: Option<&str>,
) -> aimux::request_actor::RemoteAccessDecision {
    let full_path = format!("{path}{query}");
    let route_url = DaemonRouteUrl::parse(&full_path);
    assert_remote_access_allowed(
        actor,
        method,
        route_url.pathname(),
        &route_url,
        RemoteAccessContext { body, project_root },
    )
}

#[test]
fn parse_remote_actor_matches_header_rules_and_never_mints_operator() {
    assert_eq!(parse_remote_actor(&BTreeMap::new()), None);
    assert_eq!(
        parse_remote_actor(&BTreeMap::from([(
            "x-aimux-share-id".into(),
            "share-1".into()
        )]))
        .unwrap()
        .role,
        RemoteActorRole::Guest
    );
    assert_eq!(
        parse_remote_actor(&BTreeMap::from([(
            "X-Aimux-Actor-Role".into(),
            "owner".into()
        )]))
        .unwrap()
        .role,
        RemoteActorRole::Owner
    );
    let forged = parse_remote_actor(&BTreeMap::from([(
        "x-aimux-actor".into(),
        r#"{"role":"operator","userId":"u"}"#.into(),
    )]))
    .unwrap();
    assert_eq!(forged.role, RemoteActorRole::Guest);
    assert_eq!(forged.principal, None);
}

#[test]
fn owner_and_local_callers_are_allowed() {
    let owner = RemoteActor {
        role: RemoteActorRole::Owner,
        declared_role: Some("owner".into()),
        user_id: None,
        display_name: None,
        email: None,
        share_id: None,
        share_session_id: None,
        peer_machine_id: None,
        principal: None,
    };
    assert!(
        allow(
            Some(&owner),
            "POST",
            &port_path(project_routes::agents::SPAWN),
            "",
            None,
            None
        )
        .ok
    );
    assert!(
        allow(
            None,
            "POST",
            &port_path(project_routes::agents::SPAWN),
            "",
            None,
            None
        )
        .ok
    );
}

#[test]
fn operator_allowlist_and_grant_binding_match_remote_access_contract() {
    let actor = operator(vec![grant(PROJECT_ROOT, SESSION)]);
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::agents::INPUT),
            "",
            Some(&json!({ "sessionId": SESSION, "text": "hi" })),
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::agents::PROMPT_CONTEXT),
            "",
            Some(&json!({ "sessionId": SESSION, "text": "page=/admin" })),
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::agents::INTERRUPT),
            "",
            Some(&json!({ "sessionId": SESSION })),
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path("/attachments/att_abc123/content"),
            &format!("?sessionId={SESSION}"),
            None,
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::ATTACHMENTS),
            "",
            Some(&json!({ "sessionId": SESSION })),
            Some(PROJECT_ROOT),
        )
        .ok
    );

    let denied_routes = [
        project_routes::agents::LIST,
        project_routes::agents::OUTPUT_STREAM,
        project_routes::agents::HISTORY,
        project_routes::EVENTS,
        project_routes::agents::SPAWN,
        project_routes::agents::KILL,
        project_routes::agents::STOP,
        project_routes::agents::FORK,
        project_routes::live_pane::INPUT,
        project_routes::threads::SEND,
        project_routes::worktree_actions::CREATE,
        project_routes::DESKTOP_STATE,
    ];
    for route in denied_routes {
        assert!(
            !allow(
                Some(&actor),
                "GET",
                &port_path(route),
                &format!("?sessionId={SESSION}"),
                None,
                Some(PROJECT_ROOT),
            )
            .ok,
            "GET {route}"
        );
    }
}

#[test]
fn operator_refuses_session_conflicts_unbound_projects_and_revoked_principals() {
    let actor = operator(vec![grant(PROJECT_ROOT, SESSION)]);
    assert!(
        !allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::agents::INPUT),
            &format!("?sessionId={SESSION}"),
            None,
            Some(PROJECT_ROOT),
        )
        .ok
    );
    let conflict = allow(
        Some(&actor),
        "GET",
        &port_path(project_routes::agents::OUTPUT),
        &format!("?sessionId={SESSION}"),
        Some(&json!({ "sessionId": "other" })),
        Some(PROJECT_ROOT),
    );
    assert!(!conflict.ok);
    assert_eq!(
        conflict.error.as_deref(),
        Some("conflicting session ids in request body and query")
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            Some("/srv/other"),
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            None,
        )
        .ok
    );

    let mut revoked = operator(vec![grant(PROJECT_ROOT, SESSION)]);
    revoked.principal.as_mut().unwrap().revoked_at = Some("2020-01-01T00:00:00Z".into());
    assert!(
        !allow(
            Some(&revoked),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            Some(PROJECT_ROOT),
        )
        .ok
    );
}

#[test]
fn attachment_pattern_refuses_route_smuggling() {
    let actor = operator(vec![grant(PROJECT_ROOT, SESSION)]);
    for path in [
        "/attachments/att_x/content/../../agents/spawn",
        "/attachments/..%2f..%2fagents%2fspawn/content",
        "/attachments/%2e%2e/%2e%2e/agents/spawn/content",
        "/attachments/att%2fx/content",
        "/attachments/att_x;a=b/content",
        "/attachments//content",
        "/attachments/att_x/content/extra",
        "/attachments/att_x/content/",
        "/attachments/att_x",
        "/attachments/att_x/contentious",
    ] {
        assert!(
            !allow(
                Some(&actor),
                "GET",
                &port_path(path),
                &format!("?sessionId={SESSION}"),
                None,
                Some(PROJECT_ROOT),
            )
            .ok,
            "{path}"
        );
    }
}

#[test]
fn shared_guest_is_scoped_to_shared_session_reads_input_and_attachments() {
    let actor = guest(SESSION);
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            None,
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::live_pane::OUTPUT),
            &format!("?sessionId={SESSION}"),
            None,
            None,
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::live_pane::INPUT),
            "",
            Some(&json!({ "sessionId": SESSION, "text": "hello" })),
            None,
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::live_pane::INPUT),
            "",
            Some(&json!({ "sessionId": SESSION, "attachmentIds": ["att_1"] })),
            None,
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::ATTACHMENTS),
            "",
            Some(&json!({ "sessionId": SESSION })),
            None,
        )
        .ok
    );
    // Answering the agent's own chooser, in the shared session only. Same
    // authority as typing the option's number into the composer.
    assert!(
        allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::live_pane::SELECT),
            "",
            Some(&json!({ "sessionId": SESSION, "label": "No", "number": 3 })),
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::live_pane::SELECT),
            "",
            Some(&json!({ "sessionId": "other", "label": "No", "number": 3 })),
            None,
        )
        .ok
    );
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path("/attachments/att_abc123/content"),
            &format!("?sessionId={SESSION}"),
            None,
            None,
        )
        .ok
    );

    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT),
            "?sessionId=other",
            None,
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::live_pane::INPUT),
            "",
            Some(&json!({ "sessionId": SESSION, "text": "  \n\t " })),
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "POST",
            &port_path(project_routes::agents::INPUT),
            "",
            Some(&json!({ "sessionId": SESSION, "text": "hello" })),
            None,
        )
        .ok
    );
}

#[test]
fn shared_guest_owns_the_shared_session_and_no_other() {
    // Sharing is full trust over the session that was shared: the guest may
    // stop, resume, kill and fork the agent they were given. The limit is the
    // session, not the verb -- so every widened route is asserted in both
    // directions, because a route list that grew without the second direction
    // would be a guest able to kill any agent in the owner's project.
    let actor = guest(SESSION);
    let writes = [
        project_routes::live_pane::INTERRUPT,
        project_routes::agents::INTERRUPT,
        project_routes::agents::STOP,
        project_routes::agents::RESUME,
        project_routes::agents::KILL,
        project_routes::agents::FORK,
    ];
    for path in writes {
        assert!(
            allow(
                Some(&actor),
                "POST",
                &port_path(path),
                "",
                Some(&json!({ "sessionId": SESSION })),
                None,
            )
            .ok,
            "{path} should be the guest's to call on their own session"
        );
        assert!(
            !allow(
                Some(&actor),
                "POST",
                &port_path(path),
                "",
                Some(&json!({ "sessionId": "other" })),
                None,
            )
            .ok,
            "{path} must not reach another session"
        );
        assert!(
            !allow(Some(&actor), "POST", &port_path(path), "", None, None).ok,
            "{path} with no session named must not inherit the share's"
        );
    }

    // Administering the project, and the share itself, stays the owner's.
    for path in [
        project_routes::agents::SPAWN,
        project_routes::agents::RENAME,
        project_routes::worktree_actions::CREATE,
    ] {
        assert!(
            !allow(
                Some(&actor),
                "POST",
                &port_path(path),
                "",
                Some(&json!({ "sessionId": SESSION })),
                None,
            )
            .ok,
            "{path} is not a guest route"
        );
    }

    // The plan names its session in the path, where the query-and-body check
    // cannot see it, so it is compared there instead.
    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path(&format!("{}/{SESSION}", project_routes::PLANS)),
            "",
            None,
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(&format!("{}/other", project_routes::PLANS)),
            "",
            None,
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(&format!("{}/{SESSION}/extra", project_routes::PLANS)),
            "",
            None,
            None,
        )
        .ok
    );

    assert!(
        allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT_STREAM),
            &format!("?sessionId={SESSION}"),
            None,
            None,
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &port_path(project_routes::agents::OUTPUT_STREAM),
            "?sessionId=other",
            None,
            None,
        )
        .ok
    );
}

#[test]
fn operator_stream_gate_is_separate_from_buffered_proxy_gate() {
    let actor = operator(vec![grant(PROJECT_ROOT, SESSION)]);
    let stream_path = port_path(project_routes::agents::OUTPUT_STREAM);
    let full_path = format!("{stream_path}?sessionId={SESSION}");
    let route_url = DaemonRouteUrl::parse(&full_path);

    assert!(
        assert_operator_stream_allowed(
            Some(&actor),
            "GET",
            route_url.pathname(),
            &route_url,
            RemoteAccessContext {
                body: None,
                project_root: Some(PROJECT_ROOT)
            },
        )
        .ok
    );
    assert!(
        !allow(
            Some(&actor),
            "GET",
            &stream_path,
            &format!("?sessionId={SESSION}"),
            None,
            Some(PROJECT_ROOT),
        )
        .ok
    );
    assert!(
        !assert_operator_stream_allowed(
            Some(&actor),
            "GET",
            route_url.pathname(),
            &route_url,
            RemoteAccessContext {
                body: None,
                project_root: Some("/srv/other")
            },
        )
        .ok
    );
    assert!(
        !assert_operator_stream_allowed(
            Some(&guest(SESSION)),
            "GET",
            route_url.pathname(),
            &route_url,
            RemoteAccessContext {
                body: None,
                project_root: Some(PROJECT_ROOT)
            },
        )
        .ok
    );
}

/// Being on the account is not being at the keyboard.
///
/// The owner's own app is stamped `owner`, and the daemon hands those straight
/// to its whole API. A peer carrying that stamp would be every machine holding
/// every other machine's keyboard, so a peer has its own allowlist and this is
/// the second direction of it: the route next to the allowed one stays shut.
#[test]
fn a_peer_machine_may_hand_over_work_and_nothing_else() {
    let handing_over = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &port_path(project_routes::tasks::ASSIGN),
        "",
        Some(&json!({ "taskId": "t1" })),
        Some(PROJECT_ROOT),
    );
    assert!(handing_over.ok, "{:?}", handing_over.error);

    // The allowlist says WHAT may be asked; the project binding says of whom.
    // The proxy target pins the host and not the port, so without this a peer
    // chooses which local service answers -- its own JSON, posted by this
    // machine, at whatever happens to be listening on a port it picked.
    let unbound = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &port_path(project_routes::tasks::ASSIGN),
        "",
        Some(&json!({ "taskId": "t1" })),
        None,
    );
    assert!(!unbound.ok);
    assert_eq!(unbound.status, Some(403));

    // The route beside it, which the owner's app may post to and a peer may
    // not. An allowlist with no refused neighbour proves nothing.
    let killing = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &port_path(project_routes::agents::KILL),
        "",
        Some(&json!({ "sessionId": SESSION })),
        Some(PROJECT_ROOT),
    );
    assert!(!killing.ok);
    assert_eq!(killing.status, Some(403));

    // Reading is not granted either: nothing needs it yet, and an allowlist
    // that grants what nobody asked for is the widening this phase was
    // warned about.
    let reading = allow(
        Some(&peer(Some("mbp"))),
        "GET",
        &port_path(project_routes::tasks::LIST),
        "",
        None,
        Some(PROJECT_ROOT),
    );
    assert!(!reading.ok);
}

/// The relay stamps the origin machine from the socket the frame arrived on,
/// which is exactly why the caller cannot choose it. A peer role without one
/// did not come from where it claims.
#[test]
fn a_peer_that_names_no_machine_is_refused() {
    let anonymous = allow(
        Some(&peer(None)),
        "POST",
        &port_path(project_routes::tasks::ASSIGN),
        "",
        Some(&json!({ "taskId": "t1" })),
        Some(PROJECT_ROOT),
    );
    assert!(!anonymous.ok);
    assert_eq!(anonymous.status, Some(403));

    let blank = allow(
        Some(&peer(Some("   "))),
        "POST",
        &port_path(project_routes::tasks::ASSIGN),
        "",
        Some(&json!({ "taskId": "t1" })),
        Some(PROJECT_ROOT),
    );
    assert!(!blank.ok);
}

/// A role nobody recognizes must not fall into the peer arm, and the peer
/// header alone must not mint one: the role is what grants, and the machine
/// id only says which peer it is.
#[test]
fn only_the_declared_peer_role_is_a_peer() {
    let actor = parse_remote_actor(&BTreeMap::from([
        ("x-aimux-actor-role".into(), "peer".into()),
        ("x-aimux-peer-machine-id".into(), "strix".into()),
    ]))
    .expect("peer actor");
    assert_eq!(actor.role, RemoteActorRole::Peer);
    assert_eq!(actor.peer_machine_id.as_deref(), Some("strix"));

    let impostor = parse_remote_actor(&BTreeMap::from([
        ("x-aimux-actor-role".into(), "peerish".into()),
        ("x-aimux-peer-machine-id".into(), "strix".into()),
    ]))
    .expect("unrecognized actor");
    assert_eq!(impostor.role, RemoteActorRole::Guest);
}
