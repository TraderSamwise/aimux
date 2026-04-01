# Global Control Plane RFC

## Status

Proposed

## Summary

Aimux should keep `tmux` as the runtime substrate and replace per-project host election with one global aimux control-plane daemon.

This RFC intentionally reverses the current per-project host direction.

The reason is practical, not ideological:

- `tmux` was adopted because building our own terminal runtime/multiplexer failed
- per-project host ownership has introduced large complexity for comparatively little product value
- host migration is fragile
- desktop and external-service integration want a stable control-plane endpoint
- the current host-election model creates hard-to-debug races, stale detection bugs, and empty-state flicker

Under the new model:

- `tmux` remains the only runtime substrate
- one global aimux daemon owns control-plane authority
- per-project runtime state remains project-scoped
- dashboards, desktop, CLI commands, and external services become clients of the daemon

This is a control-plane simplification, not a return to a custom PTY runtime.

## Problem

The current architecture splits authority across:

1. `tmux` runtime
2. per-project elected host
3. per-terminal dashboard clients

That split looked clean on paper, but the host layer has become a complexity hotspot.

Observed costs:

- host election and heartbeat logic
- host takeover and stale-host edge cases
- competing writers for `statusline.json`
- dashboard-backed host vs `aimux serve` host ambiguity
- desktop polling triggering replacement hosts at the wrong time
- project-local metadata endpoint discovery races
- confusing operator model for "who is currently authoritative?"

The resulting bugs are not accidental implementation noise. They are a direct consequence of making a migratable per-project control-plane lease part of the architecture.

## Goals

1. Keep `tmux` as the runtime substrate.
2. Remove per-project host election entirely.
3. Give desktop and external services one stable control-plane endpoint.
4. Preserve per-project runtime isolation where it actually matters:
   - tmux session/window topology
   - repo-local `.aimux/` artifacts
   - project-scoped runtime-private state
5. Make dashboard processes disposable clients rather than control-plane authorities.
6. Eliminate empty-state flicker caused by host replacement and competing statusline writers.

## Non-Goals

- Replacing `tmux` with a custom terminal runtime
- Reintroducing a custom PTY multiplexer
- Making the daemon the runtime authority over agent terminals
- Replacing repo-local `.aimux/` as the agent-facing contract
- Building a distributed or multi-user network service

## Decision

Aimux will move to a single global control-plane daemon.

Authority boundaries become:

- runtime: `tmux`
- control plane: global aimux daemon
- clients: dashboard terminals, desktop shell, CLI, external services

The daemon is authoritative for:

- project discovery
- project activation/registration
- metadata API
- orchestration API
- plugin runtime supervision
- statusline/state aggregation
- tmux target resolution for project/session focus

Per-project dashboards no longer become hosts.

`aimux serve` no longer means "become this project's elected host". It becomes a compatibility wrapper for daemon-backed project activation or headless daemon-assisted operation.

## Why This Is The Right Correction

### 1. `tmux` was a runtime decision, not a control-plane philosophy

We chose `tmux` because attempts to build our own HUD + agent switching layer over native TUIs kept turning into a failed terminal emulator / multiplexer implementation.

That decision remains correct.

It does **not** imply that per-project host election is the correct control-plane model.

### 2. The current model overpays for project isolation

Project isolation has value:

- smaller blast radius
- simpler project-local cleanup
- less cross-project coupling
- easier local reasoning

But those benefits are being purchased with:

- heartbeat leases
- ownership reconciliation
- takeover logic
- endpoint discovery races
- dashboard/serve ambiguity
- multi-client state coordination bugs

That trade is no longer favorable.

### 3. External integrations need one stable endpoint

Desktop, OpenClaw, and future service integrations do not want to discover and negotiate authority with a different host process for every project.

They want:

- one stable API endpoint
- one stable routing surface
- one place to ask for project/session information
- one place to issue orchestration requests

The per-project host model makes that harder than it needs to be.

## Target Architecture

## 1. Runtime Layer: `tmux`

`tmux` continues to own:

- PTY lifecycle
- window/session persistence
- scrollback
- attach/detach
- repaint and terminal protocol behavior

Each project still has:

- one shared project tmux session for agent windows/runtime
- per-terminal client session behavior if we still want isolated dashboard state

This RFC does not change the tmux topology directly.

## 2. Global Control Plane: `aimuxd`

Introduce one daemon process, referred to here as `aimuxd`.

It owns:

- project registry and discovery
- project activation state
- metadata API
- thread/task/orchestration API
- plugin loading and supervision
- statusline aggregation/writing
- session and project summaries for desktop/UI
- mapping from aimux session IDs to tmux targets

The daemon may internally maintain per-project state machines, but those are implementation details, not separately elected processes.

## 3. Clients

Clients become non-authoritative:

- `aimux` dashboard process
- desktop / Tauri
- shell commands
- external services

Clients may:

- render UI
- request project open/focus
- request orchestration actions
- subscribe to state/events

Clients may not:

- own metadata server authority
- own plugin runtime authority
- write canonical shared statusline state
- elect themselves as project host

## Responsibilities Mapping

Current per-project host responsibilities and their destination:

- `MetadataServer`
  - move to global daemon
- `PluginRuntime`
  - move to global daemon, scoped per project
- statusline writing
  - move to global daemon
- host heartbeat / `host.json`
  - delete

Dashboard process responsibilities after migration:

- render dashboard
- collect terminal-local input state
- request state from daemon
- request tmux focus/open actions via daemon

`aimux serve` responsibilities after migration:

- ensure daemon is running
- optionally activate current project
- optionally keep a headless client/bridge alive if needed for compatibility
- never participate in project-host election

## API Direction

The daemon should expose one local API surface over either:

- Unix domain socket
- or loopback HTTP on a fixed port

Unix socket is preferred for local-only control.

Minimum API groups:

- `GET /projects`
- `GET /projects/:id`
- `POST /projects/open`
- `POST /projects/focus`
- `GET /threads`
- `GET /threads/:id`
- `POST /threads/open`
- `POST /threads/send`
- `POST /threads/mark-seen`
- `POST /handoff`
- `POST /tasks/assign`
- `GET /events` or streaming subscription endpoint

The current per-project metadata endpoints should be treated as transitional compatibility surfaces.

## State Layout

Keep repo-local `.aimux/` as the canonical agent-facing shared artifact space:

- plans
- context
- history
- threads
- tasks

Rework runtime-private global state under `~/.aimux/`.

### New daemon state

Add:

- `~/.aimux/daemon/`
- `~/.aimux/daemon/socket`
- `~/.aimux/daemon/state.json`
- `~/.aimux/daemon/projects.json`
- `~/.aimux/daemon/logs/`

### Existing per-project state

Keep project directories under:

- `~/.aimux/projects/<project-id>/`

But repurpose them as daemon-managed project runtime caches, not host-owned lease state.

Delete over time:

- `host.json`
- `metadata-api.json` as authority signal
- `statusline-owner.json`

Keep or adapt:

- `metadata.json`
- `instances.json`
- `state.json`
- `graveyard.json`
- `recordings/`

## CLI Changes

## New commands

Introduce:

```bash
aimux daemon start
aimux daemon status
aimux daemon stop
aimux daemon restart
```

Potential convenience:

```bash
aimux daemon ensure
```

## Existing command compatibility

### `aimux`

Should:

- ensure daemon is running
- ask daemon to activate/open the current project
- launch or attach dashboard client UI

### `aimux serve`

Compatibility path:

- short term: ensure daemon running and activate current project headlessly
- long term: deprecate in favor of explicit daemon/project commands

### `aimux host status`

Compatibility path:

- short term: map to daemon-managed project control status
- long term: deprecate `host` vocabulary entirely

### Desktop `ensure_host`

Delete.

Desktop should ensure the daemon, not try to spawn project-local hosts.

## Dashboard and Desktop Implications

The desktop app should stop trying to infer project host liveness from per-project endpoint files.

Instead it should:

- ensure daemon availability once
- fetch project list and session summaries from daemon
- ask daemon to open/focus projects and sessions

The dashboard should likewise stop owning shared project state.

This is especially important because dashboard state can still remain per-terminal while shared project state is centralized in the daemon.

That is a much cleaner split than "many dashboard clients, one elected project host, plus headless host fallback".

## Rollout Plan

## Phase 0: Immediate Stabilization

Before the architecture migration lands, reduce the current bug surface.

Required patches:

1. Stop desktop from auto-spawning `aimux serve` based on weak liveness evidence.
2. Prevent a newly started replacement host from overwriting a richer `statusline.json` with `sessions: []`.
3. Make stale-host detection much more conservative.

This phase is not the destination. It is only to stop active damage while migration is in progress.

## Phase 1: Introduce Daemon Skeleton

Build `aimuxd` with:

- startup/shutdown
- local socket/API
- project registry loading
- project list/status endpoints
- daemon status CLI

No behavior change yet for tmux runtime ownership.

## Phase 2: Desktop Moves First

Migrate desktop/Tauri to daemon-backed discovery and control:

- no more `ensure_host`
- no more direct per-project liveness guesses
- one daemon endpoint for project/session state

This immediately removes one major source of host churn.

## Phase 3: Move Shared Writers Into Daemon

Migrate:

- metadata API
- plugin runtime supervision
- statusline aggregation/writing

At this point dashboards should no longer be authoritative shared-state writers.

## Phase 4: Convert Dashboard To Pure Client

Refactor `src/multiplexer.ts` dashboard path to:

- stop reconciling project host ownership
- stop claiming statusline ownership
- fetch/push shared state through daemon

Dashboard remains the terminal UI, not the control-plane owner.

## Phase 5: Remove Per-Project Host Model

Delete:

- `src/project-host.ts`
- host election and heartbeat logic
- `host.json`
- `statusline-owner.json`
- `host` terminology from docs and most commands

Replace old commands with compatibility wrappers where needed.

## Key Risks

### 1. The daemon becomes a second runtime by accident

Mitigation:

- keep PTY/session/window ownership in `tmux`
- forbid daemon features that emulate terminal runtime behavior

### 2. Central daemon raises blast radius

Mitigation:

- keep project state internally isolated
- make daemon restartable and stateless where possible
- derive state from tmux + filesystem rather than inventing opaque in-memory truth

### 3. Migration churn breaks desktop and dashboard simultaneously

Mitigation:

- move desktop first to the daemon
- keep dashboard compatibility shims during migration
- only remove host-election code after shared writers have moved

## Concrete First Cuts

These are the first code changes to make:

1. Add a daemon process entrypoint and local status endpoint.
2. Add daemon-backed `projects list --json`.
3. Change desktop to ensure the daemon, not project hosts.
4. Move statusline writing behind the daemon.
5. Remove `ensure_host` from Tauri and corresponding UI polling assumptions.

## Open Questions

1. Should the daemon use Unix socket transport first, with HTTP only as a compatibility layer?
2. Should project activation be explicit or lazy-on-access?
3. Should plugins run in-process in the daemon, or in per-project supervised child workers?
4. Should the daemon expose push events immediately, or start with polling JSON endpoints and add streaming later?
5. Do we preserve `aimux serve` as a user-facing concept, or deprecate it as soon as the daemon is stable?

## Recommendation

Proceed with the global daemon migration.

Do not keep investing in per-project host-election complexity unless a hard product requirement emerges that truly depends on migratable per-project host authority.

The evidence so far points the other way:

- `tmux` is the right runtime substrate
- per-project host ownership is not pulling its weight
- centralized control-plane routing better matches desktop and service integration needs

That is the architecture aimux should converge toward.
