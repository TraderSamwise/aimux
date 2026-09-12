# Live Drive Coverage Audit

Status: September 2026, after the async cutover live-drive failures around
Expose, kill honesty, runtime health history, and live harness contamination.

The live drive is still valuable, but it should be small. A check belongs in the
live lane only when the invariant depends on a real installed binary, a real
tmux server/client, real release metadata, or host behavior that an in-tree test
would necessarily fake. If the invariant is product logic behind a fallible
boundary, it needs an in-tree test with an injectable failure.

## Converted Or Covered In Tree

### Expose tile population

Live check: `expose-tile-population`.

Classification: mostly product logic, not inherently live. The original live
failure was "sessions exist, Expose renders zero tiles" after tmux live-window
projection erased topology-backed sessions.

In-tree coverage:
- `native/crates/aimux/tests/tmux_expose.rs` drives the async
  switchable-agents route, injects a projection-erased live-window query, and
  asserts Expose renders the topology-backed tile count instead of `(0)`.

Live residue: the live lane still proves the installed binary can open Expose in
a real tmux client and accept real key input.

### Kill failure honesty

Live check: readiness case `honesty-kill-failure-operation`.

Classification: product logic. The important invariant is that a real
`kill-window` error is not collapsed into success or an empty outcome, and that
the user-visible FAILED OPERATIONS surface sees the failure.

In-tree coverage:
- `native/crates/aimux/tests/project_service_lifecycle.rs` injects a failing
  tmux kill boundary and asserts the route fails, the session is not
  graveyarded, desktop-state contains `operationFailures`, and the dashboard
  frame renders `FAILED OPERATIONS` with the specific kill failure title.
- The same file keeps the inverse: a genuine no-window kill remains a clean
  no-op and does not record an operation failure.

Live residue: a real installed binary still needs to prove the actual tmux
wrapper and installed dashboard are wired to those code paths.

### Runtime health and stability reporting

Live check: observability/stability reporting in the readiness lane.

Classification: product logic once the recorder, history file, and doctor route
are in process. It does not require a sleeping-prone host to prove that moved
counters reach the user-facing verdict.

In-tree coverage:
- `native/crates/aimux/tests/runtime_health_composition.rs` drives a real
  scheduler task failure and a real backlog metric into runtime-health history,
  then reads it through the `/core/doctor/stability-text` route in both text and
  JSON mode. It asserts the verdict is `not_stable`, names task failures and
  buffer depth, and does not report `task-count-missing`.

Live residue: a real installed project-service still needs to prove the
recorder is scheduled immediately and then on cadence inside the installed
runtime.

### Hosted proxy reset and non-stream failure honesty

Live check: `hosted-proxy-ab`.

Classification: mixed. The protocol handling for reset/error responses is
product logic and belongs in in-tree daemon/proxy tests. The A/B setup across
two real hosted projects and a real local proxy still has live value.

Existing in-tree coverage includes hosted proxy reset cases in daemon tests. The
live residue is the installed proxy path, real project-service processes, and
port binding behavior.

## Stays Live

### Versioned binary

Live check: `versioned-binary`.

Reason: this proves the release asset installed on the target host is the binary
being driven. An in-tree test can check version parsing, but it cannot prove the
remote host is running the asset selected for the gate.

### Lifecycle happy path

Live check: `lifecycle`.

Reason: spawn, rename, stop, kill, and graveyard movement have many in-tree
route tests, including failure injection. The live lane should keep a small
happy path because it proves the installed CLI, daemon, project service, tmux
socket wrapper, and filesystem state work together on the host.

### Dashboard repaint and input loop

Live check: `dashboard-repaint`.

Reason: the product logic behind dashboard rendering has in-tree renderer and
controller tests. The live value is a real PTY/tmux client repainting after
resize without a keypress, which is not faithfully represented by an in-memory
renderer.

### SSE multiclient stress

Live check: `sse-multiclient`.

Reason: route-level SSE behavior has in-tree stress tests, but the live check
proves installed networking, process lifetime, and multiple real clients under
the host event loop. Keep this live, but keep protocol edge cases in tree.

### Hosted proxy A/B live path

Live check: `hosted-proxy-ab`.

Reason: as above, protocol failure modes should be in tree; the live lane keeps
only the real installed multi-project/proxy path.

### Tmux SIGSTOP wedge

Live check: `tmux-sigstop-wedge`.

Reason: the invariant is specifically about a real tmux process/pane becoming
wedged and Aimux's installed runtime reacting without hanging. Replacing that
with a fake process would stop proving the host behavior that caused the risk.

## Residue Summary

Keep the live lane for install identity, real tmux/PTY behavior, host process
lifetime, real port binding, real release `BUILD_STAMP`/version coherence, and
multi-process wiring. Move or keep moved product-logic failure paths in tree:
Expose empty tiles, kill failure honesty, runtime health verdicts, hosted proxy
reset honesty, and any future "error collapsed to empty" case.
