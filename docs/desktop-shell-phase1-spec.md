# Desktop Shell Phase 1 Spec

## Status

Historical / superseded

The original Phase 1 desktop spec assumed:

- no global daemon
- project-local host ownership
- desktop discovery primarily through file-backed project state

That is no longer the current architecture.

## Current Desktop Model

Desktop should now be understood as:

- a client of the global aimux daemon
- a terminal host for the real tmux-backed dashboard and agent windows

Desktop should:

- ensure the daemon exists
- ensure the selected project's daemon-managed project service exists
- list projects from daemon-backed discovery
- open/focus tmux-backed dashboards and agent windows

Desktop should not:

- infer control-plane ownership from old project-local lease files
- spawn replacement project hosts directly
- assume the dashboard process is the shared-state authority

## Current References

- [docs/current-architecture.md](./current-architecture.md)
- [docs/global-control-plane-rfc.md](./global-control-plane-rfc.md)
