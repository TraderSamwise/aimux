# Runtime Lifecycle

Aimux has one broad control-plane restart, project-scoped repair/reset commands, and one narrow dashboard-only reload:

- `aimux`
  - open or attach to the current project runtime
- `aimux restart`
  - restart the daemon, re-ensure known project services, and reload existing dashboard windows
- `aimux doctor versions`
  - inspect daemon, project service, and dashboard build coherence
- `aimux repair`
  - repair the current project runtime in place
- `aimux dashboard-reload --open`
  - advanced: recreate and reopen one dashboard window only
- `aimux restart-runtime --open`
  - hard restart the current project runtime
- `aimux stop`
  - stop the current project runtime

## Mental Model

Aimux runtime is made of:

1. the global daemon
2. one daemon-supervised project service per active project
3. managed tmux host/client/dashboard topology
4. managed agent and service windows

The daemon and project services form the local control plane. The tmux runtime owns execution and same-machine focus/open behavior. `aimux restart` is the normal coherence repair command for daemon/service/dashboard version drift; it preserves agent windows. `aimux restart-runtime` is the destructive project-scoped reset for the managed tmux runtime.

## Command Guide

### `aimux`

Use for normal entry.

What it does:

- starts missing project runtime pieces if needed
- attaches or switches into the current project's dashboard

### `aimux restart`

Use when code was rebuilt, dashboards are stale across projects, the daemon was upgraded, or you are unsure which projects/TUIs are on which build.

What it does:

- inventories known projects from daemon state and managed tmux sessions
- restarts the global daemon
- re-ensures known project services on the new daemon
- force-reloads dashboard windows that already existed
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

## Recovery Order

When something feels wrong, prefer this order:

1. `aimux restart`
2. `aimux doctor versions`
3. `aimux repair`
4. `aimux restart-runtime --open`

Use `aimux dashboard-reload --open` only when you intentionally want a narrow single-dashboard reload. Use `aimux restart-runtime --open` only when the current project's managed tmux runtime should be torn down and rebuilt.

## Advanced Commands

These still exist, but they are not the primary user model:

- `aimux host ...`
- `aimux daemon ...`

They are advanced compatibility/debugging surfaces around the global daemon and project-service internals. `aimux daemon restart` is a compatibility alias for the coherent `aimux restart` path.
