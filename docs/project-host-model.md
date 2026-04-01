# Project Host Model

## Status

Superseded by [docs/global-control-plane-rfc.md](./global-control-plane-rfc.md).

This document describes the replaced per-project host-election model. It remains as historical context only and should not be treated as the current target architecture.

Aimux is now built around three separate concepts that should not be conflated:

1. tmux runtime
2. per-project host
3. per-terminal dashboard client

This document is the source of truth for that split.

## 1. tmux Runtime

Tmux is the only live runtime substrate.

It owns:

- agent windows
- PTY lifecycle
- scrollback
- attach/detach
- repaint and terminal protocol behavior

Each project gets one shared host tmux session:

- `aimux-<project-slug>-<project-id>`

That host session contains the shared agent windows for the project.

Tmux is the runtime authority. Aimux no longer has a separate non-tmux live session server.

## 2. Per-Project Host

Each project has exactly one elected host process at a time.

The host owns the control-plane sidecars:

- `MetadataServer`
- `PluginRuntime`
- statusline/state writing
- host heartbeat and ownership metadata

The host is tracked in:

- `~/.aimux/projects/<project-id>/host.json`

The host is not the tmux runtime. It is the project-local control plane.

### Host lifecycle

There are two ways to run the host:

1. dashboard-backed host
- normal `aimux` dashboard mode

2. headless host
- `aimux serve`

Both modes use the same host election and own the same sidecars.

If a live host already exists for the current project:

- `aimux serve` reports it and exits
- it does not start a competing host

Useful commands:

```bash
aimux serve
aimux host status
aimux host status --json
aimux host restart --serve
aimux host stop
aimux host kill
```

### What survives if host dies

If the host process dies:

- tmux agent windows keep running
- agent runtime is still alive
- metadata/plugin/statusline sidecars stop until a host is started again

That is why host management is project-local operational control, not runtime ownership.

## 3. Per-Terminal Dashboard Clients

Multiple terminals can enter the same project via `aimux`.

Those terminals should not share dashboard UI state.

So aimux now creates per-terminal client tmux sessions:

- `aimux-<project>-<id>-client-<suffix>`

These client sessions exist only to isolate view state:

- current dashboard window
- selected dashboard tab
- dashboard pointer/load state
- current focused window for that terminal

Each client session gets its own dashboard window:

- `dashboard-<client-suffix>`

Agent windows remain shared by linking them into client sessions on demand.

### Result

Shared across terminals:

- project host tmux runtime
- agent windows
- project host metadata/control plane

Isolated per terminal:

- dashboard window/process
- dashboard tab/pointer/load state
- current terminal focus

## State split

Agent-facing shared artifacts live in repo-local `.aimux/`:

- `.aimux/plans/`
- `.aimux/status/`
- `.aimux/context/`
- `.aimux/history/`
- `.aimux/tasks/`
- `.aimux/threads/`
- `.aimux/sessions.json`

Runtime-private state lives in:

- `~/.aimux/projects/<project-id>/`

That includes:

- `host.json`
- `metadata.json`
- `metadata-api.json`
- `instances.json`
- `statusline-owner.json`
- `recordings/`
- `graveyard.json`
- `state.json`

## Desktop / Tauri Implications

Desktop should not be designed around:

- a global aimux daemon
- a global metadata server
- a project-global dashboard UI

Desktop should be designed around:

- per-project tmux runtime
- one elected per-project host
- per-project metadata API endpoint
- optional headless host startup via `aimux serve`

The right mental model is:

- tmux owns runtime
- host owns per-project control plane
- terminals and desktop are clients of that project-local system

## Future Direction

If desktop needs discovery later, add a thin global registry/index.

Do not make that registry the runtime authority.

The authority boundaries should remain:

- runtime: tmux
- control plane: per-project host
- UI clients: dashboard terminals and desktop shell
