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

use aimux::project_service::lifecycle_mutation_queue::{
    lifecycle_transition_for_route, queued_lifecycle_timeout_ms,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/lifecycle-queue/queued-routes.json");
const CONTRACT_SOURCE: &str = include_str!("../src/project_api_contract.rs");
const DAEMON_JSON_SOURCE: &str = include_str!("../src/daemon/json.rs");
const DAEMON_RELAY_SOURCE: &str = include_str!("../src/remote/daemon_relay.rs");
const CLI_WORKTREES_SOURCE: &str = include_str!("../src/daemon/text/worktrees.rs");

fn fixture_budgets() -> BTreeMap<String, u64> {
    let parsed: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    parsed["routes"]
        .as_object()
        .expect("routes object")
        .iter()
        .map(|(route, budget)| (route.clone(), budget.as_u64().expect("budget")))
        .collect()
}

fn fixture_routes() -> BTreeSet<String> {
    fixture_budgets().into_keys().collect()
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

/// One table, three readers: the dashboard's action budget, the daemon's proxy
/// hop and the Expo app. The budget was written out twice before this, and two
/// copies of a timeout is how one ends up shorter than the wait it covers --
/// which is exactly what had happened to the five slow routes.
#[test]
fn every_reader_is_told_the_same_budget_per_route() {
    let from_code: BTreeMap<String, u64> = fixture_routes()
        .into_iter()
        .map(|route| {
            let budget = queued_lifecycle_timeout_ms(&route)
                .unwrap_or_else(|| panic!("{route} is published as queued but takes no permit"));
            (route, budget)
        })
        .collect();
    assert_eq!(from_code, fixture_budgets());
}

/// Four hops carry a relayed mutation -- app, relay transport, daemon relay
/// bridge, daemon proxy -- and the shortest one decides. The relay bridge
/// answers 502 when it gives up, so a flat 30s there made the other three
/// budgets irrelevant for a phone.
#[test]
fn the_relay_bridge_asks_per_route_too() {
    assert!(
        DAEMON_RELAY_SOURCE.contains("fn relay_request_timeout(path: &str) -> Duration"),
        "the relay bridge must derive its budget from the route"
    );
    assert!(
        DAEMON_RELAY_SOURCE.contains("let request_timeout = relay_request_timeout(path);"),
        "the relay bridge must use it"
    );
    assert!(
        !DAEMON_RELAY_SOURCE.contains("let deadline = Instant::now() + REQUEST_TIMEOUT;"),
        "the relay bridge still deadlines on the flat control-traffic budget"
    );
}

/// And the CLI reads the same number rather than keeping a fourth copy.
#[test]
fn the_cli_budget_is_not_a_fourth_copy() {
    assert!(
        CLI_WORKTREES_SOURCE.contains("QUEUED_LIFECYCLE_TIMEOUT_MS"),
        "CLI_PROJECT_MUTATION_TIMEOUT_MS must derive from the queue's constant"
    );
    assert!(
        !CLI_WORKTREES_SOURCE.contains("CLI_PROJECT_MUTATION_TIMEOUT_MS: u64 = 120_000;"),
        "the CLI still carries its own literal"
    );
}

/// The routes that do filesystem work must get MORE than the default, not the
/// same. Flattening them is how the app came to give a worktree create 120s
/// while the dashboard gave it 180s.
#[test]
fn the_slow_routes_are_actually_slower() {
    let budgets = fixture_budgets();
    let default = aimux::project_service::lifecycle_mutation_queue::QUEUED_LIFECYCLE_TIMEOUT_MS;
    let slow: Vec<&String> = budgets
        .iter()
        .filter(|(_, budget)| **budget > default)
        .map(|(route, _)| route)
        .collect();
    assert_eq!(slow.len(), 5, "expected five slow routes, got {slow:?}");
    for route in slow {
        assert!(route.starts_with("/worktrees/") || route == "/agents/restore-previous");
    }
}

/// The proxy hop is the whole budget a relay-mode client gets, so it has to
/// allow at least as long as the route needs. It used to be a flat 10s, which
/// meant a phone could never wait out a spawn whatever the app asked for.
#[test]
fn the_daemon_proxy_hop_allows_what_the_route_needs() {
    for (route, budget) in fixture_budgets() {
        assert!(
            budget > aimux::daemon::json::PROXY_TIMEOUT_MS,
            "{route} needs {budget}ms, which the flat proxy budget would cut short"
        );
        assert_eq!(queued_lifecycle_timeout_ms(&route), Some(budget));
    }
}

/// And actually asks for it. The budget being correct is no use if the proxy
/// still passes the flat constant -- which is what it did, and no assertion
/// about the numbers noticed.
#[test]
fn the_proxy_hop_asks_per_route_rather_than_passing_the_flat_budget() {
    let calls = DAEMON_JSON_SOURCE
        .matches("proxy_timeout_ms(&proxy.sub_path)")
        .count();
    assert_eq!(
        calls, 2,
        "both proxy json paths must ask per route; found {calls}"
    );
    // The flat constant may still be the fallback inside that function, but it
    // must not be handed straight to a request.
    for lie in [
        "proxy_json_request(&target_url, method, headers, body, PROXY_TIMEOUT_MS)",
        "execute_proxy_json_request(&target_url, method, headers, body, PROXY_TIMEOUT_MS)",
    ] {
        assert!(
            !DAEMON_JSON_SOURCE.contains(lie),
            "a proxied json request still passes the flat budget: {lie}"
        );
    }
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
