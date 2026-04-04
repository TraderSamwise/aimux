# Latency Migration Checklist

Based on [latency-architecture-rfc.md](./latency-architecture-rfc.md).

## Completed

- [x] Document latency architecture and control/render path split
- [x] Add project-service fast-control model for worktree-scoped agent switching
- [x] Expose fast-control project-service endpoints for:
  - [x] switch next
  - [x] switch prev
  - [x] switch attention
  - [x] open dashboard
  - [x] list switchable agents
- [x] Add thin `tmux-fast-control` entrypoint
- [x] Rewire tmux prefix bindings `n/p/s/u/d` to the fast-control command path
- [x] Add thin `tmux-statusline-cli` entrypoint
- [x] Stop using the monolithic `main.js` entrypoint for tmux statusline renders
- [x] Remove `main.js tmux-switch` compatibility routing from tmux hotkeys
- [x] Remove `main.js tmux-statusline` compatibility command path
- [x] Remove tmux session option indirection for fast-control and statusline commands
- [x] Remove secondary fast-control fallback path

## Current Diagnosis

The remaining noticeable lag is no longer the old heavyweight CLI path.

It is now dominated by two still-expensive execution patterns:

1. tmux hotkeys still spawn a fresh Node process for every `n/p/s/u/d` action
2. tmux statusline still spawns a fresh Node process for every footer redraw

That means we still pay for:

- process spawn
- Node startup
- module loading
- live tmux querying
- per-refresh state reconstruction

The current thin entrypoints are better than the old CLI, but they are not the final architecture.

## Hard-Cut Goal

Replace both of these patterns:

- `tmux -> run-shell -> tmux-fast-control.js -> compute -> switch`
- `tmux -> status command -> tmux-statusline-cli -> compute -> render`

with:

- `tmux -> tiny dispatch -> project-service in-memory control model -> switch`
- `tmux -> precomputed top/bottom statusline strings`

This is the same architectural direction the GUI already benefits from:

- long-lived control/state
- thin action dispatch
- no process-per-interaction recomputation

## Phase 1: Shared In-Memory Fast-Control State

- [ ] Add a project-service-owned in-memory `fastControlState`
- [ ] Materialize one shared ordered worktree-scoped item list:
  - [ ] agents first
  - [ ] services after
  - [ ] stable `tmuxWindowIndex` order
- [ ] Materialize first-class MRU data from `last-used.json`
- [ ] Track active dashboard screen in the same state model
- [ ] Track currently focused target per client session
- [ ] Update this model on:
  - [ ] tmux switch actions
  - [ ] dashboard screen changes
  - [ ] last-used writes
  - [ ] session/service lifecycle changes

## Phase 2: Service-Owned Fast-Control Resolution

- [ ] Rework project-service `/control/*` endpoints so they answer only from in-memory `fastControlState`
- [ ] Remove endpoint handlers that re-scan tmux/disk for ordinary switch requests
- [ ] Ensure the same ordering/MRU logic is reused by:
  - [ ] tmux hotkeys
  - [ ] dashboard switch affordances
  - [ ] desktop quick-switch / focus menus

## Phase 3: Hard-Cut tmux Hotkeys Off Spawned Node Control Logic

- [ ] Replace `tmux-fast-control.js` as the hotkey execution model
- [ ] Use a tiny dispatch transport only:
  - [ ] either minimal RPC client
  - [ ] or another zero-bootstrap transport into project service
- [ ] Keep final tmux target switching local and cheap
- [ ] Delete service-timeout fallback behavior from the hot path
- [ ] Delete local tmux recomputation from the hot path
- [ ] Delete `tmux-fast-control.js` once the new dispatch path is live

## Phase 4: Precomputed Statusline Strings

- [ ] Have project service materialize final tmux-ready strings:
  - [ ] `statuslineTop`
  - [ ] `statuslineBottomByWindowKind`
  - [ ] or equivalent per-client/per-window projections
- [ ] Include current dashboard screen in that projection
- [ ] Include current scoped agent/service chips in that projection
- [ ] Trigger recomputation on:
  - [ ] screen changes
  - [ ] session/service lifecycle changes
  - [ ] attention/unread changes
  - [ ] switch / focus changes
- [ ] Change tmux statusline to read precomputed strings only
- [ ] Delete `tmux-statusline-cli`
- [ ] Delete live tmux/metadata reconstruction from statusline render path

## Phase 5: GUI / Desktop Alignment

- [ ] Make desktop consume the same shared fast-control ordering model directly
- [ ] Make desktop quick switch use the same MRU order as `Ctrl+A s`
- [ ] Stop any remaining desktop-side reconstruction of tmux navigation state
- [ ] Keep dashboard, footer, switcher, and GUI list ordering identical by construction

## Phase 6: Delete Transitional Logic

- [ ] Remove dual local/service resolution branches that only existed for the spawn-based transition
- [ ] Remove old statusline fallbacks that reconstruct from partial local snapshots
- [ ] Remove obsolete fast-control debug/fallback paths
- [ ] Update architecture docs to describe the new zero-spawn tmux path as current

## Success Criteria

- [ ] `Ctrl+A n/p/s/u/d` feel effectively immediate
- [ ] footer updates with the window switch, not half a beat later
- [ ] dashboard/footer/GUI ordering is identical
- [ ] no spawned Node process is required for ordinary tmux hotkey actions
- [ ] no spawned Node process is required for ordinary tmux footer rendering

## Remaining Validation / Follow-up

- [ ] Measure real-world hotkey latency after removing process-per-hotkey control
- [ ] Measure real-world footer/statusline latency after precomputed strings land
- [ ] Reduce synchronous reconstruction in dashboard focus/refresh paths
- [ ] Verify daemon restart can eagerly rehydrate previous live project services
- [ ] Verify dashboard remains usable when project service restarts underneath a live agent session

- [ ] Validate real-world hotkey latency after the direct cutover
- [ ] Validate real-world statusline smoothness after direct cutover
- [ ] Reduce synchronous reconstruction in dashboard focus/refresh paths
- [ ] Reuse fast-control endpoints for desktop session cycling and attention jumps
- [ ] Reuse project-service switchable-agent lists in GUI controls
- [ ] Ensure desktop does not reconstruct tmux navigation state independently
