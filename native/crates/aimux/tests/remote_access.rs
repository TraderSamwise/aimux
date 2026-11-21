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
/// to its whole API. A peer gets its own role so that it can be given routes
/// deliberately -- and it has exactly one, because the first two that looked
/// narrow were not: a task's description is read back to an overseer as a
/// briefing, which makes posting one a way to type into the agent that spawns
/// agents.
#[test]
fn a_peer_machine_may_only_submit_agent_input() {
    for (method, route) in [
        ("POST", project_routes::tasks::ASSIGN),
        ("POST", project_routes::tasks::ACCEPT),
        ("POST", project_routes::agents::KILL),
        ("GET", project_routes::tasks::LIST),
        // The same handler as the one open route, and still shut: this is the
        // door a shared guest writes to, and its guest arm keys on a share
        // session a peer does not have.
        ("POST", project_routes::live_pane::INPUT),
        // The right route, the wrong verb.
        ("GET", project_routes::agents::INPUT),
    ] {
        let refused = allow(
            Some(&peer(Some("mbp"))),
            method,
            &port_path(route),
            "",
            Some(&json!({ "taskId": "t1" })),
            Some(PROJECT_ROOT),
        );
        assert!(!refused.ok, "{method} {route} was allowed");
        assert_eq!(refused.status, Some(403));
        // The refusal names the route rather than saying "denied": a peer is
        // a program, and one of these is open.
        assert!(
            refused
                .error
                .as_deref()
                .is_some_and(|error| error.contains(route)),
            "{method} {route}: {:?}",
            refused.error
        );
    }

    let allowed = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &port_path(project_routes::agents::INPUT),
        "",
        Some(&json!({ "sessionId": "claude-abc", "text": "look at the shard numbers" })),
        Some(PROJECT_ROOT),
    );
    assert!(allowed.ok, "{:?}", allowed.error);
}

/// The allowlist accepts exactly the method spelling the body parser does.
///
/// `daemon/server.rs` reads a JSON body on `method == "POST"` and nothing
/// else, so a case-insensitive compare here would hand this function a
/// request whose body was never read -- and every body refusal would then
/// pass by being asked about `None`. Vacuous rather than wrong, which is the
/// harder kind to notice.
#[test]
fn a_peer_route_is_open_on_the_same_post_the_body_parser_reads() {
    let body = json!({ "sessionId": "claude-abc", "text": "hi" });
    let route = port_path(project_routes::agents::INPUT);
    assert!(
        allow(
            Some(&peer(Some("mbp"))),
            "POST",
            &route,
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        )
        .ok
    );
    for spelling in ["post", "Post", "pOsT", "GET", "PUT", "DELETE"] {
        let refused = allow(
            Some(&peer(Some("mbp"))),
            spelling,
            &route,
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        );
        assert!(!refused.ok, "{spelling} was allowed");
        assert_eq!(refused.status, Some(403), "{spelling}");
        // WHICH refusal, because the method check and the route check used to
        // share one sentence -- so this test stayed green with either rule
        // deleted, as long as the other still refused.
        assert_eq!(
            refused.error.as_deref(),
            Some(
                format!(
                    "peer machine mbp may only POST to {}",
                    project_routes::agents::INPUT
                )
                .as_str()
            ),
            "{spelling}"
        );
    }
}

/// The second peer door: named by PROJECT, not by port.
///
/// The proxy route needs a host and a port, which a sender across the relay
/// has no way to learn -- the owner record carries the machine and not the
/// address. This one carries the project and lets the owner supply its own
/// address, which is also the stronger shape: the port stops coming from the
/// caller.
///
/// The body rules are shared with the proxy door, so they are asserted here
/// too rather than assumed: a door that admitted `force` would be a door
/// around every one of them.
#[test]
fn a_peer_may_also_name_a_project_instead_of_a_port() {
    let route = "/peer/agents/input";
    let body = json!({ "project": PROJECT_ROOT, "sessionId": "claude-abc", "text": "hi" });

    let allowed = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        route,
        "",
        Some(&body),
        Some(PROJECT_ROOT),
    );
    assert!(allowed.ok, "{:?}", allowed.error);

    // The project it named is not one this machine serves. A different
    // mistake from naming a stranger's port, and it says so.
    let unserved = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        route,
        "",
        Some(&body),
        None,
    );
    assert!(!unserved.ok);
    assert_eq!(
        unserved.error.as_deref(),
        Some("peer machine mbp named a project this machine is not serving")
    );

    // Wrong verb, same door.
    for spelling in ["GET", "PUT", "post"] {
        let refused = allow(
            Some(&peer(Some("mbp"))),
            spelling,
            route,
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        );
        assert!(!refused.ok, "{spelling} was allowed");
    }

    // The shared body rules.
    for (field, body) in [
        (
            "force",
            json!({ "project": PROJECT_ROOT, "sessionId": "a", "text": "hi", "force": true }),
        ),
        (
            "attachmentIds",
            json!({ "project": PROJECT_ROOT, "sessionId": "a", "text": "hi", "attachmentIds": ["att_1"] }),
        ),
        (
            "sharedChatActor",
            json!({
                "project": PROJECT_ROOT,
                "sessionId": "a",
                "text": "hi",
                "sharedChatActor": { "role": "owner", "displayName": "Sam" }
            }),
        ),
    ] {
        let refused = allow(
            Some(&peer(Some("mbp"))),
            "POST",
            route,
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        );
        assert!(!refused.ok, "{field} was allowed on the project door");
    }

    // And an unstamped caller gets nothing here either.
    let anonymous = allow(
        Some(&peer(None)),
        "POST",
        route,
        "",
        Some(&body),
        Some(PROJECT_ROOT),
    );
    assert!(!anonymous.ok);
    assert_eq!(
        anonymous.error.as_deref(),
        Some("peer request did not say which machine it came from")
    );
}

/// The proxy validates the HOST and not the port, so without a project the
/// route reaches any loopback port that answers `POST /agents/input` --
/// including something that is not an Aimux project service at all.
///
/// `project_root` is resolved from this daemon's own project list, which is
/// why a peer is excluded from the proxy fast path: that path builds its
/// context with an empty list, and an empty list answers "not ours" for every
/// port including the right one.
#[test]
fn a_peer_must_name_a_project_service_this_machine_runs() {
    let refused = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &port_path(project_routes::agents::INPUT),
        "",
        Some(&json!({ "sessionId": "claude-abc", "text": "hello" })),
        None,
    );
    assert!(!refused.ok);
    assert_eq!(refused.status, Some(403));
    assert!(
        refused
            .error
            .as_deref()
            .is_some_and(|error| error.contains("not one of this machine's project services")),
        "{:?}",
        refused.error
    );
}

/// A peer may read this machine's quota headroom.
///
/// The first read route open to a peer, and the fact every other fleet
/// question depends on: whether the tool account behind an agent here has
/// room left. It is a GET, so none of the body refusals apply to it, which is
/// why the gate returns before them rather than running them against a body
/// the parser never read.
#[test]
fn a_peer_may_read_this_machines_quota_headroom() {
    let allowed = allow(
        Some(&peer(Some("mbp"))),
        "GET",
        project_routes::USAGE,
        "",
        None,
        Some(PROJECT_ROOT),
    );
    assert!(allowed.ok, "{:?}", allowed.error);
}

/// Every fleet read's route must be one a peer is allowed to answer.
///
/// `assert_peer_allowed` is a CLOSED list, and the fan-out cannot tell a 403
/// from any other refusal: a fleet read pointed at a route that is not open
/// comes back as a report in which every single machine failed, which reads as
/// a broken fleet rather than as a mistake in our own allowlist. There is no
/// test of the fan-out itself -- it needs a live relay -- so this ties the two
/// places that have to agree.
///
/// Keyed on the spec the fan-out actually uses, not on a repeat of the route
/// string, so a read added with the wrong route fails here rather than at
/// runtime on somebody's phone.
#[test]
fn every_fleet_peer_read_names_a_route_open_to_a_peer() {
    for read in aimux::remote::daemon_relay::fleet_peer_reads() {
        let allowed = allow(
            Some(&peer(Some("mbp"))),
            "GET",
            read.route,
            "",
            None,
            Some(PROJECT_ROOT),
        );
        assert!(
            allowed.ok,
            "fleet read on {} is refused to a peer, so every machine would answer 403: {:?}",
            read.route, allowed.error
        );
    }
}

/// The verb belongs to the route, not to the gate.
///
/// Opening a read with one global method rule would have meant relaxing it to
/// "POST or GET", which also opens `GET /agents/input` -- a verb the body
/// parser never reads, so every body refusal would then pass by being asked
/// about `None`. Both directions are asserted here because that is the
/// mistake this shape exists to prevent, and only the pair catches it: the
/// first alone passes if reads are opened everywhere, the second alone passes
/// if nothing is opened at all.
#[test]
fn each_peer_route_answers_only_its_own_verb() {
    let wrong_verb_on_the_read = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        project_routes::USAGE,
        "",
        Some(&json!({ "sessionId": "claude-abc", "text": "hello" })),
        Some(PROJECT_ROOT),
    );
    assert!(!wrong_verb_on_the_read.ok, "POST /usage was allowed");
    assert_eq!(wrong_verb_on_the_read.status, Some(403));
    assert!(
        wrong_verb_on_the_read
            .error
            .as_deref()
            .is_some_and(|error| error.contains("may only GET to")),
        "{:?}",
        wrong_verb_on_the_read.error
    );

    let wrong_verb_on_the_write = allow(
        Some(&peer(Some("mbp"))),
        "GET",
        &port_path(project_routes::agents::INPUT),
        "",
        None,
        Some(PROJECT_ROOT),
    );
    assert!(!wrong_verb_on_the_write.ok, "GET /agents/input was allowed");
    assert_eq!(wrong_verb_on_the_write.status, Some(403));
    assert!(
        wrong_verb_on_the_write
            .error
            .as_deref()
            .is_some_and(|error| error.contains("may only POST to")),
        "{:?}",
        wrong_verb_on_the_write.error
    );
}

/// A read is still bound to a project this machine serves, and still needs a
/// machine id.
///
/// Both refusals are older than the read route, and the risk in adding a
/// route is inheriting neither. Asserted on the new route rather than trusted
/// from the old one, because what shares the code is the gate and what shares
/// nothing is the arm.
#[test]
fn a_peer_read_inherits_the_project_and_machine_rules() {
    let no_project = allow(
        Some(&peer(Some("mbp"))),
        "GET",
        project_routes::USAGE,
        "",
        None,
        None,
    );
    assert!(!no_project.ok, "a read with no project was allowed");
    assert_eq!(no_project.status, Some(403));

    let no_machine = allow(
        Some(&peer(None)),
        "GET",
        project_routes::USAGE,
        "",
        None,
        Some(PROJECT_ROOT),
    );
    assert!(!no_machine.ok, "a read from an unnamed machine was allowed");
    assert_eq!(no_machine.status, Some(403));
    assert!(
        no_machine
            .error
            .as_deref()
            .is_some_and(|error| error.contains("did not say which machine")),
        "{:?}",
        no_machine.error
    );
}

/// Three things a peer may not put in the body of the one route it has.
///
/// Each is refused by its own name, because "403" on an input send sends
/// somebody reading the allowlist rather than the field they set.
#[test]
fn a_peer_may_not_force_attach_or_sign_its_input() {
    for (field, body, expected) in [
        (
            "force",
            json!({ "sessionId": "claude-abc", "text": "hi", "force": true }),
            "cannot force unattended delivery",
        ),
        (
            "attachmentIds",
            json!({ "sessionId": "claude-abc", "text": "hi", "attachmentIds": ["att_1"] }),
            "cannot attach this machine's files",
        ),
        (
            "sharedChatActor",
            json!({
                "sessionId": "claude-abc",
                "text": "hi",
                "sharedChatActor": { "role": "owner", "displayName": "Sam" }
            }),
            "cannot name the author of its own input",
        ),
    ] {
        let refused = allow(
            Some(&peer(Some("mbp"))),
            "POST",
            &port_path(project_routes::agents::INPUT),
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        );
        assert!(!refused.ok, "{field} was allowed");
        assert_eq!(refused.status, Some(403), "{field}");
        assert!(
            refused
                .error
                .as_deref()
                .is_some_and(|error| error.contains(expected)),
            "{field}: {:?}",
            refused.error
        );
    }

    // And the inverse, so the refusals above are not passing on the route
    // alone: the same route with none of those fields is allowed, and an
    // absent or false `force` is not a `force`.
    for body in [
        json!({ "sessionId": "claude-abc", "text": "hi" }),
        json!({ "sessionId": "claude-abc", "text": "hi", "force": false }),
        json!({ "sessionId": "claude-abc", "text": "hi", "attachmentIds": [] }),
        json!({ "sessionId": "claude-abc", "text": "hi", "sharedChatActor": null }),
    ] {
        let allowed = allow(
            Some(&peer(Some("mbp"))),
            "POST",
            &port_path(project_routes::agents::INPUT),
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        );
        assert!(allowed.ok, "{body:?}: {:?}", allowed.error);
    }
}

/// The role is the difference, not the route: the request the peer is refused
/// is the one the owner's own app makes all day.
///
/// Asserted as a pair rather than on its own -- "the owner may do this" is
/// true of every route and proves nothing by itself.
#[test]
fn the_same_route_turns_on_who_is_asking() {
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
    let route = port_path(project_routes::tasks::ASSIGN);
    let body = json!({ "taskId": "t1" });

    let as_owner = allow(
        Some(&owner),
        "POST",
        &route,
        "",
        Some(&body),
        Some(PROJECT_ROOT),
    );
    let as_peer = allow(
        Some(&peer(Some("mbp"))),
        "POST",
        &route,
        "",
        Some(&body),
        Some(PROJECT_ROOT),
    );

    assert!(as_owner.ok, "{:?}", as_owner.error);
    assert!(!as_peer.ok);
    assert_eq!(as_peer.status, Some(403));
}

/// The relay stamps the origin machine from the socket the frame arrived on,
/// which is exactly why the caller cannot choose it. A peer role without one
/// did not come from where it claims.
#[test]
fn a_peer_that_names_no_machine_is_refused() {
    // On the OPEN route, deliberately. Asserted against a closed route this
    // test held with the stamp check deleted -- the route was refusing it,
    // and the thing being tested was never asked. The stamp has to be the
    // only reason left for a refusal.
    let open_route = port_path(project_routes::agents::INPUT);
    let body = json!({ "sessionId": "claude-abc", "text": "hi" });
    let as_machine = |machine: Option<&str>| {
        allow(
            Some(&peer(machine)),
            "POST",
            &open_route,
            "",
            Some(&body),
            Some(PROJECT_ROOT),
        )
    };

    // The control: a real machine id on this exact request is allowed, so
    // every refusal below is the stamp and not the route.
    assert!(as_machine(Some("mbp")).ok);

    let anonymous = as_machine(None);
    assert!(!anonymous.ok);
    assert_eq!(anonymous.status, Some(403));

    // Not merely "non-empty". The stamp is about to be written into the text
    // an agent reads, and these are the spellings that are not machine ids:
    // uppercase, a separator, a space, a bracket, and the shared slot every
    // daemon with no persisted identity uses -- which is a label rather than
    // a name, so the refusal must say it did not learn where the frame came
    // from instead of quoting it back as though it had.
    for stamp in [
        "   ",
        "unidentified",
        "Mbp",
        "mbp/strix",
        "mbp strix",
        "a]b",
    ] {
        let refused = as_machine(Some(stamp));
        assert!(!refused.ok, "{stamp:?} was accepted as a machine id");
        assert_eq!(
            refused.error.as_deref(),
            Some("peer request did not say which machine it came from"),
            "{stamp:?}"
        );
    }
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

/// A relay-stamped request is never mistaken for a local caller, whatever the
/// stamp says.
///
/// `parse_remote_actor` returning `None` means "local caller", which is the
/// MORE trusted answer: the daemon's local-CLI routes and the core read
/// carve-out both key on `parse_remote_actor(..).is_none()`. So the fallback
/// when an actor cannot be read has to be a Guest, not an absence -- and it
/// is, because `has_relay_actor_headers` accepts ANY `x-aimux-*` header or the
/// relay-forwarded header.
///
/// WHAT THIS PINS THAT THE SIBLING TEST ABOVE DOES NOT: that breadth.
/// `parse_remote_actor_matches_header_rules_and_never_mints_operator` uses
/// `x-aimux-share-id` and `x-aimux-actor`, both of which any plausible
/// narrowing of `has_relay_actor_headers` would still list. Narrow it to a
/// known-header allowlist and those cases keep passing while a request
/// carrying only an UNRECOGNISED `x-aimux-*` header falls through to `None`
/// and is served as local. That is a privilege escalation reachable by a
/// one-line "tidy up", so the unrecognised-header case and the
/// relay-forwarded case are asserted here by name.
#[test]
fn an_unreadable_relay_stamp_is_a_guest_and_never_a_local_caller() {
    // Syntactically broken JSON, not merely a bad role: this takes the
    // `serde_json::from_str(..).ok()?` path rather than the role filter.
    let unparseable = parse_remote_actor(&BTreeMap::from([(
        "x-aimux-actor".into(),
        "{not json at all".into(),
    )]))
    .expect("an unparseable actor stamp must still be an actor, not a local caller");
    assert_eq!(unparseable.role, RemoteActorRole::Guest);
    assert_eq!(unparseable.principal, None);

    // The breadth of `has_relay_actor_headers`: a header nothing names
    // explicitly still marks the request as relayed.
    let unrecognised = parse_remote_actor(&BTreeMap::from([(
        "x-aimux-some-future-header".into(),
        "whatever".into(),
    )]))
    .expect("an unrecognised x-aimux-* header must still mark the request as relayed");
    assert_eq!(unrecognised.role, RemoteActorRole::Guest);

    // Mixed case, because the check lowercases before comparing.
    let mixed_case = parse_remote_actor(&BTreeMap::from([(
        "X-Aimux-Some-Future-Header".into(),
        "whatever".into(),
    )]))
    .expect("header matching must be case-insensitive");
    assert_eq!(mixed_case.role, RemoteActorRole::Guest);

    let forwarded = parse_remote_actor(&BTreeMap::from([(
        aimux::request_actor::RELAY_FORWARDED_HEADER.into(),
        "1".into(),
    )]))
    .expect("the relay-forwarded header alone must mark the request as relayed");
    assert_eq!(forwarded.role, RemoteActorRole::Guest);

    // The control: a genuinely local request must still read as local, or the
    // assertions above would pass for a function that called everything a
    // guest and the carve-out would never serve a local CLI again.
    assert_eq!(
        parse_remote_actor(&BTreeMap::from([(
            "content-type".into(),
            "application/json".into()
        )])),
        None,
        "a request with no aimux stamp at all is a local caller"
    );
}
