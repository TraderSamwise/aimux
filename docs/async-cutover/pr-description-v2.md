# Async Cutover PR Description v2

## Summary

This PR moves Aimux's long-lived connection, timer, and subprocess-heavy runtime
paths onto tokio. The reason is resource pressure and correctness: the old
thread-per-connection model made SSE clients, project-service processes, relay
streams, and hosted streams expensive, and the sync port had accumulated places
where cancellation, missing tmux servers, or dropped clients produced silent or
misleading results.

The branch is not just an implementation swap. It adds the gates needed to
review the migration honestly: characterization replay, marker-based sync/async
seam accounting, async blocking audits, classified native integration targets,
and Phase 8 live residuals that drive a real isolated tmux server.

## What Changed

- Added a shared tokio runtime with named task registration and doctor
  visibility.
- Moved subprocess execution through async helpers with timeout and
  `kill_on_drop(true)`.
- Converted project-service HTTP/SSE transport, scheduler tick tasks,
  `PeriodicTask::run` bodies, daemon streams, relay streams, hosted server,
  local UI serving, and route families that can reach subprocesses.
- Made destructive lifecycle routes cancellable before the irreversible tmux
  mutation and observable after that point by recording abandoned responses.
- Replaced central async seam counts with local `aimux-async-seam` markers at
  every remaining bridge.
- Added Phase 8 live residual CI coverage for tmux, daemon, dashboard, spawn,
  graveyard, SSE, process, and command behaviour.

## Verification

- `yarn verify:full` passed end to end on the branch.
  - Native runner: `failed=0`
  - Root JS: 11 files, 96 tests
  - App: 73 files, 495 tests
  - Latest recorded wall clock after the marker seam gate: 348s
- Phase 8 live residuals run as a separate CI gate against isolated homes,
  sockets, and daemon ports.
- Mutation proof examples:
  - removing an `aimux-async-seam` marker fails the seam audit with the exact
    marker format to add;
  - removing the shared missing-tmux-server bootstrap mapping breaks bare
    dashboard, spawn, and graveyard lanes together;
  - removing lifecycle abandonment recording makes disconnect-after-mutation
    tests fail.

## Review Focus

The main risk is changed behaviour under async pressure, not type errors.
Review should focus on:

- cancellation after destructive side effects,
- slowloris and request-head handling,
- graceful response flushing before socket close,
- errors that become empty successful values,
- locks or blocking calls inside async paths,
- remaining transitional `aimux-async-seam` markers,
- child process ownership under timeout or disconnect.

`docs/async-cutover/plan-v3.md` has the full hazard checklist and the built
phase record.

## Fixed During Review

- Hosted `/agents/output` through the proxy failed with `UND_ERR_SOCKET`.
  `290bd78a` fixed the root cause: the daemon listener converted the tokio
  socket back to `std` and called `shutdown(Shutdown::Both)`, sending RST
  instead of FIN. Short requests passed; the streaming route failed reliably.
- Local UI responses could reset because the async listener closed before
  request-head and response-flush obligations were complete.
- Missing tmux servers aborted first-run dashboard/spawn/graveyard paths instead
  of bootstrapping a new private server.
- Destructive lifecycle requests could complete after a dropped client with no
  record that the caller never saw the result.

## Still Open

These are the live findings a reviewer should look at first:

1. **Expose-empty from missing topology.** `runtime_topology.rs:39` turns missing
   topology into `Ok(empty_runtime_topology())`, so Expose can render `all
   worktrees (0)` as a clean successful empty view.
2. **Relay RouteRequest cancellation.** A disconnected remote caller can leave a
   non-idempotent daemon mutation applied with no response, inviting unsafe
   retries.
3. **Hosted pre-auth slowloris exposure.** Hosted accepts unbounded sockets and
   spawns a task per connection before auth, rate limiting, or read timeout.
4. **Hosted body-limit inline routing.** One body-limit path routes
   synchronously on a tokio worker while the normal variant uses the blocking
   strategy.
5. **Hosted stream slot leaks.** Stream slots are not guarded by an RAII permit,
   so disconnects can make later streams look over-limit.
6. **Relay outbox loss on abort.** Relay pops a frame before awaiting the write;
   abort between those steps loses the frame.
7. **Hosted unnamed background threads.** Two hosted workers are bare
   `thread::spawn` and invisible to `aimux doctor`.

Those are intentionally listed here because the open list is part of the value
of the PR: it tells review where the migration is still risky instead of
presenting a clean-looking branch with hidden work.

## Install Scope

Async cutover builds install only on `sam-mbp2` until Sam explicitly expands the
scope. Do not install this branch on the primary machine or the Mac mini as a
sanity check.
