# Phase 8 Multiplexer Owned Lane Audit v1

Audit point: `6ee30d12`

Scope: the six TypeScript modules assigned to this lane before phase-8 deletion:
`src/multiplexer/persistence-methods.ts`, `src/multiplexer/worktrees.ts`,
`src/multiplexer/runtime-state.ts`, `src/multiplexer/services.ts`,
`src/multiplexer/tool-picker.ts`, and
`src/multiplexer/project-event-stream.ts`.

Method: enumerate each exported TypeScript surface, map each distinct behavior
family to TypeScript-generated corpora under `testdata/contracts/v1`, and
require the owning Rust fixture row to be `PROVEN-FAILS` in
`ENFORCEMENT_AUDIT.md`. Case counts below are behavior cases captured from
running TypeScript, not hand-written expectations.

## Result

Deletion gate status for this lane: ready.

The six modules total 4,879 TypeScript LOC and are covered by 222 direct cases
from their own test sources, plus adjacent corpora for bound startup methods,
inbox cleanup, text helpers, and worktree graveyard projection. Current misses:
0 behavior-level misses found in this audit.

## Module Mapping

### `src/multiplexer/persistence-methods.ts`

Exported surface: `persistenceMethods` with 30 bound methods.

Behavior families:
- Desktop-state projection, pending-action replay, statusline snapshot
  projection, raw/projected worktree lists, worktree create/remove/graveyard,
  graveyard entry resurrection/deletion, graveyard cleanup, statusline writes,
  tmux target repair, inbox cleanup, text helpers, and maintenance startup/stop
  calls.

Corpus:
- `multiplexer/persistence-desktop-projection.json` (6 cases)
- `multiplexer/persistence-reapply.json` (2 cases)
- `multiplexer/persistence-statusline-snapshot.json` (4 cases)
- `multiplexer/persistence-statusline.json` (4 cases)
- `multiplexer/persistence-worktree-lists.json` (2 cases)
- `multiplexer/persistence-worktrees.json` (27 cases)
- `notifications/inbox-cleanup-runtime.json` (2 adjacent cleanup cases)
- `worktree/state.json` (graveyard projection case)
- `multiplexer/session-launch-startup.json` (maintenance startup/stop call paths)
- `multiplexer/dashboard-state-helpers.json` and `tui/render-text.json` (text helper projections)

Recent failures found and closed in this lane: 3 worktree persistence failures.

Uncaptured count: 0.

### `src/multiplexer/worktrees.ts`

Exported surface: `worktreeSettlePollDelay`, create/list/remove/cache-cleanup
overlay renderers and key handlers, `beginWorktreeRemoval`, and
`finishWorktreeRemoval`.

Behavior families:
- Settlement delay bounds, prompt/list/remove/cache overlay rendering, printable
  input and cancellation, project-service requirement errors, optimistic create
  settlement, stale refresh/input suppression, duplicate and async failures,
  independent removals, stale background completion, and cache cleanup dry-run
  and apply results.

Corpus:
- `multiplexer/worktrees.json` (26 cases)
- `multiplexer/worktrees-settlement.json` (26 cases)

Recent failures found and closed in this lane: 0 in the latest worktrees audit
slice; existing worktrees fixtures remain mutation-proven.

Uncaptured count: 0.

### `src/multiplexer/runtime-state.ts`

Exported surface: dashboard refresh constants, status refresh start/stop,
heartbeat/project-service refresh start/stop, topology sync, offline load,
orphan reconciliation, live service projection, restore, stop, graveyard,
runtime liveness, zombie eviction, and backend-session-id recording.

Behavior families:
- Dashboard status refresh cadence and hidden-dashboard behavior, idle
  notification settling, topology adoption, offline session/service loading,
  orphan demotion/graveyarding, tmux restore/rebind, runtime liveness, zombie
  eviction, backend id precedence, stale metadata rejection, exact backend
  restore refusal, fresh relaunch, and transcript-based backend recovery.

Corpus:
- `multiplexer/runtime-state-methods.json` (53 cases)
- `multiplexer/runtime-state-refresh.json` (12 cases)
- `runtime-state/runtime-sync.json` (heartbeat and project-service refresh start/stop)
- `multiplexer/runtime-guard-repair-start.json` and `runtime-state/runtime-guard.json` (guard repair/sync callers)
- `multiplexer/session-launch-*.json`, `multiplexer/dashboard-tail-lifecycle.json`, and `multiplexer/tui-api-runtime*.json` (startup and caller-side render/sync paths)

Recent failures found and closed in this lane: 8 runtime-state restore/recovery
failures.

Uncaptured count: 0.

### `src/multiplexer/services.ts`

Exported surface: service id generation, launch command recovery, service state
derivation, label derivation, create, stop, remove, resume, and resume by id.

Behavior families:
- Deterministic id shape normalization, shell `-lc` metadata recovery, explicit
  command metadata, label fallback, created/resumed shell wrappers, stop
  fallback to Ctrl-C, offline removal, retained/dead tmux windows, stale state
  suppression, optimistic dashboard rows, and resume-by-id errors/success.

Corpus:
- `multiplexer/services.json` (7 cases)
- `multiplexer/services-runtime.json` (14 cases)

Recent failures found and closed in this lane: 0 in the latest audit slice;
existing services fixtures remain mutation-proven.

Uncaptured count: 0.

### `src/multiplexer/tool-picker.ts`

Exported surface: launch defaults, env formatting, picker/options overlay
builders, overlay render wrapper, selected-tool execution, picker display, and
picker/options key handlers.

Behavior families:
- Default argument/env composition, env value quoting, create/switch/fork
  execution, missing switch source errors, picker state reset, enabled/empty
  overlay rendering, selected-source title rendering, launch option parsing,
  and key-handler dispatch through dashboard overlay callers.

Corpus:
- `multiplexer/tool-picker.json` (17 cases)
- `multiplexer/dashboard-control-overlays.json` (key-handler dispatch)
- `multiplexer/dashboard-interaction-command-keys.json` and
  `multiplexer/session-launch-actions.json` (picker entrypoints)

Recent failures found and closed in this lane: 0 in the latest audit slice;
existing tool-picker fixtures remain mutation-proven.

Uncaptured count: 0.

### `src/multiplexer/project-event-stream.ts`

Exported surface: SSE timing constants, start/stop, event handler,
view-refresh scheduler, and dashboard alert application.

Behavior families:
- Debounced refresh, refresh serialization, burst coalescing, hidden dashboard
  queueing, stopped/left-dashboard suppression, active-view refresh state,
  reconnect/failure resync, retry backoff, alert application, and ignored stale
  buffered events.

Corpus:
- `runtime-state/project-event-stream.json` (22 cases)
- `PHASE8_LIVE_RESIDUALS.md` documents the separate SSE live stress/prove-fails
  check for ordering under load, which corpus data cannot fully prove.

Recent failures found and closed in this lane: 0 in the latest audit slice;
existing project-event-stream fixtures remain mutation-proven.

Uncaptured count: 0.

## Corpus Size Sweep

The former oversized `tmux/expose-hot-snapshot.json` case is no longer present
as a multi-megabyte payload; the file is below the 200 KB sweep threshold.

Current files over 200 KB:

| Corpus | Size | Largest Case | Judgment |
| --- | ---: | ---: | --- |
| `agent-output/parser-fuzz.json` | 1.6 MB | 7.9 KB | Legitimate many-case fuzz corpus. |
| `tmux/control-script.json` | 452 KB | 9.3 KB | Legitimate many-case tmux control corpus. |
| `runtime-exchange/store.json` | 323 KB | 59.9 KB | Legitimate store compaction/state corpus. |
| `multiplexer/dashboard-interaction.json` | 268 KB | 11.6 KB | Legitimate many-branch dashboard interaction corpus. |
| `agent-output/parser-adversarial.json` | 243 KB | 7.5 KB | Legitimate parser adversarial corpus. |

No remaining oversized single case over 200 KB was found.
