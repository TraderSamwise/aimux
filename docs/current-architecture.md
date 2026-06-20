# Current Architecture

## Status

Current

This document is the source of truth for the runtime/control-plane split in aimux today.

## Overview

Aimux separates local execution from the shared control plane.

Runtime layers:

1. **Global daemon** — one local host service for project discovery, project activation, and supervision of per-project services.
2. **Per-project service** — the project-local HTTP/SSE authority, implemented by the metadata server.
3. **tmux runtime** — the managed per-project tmux session that owns real terminal execution.
4. **Clients** — terminal TUI dashboard, Expo web/mobile app, CLI helpers, scripts, and plugins.

These layers should not be conflated. The project service is the single writer for shared project control-plane state. tmux remains the local execution substrate.

## 1. Global Daemon

The global daemon owns:

- project discovery and activation
- supervision of daemon-managed project services
- daemon HTTP for client project/service discovery
- stable/dev runtime lane separation

Stable `aimux` uses port `43190`. `aimux-dev` uses port `43191`.

Useful commands:

```bash
aimux daemon ensure
aimux daemon status --json
aimux daemon projects --json
aimux daemon project-ensure --project /abs/path/repo
aimux daemon restart
aimux daemon stop
aimux daemon kill
```

## 2. Per-Project Service

For each active project, the daemon may supervise one project service process.

The project service owns:

- live project state and API lifecycle
- notifications, threads, tasks, handoffs, reviews, and Coordination worklists
- lifecycle mutations such as spawn, stop, kill, fork, rename, migrate, worktree, and graveyard actions
- workflow actions such as reply, mark seen, accept, block, complete, reopen, approve, and request changes
- `/events` SSE project updates and alerts for TUI, web, and mobile clients
- plugin runtime and metadata sidecars
- derived `statusline.json` snapshots for tmux status/debugging

This is not an elected lease model. There is no per-project host handoff or host stealing. If a project service dies, tmux agent windows keep running and the daemon can start a replacement service.

## 3. tmux Runtime

tmux is the only terminal runtime substrate.

It owns:

- agent, service, and dashboard windows
- PTY lifecycle
- scrollback
- attach/detach
- repaint and terminal protocol behavior
- same-machine focus/open/window switching

Each project gets one shared managed tmux session for agent runtime. Aimux does not own a custom PTY multiplexer anymore.

Remote clients do not replace tmux. They use API routes for control-plane state, pane read/stream routes for terminal views, and remote equivalents for tmux-specific behavior such as deep-link or focus resolution.

## 4. Clients

Clients include:

- terminal dashboard processes
- Expo web/mobile app in `app/`
- CLI commands
- scripts, plugins, and local watchers

Clients are not control-plane authorities. They should:

- ensure the daemon exists when appropriate
- discover project services through daemon/project metadata
- call project-service HTTP for shared reads and mutations
- consume project-service `/events` SSE for heartbeat, alerts, and refreshes
- treat `statusline.json` as derived/debug state, not a primary transport

The terminal TUI dashboard is an API-backed client for shared workflows. It still owns terminal-local UI state such as current screen, selection, filters, text buffers, overlays, and render timing.

The web/mobile app is a pure HTTP+SSE client. It does not bundle the CLI and does not own or repair the daemon.

## Shared API Surface

Project-service HTTP exposes the live control plane, including:

- `GET /health`
- `GET /desktop-state`
- `GET /coordination-worklist`
- `GET /events`
- `GET /notifications`
- `POST /notifications/read`
- `POST /notifications/clear`
- `GET /threads`
- `GET /threads/:id`
- `POST /threads/open`
- `POST /threads/send`
- `POST /threads/mark-seen`
- `POST /threads/status`
- `POST /handoff`
- `POST /handoff/accept`
- `POST /handoff/complete`
- `POST /tasks/assign`
- `POST /tasks/accept`
- `POST /tasks/block`
- `POST /tasks/complete`
- `POST /tasks/reopen`
- `POST /reviews/approve`
- `POST /reviews/request-changes`
- lifecycle, topology, worktree, graveyard, pane read, and pane stream routes

Shared response contracts belong in `src/project-api-contract.ts`. The Expo client wrappers live in `app/lib/api.ts`. TUI request helpers live in `src/multiplexer/dashboard-control.ts`.

## Dashboard Model

`aimux` remains the terminal-native UI.

When you run `aimux`:

- it ensures the daemon is running
- it ensures the current project's project service is running
- it ensures the managed tmux dashboard exists
- it opens or attaches to that dashboard

Dashboard UI state is terminal-local:

- the shared per-project tmux runtime session owns agent windows
- each terminal gets its own tmux client session and dashboard window/process
- dashboard tab, pointer, filter, and load state are per-terminal
- leaving the dashboard from inside managed tmux detaches or returns the client without destroying that per-terminal dashboard window

Shared control-plane state is not owned by the dashboard process. Dashboard reads and mutations that affect shared state should go through project-service APIs.

Dashboard startup/open paths prune stale dashboard artifacts automatically. Invalid dashboard windows are removed when they:

- point at dead panes
- are stuck in failure keep-alive commands like `cat` or `tail`
- are missing the current dashboard build stamp
- advertise a mismatched dashboard build stamp

## Tmux Control Helpers

Project-service HTTP also exposes low-latency tmux control helpers for same-machine behavior, including switchable agents, next/previous/attention switching, and opening the dashboard.

Tmux hotkeys use these through a small shell transport instead of shelling into the heavyweight operator CLI. That transport prefers local tmux resolution and falls back to project-service control helpers when local recovery is insufficient.

The final window switch still happens in tmux.

## State Split

Repo-local `.aimux/` remains the agent-facing shared contract for durable artifacts agents can inspect directly:

- plans
- context
- history
- session discovery artifacts

Runtime exchange owns threads, tasks, handoffs, reviews, workflow state, and notification records. Legacy repo-local thread/task files are import or compatibility inputs only; new external reads and writes should go through exchange-backed project-service APIs.

Global `~/.aimux/projects/<project-id>/...` remains runtime-private project state.

Global `~/.aimux/daemon/...` is daemon-private state.

## App And Remote Client Implications

Web/mobile clients should be designed around:

- one global daemon
- daemon-managed project services
- tmux as local runtime authority
- daemon/project-service HTTP as the primary transport
- project-service `/events` SSE for live updates
- explicit screens for dashboard, activity, Coordination, threads, plans, and graveyard
- explicit workflow-aware orchestration screens and actions on top of project-service HTTP
- pane read/stream APIs or deep-link/focus routes for tmux-specific behavior

Clients should not:

- infer project liveness from stale project-local lease files
- spawn replacement project hosts directly
- assume the dashboard process owns shared control-plane state
- rely on CLI subprocess polling for routine live updates
- write runtime-exchange, notification, thread/task/review, topology, worktree, or graveyard state directly

## `aimux serve`

`aimux serve` is now a compatibility wrapper.

It means:

- ensure daemon running
- ensure the current project's project service exists

It does not mean:

- become the elected host
- compete with another dashboard process for project ownership

## Notes

- [docs/global-control-plane-rfc.md](./global-control-plane-rfc.md) explains why the architecture changed.
- [docs/project-host-model.md](./project-host-model.md) is historical only.
- [docs/desktop-ui-contract.md](./desktop-ui-contract.md) is historical; the active client is the Expo app in `app/`.
