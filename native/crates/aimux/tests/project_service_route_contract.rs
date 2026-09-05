use std::collections::{BTreeMap, BTreeSet, HashSet};

use aimux::project_api_contract::{collect_project_api_routes, routes};
use aimux::project_service::routes::{
    ProjectServiceHttpMethod as Method, ProjectServiceResponseKind as ResponseKind,
    ProjectServiceRouteGroup as Group, ProjectServiceRoutePattern as Pattern,
    project_service_route_specs, project_service_specs_for,
};

#[test]
fn code_split_registry_covers_every_canonical_project_route_once() {
    let canonical: BTreeSet<_> = collect_project_api_routes().into_iter().collect();
    let specs = project_service_route_specs();
    let mut groups_by_path: BTreeMap<&str, BTreeSet<Group>> = BTreeMap::new();

    for spec in specs {
        if let Pattern::Exact(path) = spec.pattern {
            assert!(
                canonical.contains(path),
                "exact route {path} is not in the canonical project API contract"
            );
            groups_by_path.entry(path).or_default().insert(spec.group);
        }
    }

    for route in canonical {
        let groups = groups_by_path
            .get(route)
            .unwrap_or_else(|| panic!("missing project-service split owner for {route}"));
        assert_eq!(
            groups.len(),
            1,
            "route {route} must have exactly one split owner, got {groups:?}"
        );
    }
}

#[test]
fn code_split_registry_has_no_duplicate_method_patterns() {
    let mut seen = HashSet::new();
    for spec in project_service_route_specs() {
        assert!(
            seen.insert((spec.method, spec.pattern)),
            "duplicate project-service route spec for {} {}",
            spec.method.as_str(),
            spec.pattern.display_path()
        );
    }
}

#[test]
fn code_split_registry_preserves_known_method_gates() {
    assert_matches(
        Method::Get,
        routes::controls::SWITCH_NEXT,
        &[(Group::Controls, ResponseKind::Json)],
    );
    assert_matches(
        Method::Post,
        routes::controls::SWITCH_NEXT,
        &[(Group::Controls, ResponseKind::Json)],
    );
    assert_matches(Method::Get, routes::STATUSLINE_SEGMENT, &[]);
    assert_matches(
        Method::Post,
        routes::STATUSLINE_SEGMENT,
        &[(Group::Runtime, ResponseKind::Json)],
    );
    assert_matches(
        Method::Delete,
        routes::STATUSLINE_SEGMENT,
        &[(Group::Runtime, ResponseKind::Json)],
    );
    assert_matches(Method::Post, routes::agents::OUTPUT_STREAM, &[]);
    assert_matches(
        Method::Get,
        routes::agents::OUTPUT_STREAM,
        &[(Group::Events, ResponseKind::Sse)],
    );
    assert_matches(
        Method::Post,
        routes::live_pane::INPUT,
        &[(Group::Io, ResponseKind::Json)],
    );
}

#[test]
fn code_split_registry_tracks_dynamic_routes_and_binary_outputs() {
    assert_matches(
        Method::Get,
        "/plans/codex-1",
        &[(Group::Plans, ResponseKind::Json)],
    );
    assert_matches(
        Method::Put,
        "/plans/codex-1",
        &[(Group::Plans, ResponseKind::Json)],
    );
    assert_matches(Method::Post, "/plans/codex-1", &[]);
    assert_matches(
        Method::Get,
        "/threads/thread-1",
        &[(Group::Reads, ResponseKind::Json)],
    );
    assert_matches(
        Method::Get,
        "/tasks/task-1",
        &[(Group::Reads, ResponseKind::Json)],
    );
    assert_matches(
        Method::Get,
        "/attachments/file-1",
        &[(Group::Io, ResponseKind::Json)],
    );
    assert_matches(
        Method::Get,
        "/attachments/file-1/content",
        &[(Group::Io, ResponseKind::Binary)],
    );
}

fn assert_matches(method: Method, path: &str, expected: &[(Group, ResponseKind)]) {
    let actual: Vec<_> = project_service_specs_for(method, path)
        .into_iter()
        .map(|spec| (spec.group, spec.response))
        .collect();
    assert_eq!(actual, expected, "{} {path}", method.as_str());
}
