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
| TUI shared state API boundary | Mostly done | High | High | TUI reads/mutations are largely API-backed, but connection/retry/repair behavior is still not one central contract. |
| TUI transition stability | Partial | High | High | Agent/service pending actions now survive transient settlement misses; canonical API transition records and churn smoke remain. |
| Web/mobile resource lifecycle | Mostly done | Medium | Medium | Major app resources preserve stale snapshots; remaining screen-local fetch state and route-race patterns need audit. |
| Project-service events parity | Partial | Medium | High | Some push exists; remote clients still need complete change events for all API-backed views. |
| Runtime topology authority | Partial | Medium | High | Agents/services/worktrees are partly topology-owned; old caches and fail-closed lifecycle paths remain. |
| Runtime exchange authority | Partial | Low for next build | High | Notifications are exchange-backed; threads/tasks/handoffs/reviews/waits still have legacy-file authority. |
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
- [ ] Document exactly where repair notices are recorded for debugging.

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

Status: `Partial`

Remaining:

- [ ] Inventory current TUI service/API request sites and overlays.
- [x] Define one connection state machine:
  `ready`, `refreshing`, `stale`, `reconnecting`, `repairing`, `repaired`,
  `failed`.
- [ ] Route screen refreshes through the shared adapter instead of screen-local
  retry/overlay logic.
- [x] Keep last coherent snapshot visible while reconnecting unless the specific
  resource is known invalid.
- [ ] Block only unsafe mutating actions while disconnected; keep local
  navigation instant.
- [ ] Emit user-visible repair notices whenever automatic repair happens.
- [x] Add regression tests for route/service drift, service restart, slow API,
  stale snapshot preservation, and failed repair.

Done when:

- No TUI screen owns bespoke project-service reconnect semantics.
- Reconnect/repair behavior is consistent across Dashboard, Coordination,
  Project, Library, Topology, Graveyard, and Expose/meta surfaces.
- Fast local navigation does not wait on API calls.

### Epic D: Lifecycle Transition Contract

Goal: start, stop, revive, create, kill, fork, migrate, service start/stop, and
worktree operations render the same transition state in TUI, web, mobile, and
CLI.

Status: `Partial`

Remaining:

- [ ] Define canonical transition records in the project-service API response:
  operation id, target id/path, kind, phase, startedAt, updatedAt, error.
- [ ] Ensure lifecycle mutations return or emit enough state for clients to
  render pending rows without guessing.
- [ ] Reconcile optimistic client state only against fresh API-backed state.
- [x] Preserve TUI agent/service pending transition display during transient
  refresh failures.
- [x] Prevent stale TUI agent/service refreshes from clearing pending rows
  before matching settlement.
- [ ] Extend the same settlement contract to worktree operations and app/mobile
  lifecycle views.
- [ ] Add fast churn tests for create/start/stop/revive/retry in TUI and app
  stores.
- [ ] Document which transitions are tmux-substrate actions versus product-state
  actions.

Done when:

- The same API state explains every lifecycle transition shown by TUI and app.
- Clients do not infer success from local optimism alone.
- Repeated lifecycle churn does not flicker backward or lose rows.

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

Status: `Partial`

Remaining:

- [ ] Inventory all API-backed views and the events that should invalidate them.
- [ ] Emit change events for lifecycle, services, worktrees, graveyard,
  notifications, Coordination, threads, tasks, handoffs, reviews, Library,
  Topology, Project observability, plans, and repair/coherence changes.
- [ ] Make app event handling invalidate or refresh the right resource stores.
- [ ] Keep TUI push behavior aligned with the same semantic event names, even if
  it receives them through an in-process bus.
- [ ] Add tests for event emission on each mutation family.
- [ ] Document event payload compatibility rules.

Done when:

- Every shared view has a named event invalidation path.
- Remote app clients do not require ad hoc polling for lifecycle-critical state.
- TUI and app use the same semantic event names.

### Epic G: Runtime Topology Authority

Goal: topology is the authority for agents, services, worktrees, lifecycle,
graveyard, bindings, and topology-backed operation state.

Status: `Partial`

Remaining:

- [ ] Finish cutting agent lifecycle resume/revive paths to topology-owned
  semantics.
- [ ] Remove or demote `offlineSessions` as lifecycle authority.
- [ ] Remove or demote `graveyardEntries` as agent graveyard authority.
- [ ] Finish service lifecycle authority over topology service records and demote
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

### Epic H: Runtime Exchange Authority

Goal: runtime exchange is the authority for messages, tasks, reviews, handoffs,
waits, inbox routing, notification records, and notification read/done state.

Status: `Partial`

Remaining:

- [ ] Complete thread/message compatibility APIs over runtime exchange.
- [ ] Move direct messages and delivery state out of `.aimux/threads` authority.
- [ ] Model handoffs as first-class exchange records.
- [ ] Model tasks and reviews as first-class exchange records.
- [ ] Replace scattered wait/inbox truth with exchange-derived inbox state.
- [ ] Move alert recipient derivation into exchange-owned routing semantics.
- [ ] Decide plan, continuity, status, and attachment authority boundaries.
- [ ] Keep old files as explicit import/export artifacts or fail-closed
  compatibility only.
- [ ] Run the Exchange, Tasks/Reviews, Waiting/Inbox, Plans, and Continuity audit
  commands in [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md).

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
