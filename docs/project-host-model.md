# Project Host Model

## Status

Historical

This document described the superseded per-project host-election model.

That model has been removed from the codebase.

Current source of truth:

- [docs/current-architecture.md](./current-architecture.md)

Migration rationale:

- [docs/global-control-plane-rfc.md](./global-control-plane-rfc.md)

## What Changed

The old model used:

- one elected per-project host
- `host.json`
- host heartbeats and takeover logic
- dashboard-backed and headless host competition

That model was replaced by:

- one global aimux daemon
- daemon-managed project services
- dashboard/desktop clients that do not own shared control-plane authority

If you are reading older notes, PRs, or comments that mention:

- "project host"
- "host stealing"
- `aimux host status` as a lease inspector
- `aimux serve` as a host-election path

treat them as historical only.
