# Aimux Architecture

Aimux separates local execution from a shared control plane.

## Runtime Layers

1. **Global daemon** - discovers projects, activates them, and supervises one
   project service per active project.
2. **Project service** - owns project API state, lifecycle mutations,
   notifications, threads, tasks, handoffs, reviews, worktrees, graveyard state,
   pane reads, and project events.
3. **tmux runtime** - owns terminal execution: panes, windows, PTYs,
   scrollback, attach/detach, and same-machine focus behavior.
4. **Clients** - terminal dashboard, CLI, [aimux.app](https://aimux.app), the
   upcoming iOS/Android apps, scripts, and plugins. Clients read and mutate
   shared state through daemon and project service APIs.
5. **Relay** - optional remote transport for owner devices and accepted shared
   chats. It forwards authorized requests to the owner's connected daemon.

The project service is the authority for shared project state. tmux is the
authority for terminal mechanics. Clients should not become alternate writers
for the same data.

## Ownership Boundaries

The daemon owns:

- project discovery and activation
- project-service supervision
- local runtime repair
- daemon HTTP routes for clients to find projects and services

The project service owns:

- shared project reads and writes
- agent lifecycle actions such as spawn, stop, kill, fork, and resurrect
- worktree and graveyard operations
- notifications, threads, tasks, handoffs, reviews, and Coordination records
- `/events` SSE updates for local and remote clients
- pane read and stream routes that expose tmux output through an API

tmux owns:

- real agent and service execution
- pane capture and live preview mechanics
- window focus and same-machine switching
- terminal repaint and attach/detach behavior

The app and CLI are clients. They should discover the active project service
and use API routes for shared product state instead of writing repo-local or
runtime-private files directly.

## App Architecture

The browser app is [aimux.app](https://aimux.app). The browser and native
clients live in `app/` as a single Expo Router application for web, iOS, and
Android.

- `app/app/` contains route screens.
- `app/components/` contains shared UI.
- `app/lib/api.ts` contains typed daemon and project-service HTTP wrappers.
- `app/lib/heartbeat.ts` owns project SSE subscriptions.
- `app/stores/` contains Jotai state.

Durable UI preferences belong in `app/stores/settings.ts`. Shared project data
belongs in resource lifecycle stores and API wrappers, not screen-local fetch
state.

## State Locations

- `~/.aimux/daemon/` - daemon-private state.
- `~/.aimux/projects/<project-id>/` - runtime-private project state.
- Repo-local `.aimux/` - agent-facing local artifacts such as context, history,
  and explicit plans.
- Project service APIs - source of truth for shared workflow state such as
  tasks, threads, handoffs, reviews, notifications, and lifecycle records.

`statusline.json` is a derived/debug artifact. It is not the primary transport
for app, CLI, or dashboard state.

## Remote And Shared Access

Owner remote access and shared chat access both use the relay, but they are
different product surfaces:

- Owner remote access lets the owner use their own local projects from another
  device.
- Shared chats let another signed-in account join a specific session without
  running an Aimux daemon or seeing the owner's project workspace.

Shared chat routes are orthogonal to the receiver's own project list. A
receiver can move between their projects and shared chats, but those navigation
areas should not mix their state or information architecture.
