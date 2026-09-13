# Loop Alert Control v1

## Problem

The loop watcher currently sees one kind of fact: an agent that is in a
managed loop and appears stopped. It can nudge the agent directly or brief the
overseer. That was enough for the first version, but it failed in both
directions during the async cutover drive:

- The same overseer briefing about the same agent could be queued repeatedly
  while the overseer was already working.
- Real coordination work could be waiting with idle agents available, while no
  alert fired because the watcher never looked at the queue.

The fix should not be four local patches. It should be one alert-control
mechanism that owns loop alert state, dedupe, pause, buffering, and
reconciliation.

## Goals

- Keep the existing "managed loop stopped" alert, but make it edge-aware.
- Add per-agent pause without removing loop membership.
- Add project-wide human pause for alert delivery, while still buffering what
  would have been sent.
- Dedupe identical overseer messages while the overseer is not idle.
- Add reconciliation between idle capacity and unowned queued work.
- Surface state in the TUI in real terms without noisy alarms.
- Persist enough state to survive daemon and project-service restarts.

## Non-Goals

- Do not build a new task assignment system.
- Do not change what "loop active" means.
- Do not hide genuine new information behind dedupe.
- Do not make the dashboard write runtime-exchange or topology directly.
- Do not wire this into a client-only timer.

## Proposed Shape

Introduce a project-service owned `LoopAlertController`. It is driven by the
existing shared scheduler rail as a `PeriodicTask`, replacing the current
in-memory `LoopWatcher` state with a durable controller store.

The controller reads facts from three sources:

- Runtime/topology plus metadata: loop membership, session liveness, derived
  activity, overseer identity, and live activity probes.
- Runtime exchange: queued tasks, assignment state, waiting recipients, pending
  deliveries, and unowned work.
- Alert-control store: pause state, buffered alerts, last fingerprints, edge
  timestamps, reminder counters, and delivery outcomes.

The controller writes only its own alert-control store and uses normal project
service delivery paths to message the overseer. It does not mutate topology,
runtime exchange work records, or session lifecycle state except through
explicit command routes such as pause/unpause.

## State Model

Each managed loop agent has one of these alert states:

- `unwatched`: no active `loop` metadata. The loop alert controller ignores it.
- `watched`: active `loop` metadata and no per-agent pause. It participates in
  stopped-agent alerts and reconciliation.
- `paused`: active `loop` metadata plus alert pause metadata. It remains in the
  loop but is excluded from stopped-agent reminders.

Per-agent pause is not watch/unwatch. It says "do not remind me that this
watched agent is stopped right now." Removing a loop says "this agent is no
longer part of the managed loop."

Global pause is project-wide alert delivery state, not a fourth per-agent
state:

- Per-agent pause filters facts before alert planning.
- Global pause suppresses delivery after alert planning and buffers planned
  alerts.

That ordering is intentional. During global pause the system should still know
what would have been said, so the human can resume and see what accumulated.
During per-agent pause, the agent is intentionally not part of the stopped-loop
alert except for a low-frequency paused summary.

### Durable Store

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
    "reason": "human intervention"
  },
  "agents": {
    "codex-123": {
      "state": "paused",
      "pausedAt": "...",
      "pausedBy": "...",
      "reason": "waiting for user review",
      "lastPausedReminderTick": 120
    }
  },
  "alerts": {
    "lastSent": {
      "stopped-loop-agents:<fingerprint>": {
        "sentAt": "...",
        "tick": 118,
        "deliveryId": "..."
      }
    },
    "activeQueued": {
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
    ]
  }
}
```

The exact names can move during implementation, but the important property is
that the persisted state is about alert control, not an accidental client cache.
If the project service restarts, it must not forget that a message is already
queued, that global pause is on, or that an agent was manually paused.

## Alert Kinds

Use typed alert facts internally. Message text should be rendered late from
those facts.

### `stopped-loop-agents`

Source: active loop agents whose live activity is still idle/done after the
dwell window, excluding pending interactions, overseer session, scribe, and
per-agent paused sessions.

This is the current watcher signal.

### `paused-loop-agents`

Source: paused agents that are still active loop members.

This should not fire every tick. It is a reminder roughly every 10th effective
loop alert tick: "These agents are paused; remove them if you are fully done."
It is not a substitute for stopped-agent reminders.

### `unowned-work-with-idle-capacity`

Source: runtime exchange plus session inventory.

The controller should identify actionable work with no live owner and compare
it with available agents. This catches "nine idle agents and four unassigned
bugs."

A first implementation should include:

- tasks with status `pending`, `assigned` to no reachable/live assignee, or
  thread/task delivery pending with no reachable recipient;
- review or handoff threads waiting on "user" or unassigned owner when idle
  loop agents are available;
- idle/done watched agents that are not paused and not already pending
  interaction.

It should not count:

- blocked tasks waiting on a named human or named unreachable owner;
- paused agents as available capacity;
- agents with pending interaction;
- offline sessions;
- stale exchange records that the coordination worklist already classifies as
  handled or unreachable without action.

This signal is deliberately separate from stopped-loop-agents. One is about a
watched agent failing to continue its own loop goal; the other is about work
and capacity being mismatched.

## Dedupe Identity

Dedupe must use the semantic facts, not rendered text alone. Rendered text can
change because of wording, ordering, or formatting without the underlying
alert changing.

Recommended fingerprint fields:

### Stopped-loop-agents

Fingerprint:

- kind: `stopped-loop-agents`
- project id/root identity
- recipient overseer session id
- sorted candidate list of:
  - session id
  - loop `since`
  - loop source
  - normalized goal hash
  - stopped reason bucket, initially `activity:idle` or `activity:done`

Include the goal hash. If an agent is reassigned with the same session id and
same loop source but a new goal, that is new information and must alert.

Do not include timestamps such as "last output 4m ago" or rendered worktree
paths in the fingerprint. Those would make unchanged level facts look new on
every tick.

### Paused-loop-agents

Fingerprint:

- kind: `paused-loop-agents`
- project id/root identity
- recipient overseer session id
- sorted paused session ids plus each pause generation timestamp

Include pause generation so unpause/re-pause becomes a new reminder cycle.

### Unowned-work-with-idle-capacity

Fingerprint:

- kind: `unowned-work-with-idle-capacity`
- project id/root identity
- recipient overseer session id
- sorted work ids plus status/owner generation
- sorted available agent ids plus loop generation

Include both sides. If the work is the same but a new agent becomes available,
that is useful new information. If the agents are the same but a new bug enters
the queue, that is useful new information. If neither changed, it is a level
and should back off.

## Edge Versus Level

Each alert kind should be evaluated as an edge plus reminders over a level.

Definitions:

- `new`: fingerprint was not active last scan.
- `changed`: same kind, but fingerprint changed.
- `unchanged`: same fingerprint is still true.
- `cleared`: fingerprint was active and is no longer true.

Rules:

- Send immediately on `new` and `changed`, unless global pause buffers it.
- Do not send on every `unchanged` tick.
- Send a reminder only after a configured cadence.
- Clear the active fingerprint when the fact clears.
- Reset reminder counters when an alert is delivered, buffered, or materially
  changes.

Recommended cadences:

- stopped-loop-agents: dwell 30s, first alert on edge, reminder every 4
  unchanged alert ticks or 10 minutes, whichever is later.
- paused-loop-agents: every 10 effective loop alert ticks while still paused.
- unowned-work-with-idle-capacity: dwell 60s, first alert on edge, reminder
  every 6 unchanged alert ticks or 15 minutes, whichever is later.

The exact numbers should remain config-backed under `loop`, but the defaults
must be documented in tests. The important rule is that a level cannot page the
overseer every scan.

## Backpressure And Delivery

The controller should classify every planned alert into one of these delivery
outcomes:

- `sent`: delivered to the overseer.
- `queued`: accepted by delivery but not yet read/acted on.
- `deduped`: identical fingerprint already queued or already sent within the
  reminder window.
- `buffered`: global pause is on.
- `failed`: delivery path returned a named error.

The rule for gqaapg-3/gqaapg-14 is:

- If the overseer is not idle and an identical fingerprint is already queued,
  do not queue another.
- If the fingerprint is new or changed, send it even if that means it queues
  behind the overseer.

"Overseer not idle" should be derived from the same activity model used for
sessions: running/waiting means busy; idle/done/error/interrupted means not
busy enough to suppress a new alert. If liveness cannot be read, the controller
should fail loud in scheduler health and skip delivery rather than assume idle.

Queued identity should be tracked by fingerprint, not by message string. The
store should record `activeQueued[fingerprint]` until one of these happens:

- a project event says the overseer consumed or responded to that message;
- the alert fact clears;
- the alert fingerprint changes;
- a max retention window expires and the next reminder is due.

If the delivery layer cannot expose consumption yet, start with conservative
time-based retention: keep `activeQueued` until the alert clears or a reminder
is due. That is still better than sending ten identical messages in ten
minutes.

## Per-Agent Pause

Routes/commands should support:

- pause loop alerts for one session;
- unpause one session;
- list paused loop sessions;
- auto-unpause when a task is assigned to that session.

Pause should require active loop membership. Pausing an unwatched agent should
fail with a clear message rather than creating inert state.

Auto-unpause belongs in the project-service task assignment path, not in the
watcher. The assignment mutation already knows a session is being given work.
After it records assignment/delivery intent, it should clear that session's
pause state and emit a project update. This avoids a forgotten pause silently
swallowing work.

Manual pause is allowed from either a human or the overseer. Store provenance:
`pausedBy`, `pausedBySessionId`, `pausedAt`, and optional reason.

Paused agents are not idle capacity for reconciliation. A paused agent is a
human assertion that the loop should not spend attention there right now.

## Global Pause

Global pause is for "the human is intervening; do not send loop alerts into
the overseer right now."

Behavior:

- Alert facts are still evaluated.
- Planned alerts are written into `buffered`.
- Existing active fingerprints still update `lastSeenAt` and `seenCount`.
- No overseer messages are delivered while global pause is enabled.
- Clearing global pause should present a summary and then deliver only the
  latest alert per fingerprint, not every buffered duplicate.

The TUI must show loud chrome while global pause is enabled. Suggested footer
token:

`LOOP ALERTS PAUSED - 3 buffered - press O to resume`

This should be visible even when no agents are selected. It is a project mode,
not row-local state.

Rejected alternative: making global pause only a client preference. That would
fail if another dashboard, CLI, or daemon restart participates. The pause is
about project alert delivery, so it must live in project-service state.

## Reconciliation

Reconciliation is the missing signal from tonight. It should run in the same
controller task because it needs the same concepts: overseer identity, idle
capacity, delivery backpressure, pause state, and alert buffering.

Inputs:

- runtime exchange tasks/threads/messages;
- coordination worklist classification where available;
- desktop/session state for live capacity;
- loop alert pause state.

Frequency:

- Same `LoopAlertController` task, but its own cadence gates.
- Default every 2 to 4 loop-alert scans, with an immediate forced tick after
  task assignment, task completion, loop add/remove, pause/unpause, and
  session lifecycle changes.

Avoiding spam:

- Use the `unowned-work-with-idle-capacity` fingerprint.
- Require a short dwell window so a task being assigned does not race with its
  notification delivery.
- Group multiple work items and multiple available agents into one briefing.
- Do not alert if the only available agents are paused.
- Do not alert if all unowned work is already represented by a queued overseer
  alert fingerprint.

Example message:

```text
[aimux loop check] Work is waiting and loop capacity is idle:
- unowned: gqaapg-12, gqaapg-13, review thread abc
- available: codex-a, claude-b, codex-c

Assign or pause agents intentionally. If these items are no longer real, close
or update them so the queue matches the work.
```

## TUI Surface

The dashboard should expose this without becoming noisy.

Always-visible footer/status tokens:

- Normal: `O overseer`
- Overseer active: `O overseer: on / 3`
- Per-agent paused exists: `O overseer: on / 3, 2 paused`
- Global pause: `LOOP ALERTS PAUSED - 3 buffered - O resume`
- Reconciliation alert queued: `O overseer: work waiting`

In the `O` overlay:

- Show global pause toggle and buffered count.
- Show watched agents grouped as `watched`, `paused`, and `unwatched`.
- For paused agents, show reason/provenance and actions: unpause, remove from
  loop.
- Show latest alert fingerprints as plain terms:
  - "2 stopped loop agents"
  - "4 unowned tasks with 9 idle agents"
  - "3 alerts buffered while paused"
- Provide per-agent pause/unpause from selected agent context.

A stopped but paused agent should not be rendered as healthy. Suggested label:
`paused loop alerts`. This tells the human why it is not being reminded without
claiming the work is fine.

## Project API And Commands

Implementation should add project-service routes first, then CLI/TUI wrappers:

- `GET /loop-alerts` returns global pause, paused sessions, buffered alert
  summary, active fingerprints, and last delivery failures.
- `POST /loop-alerts/pause` toggles global pause with reason/provenance.
- `POST /agents/:id/loop-alerts/pause` pauses one watched agent.
- `POST /agents/:id/loop-alerts/unpause` unpauses one agent.

CLI/TUI commands can then call those routes. The dashboard must not write the
store directly.

The existing `/agents/loop` add/remove routes remain the authority for watched
membership.

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
- overseer start/clear.

Periodic scans remain as a backstop, not the main reaction path.

The task must fail loud in scheduler health when its required reads fail. It
must not convert unreadable runtime exchange or topology into "no alerts."

## Testing Strategy

Unit tests:

- same stopped candidate produces one edge alert, then no duplicate before
  reminder cadence;
- changed goal produces a new fingerprint and sends immediately;
- adding/removing a candidate changes the fingerprint;
- per-agent pause excludes stopped reminder;
- every 10th tick includes paused summary;
- task assignment auto-unpauses;
- global pause buffers alerts and resume emits one latest alert per
  fingerprint;
- unowned work plus idle capacity alerts;
- unowned work with only paused capacity does not alert;
- unreadable exchange/topology fails loudly, not as empty.

Mutation proofs:

- Remove goal from the stopped fingerprint and show reassignment with new goal
  is incorrectly deduped.
- Treat global pause as "drop" instead of "buffer" and show resume loses
  alerts.
- Treat paused agents as available capacity and show reconciliation nags about
  work it cannot assign.
- Collapse unreadable exchange into empty and show the nine-idle/four-bugs
  class disappears.

Live drive additions:

- Put an overseer into a long running turn, keep one stopped candidate
  unchanged, verify one queued message and no duplicate until reminder cadence.
- Add a new stopped candidate while overseer is busy, verify a new queued
  message appears.
- Pause one stopped candidate, verify no stopped reminder and later paused
  summary.
- Enable global pause, create stopped and reconciliation alerts, verify TUI
  chrome and buffered count, then resume and verify one latest alert per
  fingerprint.

## Rejected Designs

### Patch only the current message string

Rejected because it would fix repeated identical prose but not reconciliation,
global pause, per-agent pause, or restart persistence. It also dedupes the
wrong thing: wording instead of state.

### Store pause in dashboard local state

Rejected because CLI, app, daemon restarts, and multiple dashboards would
disagree. Pause changes alert delivery for the project, so it belongs in
project-service state.

### Make per-agent pause remove loop membership

Rejected because "do not remind me right now" and "this agent is no longer in
the managed loop" are different user intents. Collapsing them would recreate
the dominant failure class: one state pretending to be another.

### Let global pause drop alerts

Rejected because the human asked for pause, not blindness. Buffered alerts are
the point: the system should remember what it would have said.

### Separate reconciliation into another periodic task

Rejected for v1. Reconciliation and stopped-loop alerts share recipients,
dedupe, pause, buffered delivery, and TUI chrome. Separate tasks would race and
produce two sources of truth for "should the overseer be interrupted."

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

## Implementation Phases

1. Add durable alert-control store and pure controller tests.
2. Move current loop watcher edge/reminder state into the controller, preserving
   existing stopped-loop behavior except for dedupe/backoff.
3. Add per-agent pause and paused summary.
4. Add global pause, buffering, and TUI chrome.
5. Add reconciliation input from runtime exchange/worklist.
6. Add live-drive cases and mutation proofs.

The implementation should land in small commits. The pure controller tests are
the safety net; the live-drive cases prove that the controller sees the same
world a human sees.
