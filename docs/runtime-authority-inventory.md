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
| Agent lifecycle | PARTIAL | `runtime-topology.yaml` for offline/graveyard state, live tmux metadata for running windows, `offlineSessions` as an in-memory cache | runtime topology | `src/runtime-core/topology-sessions.ts`, `src/multiplexer/runtime-state.ts`, `src/multiplexer/session-launch.ts`, `src/multiplexer/session-runtime-core.ts`, `src/main.ts`, `src/project-scanner.ts` | `upsertTopologySession`, `saveRuntimeTopologySessions`, `moveTopologySessionToGraveyard`, `resurrectTopologySession`, plus cache writes to `offlineSessions` | `offlineSessions` may remain only as a rebuilt runtime/UI cache; tmux remains live substrate evidence | `offlineSessions` as authority, lifecycle writes hidden behind `saveState`, tmux metadata as durable lifecycle truth |
| Agent tmux bindings | PARTIAL | tmux window metadata plus `sessionTmuxTargets`; topology carries durable session identity but not yet all binding recovery semantics | runtime topology binding records plus tmux evidence | `src/multiplexer/runtime-state.ts`, `src/multiplexer/session-runtime-core.ts`, `src/tmux/runtime-manager.ts`, `scripts/tmux-control.sh`, statusline builders | `createSession`, `restoreTmuxSessionsFromTopology`, `syncTmuxWindowMetadata`, `setWindowMetadata`, `repairManagedTmuxTargets` | `sessionTmuxTargets` as process-local handle cache; tmux metadata as live verification | durable binding decisions inferred only from tmux window metadata or window names |
| Agent graveyard | CUT | topology session status through `moveTopologySessionToGraveyard` and `resurrectTopologySession`; old in-process `graveyardEntries` remains declared but should not decide truth | runtime topology session status | `src/main.ts`, `src/runtime-core/topology-sessions.ts`, `src/multiplexer/runtime-state.ts`, debug/project scan paths | `moveTopologySessionToGraveyard`, `resurrectTopologySession` | dashboard/debug lists may project topology graveyard records | `graveyardEntries` and any non-topology graveyard JSON/state resurrection path |
| Team relationships | PARTIAL | session `team` metadata persisted on topology session records and mirrored in tmux metadata/UI caches | runtime topology nodes/edges or session team metadata | `src/team.ts`, dashboard/statusline composition, runtime topology session readers, tmux metadata repair paths | session creation/fork/restore paths and topology session upserts | dashboard teammate grouping and statusline teammate projection | team membership inferred from UI caches or tmux metadata when topology lacks the record |
| Services | LEGACY | `.aimux/state.json` `services`, live tmux service metadata, and `offlineServices` process cache | runtime topology service records | `src/multiplexer/runtime-state.ts`, `src/multiplexer/services.ts`, `src/multiplexer/service-state-snapshot.ts`, `src/multiplexer/persistence-methods.ts`, metadata-server/CLI service endpoints | `createService`, `stopService`, `resumeOfflineService`, `removeOfflineService`, `persistProjectRuntimeSnapshotsBeforeTmuxStop`, `host.saveState` | `offlineServices` can remain a rebuilt UI cache; tmux metadata can remain live service substrate evidence | `.aimux/state.json` services as authority, direct JSON edits in service removal, service lifecycle hidden behind `saveState` |
| Worktrees | LEGACY | `git worktree list`, dashboard pending-action caches, and operation-failure JSON | runtime topology worktree records | `src/worktree.ts`, `src/multiplexer/worktrees.ts`, `src/multiplexer/persistence-methods.ts`, app/API worktree routes | `createDesktopWorktree`, `removeDesktopWorktree`, dashboard worktree mutation helpers, git commands | git remains substrate evidence; dashboard pending actions remain transient projection | dashboard caches or operation failures acting as durable worktree existence/status truth |
| Worktree graveyard | LEGACY | `.aimux/worktree-graveyard.json`; runtime methods currently throw replacement-required errors for graveyard mutate operations | runtime topology worktree graveyard records | `src/multiplexer/worktree-graveyard.ts`, `src/multiplexer/persistence-methods.ts`, service/session availability filters | existing readers only; mutation methods are intentionally blocked pending runtime-core replacement | graveyard list can be projected from topology for GUI/debug | `worktree-graveyard.json` as authority and any resurrection/delete path that bypasses topology |
| Direct messages | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Handoffs | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Tasks | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Reviews | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Waiting/inbox state | UNKNOWN | TBD | runtime exchange | TBD | TBD | TBD | TBD |
| Metadata | PROJECTION | `.aimux/metadata.json` via `src/metadata-store.ts`; currently also used by dashboard/statusline/API readers | projection | `src/metadata-store.ts`, `src/metadata-server.ts`, `src/multiplexer/persistence-methods.ts`, app API consumers | `updateSessionMetadata`, `saveMetadataState`, clear-log/transcript helpers, metadata API endpoints | display labels, progress, logs, transcript paths, derived activity, endpoint discovery | metadata deciding lifecycle, ownership, worktree existence, exchange state, or backend identity |
| Notifications | PROJECTION | `.aimux/notifications.json` via `src/notifications.ts` | projection over exchange/activity/lifecycle | notification list/count endpoints, dashboard/app notification consumers, status summaries | `addNotification`, `upsertNotification`, `markNotificationsRead`, `clearNotifications`, dashboard failure publishing | unread/cleared notification UX state | notifications as the only durable record of task state, waits, handoffs, lifecycle, or failures that belong in topology/exchange |
| Statusline | PROJECTION | `.aimux/statusline.json` and precomputed tmux statusline text files | projection over topology/exchange/metadata | `src/tmux/statusline.ts`, `scripts/tmux-statusline.sh`, tmux prefix/statusline integrations, dashboard client statusline | `writeStatuslineFile`, `buildStatuslineSnapshot`, `writePrecomputedTmuxStatuslineFiles`, `refreshProjectStatusline` | statusline JSON/text files, tmux-render caches | statusline snapshots as lifecycle/service/task authority |
| Fast-control / tmux prefix navigation | UNKNOWN | TBD | tmux-local bindings plus project-service fallback | TBD | TBD | TBD | TBD |
| GUI project snapshot | UNKNOWN | TBD | projection over project-service authoritative reads | TBD | TBD | TBD | TBD |
| CLI commands | UNKNOWN | TBD | clients over authoritative APIs/models | TBD | TBD | TBD | TBD |
| Project service HTTP/SSE | UNKNOWN | TBD | API layer over topology/exchange/projections | TBD | TBD | TBD | TBD |
| Daemon project registry | UNKNOWN | TBD | daemon registry | TBD | TBD | TBD | TBD |
| Remote clients and ownership | UNKNOWN | TBD | runtime topology ownership/presence | TBD | TBD | TBD | TBD |
| Debug state | PROJECTION | live reads across topology, metadata, tmux, graveyard, worktree graveyard, notifications, dashboard snapshot | projection/audit view | `src/debug-state.ts`, debug CLI/API consumers | debug-state assembly only | complete audit/report surface | debug output or snapshots used as writable recovery state |
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
