# Runtime Lifecycle

Aimux has one normal repair command. The lower-level repair/reset commands exist for debugging, but they are not the user recovery path.

- `aimux`
  - open or attach to the current project runtime
- `aimux restart`
  - repair daemon/service/dashboard/tmux drift and reload existing dashboard windows
- `aimux doctor versions`
  - inspect daemon, project service, and dashboard build coherence
- `aimux stop`
  - stop the current project runtime

## Mental Model

Aimux runtime is made of:

1. the global daemon
2. one daemon-supervised project service per active project
3. managed tmux host/client/dashboard topology
4. managed agent and service windows

The daemon and project services form the local control plane. The tmux runtime owns execution and same-machine focus/open behavior. `aimux restart` is the coherence repair command for daemon/service/dashboard version drift and managed tmux contract drift; it preserves agent windows.

## Command Guide

### `aimux`

Use for normal entry.

What it does:

- starts missing project runtime pieces if needed
- attaches or switches into the current project's dashboard

### `aimux restart`

Use when code was rebuilt, dashboards are stale across projects, the daemon was upgraded, a dashboard reports drift, or you are unsure which projects/TUIs are on which build.

What it does:

- inventories known projects from daemon state and managed tmux sessions
- restarts the global daemon
- re-ensures known project services on the new daemon
- repairs managed tmux contract drift in place
- force-reloads dashboard windows that already existed
- records repair diagnostics in `~/.aimux/projects/<project-id>/logs/repairs.jsonl`
- preserves managed agent windows and project tmux sessions

What it does not do:

- does not kill running agents
- does not remove project tmux sessions
- does not create dashboards for every daemon-known project unless scoped with `--project`

Related:

```bash
aimux doctor versions
aimux restart --project /abs/path/to/repo
```

### `aimux stop`

Use when you want the current project's runtime off.

What it does:

- stops the current project's project service
- tears down the current project's managed tmux runtime sessions

It keeps persisted state that Aimux already stores for later re-entry.

### `aimux stop <sessionId>`

This is the agent lifecycle form, not the project runtime form.

What it does:

- stops a specific running agent
- moves it to offline state

## Advanced Commands

These still exist, but they are not the primary user model:

- `aimux repair`
- `aimux dashboard-reload --open`
- `aimux restart-runtime --open`
- `aimux host ...`
- `aimux daemon ...`

Use them only when debugging the repair system itself or deliberately testing a lower-level runtime path.

### `aimux dashboard-reload --open`

Advanced narrow repair for one dashboard window.

What it does:

- recreates/reopens the dashboard window
- does not hard reset the rest of the project runtime

What it does not do:

- does not restart the daemon
- does not rebuild all tmux sessions
- does not fully reconcile project state

### `aimux repair`

Use when the current project runtime exists but has drifted.

Examples:

- `window 0` missing
- broken dashboard/client topology
- stale tmux options or bindings
- missing dashboard despite a live runtime

What it does:

- ensures the project service exists
- repairs managed tmux session state
- recreates missing dashboard/client topology
- reapplies managed tmux session/window policy

What it does not do:

- does not intentionally hard-reset the whole runtime
- does not restart the global daemon

### `aimux restart-runtime`

Use when in-place repair is not enough or a new build changed runtime assumptions.

What it does:

- stops the current project's runtime
- removes the current project's managed tmux sessions
- starts a fresh project runtime
- rebuilds dashboard/client topology

Recommended form:

```bash
aimux restart-runtime --open
```

## Recovery Order

When something feels wrong, use:

1. `aimux restart`
2. `aimux doctor versions`

If that does not explain or fix the issue, inspect the repair log for the affected project and debug the lower-level command intentionally. `aimux daemon restart` is a compatibility alias for the coherent `aimux restart` path.
