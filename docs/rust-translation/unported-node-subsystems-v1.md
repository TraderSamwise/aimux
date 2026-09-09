# Unported Node subsystems — inventory v1

Scope: what phase 8 deleted from `src/` (282 non-test TypeScript modules at
`a9220736^`) that has no live counterpart in the Rust binary.

## Why the existing gates missed these

- The corpus proves a `*_contract.rs` module reproduces Node's outputs. Those
  modules are self-contained twins — `dashboard_interaction_navigation_contract.rs`
  carries its own `NavigationState` — so a green suite says nothing about whether
  production Rust implements the same behavior.
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
| `src/loop-watcher.ts` | scans loop agents, builds the overseer briefing, sends canned nudges | `multiplexer/dashboard-model.ts` |
| `src/scribe-watcher.ts` | periodic scribe scan and briefing | `multiplexer/index.ts`, `dashboard-model.ts` |
| `src/tool-output-watchers.ts` | `classifyToolPane` | `session-runtime-core.ts`, `context-bridge.ts` |
| `src/multiplexer/transcript-reconciler.ts` | `TranscriptReconciler` | `multiplexer/dashboard-model.ts` |
| `src/multiplexer/service-state-snapshot.ts` | persists runtime/service snapshots before a tmux stop | multiplexer lifecycle |
| `src/project-takeover.ts` | `takeOverProjectFromOtherOwners` | project activation |
| `src/full/attachment-hosting.ts` | `maybeHostPublishedAttachment` | attachment publish path |

## Stubs that return a fixed answer instead of consulting anything

- `daemon/runtime.rs:2069` `push_notification` → `{"suppressed": true, "reason": "relay_unavailable"}`.
- `daemon/runtime.rs` `relay_status` → hardcoded `disconnected` whenever remote is enabled.
- `daemon/runtime.rs` `loop_diagnostics` → event-loop percentiles hardcoded to 0.

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
