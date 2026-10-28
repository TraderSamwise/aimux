//! Why "clear the unread of departed sessions" is not the fix it looks like.
//!
//! The problem is real and measured. `notification_thread_awaits_a_reader`
//! force-retains a notification thread while any `unreadBy`/`waitingOn` holder
//! is somebody who could still read it, and a holder whose session has DEPARTED
//! never will -- so its thread is pinned for ever. PR #500 capped that set at
//! 1000 rather than explaining why it fills, and this is why.
//!
//! The obvious fix is a periodic task that asks the topology which sessions
//! still exist and strips the holders that do not. I wrote it. It is wrong, in
//! four ways that are each worth more than the bytes it would reclaim, and this
//! file exists so the next person finds that out in a minute rather than a day.
//!
//! WHAT IT WOULD BE WORTH. Measured 2026-10-28 across 21 local projects, 2524
//! `unreadBy` + `waitingOn` entries in all:
//!
//! | holder class                | count | what an absence test does to it |
//! |-----------------------------|-------|---------------------------------|
//! | `project`                   |  1419 | calls it departed -- WRONG      |
//! | a session still in topology |   792 | leaves it -- correct            |
//! | `user`                      |   215 | calls it departed -- WRONG      |
//! | a session absent from it    |    87 | clears it -- the whole prize    |
//! | a foreign shape             |    11 | clears it                       |
//!
//! Under 4% of the entries, against a force-retained set already bounded at
//! 1000. The one case that motivates it is a tail: a single long-lived
//! `claude-s75354` on sam-mbp2 held 379 entries by itself.
//!
//! WHY IT IS WRONG.
//!
//! 1. A missing topology reads as a COMPLETE topology with no sessions in it --
//!    `read_runtime_topology` returns `Ok(empty_runtime_topology())` for
//!    `ENOENT`. So "the read failed, clear nothing" never fires, and the first
//!    test below shows what an absence test concludes instead: that every
//!    holder in the store has departed, `project` and `user` included. That is
//!    2524 entries, not 87.
//! 2. Absence is not proof even when the file is there. Topology reconcile
//!    silently drops an offline row with no `command`/`tool`, and
//!    `prune_references` drops any session whose `nodeId` left `nodes`.
//! 3. Removing a holder is not a local edit. `inbox` is derived from
//!    `unreadBy` union `waitingOn`, a record's `unread` is that entry's state,
//!    and `update_runtime_exchange` applies retention to the mutator's own
//!    output in the SAME write -- so stripping the last holder can take the
//!    thread, its message and its record with it, and drop a number a user
//!    reads. A reviewer stopped this change once already for that reason.
//! 4. It would be a treadmill on coordination threads regardless:
//!    `thread_updated_for_message` rebuilds `unreadBy` from `participants`, so
//!    the holders come back on the next message. Only notification threads are
//!    written wholesale.
//!
//! So this is recorded rather than shipped, the way `947602-175` was: the
//! reason, plus the one gate that makes the trap visible. If it is ever built,
//! it needs the topology file to EXIST rather than merely read, provenance
//! (the thread's own `notificationSessionId`) rather than an id-shape guess,
//! notification threads only, `unreadBy` only -- never `waitingOn` -- a
//! per-run cap, and a deliberate decision that `/notifications` may legitimately
//! report a smaller unread count afterwards.

use aimux::runtime_topology::{list_topology_session_states, read_runtime_topology};
use std::collections::HashSet;

/// Every holder shape the live stores actually contain, with what it is.
///
/// Not invented: each of these was read out of a real
/// `~/.aimux/projects/*/runtime-exchange.yaml` on 2026-10-28.
const HOLDERS: &[(&str, &str)] = &[
    (
        "project",
        "the participant a notification with no session gets",
    ),
    (
        "user",
        "the default `from` when a request omits one -- a person",
    ),
    ("claude-76xi5s", "a managed session"),
    ("codex-ppfmvy", "a managed session"),
    (
        "019f6ede-fc05-73a1-9312-7f6475ab380a",
        "a backend session id, a different namespace",
    ),
    ("manual-test", "whatever somebody typed once"),
];

fn absent_topology_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-departed-unread-absent-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    ))
}

/// A topology that is not there reads as one with nothing in it.
///
/// This is the trap, and it is a contract rather than a bug:
/// `read_runtime_topology` answers `Ok(empty_runtime_topology())` for a missing
/// file so that a project which has never had a session is not an error. Every
/// caller that reads "no sessions" as "no sessions exist" is correct. A caller
/// that reads it as "every session I know of has departed" is not, and has no
/// error to key off.
///
/// If this test ever fails because the read started returning `Err` for a
/// missing file, that is good news -- and the thing to check is every caller
/// that was relying on the `Ok`, starting with `queued_session_disposition`,
/// which deliberately answers `Gone` on an unreadable topology because it is
/// classifying one queued entry whose caller just read the file successfully.
#[test]
fn a_missing_topology_reads_as_a_complete_topology_with_no_sessions() {
    let absent = absent_topology_path();
    assert!(!absent.exists(), "the fixture path must not exist");

    let topology = read_runtime_topology(&absent).expect(
        "a missing topology is Ok by contract; if this is now Err, read this file's \
         doc comment before celebrating",
    );
    let sessions = list_topology_session_states(&topology, None);
    assert!(
        sessions.is_empty(),
        "a missing topology should carry no sessions, found {}",
        sessions.len()
    );
}

/// And so an absence test calls EVERY holder departed, including the two that
/// cannot be.
///
/// This is the whole finding in one assertion. The task I did not ship asked
/// "is this holder in the topology?" and stripped it when the answer was no.
/// With the topology absent the answer is no for all of them -- so it would
/// have cleared `project`, which nothing is allowed to clear, and `user`, which
/// means a person was never told.
#[test]
fn an_absence_test_calls_every_holder_departed_when_the_topology_is_gone() {
    let absent = absent_topology_path();
    let topology = read_runtime_topology(&absent).expect("missing topology is Ok");
    let known: HashSet<String> = list_topology_session_states(&topology, None)
        .into_iter()
        .filter_map(|session| {
            session
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect();

    let departed: Vec<&str> = HOLDERS
        .iter()
        .map(|(holder, _)| *holder)
        .filter(|holder| !known.contains(*holder))
        .collect();

    assert_eq!(
        departed.len(),
        HOLDERS.len(),
        "the point of this test is that absence condemns all of them; \
         if some holder is now known, the fixture has drifted"
    );
    // Named rather than counted, so the failure reads as the hazard rather
    // than as arithmetic.
    assert!(
        departed.contains(&"project") && departed.contains(&"user"),
        "an absence test must be shown to condemn `project` and `user`, which \
         are the two holders no topology will ever list: {departed:?}"
    );
}
