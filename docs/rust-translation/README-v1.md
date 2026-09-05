# Rust Translation v1

## Objective

Rewrite Aimux into Rust with full feature parity before architecture changes.
The normal installed CLI, daemon, project-service, tmux runtime, and dashboard
hot path must end with zero Node processes.

## Porting Rule

TypeScript behavior is the spec. The first Rust implementation copies file
boundaries, function names where practical, control flow, loops, data shapes,
edge cases, and awkward decisions. Improvements wait until parity is proven.

## Tracked Files

- `phases-v1.md`: phase order and acceptance gates.
- `contracts-v1.md`: external contracts Rust must preserve.
- `parity-matrix-v1.md`: behavior-surface checklist.
- `phase-log-v1.md`: compact phase evidence log.
- `decisions-v1.md`: intentional behavior differences from TypeScript.

The machine-readable contract map lives at
`native/contracts/feature-parity-v1.json`. Cross-language fixtures live under
`testdata/contracts/v1/`.
