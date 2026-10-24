//! What an agent's row says about it, decided once.
//!
//! The dashboard row carried a ladder of chips -- threads unread, new
//! activity, pending, waiting on you, waiting on them, coordination -- and the
//! app's row carried none of them. Not because the app chose differently:
//! nothing ever handed it the list, so the two surfaces answered "what is
//! going on with this agent" differently depending on where you looked.
//!
//! Each chip is a fact the unread badge cannot carry. `threadUnreadCount` and
//! the notification unread count are disjoint by construction --
//! `summarize_thread_stats` skips every notification-tagged thread and
//! `summarize_notification_stats` skips every thread that is not one -- so
//! folding them into the badge would make a badge that never clears, because
//! `mark_session_viewed` only clears the notification-tagged ones.
//!
//! So the ladder lives here, the project service publishes it, and a renderer
//! renders what it is given. The order is this module's decision; how many fit
//! is the surface's, through [`visible_row_chips`], which filters this order
//! rather than computing another one.

use serde::{Deserialize, Serialize};

use crate::project_service::session_semantics::capped_count_label;

pub const FRESH_RESTORE_NOTICE: &str = "Fresh start; history not resumed";

/// How a chip reads. The names are what a renderer maps to its own palette;
/// which tone a fact deserves is decided here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowChipTone {
    /// Someone is waiting on the person reading the row.
    Attention,
    Danger,
    /// The agent's own work, in flight.
    Work,
    Info,
    Muted,
}

/// One chip on an agent's row.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChip {
    /// A stable slug, so a surface can style, filter or test for a chip
    /// without parsing its label.
    pub kind: String,
    pub label: String,
    pub tone: RowChipTone,
}

impl RowChip {
    fn new(kind: &str, label: impl Into<String>, tone: RowChipTone) -> Self {
        Self {
            kind: kind.to_owned(),
            label: label.into(),
            tone,
        }
    }
}

/// Everything the ladder reads. All counts are the derived ones, so a chip
/// cannot disagree with the number the details pane shows.
#[derive(Debug, Clone, Default)]
pub struct RowChipsInput {
    /// A dead agent's facts are still true but nothing is happening, so every
    /// chip reads muted rather than calling for attention.
    pub offline: bool,
    /// The project service's restore disclosure, rendered verbatim.
    pub restore_notice: Option<String>,
    pub waiting_on_me_count: i64,
    pub workflow_blocked_count: i64,
    /// The sub-agent summary's own label, already spelled by the service.
    pub subagent_label: Option<String>,
    pub thread_unread_count: i64,
    pub activity_new_count: i64,
    pub pending_delivery_count: i64,
    /// Input sitting in the delivery queue for this agent, which is a
    /// different fact from `pending_delivery_count` -- that one counts thread
    /// messages. An agent whose window is gone keeps its queued input until it
    /// comes back, and this is the only place that says so.
    pub queued_input_count: i64,
    pub waiting_on_them_count: i64,
    pub family_count: i64,
}

/// The chips for one agent, most worth reading first.
///
/// The order is the decision: something waiting on a person outranks the
/// agent's own work, which outranks a count nobody has to act on. A surface
/// that can only fit two shows the first two.
pub fn agent_row_chips(input: &RowChipsInput) -> Vec<RowChip> {
    let tone = |active: RowChipTone| {
        if input.offline {
            RowChipTone::Muted
        } else {
            active
        }
    };
    let mut chips = Vec::new();
    if let Some(label) = input
        .restore_notice
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        chips.push(RowChip::new(
            "restore-notice",
            label,
            tone(RowChipTone::Attention),
        ));
    }
    // The pane says "on me" and the compact hint says "on you"; the row is
    // read by the person being waited on, so it says "you".
    if input.waiting_on_me_count > 0 {
        chips.push(RowChip::new(
            "waiting-on-me",
            "waiting on you",
            tone(RowChipTone::Attention),
        ));
    }
    if input.workflow_blocked_count > 0 {
        chips.push(RowChip::new(
            "coordination-blocked",
            "coordination blocked",
            tone(RowChipTone::Danger),
        ));
    }
    // Ahead of the coordination counts: this is the agent's own work rather
    // than something waiting on someone else.
    if let Some(label) = input
        .subagent_label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        chips.push(RowChip::new("subagents", label, tone(RowChipTone::Work)));
    }
    if input.thread_unread_count > 0 {
        chips.push(RowChip::new(
            "threads-unread",
            format!(
                "{} threads unread",
                capped_count_label(input.thread_unread_count)
            ),
            tone(RowChipTone::Work),
        ));
    }
    if input.activity_new_count > 0 {
        chips.push(RowChip::new(
            "new-activity",
            format!(
                "{} new activity",
                capped_count_label(input.activity_new_count)
            ),
            tone(RowChipTone::Info),
        ));
    }
    if input.queued_input_count > 0 {
        chips.push(RowChip {
            kind: "queued-input".into(),
            label: format!("{} queued", capped_count_label(input.queued_input_count)),
            tone: RowChipTone::Attention,
        });
    }
    if input.pending_delivery_count > 0 {
        chips.push(RowChip::new(
            "pending",
            // Undelivered is in flight, not failed.
            format!(
                "{} pending",
                capped_count_label(input.pending_delivery_count)
            ),
            tone(RowChipTone::Work),
        ));
    }
    if input.waiting_on_them_count > 0 {
        // Muted whether or not the agent is alive: nobody has to do anything
        // about it here.
        chips.push(RowChip::new(
            "waiting-on-them",
            "waiting on them",
            RowChipTone::Muted,
        ));
    }
    if input.family_count > 0 {
        chips.push(RowChip::new(
            "coordination",
            format!("coordination {}", input.family_count),
            RowChipTone::Muted,
        ));
    }
    chips
}

/// The chips a surface with room for `budget` of them shows, and whether there
/// were more.
///
/// The surface decides how many fit; it does not decide which. Dropping the
/// rest in silence is the part that would be wrong, so a surface that gets
/// `true` says there is more -- the dashboard with one muted glyph, the app
/// with its own.
pub fn visible_row_chips(chips: &[RowChip], budget: usize) -> (Vec<RowChip>, bool) {
    if chips.len() <= budget {
        return (chips.to_vec(), false);
    }
    (chips[..budget].to_vec(), true)
}

/// The chips a renderer was handed, from the published `rowChips` value.
///
/// An absent or unexpected shape is an empty list rather than a parse failure:
/// a build that publishes something else should cost a row its chips, not its
/// row.
///
/// Filtered per entry rather than all-or-nothing, because the app's reader is:
/// one malformed chip costing the terminal every chip while the app rendered
/// the rest is two surfaces disagreeing, which is the thing this ladder exists
/// to stop.
pub fn published_row_chips(chips: Option<&serde_json::Value>) -> Vec<RowChip> {
    chips
        .and_then(serde_json::Value::as_array)
        .map(|chips| {
            chips
                .iter()
                .filter_map(|chip| serde_json::from_value::<RowChip>(chip.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(chips: &[RowChip]) -> Vec<&str> {
        chips.iter().map(|chip| chip.kind.as_str()).collect()
    }

    fn busy() -> RowChipsInput {
        RowChipsInput {
            offline: false,
            restore_notice: None,
            waiting_on_me_count: 2,
            workflow_blocked_count: 1,
            subagent_label: Some("2 sub-agents".to_owned()),
            thread_unread_count: 8,
            activity_new_count: 5,
            pending_delivery_count: 3,
            queued_input_count: 0,
            waiting_on_them_count: 1,
            family_count: 4,
        }
    }

    #[test]
    fn nothing_happening_says_nothing() {
        assert!(agent_row_chips(&RowChipsInput::default()).is_empty());
    }

    #[test]
    fn the_order_puts_what_waits_on_a_person_first() {
        assert_eq!(
            kinds(&agent_row_chips(&busy())),
            vec![
                "waiting-on-me",
                "coordination-blocked",
                "subagents",
                "threads-unread",
                "new-activity",
                "pending",
                "waiting-on-them",
                "coordination",
            ]
        );
    }

    #[test]
    fn each_chip_says_what_it_is() {
        let chips = agent_row_chips(&busy());
        let labels = chips
            .iter()
            .map(|chip| chip.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                "waiting on you",
                "coordination blocked",
                "2 sub-agents",
                "8 threads unread",
                "5 new activity",
                "3 pending",
                "waiting on them",
                "coordination 4",
            ],
            "the row used to pack these into `thread 8/0/5`, which nobody could read"
        );
    }

    #[test]
    fn a_count_past_a_hundred_is_capped_the_way_every_other_count_is() {
        let chips = agent_row_chips(&RowChipsInput {
            thread_unread_count: 120,
            ..RowChipsInput::default()
        });
        assert_eq!(chips[0].label, "99+ threads unread");
    }

    #[test]
    fn a_dead_agents_facts_are_still_true_but_nothing_is_happening() {
        let chips = agent_row_chips(&RowChipsInput {
            offline: true,
            ..busy()
        });
        assert_eq!(
            kinds(&chips).len(),
            8,
            "offline hides nothing -- it only stops the row shouting"
        );
        assert!(
            chips.iter().all(|chip| chip.tone == RowChipTone::Muted),
            "every chip reads muted: {chips:?}"
        );
    }

    #[test]
    fn a_live_agent_keeps_the_tone_each_fact_deserves() {
        let chips = agent_row_chips(&busy());
        let tone = |kind: &str| {
            chips
                .iter()
                .find(|chip| chip.kind == kind)
                .map(|chip| chip.tone)
                .expect("the chip is there")
        };
        assert_eq!(tone("waiting-on-me"), RowChipTone::Attention);
        assert_eq!(tone("coordination-blocked"), RowChipTone::Danger);
        assert_eq!(tone("subagents"), RowChipTone::Work);
        assert_eq!(tone("new-activity"), RowChipTone::Info);
        // Muted while alive, because nobody has to do anything about it here.
        assert_eq!(tone("waiting-on-them"), RowChipTone::Muted);
    }

    #[test]
    fn a_blank_subagent_label_is_not_a_chip() {
        let chips = agent_row_chips(&RowChipsInput {
            subagent_label: Some("   ".to_owned()),
            ..RowChipsInput::default()
        });
        assert!(chips.is_empty());
    }

    #[test]
    fn a_surface_decides_how_many_fit_not_which() {
        let chips = agent_row_chips(&busy());
        let (visible, more) = visible_row_chips(&chips, 2);
        assert_eq!(
            kinds(&visible),
            vec!["waiting-on-me", "coordination-blocked"]
        );
        assert!(more, "and it has to say there is more");
        let (all, more) = visible_row_chips(&chips, chips.len());
        assert_eq!(all.len(), chips.len());
        assert!(!more);
        // A surface with no room for any still reports that there are some,
        // rather than rendering a row that looks quiet.
        let (none, more) = visible_row_chips(&chips, 0);
        assert!(none.is_empty());
        assert!(more);
    }

    #[test]
    fn the_published_shape_round_trips() {
        let chips = agent_row_chips(&busy());
        let presentation = serde_json::json!({ "rowChips": chips });
        assert_eq!(
            published_row_chips(presentation.get("rowChips")),
            chips,
            "what the service published is what a renderer reads back"
        );
        // An absent key is a row with nothing to say, not a parse failure.
        assert!(published_row_chips(None).is_empty());
        // A shape from another build costs the row its chips rather than its
        // row: nothing to render, and nothing thrown.
        let wrong = serde_json::json!([{ "kind": "x" }]);
        assert!(published_row_chips(Some(&wrong)).is_empty());
        assert!(published_row_chips(Some(&serde_json::json!({}))).is_empty());
        // One bad chip costs that chip, the way the app's reader costs it --
        // all-or-nothing here would have the terminal render none while the
        // app rendered the rest.
        let mixed = serde_json::json!([{ "kind": "x" }, chips[0], { "label": "y" }]);
        assert_eq!(published_row_chips(Some(&mixed)), vec![chips[0].clone()]);
    }

    #[test]
    fn the_tone_names_are_what_a_client_reads() {
        let chips = agent_row_chips(&busy());
        let encoded = serde_json::to_value(&chips).expect("chips encode");
        assert_eq!(encoded[0]["tone"], "attention");
        assert_eq!(encoded[0]["kind"], "waiting-on-me");
        assert_eq!(encoded[0]["label"], "waiting on you");
    }
}
