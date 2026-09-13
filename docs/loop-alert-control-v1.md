# Loop Alert Control v1

## Problem

The loop watcher already has edge-aware machinery, but tonight showed it still
repeated identical overseer briefings and missed the opposite failure: queued
work sitting unowned while loop agents were idle. The fix should be one
project-service alert-control mechanism, not four local patches for dedupe,
per-agent pause, global pause, and reconciliation.

This document starts from the shipped implementation, because the first design
mistake was assuming the watcher was level-only. It is not. The bug is that the
edge state is volatile and is mutated through a delivery protocol that cannot
reliably remember what happened.

## Diagnosis

The current loop watcher is already edge-aware:

- `LoopWatcher` stores `last_candidate_signature`,
  `last_overseer_reported_signature`, `unchanged_candidate_ticks`,
  `last_overseer_wake_at`, `last_nudge_at`, and `stopped_since` in memory.
- `candidate_signature` uses session id, loop `since`, goal, and loop source.
- `overseer_reminder_due` backs off unchanged candidates by
  `unchangedReminderTicks` and cooldown.
- Empty candidate sets clear active candidate/report signatures and the
  unchanged tick count.

That means the repeated briefing problem is not "the watcher needs edges." The
shipped watcher already tries to distinguish edges from unchanged levels. The
diagnosed failures are narrower and more useful:

1. State is process memory. `LoopWatcherTask::new` constructs
   `LoopWatcher::new()`, so a project-service restart, task rebuild, or daemon
   restart forgets which candidate was already reported, which agents were in a
   dwell window, and how many unchanged ticks have elapsed. After a restart an
   unchanged stopped agent looks new again.

2. The scheduled task uses a two-phase protocol that mutates state during the
   dry run. It calls `scan` once with `collect = |_send| false` to discover
   sends, performs delivery, then calls `scan` again with a commit closure only
   if at least one send delivered. Because `scan` updates
   `last_candidate_signature` and `unchanged_candidate_ticks` before it knows
   whether delivery happened, one scheduler tick can advance unchanged state
   twice. If delivery fails completely, the commit scan is skipped, so
   `last_overseer_reported_signature` is not recorded. The task has observed
   the candidate but cannot record "this alert was attempted and failed" as a
   first-class outcome.

3. The dry-run/commit split makes failure indistinguishable from silence at the
   control layer. A failed send does not become a durable `failed` outcome with
   the message id, recipient, and child error. On the next scan the same fact is
   planned again. That explains repeated identical briefings better than a
   missing feature would.

4. The current signature can over-fire and under-fire. Re-adding an already
   looped agent rewrites `loop.since`, so the same stopped work can look like a
   new candidate. A live-activity bucket such as `idle` versus `done` would make
   this worse, because pane-tail probes can flap while the semantic fact is the
   same. Conversely, a stop/run/stop cycle that happens entirely between two
   15s scans is invisible to a pure scanner; it can look like one unchanged
   level unless lifecycle events also bump the alert episode.

5. The original reconciliation proposal named `gqaapg-*` queue items, but those
   items live in `~/cs/docs/agent-queue/aimux/QUEUE.md`, outside this repo and
   outside the project-service runtime exchange. The current service cannot see
   them. A design that claims to catch that queue without a new input source is
   lying.

These are the constraints the design has to satisfy.

## Goals

- Preserve and repair the existing stopped-loop edge semantics.
- Make alert state durable across project-service and daemon restarts.
- Separate alert planning from delivery commit so a scan cannot mutate edge
  state twice or forget failed delivery.
- Add per-agent pause without removing loop membership.
- Add project-wide human pause for alert delivery, while still buffering what
  would have been sent.
- Dedupe identical overseer messages while the overseer is working.
- Add reconciliation for visible work sources the project service can actually
  read, and state plainly what it cannot see.
- Surface state in the TUI in real terms without noisy alarms.

## Non-Goals

- Do not build a new task assignment system.
- Do not change what "loop active" means.
- Do not hide genuine new information behind dedupe.
- Do not make the dashboard write runtime-exchange, topology, tasks, threads,
  notifications, or graveyard state directly.
- Do not wire this into a client-only timer.
- Do not claim coverage for the external `gqaapg` queue until it is imported or
  exposed through a project-service-readable source.

## Proposed Shape

Introduce a project-service owned `LoopAlertController` driven by the shared
scheduler rail as a `PeriodicTask`. It replaces volatile watcher memory with a
durable alert-control store and replaces `scan(deliver)` with a pure
plan/commit flow:

1. Read inputs.
2. Build alert facts.
3. Compare facts with durable active fingerprints and reminder state.
4. Produce an alert plan without mutating delivery state.
5. Deliver planned sends with bounded, named outcomes.
6. Commit the outcomes exactly once.

The controller reads facts from:

- Runtime/topology plus metadata: loop membership, session liveness, derived
  activity, overseer identity, and live activity probes.
- Runtime exchange through `try_read_runtime_exchange`: tasks, threads,
  messages, assignment state, delivery state, and unowned work visible to the
  project service.
- Alert-control store: pause state, buffered alerts, active fingerprints,
  edge/reminder counters, delivery outcomes, and loop episodes.

It writes only the alert-control store and uses normal project-service delivery
paths to message the overseer or agents. It does not mutate topology, runtime
exchange work records, or session lifecycle state except through explicit API
routes such as pause/unpause.

## State Model

Each active loop agent has one alert state:

- `unwatched`: no active loop metadata. The controller ignores it.
- `watched`: active loop metadata and no per-agent pause. It participates in
  stopped-agent alerts and reconciliation.
- `paused`: active loop metadata plus alert pause metadata. It remains in the
  loop but is excluded from stopped-agent reminders and idle-capacity matching.

Per-agent pause is not watch/unwatch. It means "do not remind me that this
watched agent is stopped right now." Removing loop membership means "this agent
is no longer part of the managed loop."

Global pause is project-wide delivery state, not a fourth per-agent state:

- Per-agent pause filters facts before alert planning.
- Global pause applies after planning and buffers planned alerts.

That ordering is important. During global pause the system should still know
what it would have said. During per-agent pause, the agent is intentionally not
part of stopped-loop alerting except for a low-frequency paused summary.

## Durable Store

Use one project-service store in the project state dir, for example
`loop-alert-control.json`.

Recommended shape:

```json
{
  "version": 1,
  "globalPause": {
    "enabled": false,
    "updatedAt": "...",
    "updatedBy": "...",
    "reason": "human intervention",
    "expiresAt": "..."
  },
  "agents": {
    "codex-123": {
      "state": "paused",
      "pausedAt": "...",
      "pausedBy": "...",
      "reason": "waiting for user review",
      "loopEpisodeId": "...",
      "lastPausedReminderTick": 120
    }
  },
  "loopEpisodes": {
    "codex-123": {
      "episodeId": "...",
      "goalHash": "...",
      "loopSource": "manual",
      "firstSeenAt": "...",
      "lastSeenAt": "..."
    }
  },
  "alerts": {
    "active": {
      "stopped-loop-agents:<fingerprint>": {
        "firstSeenAt": "...",
        "lastSeenAt": "...",
        "unchangedTicks": 3,
        "lastOutcome": "queued"
      }
    },
    "queued": {
      "stopped-loop-agents:<fingerprint>": {
        "firstQueuedAt": "...",
        "lastSeenAt": "...",
        "recipient": "codex-overseer",
        "messageHash": "..."
      }
    },
    "buffered": [
      {
        "kind": "stopped-loop-agents",
        "fingerprint": "...",
        "firstBufferedAt": "...",
        "lastSeenAt": "...",
        "seenCount": 4,
        "message": "..."
      }
    ],
    "failures": [
      {
        "at": "...",
        "kind": "stopped-loop-agents",
        "recipient": "codex-overseer",
        "messageId": "...",
        "error": "agent input delivery timed out after 15s"
      }
    ]
  }
}
```

The exact field names can move during implementation. The invariant is that
alert-control state is durable project-service state, not accidental watcher
memory or a dashboard cache.

### Corrupt Or Unreadable Store

`loop-alert-control.json` must fail loud. Do not default corruption to
unpaused, paused, empty, or globally paused.

If the store cannot be read, parsed, schema-validated, or written:

- scheduler health records `loop-alert-control unavailable` with the child
  error and path;
- `/loop-alerts` returns an unavailable response naming the store error;
- TUI chrome shows `LOOP ALERTS UNAVAILABLE`;
- automated loop alert delivery is not attempted until the store is repaired,
  because the controller cannot know whether it would duplicate, suppress, or
  violate pause state.

This is intentionally loud. The two unsafe defaults are an alert storm and a
silent global mute.

## Alert Kinds

Use typed alert facts internally. Render message text late from those facts.

### `stopped-loop-agents`

Source: active loop agents whose live activity is still idle/done after the
dwell window, excluding pending interactions, overseer session, scribe, and
per-agent paused sessions.

This preserves the current watcher signal.

### `paused-loop-agents`

Source: paused agents that are still active loop members.

This does not fire every tick. It appears roughly every 10th effective loop
alert tick: "These agents are paused; remove them if you are fully done." It is
a reminder that suppression exists, not a substitute for stopped-agent alerts.

### `unowned-work-with-idle-capacity`

Source: runtime exchange plus session inventory.

V1 covers only work the project service can read: runtime-exchange tasks,
threads, handoffs, messages, and coordination worklist classifications. It does
not cover Sam's external `gqaapg` queue in `~/cs/docs/agent-queue/aimux/QUEUE.md`
unless a later change imports that queue into runtime exchange or exposes it
through an explicit project-service-readable adapter. The message text must not
cite `gqaapg-*` ids unless such an adapter exists.

A first implementation should include:

- tasks with status `pending`, no live owner, or an unreachable assigned owner;
- handoff/review/thread records waiting on an unassigned owner when idle loop
  agents are available;
- watched, unpaused, idle/done agents that are not already pending
  interaction.

It should not count:

- blocked tasks waiting on a named human or named unreachable owner;
- paused agents as available capacity;
- agents with pending interaction;
- offline sessions;
- unreadable runtime exchange as an empty queue.

Runtime exchange must be read with `try_read_runtime_exchange`. The
`read_runtime_exchange` helper collapses failures into an empty exchange and is
therefore disallowed for reconciliation.

## Dedupe Identity

Dedupe must use semantic facts, not rendered text and not probe noise.

### Loop Episodes

Introduce a controller-side loop episode per session. The episode changes when
the agent enters the loop after being unwatched, or when the semantic loop
assignment changes: normalized goal or loop source. It does not change merely
because `/agents/loop active=true` is called again with the same goal/source
and rewrites `loop.since`.

Implementation can either make `/agents/loop` idempotent for same goal/source
or let the controller normalize that route by persisting the existing episode.
The important rule is that an already-looped agent re-added with the same work
does not become a fresh stopped alert solely because `since` was rewritten.

A stop/run/stop transition that happens entirely between periodic scans cannot
be detected from scans alone. To handle that as a real edge, lifecycle changes
must kick the scheduler and/or update a runtime generation that the controller
sees. Without an event or generation, the controller should document that the
transition is unobservable rather than pretending a fingerprint can infer it.

### `stopped-loop-agents`

Fingerprint:

- kind: `stopped-loop-agents`
- project id/root identity
- recipient overseer session id
- sorted candidate list of:
  - session id
  - loop episode id
  - loop source
  - normalized goal hash

Do not include:

- live activity bucket such as `idle` versus `done`;
- current pane-tail text;
- "last output 4m ago";
- rendered worktree paths;
- raw `loop.since` when it can be rewritten by an idempotent re-add.

Live-activity state gates eligibility, but it is not fingerprint identity. A
probe flapping between `idle` and `done` should not page the overseer again
when the underlying stopped candidate is unchanged.

### `paused-loop-agents`

Fingerprint:

- kind: `paused-loop-agents`
- project id/root identity
- recipient overseer session id
- sorted paused session ids plus pause generation timestamps

Include pause generation so unpause/re-pause starts a new reminder cycle.

### `unowned-work-with-idle-capacity`

Fingerprint:

- kind: `unowned-work-with-idle-capacity`
- project id/root identity
- recipient overseer session id
- sorted visible work ids plus status/owner generation
- sorted available agent ids plus loop episode id

Include both sides. New visible work, a newly available agent, or a changed
owner/status is new information. The same work and same capacity is a level and
must back off.

## Edge Versus Level

Every alert kind is evaluated as an edge plus reminders over an unchanged
level:

- `new`: fingerprint was not active last scan.
- `changed`: same kind, but fingerprint changed.
- `unchanged`: same fingerprint is still true.
- `cleared`: fingerprint was active and is no longer true.

Rules:

- Send immediately on `new` and `changed`, unless global pause buffers it.
- Do not send on every `unchanged` tick.
- Send a reminder only after a documented cadence.
- Clear active fingerprints when the fact clears.
- Reset reminder counters when an alert is delivered, buffered, materially
  changes, or explicitly fails with a durable delivery outcome.

Recommended defaults:

- stopped-loop-agents: dwell 30s, first alert on edge, reminder every 4
  unchanged alert ticks or 10 minutes, whichever is later.
- paused-loop-agents: every 10 effective loop alert ticks while still paused.
- unowned-work-with-idle-capacity: dwell 60s, first alert on edge, reminder
  every 6 unchanged alert ticks or 15 minutes, whichever is later.

The exact numbers should remain config-backed under `loop`, but tests must
document the defaults. A level cannot page the overseer every scan.

## Backpressure And Delivery

The controller classifies every planned alert into one delivery outcome:

- `sent`: delivered to the overseer.
- `queued`: accepted by delivery but not yet read/acted on.
- `deduped`: identical fingerprint already queued or already sent within the
  reminder window.
- `buffered`: global pause is on.
- `failed`: delivery path returned a named error.

The delivery protocol must not call the state-mutating scan twice. Planning is
pure; committing outcomes mutates durable state once.

For gqaapg-3 and gqaapg-14:

- If the overseer is not idle and an identical fingerprint is already queued,
  do not queue another.
- If the fingerprint is new or changed, send it even if it queues behind the
  overseer.

"Overseer not idle" should use the same session activity model used elsewhere:
running/waiting means busy; idle/done/error/interrupted means not busy enough
to suppress a new alert. If liveness cannot be read, the controller records an
unavailable failure and skips delivery rather than assuming idle or empty.

Queued identity is tracked by fingerprint, not message string. The store keeps
`queued[fingerprint]` until one of these happens:

- a project event says the overseer consumed or responded to that message;
- the alert fact clears;
- the alert fingerprint changes;
- a max retention window expires and the next reminder is due.

If the delivery layer cannot expose consumption yet, v1 should keep
`queued[fingerprint]` until the alert clears or the reminder cadence is due.
That is conservative and still prevents ten identical messages in ten minutes.

## Per-Agent Pause

Routes/commands should support:

- pause loop alerts for one watched session;
- unpause one session;
- list paused loop sessions.

Pause requires active loop membership. Pausing an unwatched agent fails with a
clear message instead of creating inert state.

Auto-unpause must happen when work is sent to that agent, not only when a task
is assigned. The requirement is "sending work unpauses." That includes:

- task assignment to the session;
- direct human or overseer agent input;
- explicit coordination delivery that gives the session work.

It should not include internal loop-alert reminders or passive reads. The
delivery path should clear the pause after it has accepted the work delivery
intent and should emit a project update.

Manual pause is allowed from either a human or the overseer. Store provenance:
`pausedBy`, `pausedBySessionId`, `pausedAt`, optional reason, and the
`loopEpisodeId` the pause applies to.

Paused agents are not idle capacity for reconciliation. A paused agent is a
human assertion that the loop should not spend attention there right now.

### Pause GC

The agents map must not grow forever or mute a recycled session id. Pause
entries are valid only while all of these still hold:

- session id exists in metadata/topology or is inside a short graveyard
  retention window;
- active loop membership still exists;
- the stored `loopEpisodeId` matches the current loop episode.

On loop removal, session deletion/graveyard expiry, or episode mismatch, the
pause entry is removed and a project update records the cleanup. A recycled
session id starts unpaused unless it is explicitly paused again for its new
episode.

## Global Pause

Global pause is for "the human is intervening; do not send loop alerts into
the overseer right now."

Behavior:

- Alert facts are still evaluated.
- Planned alerts are written into `buffered`.
- Existing active fingerprints still update `lastSeenAt` and `seenCount`.
- No overseer messages are delivered while global pause is enabled.
- Clearing global pause presents a summary and delivers only the latest alert
  per fingerprint, not every buffered duplicate.

Global pause needs a deadman because permanent suppression is a high-severity
failure. V1 should store `expiresAt` with a default such as 30 minutes and a
route to extend it. While enabled, every loop-alert TUI render and roughly
every 10th scheduler tick must show a still-paused reminder with buffered
count and expiry. When it expires, the controller resumes delivery on the next
tick and keeps the resume visible in TUI chrome.

The TUI must show loud chrome while global pause is enabled. Suggested footer
token:

`LOOP ALERTS PAUSED - 3 buffered - expires 12:44 - press O to resume`

This should be visible even when no agents are selected. It is a project mode,
not row-local state.

Rejected alternative: making global pause only a client preference. That would
fail if another dashboard, CLI, or daemon restart participates. The pause is
about project alert delivery, so it must live in project-service state.

## Reconciliation

Reconciliation runs in the same controller task because it needs the same
concepts: overseer identity, idle capacity, delivery backpressure, pause state,
and alert buffering.

Inputs for v1:

- runtime exchange tasks/threads/messages read with `try_read_runtime_exchange`;
- coordination worklist classification where available;
- desktop/session state for live capacity;
- loop alert pause state.

What v1 does not see:

- external queue files such as `~/cs/docs/agent-queue/aimux/QUEUE.md`;
- `gqaapg-*` ids unless a later adapter imports them into runtime exchange or
  exposes them through the project service.

That is an explicit limitation. The signal still catches runtime-exchange
tasks and handoffs with idle watched capacity, but it does not solve Sam's
external queue unless that queue becomes an input.

Frequency:

- Same `LoopAlertController` task, but with its own cadence gates.
- Default every 2 to 4 loop-alert scans.
- Force/kick after task assignment, task completion, loop add/remove,
  pause/unpause, session lifecycle changes, and runtime-exchange writes.

Avoiding spam:

- Use the `unowned-work-with-idle-capacity` fingerprint.
- Require a short dwell window so a task being assigned does not race with its
  notification delivery.
- Group multiple work items and multiple available agents into one briefing.
- Do not alert if the only available agents are paused.
- Do not alert if all unowned work is already represented by a queued overseer
  alert fingerprint.

Example message for visible runtime-exchange work:

```text
[aimux loop check] Runtime-exchange work is waiting and loop capacity is idle:
- unowned: task task-123, handoff thread-abc
- available: codex-a, claude-b, codex-c

Assign or pause agents intentionally. If these items are no longer real, close
or update them so the worklist matches the work.
```

## TUI Surface

The dashboard should expose state without becoming noisy.

Always-visible footer/status tokens:

- Normal: `O overseer`
- Overseer active: `O overseer: on / 3`
- Per-agent paused exists: `O overseer: on / 3, 2 paused`
- Global pause: `LOOP ALERTS PAUSED - 3 buffered - O resume`
- Alert store unavailable: `LOOP ALERTS UNAVAILABLE`
- Reconciliation alert queued: `O overseer: work waiting`

In the `O` overlay:

- Show global pause toggle, expiry, and buffered count.
- Show watched agents grouped as `watched`, `paused`, and `unwatched`.
- For paused agents, show reason/provenance and actions: unpause, remove from
  loop.
- Show latest alert fingerprints as plain terms:
  - "2 stopped loop agents"
  - "4 runtime-exchange tasks with 9 idle agents"
  - "3 alerts buffered while paused"
  - "loop alert state unavailable: failed to parse loop-alert-control.json"
- Provide per-agent pause/unpause from selected agent context.

A stopped but paused agent should not be rendered as healthy. Suggested label:
`paused loop alerts`. This tells the human why it is not being reminded without
claiming the work is fine.

## Project API And Commands

Implementation should add project-service routes first, then CLI/TUI wrappers:

- `GET /loop-alerts` returns global pause, paused sessions, buffered alert
  summary, active fingerprints, and last delivery failures.
- `POST /loop-alerts/pause` toggles global pause with reason/provenance and
  optional expiry.
- `POST /agents/:id/loop-alerts/pause` pauses one watched agent.
- `POST /agents/:id/loop-alerts/unpause` unpauses one agent.

CLI/TUI commands call those routes. The dashboard must not write the store
directly.

The existing `/agents/loop` add/remove routes remain the authority for watched
membership. The implementation should either make same goal/source activation
idempotent or make the controller ignore rewritten `since` for episode identity.

## Storage And Scheduler Placement

This belongs in the project service because it combines runtime inventory,
metadata, runtime exchange, and delivery to project-local agents. It should be
a `PeriodicTask` on `native/crates/aimux/src/project_service/scheduler.rs`,
using the schedule-from-finish invariant.

Use the scheduler force/kick handle for events that already know alert state
may have changed:

- loop add/remove/pause/unpause;
- task assign/complete/block;
- handoff/review creation;
- message delivery state changes;
- session spawn/stop/kill/restore;
- overseer start/clear;
- direct agent input that auto-unpauses a paused session.

Periodic scans remain as a backstop, not the main reaction path.

The task must fail loud in scheduler health when required reads fail. It must
not convert unreadable runtime exchange, topology, or alert-control store into
"no alerts."

## Testing Strategy

Unit tests:

- same stopped candidate produces one edge alert, then no duplicate before
  reminder cadence;
- the planning pass does not mutate active fingerprints or unchanged tick
  counts;
- a delivered send commits exactly one outcome;
- a failed send commits a named failure and does not disappear;
- changed goal produces a new fingerprint and sends immediately;
- re-adding an already-looped agent with same goal/source does not send solely
  because `since` changed;
- adding/removing a candidate changes the fingerprint;
- live activity flapping idle/done does not change the stopped fingerprint;
- per-agent pause excludes stopped reminder;
- every 10th reminder cadence includes paused summary;
- task assignment, direct input, and explicit work delivery auto-unpause;
- global pause buffers alerts, reminds while paused, expires, and resume emits
  one latest alert per fingerprint;
- unowned runtime-exchange work plus idle capacity alerts;
- external `gqaapg` queue items are not claimed as covered without an adapter;
- unowned work with only paused capacity does not alert;
- unreadable runtime exchange/topology/store fails loudly, not as empty;
- corrupt `loop-alert-control.json` produces unavailable state and no silent
  default;
- stale pause entry is GC'd on loop removal, session expiry, or episode
  mismatch.

Mutation proofs:

- Put state mutation back into the planning pass and show unchanged ticks
  double-advance or failed delivery repeats incorrectly.
- Include activity bucket in stopped fingerprint and show one unchanged agent
  flapping idle/done sends repeated alerts.
- Use raw `loop.since` as the only episode identity and show idempotent re-add
  sends again.
- Treat global pause as "drop" instead of "buffer" and show resume loses
  alerts.
- Remove global pause expiry/reminder and show permanent suppression can stay
  invisible.
- Treat paused agents as available capacity and show reconciliation nags about
  work it cannot assign.
- Collapse unreadable exchange into empty and show visible unowned work
  disappears.
- Default a corrupt alert-control store to empty and show either duplicate
  sends or silent suppression.

Live drive additions:

- Put an overseer into a long running turn, keep one stopped candidate
  unchanged, verify one queued message and no duplicate until reminder cadence.
- Force delivery failure once, verify the next output names the failed delivery
  rather than forgetting it ever tried.
- Add a new stopped candidate while overseer is busy, verify a new queued
  message appears.
- Re-add the same loop goal/source for an already-looped stopped agent, verify
  no fresh alert solely from rewritten `since`.
- Pause one stopped candidate, verify no stopped reminder and later paused
  summary.
- Send direct input to a paused agent, verify the pause clears.
- Enable global pause, create stopped and reconciliation alerts, verify TUI
  chrome and buffered count, then resume and verify one latest alert per
  fingerprint.
- Corrupt `loop-alert-control.json`, verify loud unavailable state and no
  silent alert delivery.

## Rejected Designs

### Patch only the current message string

Rejected because it would fix repeated identical prose but not restart
persistence, failed-delivery accounting, reconciliation, global pause, or
per-agent pause. It also dedupes the wrong thing: wording instead of state.

### Treat the current watcher as level-only

Rejected because it is factually wrong. The shipped watcher already has
candidate signatures, dwell, unchanged ticks, and reminder cadence. The design
must repair where that machinery loses state or mutates state at the wrong
time.

### Add live activity bucket to the stopped fingerprint

Rejected because pane-tail activity is probe state, not alert identity. It can
flap idle/done for one unchanged stalled agent and recreate the four-in-a-row
briefing problem.

### Store pause in dashboard local state

Rejected because CLI, app, daemon restarts, and multiple dashboards would
disagree. Pause changes project alert delivery, so it belongs in
project-service state.

### Make per-agent pause remove loop membership

Rejected because "do not remind me right now" and "this agent is no longer in
the managed loop" are different intents. Collapsing them would recreate the
dominant failure class: one state pretending to be another.

### Let global pause drop alerts or last forever

Rejected because the human asked for pause, not blindness. Buffered alerts,
loud chrome, reminders, and expiry are what keep pause from becoming permanent
suppression.

### Separate reconciliation into another periodic task

Rejected for v1. Reconciliation and stopped-loop alerts share recipients,
dedupe, pause, buffered delivery, and TUI chrome. Separate tasks would race and
produce two sources of truth for whether the overseer should be interrupted.

### Claim external queue coverage without an input

Rejected because the motivating `gqaapg` items are outside the repo and not in
runtime exchange. V1 can cover runtime-exchange work. Covering Sam's external
queue needs an explicit adapter or import path first.

## Open Questions

- What is the precise source of truth for "overseer consumed this alert"? If
  the current delivery path cannot expose it, v1 should use conservative
  fingerprint retention until the alert clears or reminder cadence is due.
- Should reconciliation consider non-loop idle agents as capacity, or only
  watched loop agents? This design recommends only watched, unpaused loop
  agents for v1 because the loop controller should not conscript arbitrary idle
  sessions.
- Should buffered alerts deliver automatically on global resume, or should the
  TUI show a "send summary now" action? This design recommends automatic
  delivery of one latest alert per fingerprint, plus a visible summary, because
  otherwise resume is too easy to forget.
- What adapter, if any, should expose the external `gqaapg` queue to the
  project service? Until that exists, reconciliation must not claim to see it.
