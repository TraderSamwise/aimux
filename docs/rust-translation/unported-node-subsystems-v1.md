# Unported Node subsystems — inventory v1

Scope: what phase 8 deleted from `src/` (282 non-test TypeScript modules at
`a9220736^`) that has no live counterpart in the Rust binary.

## Why the existing gates missed these

- The corpus proves a fixture-twin module reproduces Node's outputs. Twins are
  self-contained — `dashboard_interaction_navigation_contract.rs` carries its own
  `NavigationState` — so a green suite says nothing about whether production Rust
  implements the same behavior.
- Twins are not all named `*_contract.rs`. 138 modules expose a fixture-case
  dispatcher; 23 of them carry ordinary names, and 13 of those have no production
  reference at all (`multiplexer_runtime_helpers`, `transcript_turn_state`,
  `dashboard_api_client`, `dashboard_lifecycle`, `coordination_threads`,
  `multiplexer_notifications`, `multiplexer_resource_refresh`,
  `multiplexer_dashboard_state_helpers`, `tui_runtime_mutations`,
  `dashboard_repair_notices`, `hotkeys`, `inbox_cleanup`, plus the audit
  scaffolding). A filename-keyed sweep misses every one. Some are dead by
  design — `hotkeys` mirrors Node's in-process multiplexer host, which tmux
  replaced — and the set has not been sorted into dead-by-design vs missing.
- `scripts/audit-rust-orphans.mjs` filters out `fixture-contract` candidates
  (line 287), which is exactly the shape a subsystem takes when only its contract
  was ported.
- The compiler cannot see it: an unreferenced `pub fn` inside a `pub mod` never
  warns.

## Confirmed missing (Node had it wired, Rust has no implementation)

| Node module | What it did | Node call site |
| --- | --- | --- |
| `src/full/relay-client.ts` | daemon's websocket client to the relay | daemon remote features |
| `src/daemon-remote-features.ts`, `src/core-cli-remote-features.ts` | wiring that starts the relay client | daemon + core CLI |
| `src/mobile-push-bridge.ts` | forwards every alert to the daemon's `/internal/push` | `metadata-server.ts:1060` |
| `src/tool-output-watchers.ts` | `classifyToolPane` | `session-runtime-core.ts`, `context-bridge.ts` |
| `src/multiplexer/service-state-snapshot.ts` | persists runtime/service snapshots before a tmux stop | multiplexer lifecycle |

## Ported since this inventory

Each was a promotion, not a translation: the twin's logic lifted into a
production module with real I/O behind a deps trait, wired to a real caller, the
fixture test repointed at production, and the twin deleted in the same commit.

| Node module | Rust production module | Scheduled task |
| --- | --- | --- |
| — | `project_service/scheduler.rs` (the rail every watcher lands on) | — |
| `src/loop-watcher.ts` | `loop_watcher.rs` | `project_service/loop_watcher_task.rs` |
| `src/scribe-watcher.ts` | `scribe_watcher.rs` | `project_service/scribe_watcher_task.rs` |
| `src/builtin-metadata-watchers.ts` | `builtin_metadata_watchers.rs` | `project_service/builtin_metadata_task.rs` |
| `src/multiplexer/transcript-reconciler.ts` | `transcript_reconciler.rs` | `project_service/transcript_reconciler_task.rs` |

## Re-audited and withdrawn

- `src/project-takeover.ts` — not a gap. It only takes a project from another
  daemon home/port, which was the dev-daemon split. One daemon, nothing to take.
- `src/full/attachment-hosting.ts` — not an independent subsystem. It uploads a
  published attachment to the relay and no-ops when remote is disabled, so it is
  part of the relay port rather than extra work.

## Stubs that return a fixed answer instead of consulting anything

- `daemon/runtime.rs:2069` `push_notification` → `{"suppressed": true, "reason": "relay_unavailable"}`.
- `daemon/runtime.rs` `relay_status` → hardcoded `disconnected` whenever remote is enabled.
- `daemon/runtime.rs` `loop_diagnostics` → event-loop percentiles hardcoded to 0.

## Production paths that duplicate a ported module

- `tmux_runtime_stop.rs::stop_project_tmux_runtime` accepts a
  `persist_snapshots_before_stop` hook and is called only from a test. The
  daemon runs its own copy (`daemon/runtime.rs:2627`) with no hook, which is why
  the service snapshot never happens.

## Wired-but-uncalled

- `runtime_topology_sessions.rs::reconcile_runtime_topology_sessions` has no
  caller. Node ran it on every state save
  (`multiplexer/runtime-lifecycle-methods.ts:296`) with `removedSessionIds`.

## Verified present (checked, not missing)

`hosted-audit`, `hosted-principals`, `security-devices-client`,
`runtime-guard-repair-history`, the plugin runtime, expose, desktop notifier.

## HTTP surface is complete

All 136 project-service route specs dispatch to a real handler; none fall
through to the `501 project service route not ported` branch. The gaps above are
background behavior, not routes.
