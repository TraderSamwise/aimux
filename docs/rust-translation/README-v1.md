# Rust Translation v1

## Objective

This directory is the historical record of the Rust rewrite. Phase 8 is
complete: the normal installed CLI, daemon, project-service, tmux runtime, and
dashboard hot path are Rust-owned and must start zero Node processes.

JavaScript may remain for the Expo/mobile/web GUI and for build-time tooling
needed to produce GUI assets. It may not remain in the installed runtime path
for CLI, daemon, project-service, tmux control, terminal dashboard, doctor, or
release install shims.

## Porting Rule

During the port, TypeScript behavior was the spec. Now that the port is done,
Node source remains recoverable at `a9220736^` for intentional compatibility
questions, but Node-only churn is not an automatic backlog.

Trivially proven dead code should be deleted instead of translated. The commit
must carry the proof: no exported contract, no reachable reference from active
entrypoints, and the search/test evidence used to make the call.

Current verification uses two lanes: `yarn verify` is the fast developer lane,
and `yarn verify:full` is the release and CI lane. The Phase 8 live residuals
are a blocking CI job because they drive the real native binary against a
private tmux server.

## Tracked Files

- `phases-v1.md`: phase order and acceptance gates.
- `contracts-v1.md`: external contracts Rust must preserve.
- `parity-matrix-v1.md`: behavior-surface checklist.
- `phase-log-v1.md`: compact phase evidence log.
- `decisions-v1.md`: intentional behavior differences from TypeScript.
- `release-zero-node-v1.md`: installed runtime release gate.

The machine-readable contract map lives at
`native/contracts/feature-parity-v1.json`. Cross-language fixtures live under
`testdata/contracts/v1/`.
