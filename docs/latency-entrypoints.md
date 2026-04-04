# Latency Entry Points

This complements [latency-architecture-rfc.md](./latency-architecture-rfc.md) with the
current execution split after the tmux hotkey and statusline cutover.

## Latency Classes

### Instant control

Target:

- sub-`50ms` perceived control latency when local tmux state is healthy

Current entrypoints:

- `scripts/tmux-control.sh`

Used for:

- tmux prefix `n`
- tmux prefix `p`
- tmux prefix `s`
- tmux prefix `u`
- tmux prefix `d`
- desktop terminal focus/open actions

Rules:

- never go through the full operator CLI on the normal path
- prefer local tmux resolution first
- fall back to project-service control helpers only when local recovery is insufficient

### Lightweight render

Target:

- sub-`100ms` footer/status redraw latency

Current entrypoints:

- `scripts/tmux-statusline.sh`

Used for:

- tmux top statusline render
- tmux bottom statusline render

Rules:

- read precomputed tmux-ready strings from project state
- do not verify daemon or project-service liveness
- do not reconstruct tmux/git state on the hot path

### Interactive UI

Target:

- sub-`200ms` normal interactions

Current entrypoints:

- dashboard process (`dist/main.js --tmux-dashboard-internal`)

Used for:

- dashboard rendering
- thread/workflow/activity screens
- orchestration overlays

Rules:

- use cached/local model state where possible
- avoid full reconstruction during focus/refresh

### Operator / admin CLI

Target:

- no tight latency budget

Current entrypoints:

- `dist/main.js`
- `aimux ...`

Used for:

- user-invoked commands
- daemon/project-service admin
- reload/restart flows
- maintenance/debugging

Rules:

- full bootstrap is acceptable
- not suitable for tmux hotkeys or tmux statusline rendering

There are no legacy tmux compatibility commands on the hot path anymore.
