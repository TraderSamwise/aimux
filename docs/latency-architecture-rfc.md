# Latency Architecture RFC

## Goal

Fix the broader latency problem in aimux, not just a few slow hotkeys.

This RFC covers:

- latency-sensitive tmux hotkeys
- statusline and render helper paths
- dashboard control/model boundaries
- CLI entrypoint responsibilities
- project-service fast control responsibilities
- implications for the desktop GUI

This does **not** change the core runtime model:

- `tmux` remains the only terminal/runtime substrate
- the global daemon remains the control-plane supervisor
- daemon-managed project services remain the per-project in-memory control surfaces

## Problem

Aimux currently mixes several very different latency classes into the same execution path.

Examples:

- pure tmux `select-window` is effectively instant
- `Ctrl+A s` feels fast after choosing an item, but opening the switcher menu is slow
- `Ctrl+A n/p/u` feel slower because they pay helper cost on every press
- statusline and dashboard performance have previously regressed when small render/control paths accidentally touched heavyweight logic

The main structural issue is:

- latency-sensitive control paths still shell into the heavyweight `aimux` CLI entrypoint

That means a small control action can pay for:

- process spawn
- shell spawn
- Node startup
- module loading
- command graph bootstrap
- config/path initialization
- daemon/project-service verification
- repeated reconstruction of project/session/worktree state

The actual tmux action at the end is usually cheap.

## Current Symptoms

Observed during debugging:

- direct tmux window switching is fast
- helper-backed hotkeys are slow before the final switch
- the menu path hides latency in the “open menu” phase
- repeated control logic is being reconstructed rather than answered from a hot in-memory model

This means the issue is not only “hotkeys are slow”.

The issue is:

- the latency architecture is wrong

## Current Execution Path Classes

Aimux currently has these broad path types:

1. pure tmux
2. tmux + `run-shell` + full `aimux` CLI
3. daemon/project-service HTTP
4. dashboard process internal rendering/model refresh
5. background service ticks and writers

These paths need different rules and different budgets.

## Desired Architecture

### Principle

Every path should use the lightest execution model appropriate for its latency budget.

### Path classes

#### A. Instant control paths

Target budget:

- `~<50ms` perceived latency

Examples:

- next/prev agent
- next attention
- open switch menu
- jump to dashboard
- agent-to-agent switching

Rules:

- do not use the heavyweight CLI entrypoint
- do not rebuild project/session state from scratch
- do not ensure daemon/project-service health unless clearly missing
- prefer pure tmux or thin project-service fast control RPC

#### B. Lightweight render paths

Target budget:

- `~<100ms` per render path

Examples:

- statusline rendering
- footer/status projections
- small in-dashboard overlays

Rules:

- consume cached/project-service-provided state
- do not shell out to git/tmux except minimal unavoidable calls
- do not perform unrelated orchestration or dashboard model work

#### C. Interactive UI paths

Target budget:

- `~<200ms` normal interactions

Examples:

- dashboard focus/refresh
- opening workflow/thread/detail screens
- dashboard reply/action overlays

Rules:

- use cached/incremental model data
- avoid full recomputation on every redraw
- keep heavy derivation off the critical paint path when possible

#### D. Operator/admin CLI paths

No tight budget required.

Examples:

- `aimux`
- `aimux daemon ...`
- `aimux dashboard-reload ...`
- debugging/admin/maintenance commands

Rules:

- full CLI is acceptable here
- startup and verification cost is expected

#### E. Background service paths

Target budget:

- bounded, amortized, no user-visible jank

Examples:

- project-service polling/ticks
- orchestration dispatch
- statusline snapshot writes
- event streaming

Rules:

- no unnecessary churn
- no constant full refresh loops
- dedupe writes and notifications

## Root Cause

The current `aimux` entrypoint is too monolithic for latency-sensitive usage.

It currently acts as:

- human CLI
- tmux hotkey helper
- dashboard bootstrap
- statusline renderer entrypoint
- daemon/project-service client
- internal control helper

That is convenient, but it means small control paths still pay for a full application-shaped entrypoint.

So the problem is partly:

- renderer-ish and CLI-ish responsibilities living together

But more precisely:

- latency-sensitive control/render paths are using the same heavyweight entrypoint as the full operator CLI

## Recommended Split

### 1. Keep the full CLI

Use `aimux` for:

- startup
- admin
- scripting
- maintenance
- debugging

### 2. Add a fast control surface

Use the already-running project service as the low-latency control plane for dynamic navigation.

Examples:

- next agent in current worktree
- prev agent in current worktree
- next attention target
- switcher entries
- dashboard target resolution

### 3. Keep pure tmux where possible

Examples:

- final `select-window`
- direct switch to a known target
- menu execution once entries are already known

### 4. Keep render helpers thin

Statusline/render helpers should:

- consume cached/materialized state
- never perform heavyweight project reconstruction
- never do daemon bootstrap/verification

## Fast Control Surface

Add a dedicated low-latency project-service API for tmux/UI navigation.

Suggested endpoints:

- `POST /control/switch-next`
- `POST /control/switch-prev`
- `POST /control/switch-attention`
- `POST /control/open-dashboard`
- `GET /control/switchable-agents`

Suggested request fields:

- `currentClientSession`
- `currentWindowId`
- `currentPath`
- `projectRoot`

Suggested response:

- resolved target:
  - `sessionName`
  - `windowId`
  - `windowIndex`
  - `windowName`
- or switcher entries with labels and window ids

Prefer:

- project service resolves target
- tmux performs final `select-window`

That keeps tmux as UI/runtime authority while removing reconstruction from the hot path.

## In-Memory Project-Service Model

To make fast control actually fast, the project service should maintain hot incremental state for:

- managed windows by worktree
- linked windows by client session
- dashboard windows by client session
- attention ordering
- session labels/roles/tools
- worktree-scoped agent order
- current switchable targets per client/worktree

This model should be incrementally updated from:

- tmux runtime awareness
- dashboard/session registry
- metadata state
- orchestration/workflow state

The project service should not rescan/rebuild the world on every navigation request.

## Hotkey Audit

Current managed tmux bindings:

### Root table

- `C-j`
  - current path: pure tmux conditional passthrough
  - target path: keep pure tmux
  - status: good

- `S-Enter`
  - current path: pure tmux conditional passthrough
  - target path: keep pure tmux
  - status: good

- `WheelUpPane`
  - current path: pure tmux conditional logic
  - target path: keep pure tmux
  - status: good

### Prefix table

- `C-a`
  - current path: pure tmux `send-prefix`
  - target path: keep pure tmux
  - status: good

- `d`
  - current path: `run-shell ... aimux tmux-switch dashboard ...`
  - target path:
    - pure tmux if current client dashboard window is known
    - project-service fallback for dashboard recovery

- `n`
  - current path: `run-shell ... aimux tmux-switch next ...`
  - target path: project-service fast control + final tmux select

- `p`
  - current path: `run-shell ... aimux tmux-switch prev ...`
  - target path: project-service fast control + final tmux select

- `u`
  - current path: `run-shell ... aimux tmux-switch attention ...`
  - target path: project-service fast control + final tmux select

- `s`
  - current path: `run-shell ... aimux tmux-switch menu ...`
  - target path:
    - project-service returns switcher entries
    - tmux renders the menu locally

## Additional Latency Surfaces

This RFC also covers non-hotkey paths.

### Statusline

Current risk:

- statusline paths can accidentally become expensive when they reconstruct project state or shell out

Target:

- thin display helper only
- cached/materialized inputs only
- no heavy project/service bootstrap work

### Dashboard

Current risk:

- dashboard model refresh can still be heavier than it needs to be
- view processes can drift toward reconstructing state rather than consuming hot service state

Target:

- dashboard acts more like a UI client of the project service’s hot control/state model
- expensive recomputation is incremental or off the critical interaction path

### CLI internal helpers

Current risk:

- small internal commands still go through a broad CLI entrypoint

Target:

- internal control helpers become thin RPC clients or separate lightweight entrypoints

## GUI / Desktop Implications

This is useful for the GUI, not just tmux.

### Shared navigation semantics

Desktop and tmux should consume the same fast-control model for:

- next/prev session in current worktree
- next attention target
- switchable agent lists
- dashboard target resolution

That prevents drift between TUI and GUI.

### Lower-latency desktop controls

The desktop UI should not infer or rebuild tmux state independently.

Instead:

- ask the daemon/project service for fast control targets
- use those targets to drive embedded tmux client interactions or higher-level actions

### Better orchestration UX

Once fast control exists in the project service, the same surface can support:

- jump to next waiting review
- focus the agent with pending reply pressure
- open the most relevant workflow family target

These become shared capabilities for tmux and GUI.

## Risks

### 1. Fast control becomes another ad hoc API

Mitigation:

- keep it small
- keep it explicitly scoped to low-latency control/navigation
- document it as such

### 2. Project-service cached control state drifts from tmux reality

Mitigation:

- tmux remains final authority
- service resolves from hot state but can cheaply validate targets
- recovery path exists when cached target is stale

### 3. Two implementations of ordering/scope persist

Mitigation:

- centralize ordering/scope semantics in one fast-control module
- reuse it across tmux, dashboard, and GUI

### 4. Fallbacks silently become normal again

Mitigation:

- instrument fast-control fallbacks
- treat fallback as exceptional
- keep slow CLI paths clearly separated from fast-control paths

## Migration Plan

### Phase A: audit and budgets

- classify all control/render paths by latency budget
- list every tmux binding and helper path
- identify which paths are:
  - pure tmux
  - fast-control RPC
  - full CLI/admin only

### Phase B: add fast-control module + endpoints

Implement:

- `switch-next`
- `switch-prev`
- `switch-attention`
- `switchable-agents`
- `open-dashboard`

### Phase C: migrate tmux hotkeys

Convert:

- `n`
- `p`
- `u`
- `s`
- `d` fallback path

away from heavyweight CLI switch logic.

### Phase D: thin render helpers

Audit and harden:

- statusline entrypoint
- dashboard refresh paths
- other render-oriented helpers

so they stay within their latency budgets.

### Phase E: split entrypoint responsibilities

Formalize:

- full operator CLI
- thin fast-control client path
- thin render path
- long-lived project-service control plane

### Phase F: unify GUI/TUI control semantics

Move desktop and dashboard quick-control semantics onto the same fast-control model.

## Recommendation

Proceed with this broader latency architecture migration.

The immediate hotkey bugs are symptoms of a deeper issue:

- latency-sensitive paths are using a full application-shaped CLI entrypoint

Fixing only `n/p/s/u` would help, but it would leave the same structural problem in place for:

- statusline helpers
- dashboard control paths
- future GUI quick actions
- future orchestration shortcuts

The right move is:

- keep `aimux` as the human/operator CLI
- make project services the low-latency dynamic control plane
- keep pure tmux for final runtime/UI switching
- use the same fast-control model for tmux, dashboard, and desktop
