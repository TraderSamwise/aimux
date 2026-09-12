# Async Cutover PR Description v1

## Summary

This branch moves Aimux's long-lived connection and subprocess-heavy runtime
paths onto tokio while preserving the existing control-plane and tmux
boundaries. The work covers the shared async runtime, subprocess execution,
project-service listener/SSE transport, scheduler tick tasks, daemon stream
handling, relay, hosted server, local UI serving, and the project-service route
families that can reach subprocesses.

The migration also adds the gates needed to make this kind of port reviewable:
characterization replay, async misuse audits, marker-based sync/async seam
accounting, classified native integration targets, and Phase 8 live residuals
against a real isolated tmux server.

## What Changed

- Added one shared tokio runtime per process with named task registration and
  doctor visibility.
- Moved subprocess calls behind async helpers with timeout and child
  cancellation behaviour.
- Converted project-service HTTP and SSE transport from thread-per-connection
  to tokio tasks.
- Converted the project-service scheduler and task bodies so timeout and
  cancellation happen at the task boundary, not around abandoned blocking
  workers.
- Converted daemon listener/stream proxy, relay, hosted server, local UI, and
  high-value project-service route families.
- Made destructive lifecycle routes cancellable up to the irreversible tmux
  mutation, and recorded abandoned lifecycle responses after that point.
- Replaced central async seam count allowances with adjacent
  `aimux-async-seam` markers that carry classification and reason at the call
  site.
- Added Phase 8 live residual CI coverage for real tmux, daemon, dashboard,
  spawn, graveyard, SSE, process, and command behaviour.

## Verification

- `yarn verify:full` passed end to end on the branch.
- Latest recorded pass after the marker seam gate:
  - Wall clock: 348s
  - Native runner: failed=0
  - Root JS: 11 files, 96 tests
  - App: 73 files, 495 tests
- Phase 8 residuals run as a live isolated CI gate and have already caught real
  regressions during this migration.
- Async seam gate mutation proof: removing a site marker fails with the exact
  marker format to add; restoring it passes.
- Characterization targets are classified in the native runner so they cannot
  silently disappear from CI.

## Review Notes

The main risk is not compilation; it is changed behaviour under cancellation,
slow clients, missing tmux servers, dropped HTTP clients, and runtime nesting.
Review should focus on the hazard checklist in
`docs/async-cutover/plan-v2.md`, especially:

- blocking work inside async paths,
- locks held across `.await`,
- cancellation after destructive side effects,
- request-head and response-flush discipline,
- errors collapsed into empty values,
- unnamed tasks,
- remaining transitional sync/async seams.

## Known Open Failures

- Hosted proxy still has a live `UND_ERR_SOCKET` failure on `/agents/output`
  through the proxy while shorter hosted requests work.
- Expose still has a live empty-tile failure and needs live investigation.

Those are intentionally called out rather than hidden as fixture drift.

## Install Scope

Async cutover builds install only on `sam-mbp2` until Sam explicitly expands the
scope. Do not install this branch on the primary machine or the Mac mini as a
sanity check.
