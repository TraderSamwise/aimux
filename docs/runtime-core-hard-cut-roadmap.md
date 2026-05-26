# Runtime Core Hard-Cut Roadmap

This document tracks the long-haul effort to move aimux to one authoritative runtime model. The goal is not a projection layer. The goal is to remove parallel lifecycle, communication, and coordination authority paths so the daemon, project service, CLI, GUI, tmux bindings, and remote clients all operate on the same state model.

## Target End State

- Runtime topology owns agents, services, worktrees, bindings, teams, lifecycle, graveyard, and remote ownership/presence. Relay security/share stores remain relay-owned transport/security policy authority unless they are explicitly mirrored from topology.
- Runtime exchange owns messages, handoffs, tasks, reviews, plans or plan references, attachments or attachment references, waits, continuity context, and inbox/routing semantics.
- Project service, GUI, CLI, and tmux controls are clients over those authoritative models.
- Metadata, notifications, statusline, and debug views are projections derived from topology and exchange state.
- Remote access uses the same authoritative state and does not introduce a separate lifecycle or presence authority.
- Legacy files may exist only as migrated inputs, exports, caches, or projections. They must not compete as sources of truth.

## Current Cut Line

Already moved or partially moved:

- Agent lifecycle and graveyard storage are partially topology-backed through runtime topology session status; public resurrection paths still require the runtime-core replacement.
- Live tmux bindings are represented in topology bindings.
- Backend session ids for exact resume live in topology session records.
- Team metadata is carried on topology-backed session records.
- Runtime topology YAML is validated, atomically written, and serialized across writers.
- Project-service and dashboard lifecycle surfaces are increasingly reading topology-backed session records.

Still not fully cut:

- Direct messages, handoffs, tasks, reviews, and waits still use the existing threads/tasks files as authoritative storage.
- Notifications and metadata remain their own state/projection files.
- Service lifecycle is not fully topology-owned.
- Worktree lifecycle and worktree graveyard are not fully topology-owned.
- Remote takeover/presence semantics still need a topology-backed replacement.
- Migration/debug tooling is not complete enough to make the hard cut operationally safe.

## Execution Epics

### 1. Authority Map And Dead-Path Inventory

Build a complete source-of-truth matrix for every domain:

- agents
- tmux windows and panes
- services
- worktrees
- agent graveyard
- worktree graveyard
- threads
- plans
- tasks
- reviews
- handoffs
- notifications
- metadata
- statusline
- remote clients and ownership
- fast-control and tmux prefix navigation
- GUI, CLI, daemon, and project-service endpoints

Output:

- authoritative source per domain
- current readers
- current writers
- legacy or duplicate paths to remove
- projection/cache paths to keep
- tests required before removal

Tracking document: [runtime-authority-inventory.md](runtime-authority-inventory.md).

### 2. Topology Schema Completion

Extend runtime topology to cover all runtime-owned domains:

- services
- worktrees
- worktree graveyard
- agent graveyard detail
- team and role edges
- remote client ownership and presence
- lifecycle operation state
- queue or exchange references
- schema versioning and migrations

This phase should decide what belongs in topology versus what belongs in a separate runtime exchange file. Avoid making one YAML file a dumping ground if a separate authoritative exchange model is cleaner.

### 3. Agent Lifecycle Hard Cut

Finish the agent lifecycle cut:

- spawn
- stop
- resume
- restore
- interrupt
- kill
- graveyard
- resurrect
- fork
- migrate
- teammate create/resume/stop/kill/resurrect

Requirements:

- no stale session arrays as authority
- no metadata-owned backend session ids
- tmux metadata is binding/projection only
- stale/crashed windows reconcile into topology
- duplicate resume remains impossible by construction

### 4. Service And Worktree Hard Cut

Move service and worktree lifecycle into the authoritative runtime model:

- service create/stop/resume/remove
- service status and ports
- worktree create/remove/graveyard/delete
- worktree ordering and grouping
- worktree operation failures

Requirements:

- GUI rows read the same source as CLI and tmux dashboard.
- Worktree graveyard is no longer a separate authority.
- Service state is not owned by dashboard-local arrays.

### 5. Communication And Exchange Hard Cut

Move coordination authority into a topology-backed or sibling runtime exchange model:

- direct messages
- handoffs
- plans and plan ownership
- task assignment
- review tasks
- history/context continuity
- status-file handoff semantics
- attachment payload references
- waiting/busy states
- inbox/routing semantics
- task/thread links
- delivery state

The existing `.aimux/threads` and `.aimux/tasks` files may become migrated legacy artifacts, projection/export files, or compatibility inputs. They should not remain parallel authoritative stores.

### 6. Metadata, Notifications, And Statusline As Projections

Demote metadata and notifications to projections:

- statusline reads topology/exchange projections
- notifications derive from exchange/activity/lifecycle transitions
- metadata API writes are either projection-only or routed into authoritative domain actions
- hidden lifecycle and backend identity fields are permanently absent from metadata
- debug-state clearly labels authority versus projection

### 7. GUI, Project-Service, And CLI Consistency Sweep

Audit and align every external surface:

- daemon `/projects`
- project-service `/state`
- project-service `/events`
- `/agents/*`
- `/services/*`
- `/worktrees/*`
- `/threads/*`
- `/plans/*`
- `/tasks/*`
- `/workflow/*`
- CLI commands
- Expo app stores and actions
- tmux dashboard and prefix controls

Every user-visible action should hit the same authoritative write path.

### 8. Remote And Multi-Client Semantics

Rebuild remote and multi-client behavior on the same authority model:

- client identity
- client presence
- live/stale ownership
- attach/takeover rules
- remote security events
- concurrent GUI/CLI/tmux operations
- emergency lockdown behavior

Do not restore `instances.json`-style lifecycle shadow authority. If a presence cache remains, it must be explicitly non-authoritative.

### 9. Migration And Compatibility

Provide a safe migration path:

- import current runtime state files
- import or project existing threads/tasks/plans/history/context/recordings/status/attachments
- preserve graveyard entries
- detect corrupt or partial state
- write rollback/debug tooling
- document authoritative files versus projection files
- support dev-lane testing without touching the user's active aimux runtime

### 10. Reliability Harness And Final Dead-Path Audit

Build tests and stress checks around the failure modes this project is meant to remove:

- concurrent topology/exchange writes
- interrupted writes
- daemon restart
- project-service restart
- stale tmux windows
- duplicate resume attempts
- GUI action retries
- remote concurrent actions
- corrupt YAML/JSON
- SSE/event consistency
- projection rebuilds
- final `rg` audit for removed authority paths

## Recommended Order

Start with authority map and dead-path inventory because later cuts need a complete list of competing writers. Follow with topology and exchange schema completion so lifecycle, service, worktree, and communication phases have a stable target instead of creating another temporary authority.

Agent lifecycle should precede service/worktree cleanup because session identity, graveyard behavior, and tmux binding recovery are the most visible recovery paths. Communication and exchange can run after the lifecycle model is stable, with metadata/notification/statusline cleanup following as projection work rather than parallel authority.

GUI, project-service, CLI, remote, and migration phases should happen after the core model is authoritative enough to serve clients consistently. Reliability harness work can run in parallel once a phase has a concrete target, but the final dead-path audit must close the loop after all client and migration compatibility paths are cut.

## Risk Notes

- Communication/tasks/reviews are product-semantics-heavy. Do not migrate them mechanically without deciding wait, inbox, delivery, and ownership behavior.
- Remote is security- and concurrency-sensitive. Treat it as a full design phase, not a small compatibility patch.
- Metadata is useful, but dangerous as a shadow source of truth. Every metadata write path must be audited.
- Worktree and service state can look like "just UI", but both affect user-visible lifecycle and should be authoritative before GUI cleanup.
- The final state should make stale process state recoverable, not invisible.
