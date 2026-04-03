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

## Remaining Validation / Follow-up

- [ ] Validate real-world hotkey latency after the direct cutover
- [ ] Validate real-world statusline smoothness after direct cutover
- [ ] Reduce synchronous reconstruction in dashboard focus/refresh paths
- [ ] Reuse fast-control endpoints for desktop session cycling and attention jumps
- [ ] Reuse project-service switchable-agent lists in GUI controls
- [ ] Ensure desktop does not reconstruct tmux navigation state independently
