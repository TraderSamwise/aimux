# Runtime Lifecycle

Aimux has two user-facing recovery levels and one narrow dashboard-only reload:

- `aimux`
  - open or attach to the current project runtime
- `aimux dashboard-reload --open`
  - recreate and reopen the dashboard window only
- `aimux repair`
  - repair the current project runtime in place
- `aimux restart-runtime --open`
  - hard restart the current project runtime
- `aimux stop`
  - stop the current project runtime

## Mental Model

For a single project, Aimux runtime is made of:

1. project service
2. managed tmux host/client/dashboard topology
3. managed agent and service windows

The global daemon still exists, but it is an advanced/internal layer. Most users should think in terms of the current project's runtime, not the daemon.

## Command Guide

### `aimux`

Use for normal entry.

What it does:

- starts missing project runtime pieces if needed
- attaches or switches into the current project's dashboard

### `aimux dashboard-reload --open`

Use when only the dashboard window itself is stale, missing, or visually wrong.

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

1. `aimux dashboard-reload --open`
2. `aimux repair`
3. `aimux restart-runtime --open`

Use the advanced daemon commands only if the daemon itself is wedged or a build mismatch persists after a project runtime restart.

## Advanced Commands

These still exist, but they are not the primary user model:

- `aimux host ...`
- `aimux daemon ...`

They are advanced compatibility/debugging surfaces around the global daemon and project-service internals.
