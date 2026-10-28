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
//! Every one of those shapes came out of a real
//! `~/.aimux/projects/*/runtime-exchange.yaml`: `project`, `user`,
//! `claude-76xi5s`, `codex-ppfmvy`, `019f6ede-fc05-73a1-9312-7f6475ab380a` (a
//! backend session id, a different namespace) and `manual-test` (whatever
//! somebody typed once). The namespace is mixed, which is why an id-SHAPE test
//! is no substitute for knowing who a notification was actually for.
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

use aimux::project_service::exchange_retention::{
    RUNTIME_EXCHANGE_RETENTION, compact_runtime_exchange,
};
use aimux::runtime_topology::{list_topology_session_states, read_runtime_topology};
use serde_json::{Value, json};

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

/// Stripping the last holder takes the thread, its message and its record.
///
/// THE REASON THAT MATTERS, and the one I had asserted from a reviewer's word
/// without testing -- on a branch that already had the helpers to test it.
///
/// Retention keeps a notification thread if it is among the newest
/// `unread_notification_threads` that still await a reader, OR among the newest
/// `notification_threads` overall. Take the last holder off an old thread and
/// it leaves the first set, is too old for the second, and goes -- and
/// `subject_exists` then drops its inbox entry because the subject is gone,
/// while `select_retained_messages` drops its message.
///
/// So the sweep's prize and its hazard are THE SAME EVENT. Below the plain cap
/// the thread is retained either way and nothing is reclaimed; above it, the
/// reclaim IS the record leaving `/notifications`, because a record's `unread`
/// is the state of that inbox entry and `unreadCount` counts those records.
/// There is no version of the task that frees the bytes without changing the
/// number, which is why this is a product decision and not a cleanup.
#[test]
fn removing_the_last_holder_takes_the_thread_its_message_and_its_record() {
    const OLD: &str = "2026-01-01T00:00:00.000Z";
    const NEW: &str = "2026-05-25T00:00:00.000Z";

    fn thread(index: usize, holders: &[&str], updated_at: &str) -> Value {
        json!({
            "id": format!("notification-{index}"),
            "title": format!("Notification {index}"),
            "kind": "notification",
            "status": "open",
            "createdAt": updated_at,
            "updatedAt": updated_at,
            "createdBy": "aimux",
            "participants": holders,
            "waitingOn": [],
            "unreadBy": holders,
            "tags": ["notification"],
            "lastMessageId": format!("message-{index}"),
        })
    }

    // Filled past the plain cap, so only the unread force-retain can keep the
    // old thread -- which is the regime every busy store is already in: three
    // of eighteen local projects carry more than this many notification
    // threads, at 770, 693 and 528.
    fn store(holders: &[&str]) -> Value {
        let mut threads = (0..RUNTIME_EXCHANGE_RETENTION.notification_threads)
            .map(|index| thread(1000 + index, &["codex-filler"], NEW))
            .collect::<Vec<_>>();
        threads.push(thread(1, holders, OLD));
        json!({
            "version": 1,
            "generatedAt": NEW,
            "threads": threads,
            "messages": [{
                "id": "message-1",
                "threadId": "notification-1",
                "from": "aimux",
                "body": "something happened",
                "createdAt": OLD,
            }],
            "inbox": [{
                "id": "inbox-1",
                "subjectKind": "thread",
                "subjectId": "notification-1",
                "state": "pending",
                "createdAt": OLD,
            }],
            "tasks": [], "handoffs": [], "reviews": [], "waits": []
        })
    }

    fn survivors(exchange: &Value) -> (bool, bool, bool) {
        let retained = compact_runtime_exchange(exchange);
        let has = |collection: &str, id: &str| {
            retained["retained"][collection]
                .as_array()
                .is_some_and(|rows| {
                    rows.iter()
                        .any(|row| row.get("id").and_then(Value::as_str) == Some(id))
                })
        };
        (
            has("threads", "notification-1"),
            has("messages", "message-1"),
            has("inbox", "inbox-1"),
        )
    }

    // Held by a session: the force-retain keeps all three.
    let held = survivors(&store(&["codex-gone"]));
    assert_eq!(
        held,
        (true, true, true),
        "a thread a session still holds should keep its message and record; \
         if this is false the fixture is wrong, not the finding"
    );

    // The sweep's edit, and nothing else: one holder removed.
    let stripped = survivors(&store(&[]));
    assert_eq!(
        stripped,
        (false, false, false),
        "removing the last holder should take the thread, its message and its \
         inbox record together -- that cascade is the whole reason this task \
         was not shipped, and if it no longer happens the finding needs redoing"
    );
}
