//! Scheduler tasks run independently, but each watcher still needs a turn
//! budget so a stuck dependency cannot make its own loop pile up forever.

use aimux::project_service::scribe_watcher_task::{max_scan_candidates, scan_budget};
use aimux::project_service::watcher_delivery::{DELIVERY_TIMEOUT, READ_TIMEOUT, RailBudget};
use std::time::Duration;

#[test]
fn a_budget_reports_spent_only_once_its_allowance_has_passed() {
    let budget = RailBudget::new(Duration::from_secs(60));
    assert!(!budget.spent());
    assert!(budget.remaining() > Duration::from_secs(50));

    let spent = RailBudget::new(Duration::ZERO);
    assert!(spent.spent());
    assert_eq!(spent.remaining(), Duration::ZERO);
}

#[test]
fn a_pane_read_is_bounded_far_tighter_than_a_delivery() {
    // capturing a pane is one fast tmux call and a scan does a dozen of them;
    // a delivery is a call per line of the briefing
    assert!(
        READ_TIMEOUT < DELIVERY_TIMEOUT,
        "{READ_TIMEOUT:?} vs {DELIVERY_TIMEOUT:?}"
    );
    assert!(READ_TIMEOUT <= Duration::from_secs(3));
}

#[test]
fn a_scribe_scan_cannot_hold_a_scheduler_turn_for_a_minute() {
    let worst_case_without_budget = READ_TIMEOUT * max_scan_candidates() as u32 + DELIVERY_TIMEOUT;
    assert!(
        scan_budget() < worst_case_without_budget,
        "the budget must actually bite: {:?} vs {worst_case_without_budget:?}",
        scan_budget()
    );
    // a timed-out scribe turn should surface long before a full minute passes
    assert!(scan_budget() + DELIVERY_TIMEOUT <= Duration::from_secs(35));
}
