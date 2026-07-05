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
| daemon status, restart, repair orchestration     | daemon          | CLI/TUI should request the daemon to repair, not perform repair independently.  |
| project state and mutations                      | project service | Single writer for shared project state.                                         |
| notifications, threads, tasks, handoffs, reviews | project service | TUI/web/mobile/CLI use the same project API contracts.                          |
| Coordination worklist                            | project service | One server-built model for all clients.                                         |
| worktrees, graveyard, lifecycle mutations        | project service | Same API semantics across clients.                                              |
| PTYs, panes, windows, attach/detach, focus       | tmux runtime    | Local execution substrate; remote parity uses streams/deep links, not raw tmux. |
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

## Current Progress

As of 2026-07-05, the normal installed CLI path has been cut over for the core
user command families that should be sidecar-backed:

- daemon restart/status/project ensure
- host status
- remote, login, logout, account, and security unlock
- lifecycle commands: spawn, stop, kill, and fork
- worktree and graveyard commands
- thread and message commands
- workflow commands: task, handoff, and review
- host pane read and stream commands

For those commands, the healthy path is:

```text
installed aimux shim -> global daemon core route -> project service or daemon owner
```

The remaining work is not "make more fallback paths." The remaining work is to
shrink the exceptional surface:

- keep bootstrap/repair/dashboard entry as the only normal paths allowed to
  start Node
- classify or remove legacy/internal command families that still bypass the
  daemon-owned model
- make diagnostics read daemon/project-service truth instead of recomputing
  product state locally
- continue moving client state transitions into API-backed lifecycle contracts
  so TUI, web, and mobile see the same state machine
- remove dead direct-writer and direct-computation paths as each owner cut lands

## Path Forward

Work should proceed by command and client-surface families, not random one-off
patches:

1. Maintain a command ownership inventory.
2. Add or extend enforcement tests before each migration.
3. Move one coherent command family behind daemon/project-service APIs.
4. Hard-cut old direct paths and dead code.
5. Verify healthy no-spawn, stale fallback, output parity, and runtime behavior.
6. Open a PR, run CodeRabbit plus independent review, merge, then cut the next
   branch.

The aim is not to preserve every old internal command path. The aim is a smaller
system with one obvious owner for each behavior.

The command-level working inventory lives in
[command-ownership-inventory.md](command-ownership-inventory.md).
