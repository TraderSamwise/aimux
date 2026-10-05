//! One agent's state, worded by the service and rendered by both surfaces.
//!
//! The app computed its own word from `session.status` and reached
//! `status === "running" -> "Running"` without ever consulting `activity`, so an
//! agent that had finished its turn and was sitting at an empty prompt read as
//! "Running" while this service had already called it `ready`. The status dot
//! beside that word was correct the whole time, which is what makes it a
//! one-answer-many-surfaces failure rather than a wrong rule.
//!
//! This is the service half: it asserts the words in the shared fixture are the
//! ones `derive_session_semantics` actually produces. The app half reads the
//! same file in `app/lib/agent-status-label.cross-surface.test.ts` and asserts
//! the row renders them. Per AGENTS.md, the surfaces are compared against each
//! other through one fixture rather than each given a test of its own, because
//! a per-surface test passes happily while the surfaces disagree.

use aimux::project_service::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use serde_json::Value;

const SURFACES: &str =
    include_str!("../../../../testdata/contracts/v1/agent-status-label/surfaces.json");

fn fixture() -> Value {
    serde_json::from_str(SURFACES).expect("valid agent-status-label fixture")
}

fn semantics(case: &Value) -> Value {
    derive_session_semantics(SessionSemanticsInput {
        status: case["status"].as_str().expect("status").to_owned(),
        activity: case["activity"].as_str().map(str::to_owned),
        attention: case["attention"].as_str().map(str::to_owned),
        // Both absent from most cases, and both decide one of them: a pending
        // action is what `statusLabel` prefers over the user label, and an
        // assigned task is the only way to reach `next_step`.
        pending_action: case["pendingAction"].as_str().map(str::to_owned),
        has_active_task: case["hasActiveTask"].as_bool().unwrap_or(false),
        ..SessionSemanticsInput::default()
    })
}

fn string_at(value: &Value, path: [&str; 2]) -> String {
    value[path[0]][path[1]]
        .as_str()
        .unwrap_or_else(|| panic!("{}.{} is a string", path[0], path[1]))
        .to_owned()
}

#[test]
fn the_service_words_every_state_the_way_the_fixture_says() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().expect("cases") {
        let why = case["why"].as_str().unwrap_or_default();
        let semantic = semantics(case);
        assert_eq!(
            string_at(&semantic, ["user", "label"]),
            case["userLabel"].as_str().expect("userLabel"),
            "user.label for {case} ({why})"
        );
        assert_eq!(
            string_at(&semantic, ["presentation", "statusLabel"]),
            case["statusLabel"].as_str().expect("statusLabel"),
            "presentation.statusLabel for {case} ({why})"
        );
    }
}

/// The case the item was filed for, asserted on its own so a regression names
/// itself rather than arriving as one row of a loop.
#[test]
fn an_agent_idle_at_its_prompt_is_ready_and_never_running() {
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status: "running".to_owned(),
        activity: Some("idle".to_owned()),
        attention: Some("normal".to_owned()),
        ..SessionSemanticsInput::default()
    });

    assert_eq!(
        string_at(&semantic, ["presentation", "statusLabel"]),
        "ready"
    );
    assert_eq!(string_at(&semantic, ["runtime", "lifecycle"]), "idle");
    assert_ne!(
        string_at(&semantic, ["presentation", "statusLabel"]),
        "running",
        "the process being alive is not the agent being busy"
    );
}

/// One state, one word, across every surface that renders it.
///
/// `needs_response` had three: this service said "needs answer", the TUI row
/// said "Needs response", and Exposé's chip said "Needs reply". Nothing
/// compared them, so the app row moving onto the served word changed what a
/// user sees for that one state. They agree now, and this is what keeps them
/// agreeing -- a per-surface test passes happily while the surfaces disagree,
/// which is the whole reason this file is shaped the way it is.
#[test]
fn every_surface_words_a_state_the_same_way() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().expect("cases") {
        // The pending-action case is the row's own guard, not a user label the
        // other two surfaces map, so it is left to the app half.
        if case["pendingAction"].is_string() {
            continue;
        }
        let user_label = case["userLabel"].as_str().expect("userLabel");
        let served = string_at(&semantics(case), ["presentation", "statusLabel"]);
        let row = aimux::dashboard_renderer::row_state_label(user_label);
        let chip = aimux::project_service::switchable_agents::user_label_chip(user_label);

        assert_eq!(
            served.to_lowercase(),
            row.to_lowercase(),
            "{user_label}: the service says {served:?} and the TUI row says {row:?}"
        );
        if let Some((_, chip)) = chip {
            assert_eq!(
                served.to_lowercase(),
                chip.to_lowercase(),
                "{user_label}: the service says {served:?} and Exposé's chip says {chip:?}"
            );
        }
    }
}
