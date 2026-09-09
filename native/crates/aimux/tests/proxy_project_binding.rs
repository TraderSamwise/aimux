use aimux::daemon_projects::ProjectsRouteProject;
use aimux::proxy_project_binding::{
    ProxyTarget, is_binary_project_route, parse_proxy_target,
    resolve_project_root_for_service_target,
};
use serde_json::{Value, json};

const HOST: &str = "127.0.0.1";

fn candidate(
    path: &str,
    port: Option<Value>,
    service_alive: bool,
    host: &str,
) -> ProjectsRouteProject {
    ProjectsRouteProject {
        id: path.replace('/', "-"),
        name: path.to_owned(),
        path: path.to_owned(),
        last_seen: None,
        dashboard_session_name: "aimux-test".to_owned(),
        service: None,
        service_alive,
        service_endpoint: port.map(|port| json!({ "host": host, "port": port })),
        online_agent_count: None,
    }
}

fn target(port: u64, host: &str) -> ProxyTarget {
    ProxyTarget {
        host: host.to_owned(),
        port,
        sub_path: "/agents/output".to_owned(),
    }
}

#[test]
fn parse_proxy_target_reads_host_port_and_sub_path() {
    assert_eq!(
        parse_proxy_target("/proxy/127.0.0.1/43210/agents/output"),
        Some(ProxyTarget {
            host: "127.0.0.1".into(),
            port: 43210,
            sub_path: "/agents/output".into(),
        })
    );
}

#[test]
fn parse_proxy_target_returns_none_for_non_proxy_paths() {
    for path in [
        "/health",
        "/agents/output",
        "/proxy//43210/agents",
        "/proxy/127.0.0.1/43210",
        "/proxy/127.0.0.1/abc/agents",
    ] {
        assert_eq!(parse_proxy_target(path), None, "{path}");
    }
}

#[test]
fn parse_proxy_target_rejects_zero_port() {
    assert_eq!(parse_proxy_target("/proxy/127.0.0.1/0/agents/output"), None);
}

#[test]
fn resolve_project_root_binds_port_to_its_live_project() {
    let projects = [
        candidate("/srv/a", Some(json!(43210)), true, HOST),
        candidate("/srv/b", Some(json!(43211)), true, HOST),
    ];
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(43210, HOST))).as_deref(),
        Some("/srv/a")
    );
}

#[test]
fn resolve_project_root_ignores_dead_projects() {
    let projects = [
        candidate("/srv/dead", Some(json!(51000)), false, HOST),
        candidate("/srv/live", Some(json!(51000)), true, HOST),
    ];
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(51000, HOST))).as_deref(),
        Some("/srv/live")
    );
}

#[test]
fn resolve_project_root_refuses_ambiguous_live_ports() {
    let projects = [
        candidate("/srv/a", Some(json!(51000)), true, HOST),
        candidate("/srv/b", Some(json!(51000)), true, HOST),
    ];
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(51000, HOST))),
        None
    );
}

#[test]
fn resolve_project_root_requires_exact_host_match() {
    let projects = [candidate("/srv/a", Some(json!(43210)), true, HOST)];
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(43210, "localhost"))),
        None
    );
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(43210, "::1"))),
        None
    );
}

#[test]
fn resolve_project_root_returns_none_for_unknown_or_invalid_candidates() {
    assert_eq!(
        resolve_project_root_for_service_target(
            &[candidate("/srv/dead", Some(json!(51000)), false, HOST)],
            Some(&target(51000, HOST)),
        ),
        None
    );
    assert_eq!(
        resolve_project_root_for_service_target(
            &[candidate("/srv/a", Some(json!(43210)), true, HOST)],
            Some(&target(43999, HOST)),
        ),
        None
    );
    assert_eq!(
        resolve_project_root_for_service_target(
            &[candidate("/srv/a", None, true, HOST)],
            Some(&target(43210, HOST)),
        ),
        None
    );
    assert_eq!(
        resolve_project_root_for_service_target(
            &[candidate("", Some(json!(43210)), true, HOST)],
            Some(&target(43210, HOST)),
        ),
        None
    );
}

#[test]
fn resolve_project_root_rejects_missing_target_or_empty_host() {
    let projects = [candidate("/srv/a", Some(json!(43210)), true, HOST)];
    assert_eq!(
        resolve_project_root_for_service_target(&projects, None),
        None
    );
    assert_eq!(
        resolve_project_root_for_service_target(&projects, Some(&target(43210, ""))),
        None
    );
}

#[test]
fn binary_project_route_matches_attachment_content_only() {
    assert!(is_binary_project_route("/attachments/att_1/content"));
    assert!(!is_binary_project_route("/attachments//content"));
    assert!(!is_binary_project_route("/attachments/att_1/content/extra"));
    assert!(!is_binary_project_route("/attachments/att/one/content"));
    assert!(!is_binary_project_route("/agents/output"));
}
