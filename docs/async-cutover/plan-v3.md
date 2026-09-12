# Async Cutover — Execution Plan v3

This is the PR-facing plan for `feat/async-cutover`. Version 1 is the
pre-work plan. Version 2 recorded the first full branch green. Version 3 updates
that record with the hosted stream fix and the Phase 3 adversarial-review
findings that still need work.

The goal is unchanged: move Aimux surfaces that hold idle connections, wait on
child processes, or wait on time onto tokio without changing observable
behaviour. The main lesson from the branch is that async conversion is not a
threading swap; it is a correctness migration around cancellation, request
flushes, process ownership, and errors that must not become empty values.

## Current State

The branch has a shared tokio runtime, async subprocess boundaries, an async
project-service transport, async project-service tick tasks, daemon listener and
stream conversions, hosted and relay conversions, and async route-family
conversions for project-service APIs that can reach subprocesses.

`yarn verify:full` has passed end to end on the branch:

- Native runner: `failed=0`
- Root JS: 11 files, 96 tests
- App: 73 files, 495 tests
- Wall clock: 382s at `fa6fefad`, then 348s at `52a09540` after the marker seam
  gate change

That pass proves the release lane is now a real gate for this branch. It does
not close the open runtime findings listed below.

## What Changed From v1

Phase 4 expanded. The original plan treated it as leftover cleanup and deleting
a few transitional seams. Route enumeration showed that most project-service API
families can reach subprocesses, so Phase 4 became three route-family
conversions:

- Destructive lifecycle mutations: spawn, stop, kill. These are cancellable up
  to the irreversible tmux mutation; after the irreversible point, abandoned
  responses are recorded instead of disappearing.
- Live pane output routes. These moved to async while preserving cancellation
  and response semantics.
- Read and control routes. These removed broad sync dispatch seams instead of
  relying on `block_on` from hot request paths.

Phase 2c appeared. Version 1 had project-service transport and tick-loop phases,
but the actual scheduler work required converting `PeriodicTask::run` and the
task bodies themselves. Without that, timeout wrappers could still abandon
blocking workers while the scheduler looked async from the outside.

The scheduler cadence bug predated the cutover. During Phase 2c, the explicit
async-misuse panic exposed a hidden design problem: cadence lookup was shelling
out to git on every reschedule. That was not an async regression, but the
cutover made it visible because nested blocking could no longer happen
silently. The fix was to keep cadence state in-process and schedule next runs
from task finish time.

The seam gate changed twice. It started as a central path/count allowlist, which
was too easy to silence by increasing a number. The built gate now requires an
adjacent `aimux-async-seam` marker at every sync/async bridge with a
classification and reason. A missing marker fails with the exact marker format
to write; stale markers fail when the seam goes away.

The remote live-drive script became a gate. Phase 8 residuals were not in v1.
They now run live tmux and daemon flows on isolated homes and sockets, and they
caught real regressions during the migration: empty tmux server bootstrap,
graveyard restoration semantics, process residual races, dashboard managed
client sessions, and local UI response flushing.

Characterization coverage had to grow. The first recording covered the core
project-service and daemon HTTP/SSE surfaces. It missed daemon stream proxy,
relay, and hosted surfaces, then later missed Phase 4 cancellation contracts
that had no pre-conversion equivalent. The current branch includes those
additional characterization targets and classifies them in the native runner so
CI actually executes them.

## Gates

The branch now has five practical gates:

1. **Characterization replay.** The async characterization targets replay
   captured request, response, stream, daemon, relay, and hosted behaviour. These
   are classified in the native runner so an unlisted integration target fails
   before CI can skip it.
2. **Marker-based seam audit.** `yarn audit:async-seams` scans Rust source and
   tests for `block_on` and `block_on_named`. Every remaining seam needs an
   adjacent marker with one of `permanent`, `transitional`, `test`, or
   `fixture`, plus a reason.
3. **Async hazard audits.** `yarn audit:async-blocking`,
   `yarn audit:async-clippy`, `cargo fmt --check`, clippy all-target coverage,
   and the Rust orphan audit run in the fast lane. They guard against blocking
   calls inside async functions, hidden fixture twins, formatting drift, and
   lint regressions.
4. **Full release lane.** `yarn verify:full` runs typecheck, lint, native
   runner, root JS tests, app lint, and app tests. The native runner builds all
   targets once, refuses unclassified integration targets, runs safe targets in
   parallel, and keeps tmux/daemon/socket tests serial with written reasons.
5. **Phase 8 live residuals.** CI runs live tmux residual lanes against isolated
   homes, sockets, and ports. These lanes are deliberately slower because they
   verify real process, tmux, dashboard, spawn, graveyard, SSE, and command
   behaviour rather than fixture-only contracts.

Scoped mutation proof remains required for every phase-level fix: break the
assertion or behaviour, watch the gate fail, restore it, watch it pass.

## Async Hazard Checklist

Reviews use this checklist. Each item must be answered, not implied:

- **Blocking call inside async code.** `std::process`, `std::net`, `std::fs`,
  blocking channel receives, and `std::thread::sleep` must either move to tokio
  APIs or sit behind a named `spawn_blocking` boundary.
- **Lock held across await.** A `std::sync::Mutex` guard or shared state borrow
  must not live across `.await`.
- **Cancellation safety.** For every timeout, disconnect, or dropped task, state
  what is half-written. Destructive routes must either cancel before mutation or
  record that the mutation completed after the caller disappeared.
- **Child process orphaning.** `tokio::process::Command` must use
  `kill_on_drop(true)` unless the call site documents why the child must outlive
  the future.
- **Unbounded spawning.** Loops must not spawn tasks without a join path,
  timeout, or concurrency bound.
- **Errors collapsed into empty values.** A failed inventory, stream, tmux query,
  or delivery must not become `[]`, `{}`, `false`, or success without a visible
  reason.
- **Task naming.** Spawned async and blocking tasks must be named so `aimux
  doctor` can identify stuck work.
- **Runtime nesting.** `block_on` inside a runtime context is a bug. Remaining
  bridges need local seam markers and should trend down as route families become
  async.
- **Read-head and flush discipline.** Async listeners must consume the request
  head they need and flush complete responses before closing, or clients can see
  `ECONNRESET`/`UND_ERR_SOCKET` instead of an HTTP response.
- **Isolated live tests.** Any live daemon, tmux, or project-service test must
  use isolated `AIMUX_HOME`, socket, and port, and must stop its own daemon at
  the end.

## Built Phases

### Phase 0 — Foundation and Gates

Phase 0a added the shared tokio runtime with scoped features, task naming,
`spawn_blocking` policy, and doctor visibility. Phase 0b added the initial
characterization harness. Phase 0c added the async blocking audit and clippy
coverage.

### Phase 1 — Subprocess Boundary

Subprocess execution moved through async helpers with timeout and
`kill_on_drop(true)`. Sync callers retained explicit transitional seams. A later
review found nested runtime panics when sync route handlers called those helpers
from tokio blocking threads; that pushed Phase 4 from seam cleanup into route
conversion.

### Phase 2 — Project Service

Phase 2a converted the project-service listener and SSE transport to tokio. It
added slowloris and disconnect coverage so incomplete clients do not stall
runtime workers and SSE write failures surface as errors.

Phase 2b converted the scheduler loop. Phase 2c then converted
`PeriodicTask::run` and the task bodies so timeout and cancellation behaviour
belonged to the tasks themselves rather than to abandoned blocking workers.

### Phase 3 — Daemon, Relay, Hosted

Daemon listener and stream proxy routes moved to async. Relay stream handling
collapsed per-project reader threads into async tasks. Hosted server conversion
added event-driven outbox draining with a slow backstop and moved hosted stream
handling onto the same async transport model.

The best Phase 3 fix came from adversarial source review before a complete live
reproduction: hosted `/agents/output` failed with `UND_ERR_SOCKET` because the
daemon listener converted a tokio socket back to `std` and called
`shutdown(Shutdown::Both)`. That sent RST instead of FIN. Short hosted requests
passed because they finished before the hard close mattered; the streaming
route failed every time. `290bd78a` fixed the close to use async shutdown. This
is the clearest example in the migration of why adversarial review was worth
running.

### Phase 4 — Route Families and Seam Deletion

Phase 4 converted the destructive lifecycle routes, live pane output routes, and
read/control route families. It also moved local UI serving and residual
leftovers. The important rule from this phase is that sync dispatch around an
async route is not neutral: a dropped client can still leave a destructive
mutation running unless cancellation is carried to the real subprocess boundary
or the abandoned mutation is recorded.

## Fixed Findings Worth Remembering

- **Hosted stream `UND_ERR_SOCKET`.** Fixed in `290bd78a`. The daemon listener
  was forcing a hard close by converting the tokio socket to `std` and calling
  `shutdown(Shutdown::Both)`. The fix made shutdown graceful on the async
  stream.
- **Local UI `ECONNRESET`.** Fixed by consuming the request head and flushing a
  complete response before closing the async local UI connection.
- **Missing tmux server bootstrap.** Fixed by treating a missing tmux server as
  an empty inventory at the tmux boundary, so bare dashboard, spawn, and
  graveyard flows bootstrap instead of aborting.
- **Silent destructive lifecycle completion after disconnect.** Fixed by making
  spawn, stop, and kill cancellable before the irreversible tmux mutation and
  recording abandoned responses after it.

## Open Findings

These are still live and should not be hidden by documentation or fixture drift,
ranked by review severity:

1. **Expose-empty from missing topology.** Expose renders `all worktrees (0)`
   because `runtime_topology.rs:39` converts missing topology into
   `Ok(empty_runtime_topology())`. That is an unavailable derived file becoming
   a clean successful empty view, directly violating the errors-are-not-empty
   rule at the source.
2. **Relay RouteRequest cancellation can orphan mutation knowledge.** A remote
   caller can disconnect while a non-idempotent daemon mutation still applies.
   The caller receives no response and may retry a kill or delete that already
   happened.
3. **Hosted accepts unbounded sockets before auth or rate limiting.** Hosted
   spawns a task per connection before authentication, rate limiting, or a read
   timeout. A slowloris client can therefore consume runtime capacity before any
   policy has a chance to reject it.
4. **Hosted body-limit path routes synchronously inline on a tokio worker.** One
   hosted request path uses the blocking strategy, while the body-limit variant
   routes inline on the runtime worker. That reintroduces the blocking-worker
   hazard the cutover is meant to remove.
5. **Hosted stream slots can leak.** Stream concurrency slots are not protected
   by an RAII permit. A disconnect or early return can leave a slot claimed and
   make later legitimate streams look over-limit.
6. **Relay outbox pop happens before write completion.** A relay frame is
   removed from the outbox before the awaited write completes. If the task is
   aborted between pop and write, the frame is lost.
7. **Hosted background workers are unnamed bare threads.** Two hosted background
   workers still use `thread::spawn` and are invisible to `aimux doctor`, so a
   stuck worker cannot be identified through the runtime task surface.

## Install Policy

Cutover builds install only on `sam-mbp2` until Sam says the branch is stable
enough for the primary machine or the Mac mini. Verification on other machines
is not a shortcut; it is explicitly out of scope for this branch until Sam
changes that rule.

## Non-Goals

- No hand-rolled reactor.
- No async TUI render loop or Expose input loop.
- No `tokio::full`; features stay scoped to actual use.
- No hidden fallback paths. A sync/async seam is either permanent by process
  shape, transitional with a deletion plan, or test/fixture-only with a local
  marker.
