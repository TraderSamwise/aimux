# Aimux North Star Completion Tracker

This is the measuring stick for the API-first, long-lived-sidecar migration.
It tracks what remains before the architecture is complete, not just what is
needed for the next shippable build.

Related docs:

- [core-sidecar-north-star.md](core-sidecar-north-star.md): target architecture
- [release-readiness-gate.md](release-readiness-gate.md): release-candidate gate
- [command-ownership-inventory.md](command-ownership-inventory.md): command-level no-spawn ownership
- [runtime-authority-inventory.md](runtime-authority-inventory.md): source-of-truth map by domain
- [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md): audit commands for old paths
- [runtime-projection-contract.md](runtime-projection-contract.md): projection/cache boundary

## Progress Scale

Use these labels consistently:

- `Done`: replacement shipped, old authority removed or demoted, tests enforce it.
- `Mostly done`: normal paths use the new model, but cleanup, diagnostics, or
  edge-case enforcement remains.
- `Partial`: the new model exists, but old authority or bespoke client logic
  still participates in normal behavior.
- `Not started`: no durable replacement has landed.
- `Deferred`: intentionally not needed for the next build, but still required
  for north-star completion.

## Executive Snapshot

| Area | Status | Ship Risk | North-Star Risk | Measurement |
| --- | --- | --- | --- | --- |
| Command no-spawn healthy paths | Mostly done | Medium | Medium | `command-ownership-inventory.md` says no normal command is still `SIDECAR`. Need release-gate no-spawn audit. |
| Daemon/project-service ownership | Mostly done | Medium | Medium | Core command families route through daemon/project-service; diagnostics and internal paths still need periodic audit. |
| TUI shared state API boundary | Done | Medium | Low | Production TUI API request sites are guarded by `tui-api-boundary.test.ts`; reconnect, stale snapshot, mutation blocking, and repair notice behavior route through the shared TUI API runtime. |
| TUI transition stability | Mostly done | Medium | Medium | Lifecycle mutation responses include canonical transition records; TUI and app core lifecycle controls now reconcile against API-backed state. Churn smoke remains. |
| Web/mobile resource lifecycle | Mostly done | Medium | Medium | Major app resources preserve stale snapshots; remaining screen-local fetch state and route-race patterns need audit. |
| Project-service events parity | Mostly done | Medium | Medium | Shared invalidation groups cover every API-backed view; HTTP mutations publish view-scoped `project_update` events and app/TUI clients consume the same semantic event. |
| Runtime topology authority | Mostly done | Medium | Medium | Services/worktrees are topology-owned; agent resume/graveyard/exit paths are topology-gated; `offlineSessions` is being reduced to a projection cache. Binding and team-role authority remain. |
| Runtime exchange authority | Mostly done | Low for next build | Medium | Threads/messages/tasks are exchange-backed; handoffs/reviews/waits/inbox are exchange-derived; legacy thread/task dirs are import-only. Alert routing and plan/continuity/status/attachment boundaries remain. |
| tmux boundary | Mostly done | Medium | Medium | tmux is treated as substrate for local navigation/focus, but binding recovery and remote equivalents need finalization. |
| Upgrade/restart coherence | Mostly done | High | Medium | `aimux restart` and install repair are strong; release rehearsal must prove multi-project coherence from old builds. |
| Dead-code/dead-path deletion | Partial | Low for next build | High | Inventories exist; old paths remain until each authority cut lands. |
| Regression smoke coverage | Partial | High | High | Unit coverage is broad; end-to-end churn smoke still needs a documented release gate and recurring execution. |

## Completion Epics

### Epic A: Release Coherence Gate

Goal: every release candidate can be installed over a dirty, running Aimux and
leave the user with coherent daemon, services, dashboards, and tmux runtime.

Status: `Mostly done`

Remaining:

- [x] Add a release-candidate checklist covering local release asset install,
  post-install repair, daemon/service/dashboard version coherence, and runtime
  contract drift repair.
- [ ] Smoke `aimux restart` across at least two active projects with existing
  dashboards and agent windows.
- [ ] Verify `aimux doctor versions` reports coherent daemon, project services,
  dashboards, and runtime owners after install.
- [ ] Verify old dashboard/client windows reload or reconnect without exposing
  stale-build decision dialogs.
- [ ] Verify agent tmux windows survive restart unless a deliberate runtime
  rebuild path is required.
- [x] Document exactly where repair notices are recorded for debugging.

Done when:

- A local release install from `master` can be used as the release rehearsal.
- The checklist has pass/fail evidence for at least one real multi-project run.
- The only user-facing recovery instruction for normal drift is `aimux restart`
  or automatic repair.

### Epic B: Healthy CLI No-Spawn Purity

Goal: normal installed commands do not spawn Node when a matching daemon is
healthy.

Status: `Mostly done`

Remaining:

- [ ] Add or refresh a release-gate script/test that exercises the installed
  shell shim against a healthy daemon and proves all `CUT` commands avoid Node
  startup.
- [ ] Reconcile any command not listed in
  [command-ownership-inventory.md](command-ownership-inventory.md).
- [ ] Keep bootstrap-only commands explicit: `aimux`, `aimux init`, install,
  stale-daemon recovery, and explicit debug/internal plumbing.
- [ ] Ensure invalid args for recognized `CUT` commands fail in the shim without
  spawning Node when the daemon is healthy.
- [ ] Keep output parity for text and JSON modes as commands move or change.

Done when:

- The inventory has no unclassified normal command.
- Healthy no-spawn tests are part of CI or release gating.
- Stale/missing daemon fallback tests still prove bootstrap works.

### Epic C: One TUI Connection Contract

Goal: the TUI has one API connection adapter for refresh, reconnect, repair,
stale snapshots, and lifecycle transition settlement.

Status: `Done`

Remaining:

- [x] Inventory current TUI service/API request sites and overlays.
- [x] Define one connection state machine:
  `ready`, `refreshing`, `stale`, `reconnecting`, `repairing`, `repaired`,
  `failed`.
- [x] Route screen refreshes through the shared adapter instead of screen-local
  retry/overlay logic.
- [x] Keep last coherent snapshot visible while reconnecting unless the specific
  resource is known invalid.
- [x] Block only unsafe mutating actions while disconnected; keep local
  navigation instant.
- [x] Emit user-visible repair notices whenever automatic repair happens.
- [x] Add regression tests for route/service drift, service restart, slow API,
  stale snapshot preservation, and failed repair.

Done when:

- No TUI screen owns bespoke project-service reconnect semantics.
- Reconnect/repair behavior is consistent across Dashboard, Coordination,
  Project, Library, Topology, Graveyard, and Expose/meta surfaces.
- Fast local navigation does not wait on API calls.

Repair notices:

- Automatic TUI API recovery and runtime-guard repair append bounded entries to
  the dashboard host's in-memory `dashboardRepairNotices` ring.
- The same events are written to the Aimux debug log through the `runtime`
  channel, and dashboard-visible recovery paths flash the footer or show the
  existing busy/error overlay.
- Production TUI source is scanned by `src/multiplexer/tui-api-boundary.test.ts`
  so raw project-service transports stay confined to the shared runtime/control
  layer.

### Epic D: Lifecycle Transition Contract

Goal: start, stop, revive, create, kill, fork, migrate, service start/stop, and
worktree operations render the same transition state in TUI, web, mobile, and
CLI.

Status: `Mostly done`

Remaining:

- [x] Define canonical transition records in the project-service API response:
  operation id, target id/path, kind, phase, startedAt, updatedAt, error.
- [x] Ensure lifecycle mutations return or emit enough state for clients to
  render pending rows without guessing.
- [x] Reconcile optimistic client state only against fresh API-backed state.
- [x] Preserve TUI agent/service pending transition display during transient
  refresh failures.
- [x] Prevent stale TUI agent/service refreshes from clearing pending rows
  before matching settlement.
- [x] Extend the same settlement contract to TUI worktree create/graveyard
  operations.
- [x] Extend the same settlement contract to app/mobile lifecycle views.
- [ ] Add fast churn tests for create/start/stop/revive/retry in TUI and app
  stores.
- [x] Document which transitions are tmux-substrate actions versus product-state
  actions.

Done when:

- The same API state explains every lifecycle transition shown by TUI and app.
- Clients do not infer success from local optimism alone.
- Repeated lifecycle churn does not flicker backward or lose rows.

App adoption notes:

- Dashboard, sidebar, agent chat, service detail, worktree management,
  graveyard, and teammate lifecycle controls record project-service transition
  envelopes into the shared desktop-state projection.
- Active transition records overlay stale `desktop-state` snapshots for agents,
  services, and worktrees, then settle only when a fresh API-backed snapshot
  reaches the expected target state.
- tmux-substrate lifecycle operations remain local execution mechanics under
  the project service; app/mobile render their product-state transition through
  the same API envelope and never infer settlement from local optimism alone.

### Epic E: App/Web/Mobile Resource Contract

Goal: every shared app view uses resource lifecycle state rather than
screen-local fetch/loading/error state.

Status: `Mostly done`

Remaining:

- [ ] Audit app screens for local `loading`, `error`, `fetch`, and route-key
  request refs that duplicate the resource-store model.
- [ ] Move any remaining shared project views into resource stores with
  `value`, `pending`, `stale`, `error`, `updatedAt`, and request keys.
- [ ] Apply route/endpoint stale-response guards to every selected-project
  resource.
- [ ] Keep durable preferences in Jotai storage and transient UI state in UI
  stores only.
- [ ] Add route-switch tests for critical screens: Dashboard, Threads,
  Coordination, Project, Library, Topology, Graveyard, Plan Editor.
- [ ] Verify native/web behavior under daemon restart and project-service
  reconnect.

Done when:

- App screens render from resource stores for shared project data.
- Route changes cannot apply old endpoint/project responses.
- Refresh failure preserves last good data unless the route itself changed.

### Epic F: Project-Service Events Parity

Goal: remote clients can stay current from project-service `/events` without
polling every important view.

Status: `Mostly done`

Remaining:

- [x] Inventory all API-backed views and the events that should invalidate them.
- [x] Emit change events for lifecycle, services, worktrees, graveyard,
  notifications, Coordination, threads, tasks, handoffs, reviews, Library,
  Topology, Project observability, plans, and repair/coherence changes.
- [x] Make app event handling invalidate or refresh the right resource stores.
- [x] Keep TUI push behavior aligned with the same semantic event names, even if
  it receives them through an in-process bus.
- [x] Add tests for event emission on representative mutation families and
  route-level invalidation contracts for the rest.
- [x] Document event payload compatibility rules.
- [ ] Run release-gate web/mobile/TUI churn with a real `/events` stream open
  across lifecycle, workflow, plan, notification, and repair mutations.

Event compatibility rules:

- `ready` means clients must refresh every project API view.
- `project_update.views` is additive and semantic. Known values are the
  `PROJECT_API_VIEWS` contract; unknown values mean "service is newer", so
  clients must refresh all project API views instead of dropping the event.
- Mutation producers should use `PROJECT_API_VIEW_INVALIDATIONS` or
  `projectApiViewsForMutationRoute()` rather than hand-written view arrays.
- `alert` remains a notification delivery event and is paired with
  `project_update` for notification/Coordination refresh.

Done when:

- Every shared view has a named event invalidation path.
- Remote app clients do not require ad hoc polling for lifecycle-critical state.
- TUI and app use the same semantic event names.

### Epic G: Runtime Topology Authority

Goal: topology is the authority for agents, services, worktrees, lifecycle,
graveyard, bindings, and topology-backed operation state.

Status: `Mostly done`

Remaining:

- [x] Finish cutting agent lifecycle resume/revive paths to topology-owned
  semantics.
- [x] Remove or demote `offlineSessions` as lifecycle authority.
- [x] Remove or demote `graveyardEntries` as agent graveyard authority.
- [x] Finish service lifecycle authority over topology service records and demote
  `.aimux/state.json` service rows to compatibility/debug snapshots.
- [ ] Finalize durable tmux binding records and use tmux metadata only as live
  substrate evidence.
- [ ] Decide whether team role config remains separate config authority or moves
  into topology schema.
- [ ] Run the Agent Lifecycle, Services, Worktrees, Tmux Binding, and Team audit
  commands in [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md)
  after every related cut.

Done when:

- Lifecycle and graveyard truth does not depend on old in-memory caches.
- Topology survives process restart and can repair tmux bindings.
- Old topology-domain paths are projections, tests, importers, or fail-closed
  compatibility only.

Service authority notes:

- Service lifecycle creates, stops, resumes, removes, and worktree cleanup paths
  mutate topology service records instead of editing `.aimux/state.json` as
  lifecycle truth.
- `offlineServices` is a rebuilt UI/runtime cache sourced from topology, not a
  legacy saved-state restore path.
- `.aimux/state.json` service rows are rewritten only from current runtime state
  or observed tmux service windows for compatibility/debug output; stale service
  rows are dropped instead of merged forward.

Agent authority notes:

- Agent resume and graveyard operations require matching topology rows; stale
  `offlineSessions` or `graveyardEntries` projections cannot revive or remove an
  agent by themselves.
- Runtime exits, explicit stops, backend-id recovery, and graveyard resurrection
  mutate topology first, then rebuild offline/graveyard projections from topology.
- `offlineSessions` and `graveyardEntries` remain UI/runtime projection caches
  while dashboard rendering and selection code are being simplified around the
  topology-backed API model.

### Epic H: Runtime Exchange Authority

Goal: runtime exchange is the authority for messages, tasks, reviews, handoffs,
waits, inbox routing, notification records, and notification read/done state.

Status: `Mostly done`

Remaining:

- [x] Complete thread/message compatibility APIs over runtime exchange.
- [x] Move direct messages and delivery state out of `.aimux/threads` authority.
- [x] Model handoffs as exchange-derived records.
- [x] Model tasks and reviews as exchange-backed or exchange-derived records.
- [x] Replace legacy wait/inbox files with exchange-derived wait/inbox state.
- [ ] Move alert recipient derivation into exchange-owned routing semantics.
- [ ] Decide plan, continuity, status, and attachment authority boundaries.
- [x] Keep old thread/task files as explicit import-only artifacts or fail-closed
  compatibility only.
- [x] Run the Exchange, Tasks/Reviews, and Waiting/Inbox audit commands in
  [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md).
- [ ] Run the Plans and Continuity audit commands in
  [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md).

Done when:

- `.aimux/threads` and `.aimux/tasks` are no longer normal write authorities.
- Workflow, Coordination, notifications, and inbox surfaces are exchange
  projections.
- Legacy files are import/export/debug artifacts only.

### Epic I: Tmux Boundary And Remote Equivalents

Goal: tmux remains local execution/focus/pane transport, while product state
comes from daemon/project-service APIs.

Status: `Mostly done`

Remaining:

- [ ] Keep Expose/meta-dashboard explicitly tmux-native and read-only for
  product state.
- [ ] Finalize pane read and stream APIs as the remote equivalent for live pane
  output.
- [ ] Define remote behavior for "open/focus": deep link, focus request, or
  same-machine-only capability.
- [ ] Ensure fast prefix navigation uses tmux-local metadata/statusline caches,
  not slow API calls.
- [ ] Add latency checks for dashboard return, next/prev, attention jump, and
  expose/global expose.

Done when:

- Remote clients never need raw tmux mechanics.
- Same-machine TUI remains fast because local navigation stays tmux-native.
- tmux metadata cannot become product-state authority.

### Epic J: Diagnostics, Debug, And Dead-Path Deletion

Goal: diagnostics explain the authoritative system without recomputing or
reviving old truth.

Status: `Partial`

Remaining:

- [ ] Make `aimux doctor versions` and related diagnostics read daemon/project
  truth rather than local recomputation when healthy.
- [ ] Keep debug state read-only and label every source as authority,
  projection/cache, substrate, or legacy.
- [ ] Remove old fallback builders after their API-backed replacements are
  proven.
- [ ] Remove direct client writers to runtime exchange/topology once service
  routes exist.
- [ ] Keep advanced commands documented as debug/internal, not normal user
  recovery.
- [ ] Add tests that fail if removed paths silently write old files.

Done when:

- Debug output cannot create or repair state.
- No normal user docs point people to advanced repair commands.
- Dead-path audit commands show only allowed projection/cache/importer/exporter,
  test, or fail-closed compatibility matches.

## Release-Ready Versus North-Star Complete

Release-ready does not require every item above. A new build can ship once:

- lifecycle transitions are stable under normal user churn;
- install/restart repair coherence is proven on real running projects;
- the TUI no longer exposes confusing repair/sync decision loops;
- app/web route-stale response races are covered for critical screens;
- healthy installed CLI no-spawn behavior is rechecked;
- docs tell users one recovery path, not a menu of internals.

North-star complete requires every completion epic above to be `Done`.

## Scorecard Template

Update this table after each epic PR.

| Date | PR | Area | Before | After | Evidence |
| --- | --- | --- | --- | --- | --- |
| 2026-07-06 | #339 | App resource lifecycle | Partial | Mostly done | Project tab observability/tasks moved to resource actions; route/endpoint stale response race fixed; app focused tests and PR checks passed. |
| 2026-07-06 | #344 | TUI connection contract | Partial | Partial | Dashboard model refresh now returns `applied/stale/skipped/failed` outcomes; `TuiApiRuntime` blocks mutation wrappers while the critical `desktop-state` resource is reconnecting; focused TUI API tests and typecheck passed. |
| 2026-07-06 | #345 | TUI repair observability | Partial | Partial | API recovery and runtime-guard repair now record bounded `dashboardRepairNotices`, flash visible recovery notices, and keep focused regression coverage for repair start/success/failure. |
| 2026-07-06 | #346 | TUI API boundary enforcement | Partial | Done | Raw project-service transport checks moved into `tui-api-runtime`; production TUI source scan now fails if screens bypass the shared API runtime. |
| 2026-07-07 | #351 | Runtime topology authority | Partial | Partial | Agent resume/graveyard paths now require topology rows and prune stale offline projections; focused lifecycle tests and full gate passed. |
| 2026-07-07 | #352 | Runtime topology authority | Partial | Partial | Runtime topology reconciliation moved into `runtime-core`, preserving recoverable topology rows while dropping explicit removals; focused and full gates passed. |
| 2026-07-07 | #353 | Runtime topology authority | Partial | Mostly done | Stop/runtime-exit/backend recovery/graveyard resurrection write topology first and reload projections; stale offline projection can no longer suppress current topology writes; focused and full gates passed. |
| 2026-07-07 | #354 | Runtime exchange authority | Partial | Mostly done | Legacy thread/task directory helpers renamed to explicit import-only helpers; direct legacy exchange path construction is guarded; thread/task compatibility APIs remain exchange-backed; focused and full gates passed. |

## How To Measure Progress

At each epic boundary:

1. Pick one row from the Executive Snapshot.
2. State its current status and target status for the PR.
3. Run the relevant audit commands from the linked inventory docs.
4. Land the cut or cleanup.
5. Add/adjust enforcement tests.
6. Update this tracker with the PR and evidence.

Do not call an area `Done` because the happy path works once. `Done` requires:

- old authority removed or explicitly demoted;
- no silent dual-writes;
- no normal user path through debug plumbing;
- tests or smoke evidence that would catch regression;
- docs updated so future agents can measure the same thing.
