# Role-Tuned Push Notifications V1

This is a design only. It should not change coder notifications by accident: the
current coder alerting behavior is the compatibility baseline.

## Problem

Aimux currently treats "idle" too uniformly. For a coder, idle can mean "ready
for the next instruction". For an overseer, idle can mean "waiting for watched
agents to finish", which is normal supervision. For a scribe, idle is usually
expected and should rarely page Sam.

The role split should be based on the existing contract in
`native/crates/aimux/src/team_contract.rs`: `is_project_control_session`,
`is_overseer_session`, `is_scribe_session`, `agent_role`, and `agent_lane`.
Clients and background tasks should not infer roles from names, window titles, or
project paths.

## Notification Classes

Every push candidate should be classified before policy decides whether it pages
Sam:

- `needs-human-input`: the agent explicitly cannot proceed without Sam, or a
  command/input route produced a refusal that requires user action.
- `stalled-actionable`: the agent has stopped or stayed idle in a way that is
  actionable after dwell. The loop watcher already models this for stopped
  agents.
- `waiting-on-agents`: a supervisor is idle because watched coders are still
  running, stopped, paused, or queued. This is state for the overseer surface,
  not normally a push to Sam.
- `work-available`: idle capacity exists alongside unowned runtime-exchange or
  worklist work. This is the reconciliation signal; it must keep its current
  caveat that it cannot see Sam's external queue.
- `system-unavailable`: Aimux could not ask a required authority, such as
  topology, metadata, runtime exchange, tmux, notification storage, or watcher
  state. This is distinct from "empty".
- `progress-or-summary`: useful status, completion, digest, or scribe output
  that should usually remain in-app unless Sam chooses a push policy.

## Role Semantics

Coder stays as today. If `agent_role(Some(session))` returns `"coder"` or the
role is unknown, the existing push path remains the default. This feature must
not retune ordinary coder idle/done notifications as a side effect.

Overseer idle has two meanings. Idle while watched agents are still active,
paused, or waiting is `waiting-on-agents` and should be quiet by default. Idle
while the overseer itself needs Sam, cannot reconcile work, cannot read required
authority state, or receives a loop-watcher briefing after dwell is
`needs-human-input`, `system-unavailable`, or `stalled-actionable`. The existing
loop watcher should remain the source of truth because `LoopWatcher::plan_sends`
already has durable signatures, attempted/reported state, pause handling, and
reminder cadence.

Scribe idle is normal. A scribe should not push simply because it is idle after
writing or waiting. Scribe pushes should be limited to `needs-human-input` and
`system-unavailable`, such as failure to read topology/metadata, failure to read
candidate output, failure to write or deliver a briefing, or an explicit stuck
condition. `ScribeWatcherTask::run` and `finish_scribe_watcher_task` already
collect scheduler-visible failures; those are better push inputs than raw idle.

## Edge And Level Rules

Use the loop watcher's existing edge-versus-level machinery, not a new throttle.
`LoopWatcher::dwelled_candidates` records first-seen state, applies dwell,
increments unchanged ticks after attempted sends, and uses
`stopped_candidate_due` plus reminder cadence to distinguish "first became
actionable" from "still unchanged". `candidate_signature` captures stopped-agent
identity; `reconciliation_signature` is condition-level so worklist churn does
not spam while the same condition holds.

Role-tuned notifications should follow the same shape:

- First push after class-specific dwell, unless the event is an immediate
  refusal or unavailable authority.
- Repeated pushes only on a documented reminder cadence while the same
  fingerprint remains true.
- Fingerprints should describe the actionable condition, not volatile rendering
  details. For overseer reconciliation that means "unowned work exists and idle
  capacity exists", not every item id. For scribe unavailable state it means the
  failed authority and scribe session, not the latest log text.
- A cleared condition must reset enough state that a genuinely new condition can
  push again.

## Proposed Architecture

Add a role-aware notification policy layer after raw events are produced and
before push delivery. Inputs should be normalized records:

```text
{ role, sessionId, class, source, fingerprint, text, firstSeenAt, severity }
```

Role comes from `agent_role`/`is_project_control_session`. Sources should be the
existing authorities: current coder alerting, `LoopWatcher::plan_sends` for
overseer watched-agent and reconciliation signals, and `ScribeWatcherTask` /
`crate::scribe_watcher` for scribe signals. The policy layer decides push,
in-app-only, or silence using a table by `{role, class}`.

This keeps coder behavior stable because coder events continue through the
existing path unless explicitly classified otherwise. It also prevents overseer
and scribe policy from duplicating loop-watcher state: supervisor pushes consume
already-dwelled, already-deduped outputs instead of polling panes again.

## Rejected Approaches

- Treat all idle as one push event. That is the current problem: it cannot tell
  a waiting overseer from a blocked overseer.
- Infer supervisor behavior from names or tmux windows. Role authority already
  exists in `team_contract.rs`, and spelling-based classification would drift.
- Add a second watcher for overseer notifications. The loop watcher already has
  durable edge/level state, pause, buffering, and reconciliation cadence; a
  parallel watcher would recreate the same failure modes.
- Retune coder alerts while adding supervisor policy. Sam asked for a class
  architecture that covers default coder behavior as it functions today, not a
  coder notification redesign.

## Open Questions For Sam

- Which overseer conditions should page Sam versus stay in the overseer overlay:
  watched agent stopped, work available, all watched agents idle, or overseer
  explicitly blocked?
- What dwell and reminder cadence should overseer pushes use if they differ from
  the loop watcher's current stopped-agent cadence?
- Should scribe `system-unavailable` events push immediately, or appear only in
  doctor/runtime health unless repeated?
- Should `progress-or-summary` ever become a push, or should summaries stay
  in-app by default?
- During global loop-alert pause, should role-tuned pushes for overseer/scribe
  also buffer, or should only loop-watcher-generated alerts be paused?
- Should mobile/web quiet hours and grouping be role-aware in this same design,
  or layered later on top of these classes?
