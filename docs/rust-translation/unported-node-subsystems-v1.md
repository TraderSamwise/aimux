# Unported Node Subsystems

Scope: runtime behavior Node had wired before the Rust cutover, but the Rust
binary either still does not perform or only preserves as an uncalled contract.

## Why The Gates Missed These

- Fixture twins are self-contained Rust copies of Node behavior. A green fixture
  proves the twin matches Node, not that production Rust calls the behavior.
- Twins are not always named `*_contract.rs`, so filename-only sweeps miss some
  of them.
- The compiler does not warn for an unreferenced `pub fn` inside a `pub mod`.

## Still Outstanding

Ranked by cost of absence, not by implementation size.

1. **Attachment text recovery.** Live Rust transcript projection has a simpler
   attached-files parser than Node's shared helper for tmux-wrapped attachment
   paths, multiple/bare references, and filename/mime recovery. Cost: wrapped
   or multi-attachment transcript blocks can render as plain text or lose labels
   in GUI chat/transcript views. Size: hours, promotion into the projection path.

2. **OSC terminal notifications.** Routing parity was duplicate and removed, but
   OSC 9/777/99 parsing is not wired to production terminal output. The parser
   and corpus remain as the tracked spec. Cost: terminal-emitted notifications
   do not become Aimux notifications; low frequency but real if tools depend on
   OSC notify. Size: hours, promotion into the output/event pipeline.

## Deleted As Duplicate Or Dead

- `coordination_threads`: production coordination mutation routes and indexes
  already implement direct thread reuse, send/mark-seen/status, waits/inbox, and
  completed-task reactivation.
- `desktop_notifier_contract`: production `desktop_notifier.rs` owns notifier
  behavior; the old contract modeled stale Node fallback details.
- `project_service/agent_tracker_derivation`: production
  `project_service/runtime_event_state.rs` derives activity, attention, unread,
  event history, and focus suppression.
- `worktree_state_contract`: production `project_service/worktrees.rs` owns the
  worktree/graveyard projection with live tests.
- `orchestration_routing_contract`: production
  `project_service/orchestration_routes.rs` owns routing selection. OSC parsing
  was split out and kept.
- `project_takeover_contract`: already deleted. The old feature only took a
  project from another daemon home/port in the dev-daemon split; the one-daemon
  model has nothing to take over.
- `session_launch_actions_contract`: production dashboard/session actions are
  no longer dispatched through the old Node `handleAction`/`focusSession` host
  object. The live Rust surfaces are the dashboard controller and action/focus
  modules, plus project-service lifecycle routes for shared state mutations:
  `dashboard_controller.rs`, `dashboard_actions.rs`, `dashboard_focus.rs`,
  `dashboard_targets.rs`, `project_service/lifecycle.rs`, and the routed
  handlers under `project_service/lifecycle/`.
- `session_launch_create_contract`: the fixture was replaced by scoped tests
  against the production spawn path. The tested caller enters
  `route_lifecycle_request_with_runtime`, routes to `/agents/spawn`, and reaches
  `launch_agent_session` in `project_service/lifecycle/agent_session_launch.rs`
  through the real project-service lifecycle dispatcher, with tmux/file effects
  behind the fake lifecycle runtime.

## Tracked But Not Rust Rewrite Ports

- **Transport security contract.** Shared-chat actor resolution and browser
  device-proof encoding are live in the TypeScript app and relay. Keep the
  invariant tracked there; no native Rust port is needed.
- **Plugin runtime contract.** Native replaced the built-in JS plugins with the
  native plugin registry/API/scheduler. The unported part is custom
  `~/.aimux/plugins/*.js` userland plugin loading; port it only if custom JS
  plugins remain a supported product surface.

## Fixed Since The Original Audit

The original 2026-09-09 audit entries for hosted mode, relay client, mobile
push bridge, attachment hosting, tool-output watchers, service-state snapshots,
runtime topology reconciliation, builtin metadata watchers, loop watcher,
scribe watcher, transcript reconciler, agent prompt delivery, runtime guard
repair start, and debug logging have all been ported and wired. Debug logging
now lives in native `debug_logging.rs` with production call sites for control
plane restart, project-service ensure/startup, tmux repair, runtime-guard
repair, and watcher rail diagnostics; the old debug parity fixtures were
deleted. Repair events now write durable project `repairs.jsonl` entries from
control-plane restart, project-service ensure, tmux runtime repair, dashboard
reload, dashboard-triggered runtime-guard repair, and lifecycle orphan cleanup.
Lifecycle orphan cleanup now runs during restart with Node-parity validation
artifact and orphan-dashboard rules, plan-first repair-event logging, restart
summary counts, and PID re-read guards before SIGKILL; its parity fixture was
deleted after promotion.
