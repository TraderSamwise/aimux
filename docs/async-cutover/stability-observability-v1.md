# Runtime stability observability — v1

Sam's bar: not "it usually works" but "it provably is stable" after a week of real
use, checkable by reading what the runtime recorded.

## The gap

Today's observability is **event-shaped**: it tells you when something bad happened
once. A panic is logged. A task over 5s is logged. `aimux doctor tasks` reports
what is alive right now with an `age_ms`.

Nothing is **level-shaped**. Nothing tells you something has been quietly wrong for
an hour. Specifically, none of these are detectable today:

- a task that is registered and alive but has not COMPLETED in an hour
- a watcher whose work outpaces its cadence, so it silently runs less often
- timeouts accumulating — twenty in an hour reads exactly like one
- a bounded buffer filling toward its eviction threshold
- task count or memory trending up across a day

`age_ms` is the trap: it reports how long a task has EXISTED, not when it last
produced a result. A wedged task and a healthy one look identical.

## What to build

**1. Per-task health counters.** In the scheduler, per task: total runs, last
completed at, last duration, p95 duration, consecutive failures, consecutive
timeouts, total timeouts, last error. Exposed in `aimux doctor tasks`.

**2. Backlog depth.** Every bounded buffer reports current depth and high-water
mark: the relay outbox (512-frame cap with eviction), hosted outbox, watcher
delivery queue, SSE subscriber counts. A buffer that never empties is the shape a
leak takes before it becomes a leak.

**3. A periodic on-disk snapshot.** Current state at check time says nothing about
the week. A rail task writes a compact sample on a slow cadence to a bounded,
rotating file under the project or global state dir. Small enough to keep a week,
structured enough to diff. This is the piece that makes the whole thing answerable
after the fact.

**4. A verdict command.** `aimux doctor stability` reads the history and answers
plainly: stable, or not, and why. It must name specifics — "loop-watcher has not
completed in 2h", "relay outbox high-water 480 of 512", "task count up 30% over
24h" — never a bare score. If it cannot tell, it says so rather than reporting
healthy.

## Rules

- Recording must never be able to wedge the thing it measures. Bounded writes,
  bounded files, no unbounded in-memory accumulation.
- A metric that cannot be read is a failure, not a zero — the standing
  errors-are-not-empty-values rule applies to the observability itself.
- Every counter needs a test that moves it, and the verdict command needs a test
  where it correctly says NOT stable.
