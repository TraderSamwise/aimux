# Per-Project Service Processes

Status: planned. Measuring document for the process-model half of
[core-sidecar-north-star.md](core-sidecar-north-star.md).

## Why

The north star lists the allowed long-lived processes as **one global daemon**
and **one per-project service per active project** — two entries. The code
collapses them: `src/core-project-actor.ts` sets `pid: process.pid`, so every
project service *is* the daemon. The completion tracker does not cover this;
it measures API-first boundaries, which are done. This is an unlisted
divergence between the documented architecture and the implementation.

It is not a purity argument. Node is single-threaded, so a synchronous call in
one project is dead time for every other project's HTTP handlers, including the
`/health` probe whose timeout decides whether clients believe the daemon is
alive at all. Measured on 2026-08-09:

| | |
| --- | --- |
| project-service `/health`, trivial handler | p50 4341ms, max 13462ms |
| loop delay p99 | 856ms |
| synchronous tmux share of wall time | 9.9% |

Clients read that as a dead daemon and each started a replacement, which took
over, was equally busy, and was replaced in turn — a new daemon every 20-60s
for ~25 minutes, every cycle tearing down the project service and with it the
Exposé socket.

Two fixes have landed and neither closes this:

- `shouldKeepUnresponsiveDaemon` (f5fdceb0) stops a stall becoming a loop. It
  makes slowness survivable, not rare.
- Build-scoped tmux memoization (0ed106eb) cut the synchronous share from 9.9%
  to 3.0% and loop p99 from 856ms to 388ms. Still over the 2% / 250ms budget in
  `src/event-loop-budget.ts`, and still one loop shared by every project.

Separate processes make the whole class unreachable: the kernel schedules them,
and one project's fork cannot occupy another project's loop. That is the reason
to do it, and the reason not to treat the memoization as the fix.

## Acceptance criteria

1. `CoreProjectActorState.pid` is the service's own pid, not `process.pid`.
2. Two active projects, one deliberately blocked in a long synchronous
   operation: the other project's `/health` stays under 100ms p99.
3. `assessLoopBudget` reports `withinBudget` for each service process under
   normal load.
4. A service crash does not take the daemon down; the daemon restarts it and
   records the restart where `aimux doctor versions` can show it.
5. A daemon restart does not orphan service processes — no strays after
   `aimux restart`, asserted by the existing orphan validation.
6. Endpoint discovery survives a service restart without clients re-reading a
   stale port. Today `metadata-api.txt` is the discovery file and it flickers
   during churn; hook `curl`s read it on every tool call.
7. The `pid` in `/projects` `serviceEndpoint` identifies a live process, and
   `isAimuxProjectServiceProcess` recognises it.

## Sequencing

1. **Make the service addressable as a process.** Extract the project service
   entrypoint so it can run standalone against a project root, still spawned
   in-process, and prove parity.
2. **Supervision.** The daemon spawns, health-checks, restarts with backoff, and
   reaps. This is where the failure modes live, and it is the phase that most
   wants its own tests: the restart loop this document exists to prevent was a
   supervision bug, not a performance bug.
3. **Endpoint discovery.** A service that moves ports must not strand hook
   `curl`s or the relay proxy. Decide whether the port is stable per project or
   discovered per call.
4. **Cut over.** Delete the in-process path — no dual mode, per the repo's
   direct-cutover convention.
5. **Verify against the criteria above**, on the live machine, under real agent
   load rather than a synthetic one.

## Risks

**Supervision is the dangerous part.** A supervisor that mistakes a busy service
for a dead one rebuilds exactly the loop this document is about, one level down.
Whatever `shouldKeepUnresponsiveDaemon` learned applies again: a live process is
evidence, and replacement needs more than a missed probe.

**Startup cost per project.** In-process activation is nearly free. A process
per project pays Node startup and plugin load each time — already ~2-3s in the
logs. Projects are long-lived, so this is an activation-latency question, not a
throughput one, but it needs measuring rather than assuming.

**Shared-state writers.** The project service is the single writer for project
state. Moving it to its own process does not change that, but it does mean the
daemon can no longer reach into it directly — any place that does is a boundary
violation that will surface during the cutover, and should be fixed rather than
bridged.

**IPC or HTTP.** The service already speaks HTTP and the daemon already proxies
to it, so HTTP is the smaller step and keeps one contract for local and relay
callers.
