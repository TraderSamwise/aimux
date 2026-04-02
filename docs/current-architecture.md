# Current Architecture

## Status

Current

This document is the source of truth for the runtime/control-plane split in aimux today.

## Overview

Aimux has three distinct layers:

1. `tmux` runtime
2. global aimux daemon
3. clients

These layers should not be conflated.

## 1. `tmux` Runtime

`tmux` is the only runtime substrate.

It owns:

- agent windows
- PTY lifecycle
- scrollback
- attach/detach
- repaint and terminal protocol behavior

Each project gets one shared managed tmux session for agent runtime.

That project session is the live terminal authority.

Aimux does not own a custom PTY multiplexer anymore.

## 2. Global Aimux Daemon

Aimux now has one global control-plane daemon.

It owns:

- project discovery
- project activation
- supervision of daemon-managed project services
- metadata API lifecycle
- plugin runtime supervision
- statusline/state aggregation
- desktop-facing project/session summaries

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

## 3. Daemon-Managed Project Services

For each active project, the daemon may supervise one project service process.

That project service owns the project-scoped sidecars:

- `MetadataServer`
- `PluginRuntime`
- project `statusline.json` writing

This is not an elected lease anymore.

There is no per-project host handoff or host stealing model now.

If a project service dies:

- tmux agent windows keep running
- the daemon can start a replacement project service
- shared control-plane behavior resumes when the replacement starts

## 4. Clients

Clients include:

- terminal dashboard processes
- desktop / Tauri
- CLI commands
- external services

Clients are not control-plane authorities.

They:

- ensure the daemon exists
- ensure the current project service exists when needed
- attach to tmux dashboards/agent windows
- call metadata/orchestration surfaces through the daemon-managed system

Desktop transport is now HTTP-first:

- desktop uses daemon HTTP for project discovery and project-service discovery
- desktop uses project-service HTTP for live project snapshots and awaited lifecycle actions
- desktop should not poll by spawning CLI subprocesses for routine heartbeat state
- desktop should treat `statusline.json` as a derived/debug artifact, not as its primary live API
- desktop pending UI should remain active until heartbeat reconciles the expected state change

The CLI is also the GUI automation surface. For project-targeted automation, prefer explicit `--project` commands instead of cwd-dependent invocation:

```bash
aimux spawn --tool claude --project /abs/path/to/repo --json
aimux fork <sessionId> --tool codex --project /abs/path/to/repo --json
aimux stop <sessionId> --project /abs/path/to/repo --json
aimux rename <sessionId> --label "Backend reviewer" --project /abs/path/to/repo --json
aimux migrate <sessionId> --worktree /abs/path/to/worktree --project /abs/path/to/repo --json
aimux kill <sessionId> --project /abs/path/to/repo --json
aimux graveyard send <sessionId> --project /abs/path/to/repo --json
aimux graveyard resurrect <sessionId> --project /abs/path/to/repo --json
aimux worktree list --project /abs/path/to/repo --json
aimux worktree create feature-x --project /abs/path/to/repo --json
aimux desktop focus --project /abs/path/to/repo --session <sessionId>
```

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
- dashboard tab, pointer, and load state are per-terminal

Shared control-plane state is no longer owned by the dashboard process.

## `aimux serve`

`aimux serve` is now a compatibility wrapper.

It means:

- ensure daemon running
- ensure the current project's project service exists

It does not mean:

- become the elected host
- compete with another dashboard process for project ownership

## State Split

Repo-local `.aimux/` remains the agent-facing shared contract:

- plans
- context
- history
- threads
- tasks
- sessions discovery artifacts

Global `~/.aimux/projects/<project-id>/...` remains runtime-private project state.

Global `~/.aimux/daemon/...` is daemon-private state.

## Desktop / Tauri Implications

Desktop should be designed around:

- one global daemon
- daemon-managed project services
- tmux as runtime authority
- daemon/project-service HTTP as the primary desktop transport

Desktop should not:

- infer project liveness from stale project-local lease files
- spawn replacement project hosts directly
- assume the dashboard process owns shared control-plane state
- rely on CLI subprocess polling for routine live updates

## Notes

- [docs/global-control-plane-rfc.md](./global-control-plane-rfc.md) explains why the architecture changed.
- [docs/project-host-model.md](./project-host-model.md) is historical only.
- [docs/desktop-ui-contract.md](./desktop-ui-contract.md) is the desktop/Tauri UI integration contract.
