# Latency Entry Points

This complements [latency-architecture-rfc.md](./latency-architecture-rfc.md) with the
current entrypoint split.

## Latency Classes

### Instant control

Target:

- sub-`50ms` perceived control latency

Current entrypoints:

- `dist/tmux-fast-control.js`
- `dist/tmux-switch-cli.js` fallback only

Used for:

- tmux prefix `n`
- tmux prefix `p`
- tmux prefix `s`
- tmux prefix `u`
- tmux prefix `d`

Rules:

- never go through the full operator CLI on the normal path
- talk to the live project service first
- do only minimal local resolution on fallback

### Lightweight render

Target:

- sub-`100ms` render helper latency

Current entrypoints:

- `dist/tmux-statusline-cli.js`

Used for:

- tmux top statusline render
- tmux bottom statusline render

Rules:

- read cached `statusline.json`
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
- not suitable for tmux hotkeys or render helpers

## Compatibility Commands

The full CLI still exposes legacy compatibility commands like:

- `aimux tmux-switch`
- `aimux tmux-statusline`

These are no longer on the hot runtime path. They remain as compatibility/admin fallbacks
while the thin entrypoints take over real tmux/runtime usage.
