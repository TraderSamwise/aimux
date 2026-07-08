# Aimux Core Sidecar North Star

Aimux is converging on one local control-plane kernel with multiple clients.
The product should feel like one system, not a pile of independently repaired
processes.

## North Star

Aimux should run as:

1. **One long-lived local core daemon**: the host-level Aimux kernel.
2. **One per-project service per active project**: the project-state authority.
3. **One managed tmux runtime per project**: local execution, panes, windows, and
   same-machine terminal mechanics.
4. **Many clients**: terminal TUI, web, mobile, CLI, scripts, and plugins.

Normal user paths should not spawn short-lived Node processes. The installed
`aimux` command should be a thin launcher/client:

- If the matching daemon is alive, route the command to the daemon or project
  service.
- If the daemon is missing or stale, bootstrap/repair once, then route through
  the long-lived sidecar.
- If Aimux cannot repair itself, give one clear recovery path.

The user-facing rule is: **Aimux just works.** If repair is possible, Aimux does
it and records what happened. If repair is impossible, Aimux says exactly what
blocked it and what one command/action is needed.

## Process Model

Allowed long-lived processes:

- global daemon
- per-project service
- managed tmux runtime and its panes/windows
- dashboard/client processes started by tmux as user-facing surfaces
- web/mobile dev servers when explicitly running app development

Allowed short-lived process paths:

- install/bootstrap when no matching daemon exists
- stale-daemon recovery when the current installed build must replace an old
  daemon
- explicit developer/debug commands that are documented as internal plumbing

Disallowed normal paths:

- user-facing commands that spawn Node while a matching daemon is healthy
- dashboard hot paths that block on fresh API calls before local navigation
- clients writing shared project state directly
- tmux metadata becoming an alternate source of truth for product state

## Ownership Matrix

| Area                                             | Owner           | Notes                                                                           |
| ------------------------------------------------ | --------------- | ------------------------------------------------------------------------------- |
| project discovery and activation                 | daemon          | Host-level project registry and service supervision.                            |
| daemon status and service repair                 | daemon          | Daemon owns supervision and project-service repair.                             |
| restart bootstrap recovery                       | launcher + daemon + tmux | Launcher performs local repair orchestration when daemon may be stale or wedged. |
| project state and mutations                      | project service | Single writer for shared project state.                                         |
| notifications, threads, tasks, handoffs, reviews | project service | TUI/web/mobile/CLI use the same project API contracts.                          |
| Coordination worklist                            | project service | One server-built model for all clients.                                         |
| worktrees, graveyard, lifecycle mutations        | project service | Same API semantics across clients.                                              |
| PTYs, panes, windows, attach/detach, focus       | tmux runtime    | Local execution substrate; remote parity uses streams/deep links, not raw tmux. |
| Exposé and meta-dashboard terminal surfaces      | tmux + APIs     | tmux renders/previews; daemon/project-service APIs provide item models and focus routing. |
| TUI selection, filters, overlays, text buffers   | TUI             | Presentation state only.                                                        |
| web/mobile preferences and view state            | app client      | Presentation state only.                                                        |

## API-First Acceptance Criteria

A feature is API-first when:

- shared reads come from daemon or project-service APIs
- shared mutations go through daemon or project-service APIs
- TUI, web, mobile, and CLI can use the same semantic contract
- API responses include enough transitional state for clients to avoid flicker
- project-service `/events` can notify remote clients of relevant changes
- local tmux-only behavior has a documented remote equivalent or limitation

API-first does **not** mean remote-only. Execution remains local by design.
tmux is still the runtime substrate; it just is not the product-state authority.

## No One-Shot Node Acceptance Criteria

A normal installed `aimux` command satisfies the sidecar rule when:

- it does not start Node if a matching daemon is healthy
- it falls back to bootstrap only when the daemon is missing, stale, or
  unreachable
- stale-build recovery can replace/repair the old daemon
- tests cover the healthy no-spawn path and stale fallback path
- output shape matches the legacy CLI contract, including JSON fields

The shell shim may stay small and boring. Complex behavior belongs in the daemon
or project service, not in shell parsing.

## Client Connection Contract

Clients should treat API connectivity as a state machine:

- render from the last coherent snapshot
- apply local optimistic/in-flight state for lifecycle transitions
- reconcile on project-service heartbeat/events
- block only the actions that are unsafe while disconnected
- self-repair through daemon/project-service APIs when possible
- notify when repair happens so debugging has an audit trail

The TUI should not have separate bespoke reconnection logic per screen. It needs
one adapter that owns request lifecycle, reconnect, repair, stale snapshots, and
transition reconciliation.

## Completion State

As of 2026-07-07, the core-sidecar north star is the expected architecture, not
a migration aspiration. The completion tracker is the measuring document:
[north-star-completion-tracker.md](north-star-completion-tracker.md).

The architecture is complete when code keeps these boundaries true:

- normal installed commands route through the daemon or project service when a
  matching daemon is healthy
- bootstrap, stale-daemon recovery, and explicit debug plumbing are the only
  allowed short-lived Node paths
- the TUI uses one shared API runtime for project-service connectivity,
  reconnect, repair notices, stale snapshots, and lifecycle settlement
- web/mobile selected-project resources use the same API contracts and
  stale-response rules as the TUI
- project-service `/events` exposes semantic invalidation for all API-backed
  views
- tmux owns local terminal mechanics only, while daemon/project-service APIs own
  product state
- diagnostics classify sources as authority, projection/cache, substrate, or
  legacy compatibility instead of recomputing alternate truth

Release candidates still need live smoke evidence, but that is an operational
gate, not unfinished north-star architecture.

## Done Means

This migration is done when:

- every normal CLI command is classified as daemon-owned, project-service-owned,
  tmux-native, or bootstrap-only
- healthy installed commands do not spawn Node
- TUI shared state reads/mutations are API-backed
- web/mobile use the same daemon/project-service contracts for equivalent
  workflows
- project-service events provide push parity for remote clients
- tmux-specific actions have pane-streaming or deep-link/focus equivalents
- dead direct-writer and direct-computation paths are removed
- docs and tests make regressions hard to reintroduce

## Completed Architecture

As of 2026-07-07, the normal installed CLI path has been cut over for the core
user command families that are sidecar-backed:

- daemon restart/status/project ensure
- host status
- remote, login, logout, account, and security unlock
- lifecycle commands: spawn, stop, kill, and fork
- orchestration commands: loop and overseer
- team role config commands
- worktree and graveyard commands
- thread and message commands
- workflow commands: task, handoff, and review
- host pane read and stream commands
- advanced repair commands: dashboard-reload and restart-runtime

For those commands, the healthy path is:

```text
installed aimux shim -> global daemon core route -> project service or daemon owner
```

The TUI dashboard now routes shared lifecycle mutations through the project API
and keeps API refresh glitches from clearing in-flight start/stop/create/remove
state while the matching pending action still owns the transition. Service
transition settlement requires fresh API-backed state; optimistic/pending rows
may stabilize rendering, but they cannot prove mutation success. The app uses
the same transition-envelope model for dashboard, sidebar, agent chat, service
detail, worktree, graveyard, and teammate lifecycle controls; stale snapshots
are overlaid only until fresh API-backed state reaches the expected target.

The app has resource lifecycle stores for critical selected-project state:
`desktop-state`, the durable notification feed, Coordination, Library, Topology,
Project, project Threads, Graveyard, Plan Editor, and the global inbox surfaces
all preserve the last good snapshot across transient refresh failures and expose
pending/stale/error metadata. Plan editing also keeps draft-vs-saved content in
the project resource store so late refreshes cannot clobber unsaved edits.
Service detail also uses the shared `desktop-state` resource instead of owning
its own desktop-state fetch/retry loop.
The Project tab's observability/tasks refreshes now run through project-store
resource actions instead of screen-owned request bookkeeping.

The tmux Exposé popup remains the rich local terminal UI, but it is no longer a
separate switcher brain. Worktree/project scopes read switchable tiles from the
project service, global scope reads them from daemon `/core/expose/items`, and
focus/open goes through project-service or daemon focus routes before tmux does
the local window switch.

## Maintenance Path

Future work should preserve the completed architecture instead of reopening
parallel paths:

1. Maintain the command ownership inventory.
2. Maintain a client connection-state inventory for TUI, web, and mobile.
3. Add or extend enforcement tests before each migration.
4. Move one coherent transition or client surface behind the shared contract.
5. Hard-cut old direct paths and dead code.
6. Verify no-spawn, stale fallback, event/reconnect behavior, output parity, and
   runtime behavior.
7. Open a PR, run CodeRabbit plus independent review, merge, then cut the next
   branch.

The aim is not to preserve every old internal command path. The aim is a smaller
system with one obvious owner for each behavior and one boring way for clients
to stay coherent.

The command-level working inventory lives in
[command-ownership-inventory.md](command-ownership-inventory.md).
The cross-epic completion tracker lives in
[north-star-completion-tracker.md](north-star-completion-tracker.md).
