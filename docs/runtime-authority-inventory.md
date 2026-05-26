# Runtime Authority Inventory

This inventory is the working map for the runtime-core hard cut. Its job is to identify, for each domain, what currently writes state, what currently reads state, what should become authoritative, and which legacy paths must be removed or demoted to projections.

Use this file together with [runtime-core-hard-cut-roadmap.md](runtime-core-hard-cut-roadmap.md). The roadmap describes the long-haul execution order; this inventory tracks the concrete authority map that makes those phases auditable.

## Status Labels

- `CUT`: the domain already has the intended source of truth.
- `PARTIAL`: some write/read paths use the intended source, but parallel authority remains.
- `LEGACY`: the domain still uses old authority and needs a hard cut.
- `PROJECTION`: the domain should not be authoritative; it should be rebuilt from another source.
- `UNKNOWN`: the domain still needs source inspection before planning a cut.

## Authority Types

- `runtime topology`: `runtime-topology.yaml` through `src/runtime-core/*`.
- `runtime exchange`: future authoritative exchange model for messages, handoffs, tasks, reviews, waits, and inbox state. This may be part of topology or a sibling runtime file, but must not duplicate `.aimux/threads` / `.aimux/tasks` authority.
- `project service memory`: daemon-supervised project service state that should be treated as a runtime cache unless explicitly persisted through an authoritative model.
- `tmux`: live terminal substrate and binding evidence, not durable coordination truth.
- `projection`: derived state such as metadata, statusline, notifications, debug views, and GUI caches.
- `legacy file`: current JSON/thread/task files that may need migration, export-only status, or removal.

## Domain Matrix

| Domain | Status | Current Authority | Target Authority | Current Readers | Current Writers | Keep As Projection/Cache | Remove Or Demote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent lifecycle | UNKNOWN | TBD | runtime topology | TBD | TBD | TBD | TBD |
| Agent tmux bindings | UNKNOWN | TBD | runtime topology binding records plus tmux evidence | TBD | TBD | TBD | TBD |
| Agent graveyard | UNKNOWN | TBD | runtime topology session status | TBD | TBD | TBD | TBD |
| Team relationships | UNKNOWN | TBD | runtime topology nodes/edges or session team metadata | TBD | TBD | TBD | TBD |
| Services | UNKNOWN | TBD | runtime topology service records | TBD | TBD | TBD | TBD |
| Worktrees | UNKNOWN | TBD | runtime topology worktree records | TBD | TBD | TBD | TBD |
| Worktree graveyard | UNKNOWN | TBD | runtime topology worktree graveyard records | TBD | TBD | TBD | TBD |
| Direct messages | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Handoffs | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Tasks | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Reviews | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Waiting/inbox state | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Metadata | UNKNOWN | TBD | projection | TBD | TBD | TBD | TBD |
| Notifications | UNKNOWN | TBD | projection over exchange/activity/lifecycle | TBD | TBD | TBD | TBD |
| Statusline | UNKNOWN | TBD | projection over topology/exchange/metadata | TBD | TBD | TBD | TBD |
| Fast-control / tmux prefix navigation | UNKNOWN | TBD | tmux-local bindings plus project-service fallback | TBD | TBD | TBD | TBD |
| GUI project snapshot | UNKNOWN | TBD | projection over project-service authoritative reads | TBD | TBD | TBD | TBD |
| CLI commands | UNKNOWN | TBD | clients over authoritative APIs/models | TBD | TBD | TBD | TBD |
| Project service HTTP/SSE | UNKNOWN | TBD | API layer over topology/exchange/projections | TBD | TBD | TBD | TBD |
| Daemon project registry | UNKNOWN | TBD | daemon registry | TBD | TBD | TBD | TBD |
| Remote clients and ownership | UNKNOWN | TBD | runtime topology ownership/presence | TBD | TBD | TBD | TBD |
| Debug state | UNKNOWN | TBD | projection/audit view | TBD | TBD | TBD | TBD |
| Migration/compatibility state | UNKNOWN | TBD | one-way import/export tooling | TBD | TBD | TBD | TBD |

## Audit Columns

Each domain row should eventually answer:

- `Current Authority`: the file, in-memory object, tmux metadata, API surface, or external service that currently decides truth.
- `Target Authority`: the single intended source after the hard cut.
- `Current Readers`: code paths that read the domain, including GUI and CLI.
- `Current Writers`: code paths that mutate the domain.
- `Keep As Projection/Cache`: files or state that can remain if clearly non-authoritative.
- `Remove Or Demote`: code paths, files, endpoints, or docs that must not remain parallel truth.

## Dead-Path Checklist

The concrete checklist lives in [runtime-authority-dead-paths.md](runtime-authority-dead-paths.md). This matrix should reference that checklist rather than carrying every `rg` pattern inline.
