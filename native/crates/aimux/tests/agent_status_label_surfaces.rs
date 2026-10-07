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
/// Read as text so the set of labels can be compared against the arms that
/// produce them. Asserting one input per label would prove each arm reachable
/// and still miss a fifteenth.
const SEMANTICS_SOURCE: &str = include_str!("../src/project_service/session_semantics.rs");

fn fixture() -> Value {
    serde_json::from_str(SURFACES).expect("valid agent-status-label fixture")
}

fn semantics(case: &Value) -> Value {
    derive_session_semantics(SessionSemanticsInput {
        status: case["status"].as_str().expect("status").to_owned(),
        activity: case["activity"].as_str().map(str::to_owned),
        attention: case["attention"].as_str().map(str::to_owned),
        // No case in `cases` carries a pending action -- the row answers one
        // from the action rather than the payload, so it lives in
        // `optimisticAction` and has its own test. An assigned task is the only
        // way to reach `next_step`, so that one stays.
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
    // Every PINNED label, not only the ones the cases happen to reach. The
    // cases cover eleven of the fourteen, so `graveyarding`, `starting` and
    // `stopping` were free to drift, and the transients below -- which the
    // row words from `pendingAction` rather than from `user.label` -- were
    // compared nowhere at all.
    let labels = fixture["userLabels"]["labels"]
        .as_array()
        .expect("pinned labels")
        .iter()
        .map(|label| label.as_str().expect("label").to_owned())
        .chain(
            aimux::transient_state::TRANSIENT_ACTIONS
                .iter()
                .map(|action| (*action).to_owned()),
        )
        .collect::<Vec<_>>();
    for user_label in &labels {
        let user_label = user_label.as_str();
        let served = aimux::project_service::session_semantics::published_status_label(user_label);
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
    assert!(
        labels.len() >= 28,
        "the label and transient sets must both be covered"
    );
}

/// `agent_one_answer` passes five inputs and defaults the other eleven, so
/// the CLI only agrees with the dashboard row while the word depends on those
/// five alone. Nothing pinned that, and a rule keyed on a count would have
/// diverged the two surfaces silently with every other gate green.
#[test]
fn the_published_word_depends_on_nothing_the_cli_cannot_pass() {
    let mut labels = std::collections::BTreeSet::new();
    let five = |status: &str,
                pending: Option<&str>,
                activity: Option<&str>,
                attention: Option<&str>,
                task: bool| SessionSemanticsInput {
        status: status.to_owned(),
        pending_action: pending.map(str::to_owned),
        activity: activity.map(str::to_owned),
        attention: attention.map(str::to_owned),
        has_active_task: task,
        ..SessionSemanticsInput::default()
    };
    let loaded = |mut input: SessionSemanticsInput| {
        input.unseen_count = 7;
        input.notification_unread_count = 3;
        input.latest_notification = Some(serde_json::json!({ "body": "look at me" }));
        input.latest_notification_text = Some("look at me".to_owned());
        input.thread_unread_count = 4;
        input.thread_pending_count = 5;
        input.thread_waiting_on_me_count = 6;
        input.thread_waiting_on_them_count = 2;
        input.workflow_on_me_count = 8;
        input.workflow_blocked_count = 9;
        input.workflow_family_count = 2;
        input
    };

    for (status, pending, activity, attention, task) in [
        ("running", None, Some("running"), None, false),
        ("running", None, None, None, false),
        ("running", None, None, None, true),
        ("waiting", None, None, None, false),
        ("idle", None, Some("done"), None, false),
        ("idle", None, Some("interrupted"), None, false),
        ("running", None, Some("error"), None, false),
        ("running", None, None, Some("needs_input"), false),
        ("running", None, None, Some("needs_response"), false),
        ("running", None, None, Some("blocked"), false),
        ("offline", None, Some("running"), None, false),
        ("offline", None, Some("waiting"), Some("needs_input"), false),
        (
            "running",
            Some("graveyarding"),
            Some("running"),
            None,
            false,
        ),
        ("running", Some("starting"), None, None, false),
        // `user_state`'s final arm. Without a case that lands here, a rule
        // keyed on an unread count would pass: the dashboard fills the counts
        // and the CLI defaults them to zero.
        ("idle", None, None, None, false),
        ("idle", None, None, Some("normal"), false),
        ("offline", None, None, None, false),
        ("graveyard", None, None, None, false),
        ("idle", None, None, None, true),
    ] {
        let bare = derive_session_semantics(five(status, pending, activity, attention, task));
        let busy =
            derive_session_semantics(loaded(five(status, pending, activity, attention, task)));
        assert_eq!(
            string_at(&bare, ["presentation", "statusLabel"]),
            string_at(&busy, ["presentation", "statusLabel"]),
            "counts, notifications and threads changed the word for \
             {status}/{pending:?}/{activity:?}/{attention:?}/{task}, which the \
             CLI cannot pass and so cannot agree about"
        );
        assert_eq!(
            string_at(&bare, ["user", "label"]),
            string_at(&busy, ["user", "label"]),
        );
        labels.insert(string_at(&bare, ["user", "label"]));
    }
    // Including the arm nothing used to reach. A combination list that misses
    // an arm leaves that arm free to read an input the CLI cannot pass.
    assert!(
        labels.contains("idle"),
        "no case reached the fall-through arm; reached {labels:?}"
    );
    assert!(labels.len() >= 10, "reached only {labels:?}");
}

/// The fixture's list of user labels is still every label `user_state` emits.
///
/// The app turns this label into the row's tone, and `normalizeAppStatusKind`
/// returns null for a word it does not know -- after which the row falls back
/// to `offline` and paints a live agent grey. A fifteenth label added without
/// teaching the app about it is therefore a silent wrong answer, not a crash,
/// so the set is pinned here and mapped on the app side.
#[test]
fn the_pinned_user_labels_are_still_the_ones_the_service_emits() {
    let body = {
        let start = SEMANTICS_SOURCE
            .find("fn user_state(")
            .expect("user_state is still in this file");
        let rest = &SEMANTICS_SOURCE[start..];
        let end = rest
            .find("\nfn user(")
            .expect("user_state is followed by user");
        &rest[..end]
    };

    let mut emitted = body
        .match_indices("user(\"")
        .map(|(at, _)| {
            let after = &body[at + "user(\"".len()..];
            after[..after.find('"').expect("a closed label literal")].to_owned()
        })
        .collect::<Vec<_>>();
    emitted.sort();
    emitted.dedup();
    assert!(
        !emitted.is_empty(),
        "found no labels; the scan is matching nothing rather than passing"
    );

    let pinned = fixture()["userLabels"]["labels"]
        .as_array()
        .expect("userLabels.labels")
        .iter()
        .map(|label| label.as_str().expect("a string label").to_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        emitted, pinned,
        "user_state's labels and the pinned set have drifted; add the new one to \
         the fixture and teach normalizeAppStatusKind about it"
    );
}

/// What the service says while an action is in flight, which is NOT what the
/// row shows.
///
/// The row answers an action from the action, because the optimistic overlay
/// invents the session before the service has seen it. That is only correct if
/// the two agree once the service does see it, so this pins the service half:
/// `statusLabel` prefers the action, and `user.label` does not know about it at
/// all for an action `runtime_lifecycle` does not name -- which is exactly why
/// the row cannot take its tone from the label.
#[test]
fn the_service_prefers_the_action_in_its_word_but_not_in_its_label() {
    let fixture = fixture();
    let action = fixture["optimisticAction"]["pendingAction"]
        .as_str()
        .expect("pendingAction");
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status: "running".to_owned(),
        activity: Some("idle".to_owned()),
        attention: Some("normal".to_owned()),
        pending_action: Some(action.to_owned()),
        ..SessionSemanticsInput::default()
    });

    assert_eq!(
        string_at(&semantic, ["presentation", "statusLabel"]),
        aimux::transient_state::transient_state_label(action),
        "the word prefers the action"
    );
    assert_eq!(
        string_at(&semantic, ["user", "label"]),
        "ready",
        "and the label does not know about it, which is why the row's tone \
         cannot come from here"
    );
}
