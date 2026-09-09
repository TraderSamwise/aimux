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

1. **Lifecycle orphan cleanup.** Native can identify orphaned dashboards, but
   restart still reports empty orphan cleanup and there is no production
   equivalent of Node's validation tmux/process and orphan dashboard cleanup.
   Cost: validation leftovers and stale dashboards can accumulate and make
   runtime state or restart reports misleading. Size: about a day to days,
   promotion with careful process/tmux integration.

2. **Attachment text recovery.** Live Rust transcript projection has a simpler
   attached-files parser than Node's shared helper for tmux-wrapped attachment
   paths, multiple/bare references, and filename/mime recovery. Cost: wrapped
   or multi-attachment transcript blocks can render as plain text or lose labels
   in GUI chat/transcript views. Size: hours, promotion into the projection path.

3. **Repair events.** `repair_events.rs` can append the JSONL record, but no
   production repair/restart path calls it for control-plane restart,
   project-service ensure, tmux repair, dashboard reload, or orphan cleanup.
   Cost: repairs still work, but the durable repair timeline and notification
   trail are missing for postmortems. Size: hours, promotion into daemon/repair
   call sites.

4. **OSC terminal notifications.** Routing parity was duplicate and removed, but
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
deleted.
