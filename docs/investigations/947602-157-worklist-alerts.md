# Closed work, inspectable thread IDs, and deliberate parking

Baseline: master `4712ecae9` (2026-10-18). Initial implementation commit:
`ff2fd0822`. This investigation separates real waiting work, deliberate inactivity,
and an inventory that could not be read. It does not repair the reported state by
deleting threads, changing ownership, or globally silencing the fleet.

## Reproduced baseline failures

The baseline gates executed production project routes, CLI classification/text
routing, or the real loop planner in isolated fixture contexts. These were
runtime assertion failures, not compilation or source-text failures.

| Gate | Observed baseline result | Required result |
| --- | --- | --- |
| `closing_a_thread_clears_waiting_and_stops_the_real_worklist_alert` | Closing returned `waitingOn: ["user"]` | Closing clears `waitingOn` |
| `the_thread_id_advertised_by_the_loop_briefing_resolves_through_the_cli_route` | The real briefing advertised `t:thread-obligation`; CLI `thread show` returned 404 for it | Advertise the actual thread ID and resolve it through the CLI route |
| `thread_and_worklist_reads_distinguish_empty_actionable_and_unreadable_state` | Persisted `threads: {}` returned HTTP 200 with an empty worklist | Return HTTP 500 with the read/schema error |
| `non_loop_idle_session_can_be_parked_without_reentering_managed_loop` | Pause returned 409, `session is not in a loop` | Allow safe, explicit parking of an idle non-loop session |
| `work_inventory_empty_present_and_unavailable_are_distinct` | The planner failed the required `Work inventory unavailable` assertion | Preserve inventory failure as a separate diagnostic |

The captured logs are `/tmp/aimux-157-baseline-close.log`,
`/tmp/aimux-157-baseline-threads.log`,
`/tmp/aimux-157-baseline-thread-errors.log`,
`/tmp/aimux-157-baseline-parking.log`, and
`/tmp/aimux-157-baseline-outcomes.log`. The first combined thread run also
poisoned the test isolation mutex after the genuine CLI-ID failure; those
subsequent lock failures are not independent reproductions. Closure and schema
failure were rerun individually to obtain the valid failures above.

## Thread closure and responsibility

`runtime_exchange::thread_is_terminal` is the shared Rust rule for `closed`,
`done`, and `abandoned`. The status mutation clears waits for every terminal
status, including when a caller supplies an explicit `waitingOn`. Read-time
projections also apply the rule, so old persisted terminal threads with stale
waits or undelivered messages do not need a destructive data migration.

The worklist retains terminal history in its handled section, but does not
advertise it as actionable or pending. The desktop thread waiting/pending
counters and workflow recommendations use the same terminal decision. Derived
thread waits are satisfied; stale waits no longer produce waiting inbox rows.
Unread history remains unread until acknowledged. Closing a thread therefore
does not pretend its messages were read.

Responsibility is also shared: nonempty `waitingOn` names the participants who
hold the next action; the stored `owner` is the fallback only when nobody is
awaited. A completed worker's task can be `done` while its conversation remains
`waiting` on the assigner for review. The retained worker owner field must not
make that worker look stalled or prevent its deliberate parking.

The worklist row key remains `t:<thread-id>` for namespaced UI identity and
deduplication. Loop text takes the actual ID from `thread.thread.id` instead of
using that row key as a CLI argument. The test follows the advertised ID through
`classify_core_cli`, the real daemon collaboration text router, and an adapter
that dispatches the actual project-service thread route. An unknown raw ID still
returns 404.

Recovered Node predecessors `a9220736^:src/threads.ts` and
`a9220736^:src/coordination-model.ts` cleared only `done`/`abandoned`, allowed
explicit waits to win, and derived actionability from waits/pending delivery
without a terminal gate. Terminal closure and stale-state suppression are
intentional corrections to that behavior; the namespaced worklist key is
preserved.

## Per-session parking

The existing `aimux loop pause <id>` path now distinguishes active managed-loop
pauses from parking an idle session outside a loop. Parking does not activate a
managed loop or pause the fleet. The project service authorizes the mutation and
stores `loopAlertsParked` metadata; clients do not write that state directly.

A park requires all of the following:

- A starting/running/idle topology session backed by its exact live tmux
  session/window binding.
- Known `idle` or `done` activity and complete session identity.
- Successfully read topology, live-window inventory, metadata, and exchange.
- No active task assigned to that session (`pending`, `assigned`,
  `in_progress`, or `blocked`) and no nonterminal thread for which that session
  currently holds responsibility.

Busy, unknown, offline, foreign-window, and active-owned-work cases refuse with
a concrete reason. Unavailable inventory returns an error instead of granting
parking. A stale terminal thread does not prevent parking. The park is bound to
session ID, creation time, tmux session/window, and the session's own work
fingerprint. Unrelated metadata changes or unassigned backlog do not revoke it.
A recycled session/window cannot inherit it.

New owned work, a new responsible thread, resumed busy/running activity, changed
identity, or explicit unpause rearms alerts. Scheduler scans durably invalidate
stale parking; an old scan uses an expected-value comparison so it cannot erase
a newer deliberate park. Parked idle sessions are included in live activity
probes so resumed work can be observed even without a new input request.
Ordinary non-loop idle sessions do not gain that extra probe.

## Inventory has three outcomes

An empty worklist means successfully inspected with no work. A populated
worklist means real work is available. Missing/malformed worklist contracts or
failed reads mean unknown, with a `Work inventory unavailable` diagnostic that
includes the cause. An error is neither an empty list nor a fabricated unowned
work item. The scheduled reader propagates failed exchange reads.

Exchange normalization validates present thread/task arrays and records rather
than defaulting malformed containers to empty. Records require IDs; present
ownership/status fields must have their supported scalar shape, and present
thread participant/wait/unread fields must be arrays of strings. Legacy absent
arrays and absent optional ownership/status fields remain accepted. Other
exchange arrays retain their existing normalization behavior; this is scoped to
the thread/task ownership inventory used by the decisions above.

## Audit follow-ups and regression gates

The first local audit followed parking beyond the route into scheduled scans and
thread-only work. It added durable scheduler invalidation, parked-session live
probes, thread responsibility checks, and the inverse where a finished task's
assigner holds the next action. The same audit followed terminal semantics into
desktop counters and derived indexes, and extended schema validation to task
ownership so malformed tasks cannot falsely authorize parking.

The second audit followed old notifications and buffered sends. A deliberately
parked self-exit must stay quiet for a restarted watcher or a newly added
overseer. Buffered exit, idle-fleet, and managed-loop briefings are checked
against current work and parking before delivery, so a queued old message cannot
resurrect a finished agent. The inverse retains delivery when the original
unparked conditions still hold.

The scoped regression targets are:

- `project_service_worklist_alerts`: real closure/status routes, stale terminal
  waits/delivery, explicit-wait precedence, desktop/worklist/index agreement,
  advertised CLI IDs, and empty/work/error reads with legacy inverses.
- `project_service_loop_parking`: CLI-to-route parking, active-owned-work and
  activity/inventory refusals, session/window identity, new assignments and
  thread-only work, scheduler rearming, finished-worker handback, stale-scan
  races, self-exits, and buffered-send freshness, with nonparked inverses.
- `loop_watcher_worklist_outcomes`: empty/present/unavailable inventory and
  invalid parking metadata that must not hide a genuine stall.

## Initial mutation verification

The initial matrix tested production source at `fbec0abad`, before the later
aggregate-buffer correction. Fourteen independent production mutations produced
17 named runtime assertion failures; restoring each mutation passed the same
17 exact tests (14 primary runs plus three additional runs). Each invocation
selected one test with `--exact`: the failed runs reported one failed test and
the restored runs reported one passed test. There were no compiler failures,
zero-test runs, skips, or poisoned-lock follow-ons counted in this matrix.

| Injected production fault | Named failing test or tests |
| --- | --- |
| Remove `closed` from the shared terminal-status rule | `closing_a_thread_clears_waiting_and_stops_the_real_worklist_alert`; `terminal_threads_with_stale_waiting_and_delivery_are_handled_while_open_work_still_alerts` |
| Advertise the namespaced row key as the thread ID | `the_thread_id_advertised_by_the_loop_briefing_resolves_through_the_cli_route` |
| Admit parked sessions as idle-fleet capacity | `non_loop_idle_session_can_be_parked_without_reentering_managed_loop` |
| Suppress genuine idle/done fleet capacity | `unparked_stalled_non_loop_worker_still_alarms_after_dwell` |
| Convert an inventory error into synthetic actionable unowned work | `work_inventory_empty_present_and_unavailable_are_distinct` |
| Remove thread-schema validation | `thread_and_worklist_reads_distinguish_empty_actionable_and_unreadable_state` |
| Remove scheduled durable parking refresh | `scheduled_loop_watcher_removes_parking_when_work_resumes_before_a_later_stall` |
| Omit parked idle sessions from live probes | `live_probe_selection_includes_parked_idle_sessions_but_not_ordinary_idle_sessions` |
| Accept new input without clearing session parking | `agent_input_auto_unpauses_loop_alerts_before_accepting_real_work` |
| Ignore idle-owned thread-only work | `unparked_worker_stalled_on_owned_or_waiting_thread_alarms_without_tasks` |
| Prefer stored thread owner over waiting recipients | `completing_assigned_task_leaves_finished_worker_quiet_and_parkable_while_assigner_reviews` |
| Remove expected-value protection from parking refresh | `stale_scan_cannot_erase_a_newer_deliberate_park` |
| Let parked self-exits generate new notifications | `parked_self_exited_agents_stay_quiet_for_fresh_and_new_overseer_recipients` |
| Replay buffered sends without current-state validation | `buffered_old_exit_and_idle_fleet_alerts_do_not_flush_after_parking_and_closed_work`; `buffered_idle_fleet_alert_does_not_flush_when_work_closed_without_parking`; `buffered_active_loop_briefing_cannot_resurrect_an_agent_after_loop_removal_and_parking` |

The five requested failure classes have concrete observations: closing again
returned `["user"]` instead of `[]`; the advertised `t:` ID again returned CLI
404; deliberately parked capacity generated an alert; the genuine unparked
stall produced no sends; and the inventory-error mutation lost the required
`Work inventory unavailable` diagnostic. The additional stale-terminal test
showed a closed thread in `needsYou` with `stateLabel: "on me"` and one pending
delivery. These failures exercise decisions in production paths rather than
source spelling.

The matrix is captured in `/tmp/aimux-157-mutation-results.json`, with per-run
logs named in that report and the final marker
`ALL_MUTATIONS_FAILED_AND_RESTORED_PASS 14` in
`/tmp/aimux-157-mutations-progress.log`. The runner checked original source bytes
between experiments and restored all three production files in its cleanup.
The captured SHA-256 values in
`/tmp/aimux-157-mutation-source-sha256.json` match those files at `fbec0abad`:

| Production file under `native/crates/aimux/src/` | SHA-256 |
| --- | --- |
| `loop_watcher.rs` | `4076eddbe9a723a88d439616d0aed1adf9d4eb12e4d2848572b8b7acb5e48367` |
| `project_service/runtime_exchange.rs` | `393fcbfb98233389eb1ed3d67e8ef28a3b63751af56db4603b9912c58ba42a2e` |
| `project_service/loop_watcher_task.rs` | `0a38215ab3fb708866b68789659ff91c58dffc3a1d7ee0f5f2c52038d7e269e4` |

## Aggregate-buffer follow-up

The inverse audit during proof work found a further real runtime failure:
`buffered_aggregate_briefing_keeps_unfinished_worker_after_another_worker_is_removed_and_parked`
failed with `parking one worker must not silence another unfinished worker`.
The captured baseline is `/tmp/aimux-157-baseline-aggregate-buffer.log`; this was
one selected runtime test failure, not a compiler error. Rejecting an entire
aggregate briefing when any old candidate became parked was too broad.

The follow-up filters current candidates within aggregate buffered briefings
and preserves unfinished, unparked workers. Related inverse gates cover the
direct delivery queue and a later planner scan, including deduplication of the
refreshed buffer against a fresh briefing. Single-worker inverses cover managed
pause and loop removal without relying on non-loop parking. These tests were
added after the initial 14-experiment matrix; that matrix is not a claim about
the final production head.

## Final-source counterfactuals

Two additional production experiments tested the aggregate-buffer correction at
`ef51bfc1d687e15b46e1706f62c96f49fb796fbf`. They produced seven exact named
runtime assertion failures, each followed by a passing restored run:

| Injected production fault | Named failing test or tests |
| --- | --- |
| Drop the entire buffered aggregate when one member becomes parked | `buffered_aggregate_briefing_keeps_unfinished_worker_after_another_worker_is_removed_and_parked` |
| Bypass all buffered-send freshness checks | `buffered_old_exit_and_idle_fleet_alerts_do_not_flush_after_parking_and_closed_work`; `buffered_idle_fleet_alert_does_not_flush_when_work_closed_without_parking`; `buffered_active_loop_briefing_cannot_resurrect_an_agent_after_loop_removal_and_parking`; `buffered_managed_loop_briefing_is_discarded_after_active_loop_pause`; `buffered_managed_loop_briefing_is_discarded_after_loop_removal_without_parking`; `buffered_aggregate_briefing_keeps_unfinished_worker_after_another_worker_is_removed_and_parked` |

The broad-drop fault again failed because parking one worker silenced another
unfinished worker. The freshness bypass delivered obsolete exit, closed-work,
parked-loop, paused-loop, and removed-loop reminders. Its aggregate failure
specifically showed the parked worker still present in the rendered briefing.
Every failed invocation executed one named test and failed at its runtime
assertion; every restoration executed and passed that same test. No compiler
failures, zero-test runs, or skips were used as evidence.

The final experiments are captured in
`/tmp/aimux-157-final-mutation-results.json` and their per-run logs. The runner
finished with `ALL_FINAL_MUTATIONS_FAILED_AND_RESTORED_PASS 2` in
`/tmp/aimux-157-final-mutations-progress.log`. Its captured
`loop_watcher.rs` SHA-256,
`6a9621246681992007a44451cff15170e3f1a732e16dd8d3e4f908b8b56c99cb`,
matches both that production commit and the restored worktree bytes; the report
is `/tmp/aimux-157-final-mutation-source-sha256.json`.

Across both phases, this is 16 independent experiments and 24 failing/passing
restoration pairs across 20 distinct named gates. Fourteen experiments tested
`fbec0abad`; two tested `ef51bfc1d687e15b46e1706f62c96f49fb796fbf`.
They were not all rerun on the final head. The buffer refinement leaves the
earlier unrelated fault points intact, and the changed buffered-send method was
tested again by the final experiments.

## Scoped verification

The final post-restoration run passed 265 tests across nine scoped integration
targets, with zero failures or ignored tests (`/tmp/aimux-157-final-integration.log`).
The real input-delivery gate also passed again, covering both active-loop and
parked-session pauses (`/tmp/aimux-157-final-input.log`). The runtime-exchange
store fixture passed; its original 19 corpus cases remain unchanged.

Root `yarn verify` passed on the last production changes in 80.73 seconds. The
eight coordination fixture tests and two desktop fixture tests also passed.
The coordination corpus expectation for unreadable inventory was deliberately
changed from a fabricated unowned-work row to the dedicated inventory-error
diagnostic, matching the explicit correction to the Node-era fallback. This
preserves the error's visibility without treating it as assignable work.

These gates exercise isolated production routes, scheduler/planner paths, and
the delivery queue. They do not establish that an already running installed
daemon or shared agent fleet has changed; no live-fleet validation is claimed
by this document.
