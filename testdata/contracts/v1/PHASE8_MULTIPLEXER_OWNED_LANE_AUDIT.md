# Phase 8 Multiplexer Owned Lane Audit v1

Audit point: `rust-translation-v1 owned-lane sufficiency pass` historical deletion baseline. Current active suite/corpus bindings live in `ENFORCEMENT_AUDIT.md`.

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

The six modules total 4,879 TypeScript LOC and are covered by 253 direct cases
from their own test sources, plus adjacent corpora for inbox cleanup, text
helpers, and worktree graveyard projection. This pass found 56 behavior-level
misses in the owned lane and captured all 56 as enforced cases.

Scoped enforcement after the pass is historical; use `ENFORCEMENT_AUDIT.md` for the current active inventory.

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
- `notifications/inbox-cleanup-runtime.json` (2 adjacent cleanup cases)

New misses captured in this pass: 6 maintenance timer cases covering
start/stop for graveyard and inbox cleanup, guarded double-start behavior, and
clearInterval side effects.

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

New misses captured in this pass: 7 wrapper/action cases for direct overlay
render exports, list display, remove/cache confirm renderers, and the `y`
remove-confirm alias.

Recent failures found and closed in this lane: 1 worktree key-handler failure.

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
- `runtime-state/runtime-sync.json` (heartbeat and project-service refresh start/stop)

New misses captured in this pass: 6 method wrapper/state mutation cases for
heartbeat forwarding, project-service refresh forwarding, coordination render
routing, hidden-host render behavior, and zombie eviction side effects.

Recent failures found and closed in this lane: 10 runtime-state
restore/recovery and method-wrapper failures.

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

New misses captured in this pass: 6 cases for blank shell service create/resume,
blank launch-command metadata fallback, and non-service tmux-window guard
behavior.

Recent failures found and closed in this lane: 2 service runtime parity
failures.

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

New misses captured in this pass: 14 key-handler cases covering escape, arrow
movement, digit launch, options overlay entry/exit, launch option parse errors,
and option-key redraw semantics.

Recent failures found and closed in this lane: 8 tool-picker key-handler
failures.

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
- `runtime-state/project-event-stream.json` (39 cases)
- `PHASE8_LIVE_RESIDUALS.md` documents the separate SSE live stress/prove-fails
  check for ordering under load, which corpus data cannot fully prove.

New misses captured in this pass: 17 active-stream and alert cases covering
split SSE frames, multi-line data, CRLF/comment handling, malformed JSON debug,
empty event names, non-array project-update views, topology/graveyard active
view refreshes, non-OK stream startup, and all alert variants.

Recent failures found and closed in this lane: 7 project-event-stream parity
failures.

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
