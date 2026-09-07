# Multiplexer Sufficiency Audit v1

Scope: the nine modules owned by this lane before TypeScript deletion:
`dashboard-control.ts`, `dashboard-model.ts`, `dashboard-interaction.ts`,
`dashboard-ops.ts`, `dashboard-tail-methods.ts`, `session-launch.ts`,
`session-runtime-core.ts`, `tui-api-runtime.ts`, and `index.ts`.

Method: enumerate exported functions and distinct branch families, map each to
captured TypeScript output, then add fixtures for thin spots. Every added suite
was mutation-proven with `scripts/audit-fixture-enforcement.mjs`.

## Result

Deletion gate status for this lane: ready.

The previously recorded `dashboard-control.ts` `startRuntimeGuardRepair`
owned-repair branch is now captured without touching the live fleet by loading
the compiled TypeScript with a mocked `runtime-restart.js` dependency. Safe
pre-restart branches remain covered in `multiplexer/runtime-helpers.json`.

## Module Mapping

### `src/multiplexer/index.ts`

Exports/behaviors:
- `Multiplexer` prototype method surface and delegated module wiring.
- Native fork launch selection/refusal and launch override handling.
- Alert context publication and fork-session orchestration.

Corpus:
- `testdata/contracts/v1/multiplexer/index-helpers.json` (11 cases)

Uncaptured count: 0.

### `src/multiplexer/dashboard-ops.ts`

Exports/behaviors:
- Dashboard operation feedback wrapper.
- Spawn, fork, switch, migrate, stop, graveyard, resume, service create/start,
  service stop/remove, pending action tokens, coalescing, timeouts, and local
  non-dashboard mutation paths.
- Session detail rendering and terminal text wrappers.

Corpus:
- `testdata/contracts/v1/multiplexer/dashboard-ops-helpers.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-ops-agent-actions.json` (6 cases)
- `testdata/contracts/v1/multiplexer/dashboard-ops-mutations.json` (19 cases)
- `testdata/contracts/v1/multiplexer/dashboard-session-details.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-tail-actions.json` (5 cases)

Uncaptured count: 0.

### `src/multiplexer/dashboard-tail-methods.ts`

Exports/behaviors:
- Tail method delegation for sessions, services, visual order, worktrees,
  lifecycle actions, session creation, agent actions, labels, and details.
- Project-service vs dashboard selector behavior.

Corpus:
- `testdata/contracts/v1/multiplexer/dashboard-state-helpers.json` (10 cases)
- `testdata/contracts/v1/multiplexer/dashboard-tail-actions.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-tail-lifecycle.json` (6 cases)
- `testdata/contracts/v1/multiplexer/dashboard-tail-session-create.json` (8 cases)
- `testdata/contracts/v1/multiplexer/dashboard-session-details.json` (5 cases)

Uncaptured count: 0.

### `src/multiplexer/tui-api-runtime.ts`

Exports/behaviors:
- Runtime request/mutation snapshots, stale/recoverable/fatal transitions,
  disposal, scheduler timing, recovery suppression, guard probing, and critical
  resource refresh.

Corpus:
- `testdata/contracts/v1/multiplexer/tui-api-runtime.json` (24 cases)
- `testdata/contracts/v1/multiplexer/tui-api-runtime-state.json` (23 cases)

Uncaptured count: 0.

### `src/multiplexer/dashboard-control.ts`

Exports/behaviors:
- Project root resolution, screen setting, notification context, selected entry
  helpers, last-used tracking.
- Runtime guard key ownership, safe pass-through, stale/disconnected mutation
  blocking, and safe repair preconditions.
- Overlay dispatch/rendering, orchestration input/route picker, project-service
  request resolution, stale endpoint repair, and local tmux focus/open helpers.

Corpus:
- `testdata/contracts/v1/multiplexer/dashboard-control-helpers.json` (8 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-runtime-guard-keys.json` (14 cases)
- `testdata/contracts/v1/multiplexer/runtime-helpers.json` (15 cases)
- `testdata/contracts/v1/multiplexer/runtime-guard-repair-start.json` (1 case / 3 scenarios)
- `testdata/contracts/v1/multiplexer/dashboard-control-overlays.json` (10 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-overlay-output.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-orchestration.json` (8 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-activation.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-project-service-request.json` (8 cases)
- `testdata/contracts/v1/multiplexer/dashboard-control-worktree-sessions.json` (4 cases)

Uncaptured count: 0.

### `src/multiplexer/dashboard-model.ts`

Exports/behaviors:
- Pending-action reconciliation and tokenized metadata pending settlement.
- Worktree group build/compose ordering, model application, snapshot invalidation,
  desktop-state snapshot generation, session/service computation, process-info
  parsing, project-service refresh, local refresh, and service lifecycle.

Corpus:
- `testdata/contracts/v1/multiplexer/dashboard-model-pending-actions.json` (6 cases)
- `testdata/contracts/v1/multiplexer/dashboard-model-metadata-pending.json` (6 cases)
- `testdata/contracts/v1/multiplexer/dashboard-worktree-groups.json` (7 cases)
- `testdata/contracts/v1/multiplexer/dashboard-model-apply.json` (7 cases)
- `testdata/contracts/v1/dashboard/desktop-state-golden.json` (4 cases)
- `testdata/contracts/v1/multiplexer/dashboard-model-process-info.json` (3 cases)
- `testdata/contracts/v1/runtime-state/dashboard-model-service.json` (11 cases)
- `testdata/contracts/v1/multiplexer/dashboard-model-services-lifecycle.json` (4 cases)

Uncaptured count: 0.

### `src/multiplexer/dashboard-interaction.ts`

Exports/behaviors:
- Dashboard key routing, activation, quick jump, command keys, route picker input,
  overlay helpers, overlay key handlers, async overseer/scribe mutations, review
  request, route preview formatting, and orchestration submit.

Corpus:
- `testdata/contracts/v1/multiplexer/dashboard-interaction.json` (13 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-navigation.json` (10 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-command-keys.json` (12 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-activation.json` (10 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-helpers.json` (12 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-overlays.json` (40 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-review-request.json` (5 cases)
- `testdata/contracts/v1/multiplexer/dashboard-interaction-orchestration-submit.json` (6 cases)

Uncaptured count: 0.

### `src/multiplexer/session-launch.ts`

Exports/behaviors:
- Default scribe launch resolution and ensure/create/skip/claim paths.
- Backend-derived Aimux IDs, launch arg redaction, Codex developer-instruction
  insertion, startup project-service/dashboard paths, run/resume/restore,
  create/createAsync, migration/switching, worktree grouping helpers, focus, and
  dashboard action dispatch.

Corpus:
- `testdata/contracts/v1/multiplexer/session-launch-default-scribe.json` (8 cases)
- `testdata/contracts/v1/multiplexer/runtime-helpers.json` (15 cases)
- `testdata/contracts/v1/multiplexer/session-launch-startup.json` (4 cases)
- `testdata/contracts/v1/multiplexer/session-launch-resume.json` (7 cases)
- `testdata/contracts/v1/multiplexer/session-launch-create.json` (9 cases)
- `testdata/contracts/v1/multiplexer/session-launch-migrate-switch.json` (7 cases)
- `testdata/contracts/v1/multiplexer/session-launch-actions.json` (11 cases)
- `testdata/contracts/v1/multiplexer/session-launch-dashboard.json` (10 cases)

Uncaptured count: 0.

### `src/multiplexer/session-runtime-core.ts`

Exports/behaviors:
- Labels, dashboard label updates, status/headline derivation, running-session
  resolution, live tmux target resolution, interrupt/resize/send input for plain
  and tmux-backed sessions, output parsing/projection/cache, transcript forget,
  runtime registration, runtime event handling, tmux metadata build/sync, and
  context watcher projection.

Corpus:
- `testdata/contracts/v1/multiplexer/session-runtime-label-update.json` (6 cases)
- `testdata/contracts/v1/multiplexer/session-runtime-headline.json` (6 cases)
- `testdata/contracts/v1/multiplexer/runtime-helpers.json` (15 cases)
- `testdata/contracts/v1/multiplexer/session-runtime-agent-controls.json` (10 cases)
- `testdata/contracts/v1/multiplexer/session-runtime-output.json` (5 cases)
- `testdata/contracts/v1/multiplexer/session-runtime-metadata.json` (4 cases)
- `testdata/contracts/v1/multiplexer/session-runtime-tmux-metadata-sync.json` (3 cases)

Uncaptured count: 0.

## Evidence Added In This Audit

- `2221a1d3` captured direct dashboard interaction helpers.
- `d6aa4f70` expanded dashboard interaction overlay branch coverage.
- `9cc65caf` captured default-scribe unknown/disabled tool skips.
- `795c8d0e` expanded launch helper edge coverage.
- `8868e10c` captured tmux-backed session control branches.
- `9355fc31` captured default-scribe claim timeout.
- `cc99cba7` wired native plugin statuses into project-service diagnostics.
- `bb389a46` captured the `startRuntimeGuardRepair` owned-repair branch
  without live fleet manipulation.
