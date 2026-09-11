# Unported Node Subsystems

Scope: historical audit of runtime behavior Node had wired before the Rust
cutover, but the Rust binary either did not perform or only preserved as an
uncalled contract.

Current status: no active unported Rust rewrite subsystem is tracked here.
`yarn audit:rust-orphans` should report exactly five tracked fixture dispatcher
modules. Two are deliberate keeps: `plugin_runtime_contract.rs` and
`transport_security_contract.rs`. Three are protected until their product
decisions or production gaps close: `attachment_store_contract.rs`,
`cli_attachment_contract.rs`, and `agent_restore_state_contract.rs`.

## Why The Gates Missed These

- Fixture twins are self-contained Rust copies of Node behavior. A green fixture
  proves the twin matches Node, not that production Rust calls the behavior.
- Twins are not always named `*_contract.rs`, so filename-only sweeps miss some
  of them.
- The compiler does not warn for an unreferenced `pub fn` inside a `pub mod`.
- The `session_viewed` corpus stayed green while production only zeroed
  `unseenCount` instead of doing Node's full mark-seen update, because the twin
  answered the fixtures itself.
- The notification composer proved the inverse failure mode: production
  composition was correct, but a second composer at the delivery boundary
  threw the composed record away and hardcoded "Aimux". For that case, "is it
  ported?" was the wrong question: the code existed, but a downstream caller
  ignored it. The durable rule is still the same: fixtures must reach the live
  production path.
- Test the inverse of every guard, gate, and precedence rule before it ships.
  Demotion became a one-way door, classifier centralization disabled legacy
  fallback for older windows, and a notification delivery guard fixed fixture
  leaks by silently swallowing real alerts. Adversarial review caught those
  regressions after the original authors missed them.

## Still Outstanding

- Attachment hosting and restore-previous-agents remain product decisions or
  production-gap work, not generic Rust rewrite debt.

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

These five modules account for the remaining tracked count of 5. They are
protected entries, not a generic Node backlog.

- **Transport security contract.** Shared-chat actor resolution and browser
  device-proof encoding are live in the TypeScript app and relay. Keep the
  invariant tracked there; no native Rust port is needed.
- **Plugin runtime contract.** Native replaced the built-in JS plugins with the
  native plugin registry/API/scheduler. The unported part is custom
  `~/.aimux/plugins/*.js` userland plugin loading; port it only if custom JS
  plugins remain a supported product surface.
- **Attachment contracts.** Keep `attachment_store_contract.rs` and
  `cli_attachment_contract.rs` until attachment relay hosting is product-complete
  through production routes.
- **Agent restore state contract.** Keep `agent_restore_state_contract.rs` until
  restore-previous-agents is either completed or explicitly retired.

## Fixed Since The Original Audit

Attachment text recovery now runs in production transcript projection through
`project_service/agent_output_projection.rs`: `parts_from_flattened()` detects
legacy "Attached files" / "Attached image files" transcript blocks and
`recover_wrapped_attachments()` recovers tmux-wrapped attachment paths,
multiple/bare references, filename metadata, and MIME metadata before
`messages_from_blocks()` emits structured message parts. The live agent output
routes call this path through `project_service/agent_output.rs`.

OSC terminal notifications now run in production live-output capture.
`project_service/agent_output.rs` checks captured pane payloads for OSC starts,
strips OSC bytes from returned output, and writes untrusted terminal
notifications through the live output route. `project_service/process.rs`
constructs the live project-service context with the OSC output tap.

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
