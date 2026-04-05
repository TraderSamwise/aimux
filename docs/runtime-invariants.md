# Runtime Invariants

This document defines the intended ownership boundaries for the current aimux runtime.

It exists to prevent the same state from being mutated by multiple layers and to make future refactors of `src/multiplexer.ts` concrete instead of speculative.

## Ownership

### tmux

`tmux` owns live terminal mechanics:

- sessions
- windows
- panes
- client attachment
- instant switching
- repaint

Common-path switching must stay tmux-local whenever possible.

### Project service

The daemon-managed project service owns shared project state:

- session metadata
- labels
- last-used state
- orchestration/thread/workflow state
- precomputed statusline/state snapshots

The project service does not own terminal-local cursor state.

### Dashboard process

The dashboard TUI process owns local dashboard UI state:

- current screen
- focused worktree
- worktree/session level
- selected dashboard row
- transient overlays

Dashboard return should reuse the existing dashboard process and preserve this state.

### CLI / bootstrap

The CLI owns bootstrap and administrative flows:

- ensuring daemon/project service
- creating/reloading dashboard processes when missing or dead
- one-shot operator commands

It should not be the common-path controller for interactive tmux navigation.

## Session Lifecycle Invariants

### Create

Creating an agent or service from the dashboard must:

1. create detached
2. keep the user on the dashboard
3. set inline pending state
4. move dashboard selection to the created row once it exists

Creating must not auto-enter the new window.

### Open / focus

Opening a live row from the dashboard should prefer the current dashboard client's already-linked tmux window.

Only if that direct path fails should it fall back to broader open helpers.

### Restore

Restoring an offline session must treat the old offline row as historical metadata, not as runtime truth.

Restore must:

1. preserve display label
2. remove poisoned offline state before relaunch
3. avoid reusing stale resume flags unless explicitly intended
4. no-op while the same session is already starting

### Stop / graveyard

Stop and graveyard must be idempotent with respect to repeated user input.

If a row is already effectively offline or already pending stop/graveyard, repeated actions should not create duplicate side effects.

### Rename

Rename is display metadata only.

It must not change tmux identity or runtime recovery identity.

## Dashboard UI Invariants

### Selection restore

Dashboard selection restore should run only when the dashboard model changes or when the preferred selection is explicitly updated.

Ordinary redraws must not reset local cursor state.

### Focus-in

Ordinary return to dashboard should be redraw-only.

It must not trigger heavy model refresh or rebuild in the common path.

### Pending state

Pending state is shared action metadata, not a modal UI concept.

Dashboard should render pending state inline and reject duplicate conflicting actions while pending is active.

## Control-Path Invariants

### Dashboard target resolution

There should be one primary dashboard target resolver for open/reload semantics.

Common-path return to an already-live dashboard should not go through heavy bootstrap or project-service verification.

### tmux control shell

`scripts/tmux-control.sh` is transport plus degraded-mode recovery.

It is not a second primary control plane.

Common-path hotkeys should prefer local tmux resolution first.

### Statusline

Statusline rendering must use precomputed state.

The footer must not reconstruct broad runtime state on every refresh.

## Current Audit Risks

The remaining broad risk surfaces are:

- session lifecycle actions and pending state all living in `src/multiplexer.ts`
- overlap between dashboard open helpers and metadata-server open helpers
- degraded-mode logic in `scripts/tmux-control.sh`
- any remaining path that uses display labels or tmux window names as identity

## Refactor Order

Recommended extraction order from `src/multiplexer.ts`:

1. dashboard UI snapshot and selection persistence
2. dashboard action handlers for create/restore/rename/graveyard
3. dashboard open/focus helpers
4. background refresh / heartbeat logic

That order follows the ownership boundaries above and reduces the bug classes that have already appeared in production use.
