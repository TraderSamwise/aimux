# Tmux Runtime Architecture

## Decision

Aimux uses `tmux` as its runtime substrate.

Aimux remains responsible for:

- agent/session metadata
- worktree orchestration
- dashboard and project views
- plans and coordination files
- tray integration
- notifications

Tmux becomes responsible for:

- PTY ownership
- scrollback
- attach/detach
- repaint and terminal protocol handling
- pane/window persistence

This is the live backend architecture, not a partial hybrid.

## Core Model

### Default Runtime Topology

- one tmux session per project
- deterministic tmux session name per project
- dashboard lives in a dedicated tmux window inside that project session
- each agent lives in its own tmux window

Recommended default:

- tmux session: `aimux-<project-slug>-<project-id>`
- dashboard window index/name: `0:dashboard`
- agent windows: `1..N`, named from session label or session id

### Why Per-Project Session

Per-project tmux sessions are the default because they provide:

- clean isolation between projects
- clean project lifecycle ownership
- simpler cleanup semantics
- safer coexistence with users who already use tmux personally
- better mapping to the current aimux project mental model

Avoid a single global shared aimux tmux session as the default because it creates:

- cross-project coupling
- naming collisions
- worse cleanup
- more dangerous interaction with user-owned tmux environments

## Coexistence With User tmux

Aimux should never assume it owns the user's entire tmux world.

### Default Behavior

- if user is not in tmux, aimux creates/attaches to the project's managed tmux session
- if user is already in tmux, aimux still creates/uses the project's managed tmux session
- aimux switches the client to that project session instead of polluting the user's current personal session

### Non-Default Advanced Mode

Potential future opt-in:

- attach aimux windows to the current tmux session

This should not be the default because it is harder to reason about, harder to support, and more likely to annoy power users.

## User Experience Target

### Entering Aimux

- user runs `aimux`
- aimux resolves project root
- aimux ensures the project tmux session exists
- aimux ensures the dashboard window exists
- aimux attaches or switches to the dashboard window

### Creating an Agent

- aimux allocates an aimux session id
- aimux creates metadata/state as today
- tmux creates a new window in the project session
- tool command starts inside that window with the right cwd/worktree and preamble/context files
- aimux records `session id -> tmux target`

### Focusing an Agent

- aimux switches client to the agent's tmux window
- no custom focused compositor
- no custom footer in the terminal surface

### Returning to Dashboard

- user can switch back to dashboard window in tmux
- aimux should provide a standard keybinding/command for this

Recommended:

- dashboard is always window `0`
- aimux binds a tmux key or emits a helper command for `select-window -t 0`

### Rejoin / Reconnect

- tmux already has the live screen and scrollback
- aimux only needs metadata/runtime discovery
- no custom viewport hydration or focused snapshot reconstruction

## Architecture

## 1. `TmuxRuntimeManager`

New core backend responsible for:

- ensuring tmux is installed and available
- deterministic project session naming
- creating project session if missing
- creating dashboard window if missing
- creating agent windows
- killing windows
- sending input/commands to windows
- selecting/attaching clients to windows
- capturing pane/window content for dashboard metadata if needed
- mapping aimux session ids to tmux targets

Likely API surface:

- `ensureProjectSession(projectRoot): Promise<ProjectTmuxSession>`
- `ensureDashboardWindow(projectSession): Promise<TmuxTarget>`
- `spawnAgent(sessionState, spawnSpec): Promise<TmuxTarget>`
- `focusTarget(target): Promise<void>`
- `killTarget(target): Promise<void>`
- `renameTarget(target, title): Promise<void>`
- `captureTarget(target, opts): Promise<CapturedScreen>`
- `listTargets(projectSession): Promise<TmuxTarget[]>`

## 2. `AgentRuntime`

Aimux runtime object per agent should be simplified to metadata + tmux target:

- `id`
- `tool`
- `label`
- `role`
- `worktreePath`
- `backendSessionId`
- `tmuxTarget`
- `status`

Status becomes derived from tmux/runtime facts, not from a custom PTY/compositor loop.

## 3. Dashboard / Registry / Tray

These systems stay mostly intact conceptually:

- dashboard uses aimux metadata + runtime status
- all-projects/meta view stays aimux-owned
- tray still starts/stops project server and opens dashboard

But they should stop assuming custom focused terminal ownership.

## 4. Focused Mode

The current custom focused terminal surface should be retired.

Replace with:

- dashboard as a tmux window
- agent focus as tmux window switch

This means:

- `FocusedRenderer`
- terminal query responder/broker/fallback
- terminal host scroll region logic
- custom viewport snapshot hydration path

have been deleted as part of the tmux cutover.

## Operating Principles

## 1. No Long-Term Dual Runtime

- tmux runtime only

Do not preserve a first-class custom multiplexer backend long term.

## 2. Keep Dashboard Value, Delete Runtime Burden

Keep:

- dashboard
- plans
- worktree tools
- metadata views

Delete:

- custom focused session compositor
- scrollback emulation
- terminal query emulation

## State Mapping

The key persistent mapping becomes:

- aimux session id -> tmux session/window target

That mapping should live in project state/server state and be considered authoritative.

## Detailed Design Decisions

## Session Naming

Use a deterministic project identifier derived from project root.

Recommended:

- display name based on repo/folder name
- internal tmux session name based on slug + stable hash:
  - `aimux-<short-hash>`

Optional:

- include repo slug for easier debugging:
  - `aimux-tealstreet-mobile-<short-hash>`

## Window Naming

Dashboard:

- fixed `dashboard`

Agent windows:

- prefer label if present
- else worktree short name
- else session id

Window names should be human-readable but not authoritative. The authoritative mapping is still aimux session id -> tmux target id.

## Worktrees

Each agent still carries worktree metadata and cwd. Tmux only hosts the terminal runtime. Worktree management remains purely aimux-owned.

## Plans

No change:

- `.aimux/plans/<session-id>.md`

This remains session-indexed and independent of tmux.

## Dashboard Data Sources

Dashboard should derive from:

- aimux state/session metadata
- project server state
- tmux target liveness

Not from terminal snapshots.

## Risks

## 1. Dashboard Return UX

Need a clean, discoverable way to return from agent window to dashboard.

Mitigation:

- fixed window `0`
- standard keybinding
- explicit docs/help text

## 2. User tmux Expectations

Users already inside tmux may dislike unexpected session switching.

Mitigation:

- always use dedicated project session by default
- be explicit in docs
- maybe add opt-in current-session mode later

## 3. Tray / GUI Launch Behavior

Tray actions need to target tmux sessions correctly even when no terminal is attached.

Mitigation:

- tray/server should ensure project session exists
- opening dashboard should attach/switch to dashboard window

## Success Criteria

The tmux-backed architecture is successful when:

- focused agent sessions are tmux-native
- dashboard is tmux-native window `0`
- scrollback is reliable and isolated per agent
- terminal protocol quirks are tmux's problem, not aimux's
- the old custom terminal-core code stays deleted
