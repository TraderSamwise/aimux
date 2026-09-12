# Async Cutover — Execution Plan v1

Adopt tokio across every surface that holds an idle connection, waits on a process it
does not control, or waits on time. The TUI render loop, the Expose input loop, CLI
dispatch, pure logic, and the event-loop sampler stay sync. Surface-by-surface rationale
is in the design doc; this file is the build order, the parallelism, and the correctness
apparatus.

## The correctness problem, stated

The Node port had a source of truth: `git show a9220736^:<path>`. **This migration has
none.** A conversion bug produces code that compiles, passes existing tests, and behaves
differently under concurrency. So the plan supplies a substitute source of truth before
any conversion starts.

**The pre-conversion binary is the source of truth.** Phase 0 captures its observable
behaviour as recorded fixtures; every later phase must reproduce them byte for byte.

Five gates, every phase, no exceptions:

1. **Characterization diff** — recorded request/response and SSE transcripts from the
   pre-conversion build replay green against the converted build.
2. **Scoped tests, mutation-proved both directions** — break the assertion in production
   code, watch it fail, restore, watch it pass. Must-catch and must-not-catch.
3. **Adversarial review** against the async hazard checklist (below), by an agent that did
   not write the code.
4. **Live drive on sam-mbp2** — build a release asset, install, exercise the surface for
   real. Never install on the primary machine.
5. `yarn verify` fast lane green. Scoped cargo targets only; never the full suite.

## Branches

`feat/async-cutover` is the integration branch and the thing that eventually PRs to
master. It is what the main checkout is on.

- **Phases 0, 1, 2** land directly on it. The agents share the main checkout and the file
  groups are disjoint, so a branch per agent would buy nothing and cost a merge each.
- **Phase 3** is where separate branches earn their keep, because the three daemon islands
  are worked simultaneously in separate worktrees. One branch each off
  `feat/async-cutover` — `feat/async-daemon-listener`, `feat/async-relay`,
  `feat/async-hosted` — merged back in that order, since hosted calls the listener's
  generic stream handler.
- **Phase 4** lands on the integration branch again.

Merge, never rebase, across agents and branches. Nobody creates a branch in the main
checkout while others are working in it.

## Where builds may be installed

**sam-mbp2 only.** For the whole cutover, no build from this work goes onto the primary
machine or the Mac mini — not "just to check", not a build that looks fine. Stability is
far enough away that a local install is a way to lose a working machine.

On sam-mbp2 there are no limits: install obviously broken builds, leave it wedged, break
the daemon. That is what it is for. Nothing important runs there.

Revisit only when Sam says the cutover is approaching stable.

## Async hazard checklist (the review rubric)

Every review pass checks all of these by name and reports per item:

- **Blocking call inside an async fn.** `std::process`, `std::net`, `std::fs` on a hot
  path, `std::thread::sleep`, blocking channel recv. Must be `tokio::` equivalents or
  `spawn_blocking`.
- **Lock held across an await.** `std::sync::Mutex` guard alive over `.await` deadlocks or
  stalls the executor. Either drop before awaiting or use `tokio::sync::Mutex`.
- **Cancellation safety.** When a task is dropped mid-await, what state is half-written?
  Every `select!` branch and every `timeout` wrapper needs this answered explicitly.
- **Child process orphaning.** `tokio::process::Command` without `kill_on_drop(true)`
  leaks the child when the future is cancelled — the exact bug this migration exists to
  fix.
- **Unbounded spawning.** `tokio::spawn` in a loop with no join or limit.
- **Errors collapsed into empty values.** The standing repo rule. `?? []`,
  `unwrap_or_default()`, `.catch(() => null)` on a fallible async call.
- **Task naming.** An unnamed task is invisible in diagnostics; a stuck task must be
  identifiable from `aimux doctor`.
- **Runtime nesting.** `block_on` inside an async context deadlocks. Transitional
  `block_on` calls are permitted only at a named sync/async seam and must be listed.

## Phases

Each phase ends committable: typecheck, clippy, fmt, scoped tests, `yarn verify` green.
Commits are explicit-path only — several agents share this checkout.

### Phase 0 — Foundation and apparatus

Three agents, fully parallel, near-zero overlap.

- **0a · Runtime foundation.** tokio in `native/Cargo.toml` with the feature set actually
  needed (no `full`). Shared runtime bootstrap, task-naming helper, `spawn_blocking`
  policy, and a `aimux doctor` surface that lists live tasks. Touches `Cargo.toml`,
  a new `runtime.rs`, `doctor`.
- **0b · Characterization harness.** Record the pre-conversion behaviour of the project
  service HTTP + SSE surface and the daemon HTTP surface as replayable fixtures, plus the
  replay runner. **This is the source-of-truth substitute and it must land before any
  conversion.** Touches `tests/` and a new fixture directory only.
- **0c · Hazard gates.** Clippy config (`await_holding_lock` and friends denied) plus a
  grep-based audit script that fails on `std::process` / `std::net` / `std::thread::sleep`
  inside an `async fn`, wired into `yarn verify`. Prove the gate can fail. Touches
  `clippy.toml`, `scripts/`, `package.json`.

### Phase 1 — Subprocess boundary

One agent, one reviewer. **The highest-value conversion in the codebase.**

`tmux.rs` (3,186 lines) and the other subprocess call sites move to
`tokio::process::Command` with `kill_on_drop(true)` inside `tokio::time::timeout`. Direct
cutover: helpers and their callers convert together. Callers still in sync processes use a
single shared `block_on` at a named seam, recorded in the commit body and deleted in
Phase 4.

### Phase 2 — Project service, whole

Two agents on a file-group split, one reviewer. Start here: it holds the thread-per-stream
cost that exists today, owns most subprocess calls, and there are thirteen of these
processes so every win multiplies.

- **2a · Transport.** `process.rs`, `server.rs`, `http.rs`, `dispatcher.rs`,
  `event_streams.rs`. Listener and SSE streams become tasks.
- **2b · Tick loop.** `scheduler.rs` and the six tick tasks become `tokio::time::interval`
  + `JoinSet` + `timeout`. Delete the worker-pool design; keep health states, watchdog,
  jitter and the registration test. **`watcher_delivery` comes back onto the loop** — it
  left only because bounded tmux delivery had nowhere to live.

### Phase 3 — Daemon, whole

Three agents, one per worktree — these are genuinely separable islands.

- **3a · Listener and stream proxy.** `daemon/listener.rs`, `daemon/stream.rs`.
- **3b · Relay.** `relay_runner.rs`, `websocket.rs`, `daemon/relay.rs`. The per-project
  reader threads collapse into one task with `select!`.
- **3c · Hosted and Expose.** `hosted_server.rs`, `daemon/expose.rs`,
  `visual_clients.rs`, daemon disk maintenance. Hosted rides along while it is still one
  demo project.

3a lands before 3c merges — hosted calls the listener's generic stream handler.

### Phase 4 — Leftovers and seam deletion

One or two agents. Attachments, `local_ui_server.rs`, `remote_login.rs`, the CLI
`block_on` helper. **Then delete every transitional seam from Phase 1** and assert none
remain. The dashboard SSE reader goes async here; the render loop stays sync behind a
channel.

## Parallelism and merge tax

- Phase 0: three agents, main checkout, disjoint files.
- Phase 1: one agent — `tmux.rs` is a single coupled unit and splitting it buys nothing.
- Phase 2: two agents, main checkout, file-group split.
- Phase 3: three agents, one worktree each; merge in order 3a, 3b, 3c.
- A dedicated **reviewer agent runs continuously** across all phases. Read-only, zero
  merge tax, reviews each landed commit against the hazard checklist.

Rules that keep the tax low: stage explicit paths only, never `git add -A`, never touch a
file you did not write, commit promptly, merge — never rebase — across agents.

## Non-goals

- No hand-rolled reactor. The scheduling policy is ours; readiness notification is not.
- No async in the TUI render loop, the Expose input loop, CLI dispatch, or pure logic.
- No `tokio::full`. Take the features actually used.
- No module-at-a-time drift. The unit of conversion is a process.
