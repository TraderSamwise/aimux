//! The set of routes that take the lifecycle permit, pinned across languages.
//!
//! The project service's queue holds one permit and waits up to 150s for a
//! turn, on the stated assumption callers allow 120s. A client that gives up
//! sooner reports a failure for work still running, and a retried spawn is a
//! second agent. So every client has to agree on WHICH routes those are, and
//! `lifecycle_transition_for_route` is the authority because it is the function
//! that takes the permit.
//!
//! The TS half asserts the same fixture in
//! `src/project-api-contract.queued-routes.test.ts`.

use aimux::project_service::lifecycle_mutation_queue::lifecycle_transition_for_route;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/lifecycle-queue/queued-routes.json");
const CONTRACT_SOURCE: &str = include_str!("../src/project_api_contract.rs");

fn fixture_timeout_ms() -> u64 {
    let parsed: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    parsed["timeoutMs"].as_u64().expect("timeoutMs")
}

fn fixture_routes() -> BTreeSet<String> {
    let parsed: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    parsed["routes"]
        .as_array()
        .expect("routes array")
        .iter()
        .map(|route| route.as_str().expect("route string").to_owned())
        .collect()
}

/// Every route literal the contract declares, so a NEW queued arm cannot be
/// added without this test noticing. There is no exhaustive route list in Rust
/// to iterate, and a hand-kept one here would drift the same way.
fn declared_routes() -> BTreeSet<String> {
    CONTRACT_SOURCE
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("pub const ")?;
            let (_, value) = rest.split_once(": &str = ")?;
            let literal = value.trim_end_matches(';').trim();
            let path = literal.strip_prefix('"')?.strip_suffix('"')?;
            path.starts_with('/').then(|| path.to_owned())
        })
        .collect()
}

fn queued_routes() -> BTreeSet<String> {
    declared_routes()
        .into_iter()
        // An empty body: every queued arm returns `Some` regardless of what it
        // reads out of one, carrying an empty target instead.
        .filter(|route| lifecycle_transition_for_route(route, &json!({})).is_some())
        .collect()
}

#[test]
fn the_published_queued_routes_are_the_ones_that_take_the_permit() {
    let declared = declared_routes();
    assert!(
        declared.len() > 50,
        "the route scrape found only {} paths, so it has stopped reading the contract",
        declared.len()
    );
    assert_eq!(
        queued_routes(),
        fixture_routes(),
        "the fixture and `lifecycle_transition_for_route` disagree about which routes queue"
    );
}

/// One number, three readers. The budget was written out twice -- once here
/// and once in the TS contract -- and two copies of a timeout is how one of
/// them ends up shorter than the wait it is promising to cover.
#[test]
fn every_client_is_told_the_same_budget() {
    assert_eq!(
        aimux::project_service::lifecycle_mutation_queue::QUEUED_LIFECYCLE_TIMEOUT_MS,
        fixture_timeout_ms(),
    );
}

#[test]
fn a_route_in_the_lifecycle_group_that_queues_nothing_keeps_the_short_budget() {
    // These three are POSTed alongside the queued ones and look like siblings,
    // but they take no permit, so promising a caller 120s for them would be a
    // different lie.
    for route in [
        aimux::project_api_contract::routes::agents::DISMISS_RESTORE_PREVIOUS,
        aimux::project_api_contract::routes::agents::RECORD_BACKEND_SESSION,
        aimux::project_api_contract::routes::agents::INTERRUPT,
    ] {
        assert!(
            lifecycle_transition_for_route(route, &json!({})).is_none(),
            "{route} should take no lifecycle permit"
        );
        assert!(
            !fixture_routes().contains(route),
            "{route} takes no permit, so it must not be published as queued"
        );
    }
}

#[test]
fn an_empty_body_does_not_hide_a_queued_route() {
    // The arms that read a body -- fork's `sourceSessionId`, worktree create's
    // `name`/`source` -- must still answer `Some`, or the scrape above would
    // silently under-report and the fixture would shrink to match.
    for route in fixture_routes() {
        assert!(
            lifecycle_transition_for_route(&route, &Value::Null).is_some(),
            "{route} must queue even with no body"
        );
    }
}
