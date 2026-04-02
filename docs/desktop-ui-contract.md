# Desktop UI Contract

This document describes how the Tauri desktop should consume aimux state and actions today.

## Status

Current

## Transport

Desktop is an HTTP client over the daemon-managed control plane.

Use:

- daemon HTTP for project discovery and project-service discovery
- project-service HTTP for live project state and project-scoped actions

Do not use:

- CLI subprocess polling for normal desktop reads
- `statusline.json` as the primary desktop API

`statusline.json` remains a derived artifact for tmux/status/debugging.

## Read Model

Desktop heartbeat should be driven by:

- daemon project discovery
- project-service `GET /desktop-state`

Heartbeat is for reconciliation and external changes, not for action initiation.

## Action Model

Desktop actions should call awaited project-service endpoints:

- `POST /agents/spawn`
- `POST /agents/fork`
- `POST /agents/stop`
- `POST /agents/rename`
- `POST /agents/migrate`
- `POST /agents/kill`
- `POST /worktrees/create`
- `POST /graveyard/resurrect`

These are not fire-and-forget actions.

The desktop should treat them as:

1. request started
2. HTTP request completes
3. heartbeat reconciles the resulting state change

The UI should remain pending until step 3, not clear loading immediately at step 2.

## Pending State Rules

Desktop pending state should be deterministic and centralized.

Use one action registry in the UI store.

Each action should carry:

- `kind`
- `projectPath`
- optional `sessionId`
- optional `worktreePath`
- `message`
- `phase`

Suggested phases:

- `requesting`
- `awaiting-sync`
- `done`
- `error`

## Optimistic Overlay Rules

The store should apply pending overlays to the selected project so the UI updates immediately:

- spawn: insert a temporary `starting` agent row
- create worktree: insert a temporary `creating` worktree row
- stop: mark the target agent as `stopping`
- kill: mark the target agent as `killing`

These overlays should remain visible until heartbeat confirms the real state transition.

## UI Feedback Rules

Preferred feedback model:

- inline pending state at the point of action
- global footer/action bar for summarized in-flight actions

Do not use tick-based loading heuristics.

Do not clear pending based on elapsed time alone.

Time-based minimum visibility is acceptable only to guarantee at least one paint, not as the source of truth.

## Tauri Command Rules

Desktop-facing Tauri commands should not block the main thread.

If a command performs blocking local HTTP or file/network-style waiting, run it off the Tauri main path.

In practice:

- Tauri commands for desktop actions should be async
- blocking Rust work should run via `spawn_blocking`

## Ordering Rules

The desktop worktree list should follow the same visual ordering source as the TUI:

- use the server-provided worktree order
- do not resort worktrees based on last touched session
- keep unassigned entries last
- keep temporary pending-worktree placeholders after the real ordered worktrees

## Mental Model

The desktop is not the authority.

The project service owns live state in memory.

Desktop should:

- request actions
- show deterministic pending state
- reconcile to heartbeat

It should not invent its own independent state machine for agent lifecycle.
