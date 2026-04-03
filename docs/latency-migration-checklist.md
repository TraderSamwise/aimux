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

## In Progress

- [ ] Validate real-world hotkey latency after the fast-control migration
- [ ] Validate real-world statusline smoothness after thin entrypoint split
- [ ] Reduce or eliminate fast-control fallback frequency

## Next

### Fast control

- [ ] Move dashboard keyboard-side quick navigation to the same fast-control module where applicable
- [x] Add lightweight telemetry/timing for fast-control fallback rate
- [x] Log when fast control falls back to the heavyweight CLI path

### Statusline / render helpers

- [x] Audit remaining statusline helper imports for avoidable weight
- [x] Confirm no render helpers trigger daemon/project-service verification
- [x] Confirm render helpers never shell out for git/tmux reconstruction on the hot path

### Dashboard/UI

- [ ] Identify dashboard refresh/model work that can move behind project-service-owned cached state
- [ ] Reduce synchronous reconstruction in dashboard focus/refresh paths
- [x] Ensure dashboard uses shared fast-control semantics for agent ordering and attention routing

### CLI / entrypoints

- [x] Classify all internal commands by latency budget
- [x] Split any remaining hot/internal helpers away from the full operator CLI
- [x] Keep `aimux` as the human/admin entrypoint for normal runtime paths

### GUI/Desktop

- [ ] Reuse fast-control endpoints for desktop session cycling and attention jumps
- [ ] Reuse project-service switchable-agent lists in GUI controls
- [ ] Ensure desktop does not reconstruct tmux navigation state independently
