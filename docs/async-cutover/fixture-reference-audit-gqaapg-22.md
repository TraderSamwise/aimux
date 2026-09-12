# Async Cutover Fixture Reference Audit

Queue item: `gqaapg-22`

This audit treats `testdata/contracts/v1/async-cutover/*.json` as recorded
behavior, not as proof that the behavior was correct. The fixtures were captured
from the pre-conversion binary, so a green replay can preserve a bug if that
binary already collapsed an error into a successful empty or `ok: true` shape.

## Classification Key

- `preserve` - genuine parity lock for HTTP/SSE framing, response shape, stream
  ordering, cancellation, or listener behavior. Keep exact fixture unless the
  product contract intentionally changes.
- `unsafe-reference` - fixture is plausibly recording behavior we no longer
  consider correct, or it cannot distinguish "empty" from "could not ask".
  Do not silently re-record; replace/split the assertion.
- `underpowered` - recorded behavior is not itself wrong, but the harness could
  still go green if the thing it sampled failed. Keep the case, but strengthen
  the assertion or add a companion case.

## `http-sse.json`

| Case | Classification | Rationale | Required action |
| --- | --- | --- | --- |
| `daemon-health` | preserve | Locks daemon liveness JSON, CORS/header ordering, close framing, and build stamp normalization. No known fallible domain state is collapsed into success. | Keep exact parity lock. |
| `daemon-project-ensure` | preserve | Locks daemon POST handling and waiting for a healthy project endpoint. Success is backed by the later endpoint read. | Keep exact parity lock. |
| `daemon-projects-after-ensure` | preserve | Locks daemon registry projection after an ensured project. It asserts a concrete project/service endpoint, not empty absence. | Keep exact parity lock. |
| `daemon-missing-route-error` | preserve | Locks explicit `404 ok:false` JSON for an unknown daemon route. This is the opposite of an empty-success lie. | Keep exact parity lock. |
| `project-health` | preserve | Locks project-service health response and service info. No runtime topology, tmux, or mutation result is inferred. | Keep exact parity lock. |
| `project-desktop-state-empty` | unsafe-reference | The observed `200 ok:true` with `sessions: []` and `services: []` is a valid empty desktop baseline only if the topology source was explicitly available and empty. The harness does not prove that; `read_runtime_topology` currently returns `empty_runtime_topology()` for a missing topology file, so this fixture can preserve "missing derived state means empty world." | Split it. Add/keep `project-desktop-state-explicit-empty-topology` that seeds an explicit empty topology file and asserts the current 200 shape. Add `project-desktop-state-missing-topology` or `project-desktop-state-unreadable-topology` that asserts the new intended behavior: not a clean empty world. Prefer `500 ok:false` with an error naming the topology read failure, or an explicit `topologyUnavailable`/operation failure if the product decides the route must stay 200. Do not update this fixture by simply recording whatever the current route returns. |
| `project-method-not-allowed-error` | preserve | Locks `405 ok:false` with `allowed: ["POST"]`. This is explicit error behavior. | Keep exact parity lock. |
| `project-sse-query-validation-error` | preserve | Locks validation before stream headers: `400 ok:false` JSON. This protects against partial SSE responses and is not an empty-success baseline. | Keep exact parity lock. |
| `project-sse-concurrent-clients-ordering` | preserve | Locks two open SSE clients receiving the same ready and project_update frames in order after real mutations. The mutations are asserted to return 200 before frames are read. | Keep exact parity lock. |
| `project-sse-keepalive-framing` | preserve | Locks idle SSE keepalive framing and timing window. It does not infer application state. | Keep exact parity lock. |
| `project-sse-client-disconnect` | preserve | Locks that one client disconnect does not poison later `/health`. It asserts the later health response shape. | Keep exact parity lock. |
| `project-incomplete-mutation-disconnect-no-side-effect` | underpowered | The intended contract is correct: a truncated mutation must not apply. But the sample only checks whether `/desktop-state` contains `codex-disconnect`; if `/desktop-state` failed, returned non-JSON, or collapsed topology failure into empty, the helper would also report `false`. | Keep the case, but assert every sample response is valid `200 ok:true` before checking absence. Also inspect the underlying topology or mutation store directly, so the proof of "no side effect" does not depend solely on the desktop-state projection. |
| `daemon-concurrent-projects-with-slow-client` | preserve | Locks listener concurrency under a slow incomplete daemon client. It asserts eight concrete `/projects` successes with the ensured project present. | Keep exact parity lock. |
| `runtime-logs-no-nested-runtime-panics` | underpowered | The target contract is correct, but the scanner silently ignores unreadable directories and files. A fixture value of `panicLogLines: []` can mean "no panic lines" or "could not read logs." | Keep the case, but record scan metadata such as `filesScanned` and fail the harness on read errors under the isolated `AIMUX_HOME`. |

## `phase3-surfaces.json`

| Case | Classification | Rationale | Required action |
| --- | --- | --- | --- |
| `daemon-stream-proxy-host-agent-text-transform` | preserve | Locks a stream proxy transform from upstream SSE output to the host-agent plain text response. The upstream request and response bytes are concrete. | Keep exact parity lock. |
| `daemon-stream-proxy-project-events-raw-sse` | preserve | Locks raw SSE proxying and forwarded headers for project events. The fixture asserts bytes, not derived state. | Keep exact parity lock. |
| `daemon-stream-proxy-downstream-disconnect-drops-upstream` | preserve | Locks the important cancellation behavior: downstream write failure drops the upstream socket (`upstreamObservedEof: true`). The exact OS error text `broken pipe` is brittle but not a known product lie at this helper boundary. | Preserve the EOF/cancellation assertion. Consider normalizing the error to kind only if this becomes platform brittle, but do not weaken the upstream-drop assertion. |
| `relay-client-project-event-subscription-delivery` | preserve | Locks relay subscribe ack, event delivery, upstream-closed error frame, and auth_failed status after websocket close. This case explicitly records an error frame rather than hiding one. | Keep exact parity lock. |
| `hosted-operator-stream-closes-on-principal-revocation` | preserve | Locks hosted stream re-authentication/revocation behavior, first event delivery, and audit records. It is a stream revocation contract, not the non-stream hosted proxy reset that failed in production. | Keep exact parity lock. Add separate non-stream hosted proxy cases for upstream socket reset and downstream client reset; do not treat this case as coverage for those bugs. |

## Missing From These Fixtures

The current async-cutover characterization fixtures do not cover several bug
classes found tonight:

- `/agents/kill` or project lifecycle kill failure after the irreversible tmux
  boundary. This is now covered by the ignored proof test added for `gqaapg-1`,
  but it is not a characterization fixture.
- `/agents/input` half-delivery where Enter was attempted but the prompt was not
  submitted. This is also covered by the ignored proof test from `gqaapg-1`, not
  by these fixtures.
- Hosted non-stream proxy socket reset or upstream JSON read failure. The Phase
  3 fixture covers hosted stream revocation only.
- Expose/topology unavailable behavior. The desktop-state empty fixture is not a
  proof that unavailable topology is distinguishable from a genuinely empty
  project.

## Bottom Line

Only one recorded case is unsafe as a reference for future behavior:
`project-desktop-state-empty`. It should be split into an explicit-empty baseline
and an unavailable-topology negative case. Two other cases are underpowered
because their harnesses can turn "could not observe" into "nothing bad
happened": `project-incomplete-mutation-disconnect-no-side-effect` and
`runtime-logs-no-nested-runtime-panics`.

The remaining recorded cases are real parity locks and should stay exact unless
the product contract intentionally changes.
