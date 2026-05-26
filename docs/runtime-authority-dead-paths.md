# Runtime Authority Dead-Path Checklist

This checklist is the audit handle for the runtime-core hard cut. Each item names the old path to find, what must happen to it, and the condition under which it can remain.

Use this file with [runtime-authority-inventory.md](runtime-authority-inventory.md). The inventory maps authority by domain; this checklist maps concrete search patterns.

## Audit Rule

Every future implementation phase should run the relevant `rg` commands before planning, after implementation, and before commit. A match is acceptable only when the code is a projection/cache, a one-way importer/exporter, a test asserting the cut, or an intentionally blocked compatibility route.

## Agent Lifecycle

Audit commands:

```bash
rg -n "offlineSessions|graveyardEntries|saveState\\(|loadState\\(|state\\.sessions|sessionsToResume|restoreSessions|resumeSessions" src
rg -n "upsertTopologySession|saveRuntimeTopologySessions|moveTopologySessionToGraveyard|resurrectTopologySession|listTopologySessionStates" src
```

- Remove or demote `offlineSessions` as lifecycle authority. It may remain only as a rebuilt in-memory/UI cache sourced from topology.
- Remove `graveyardEntries` as a competing agent graveyard path. Graveyard truth must be topology status.
- Remove lifecycle writes hidden behind generic `saveState()`. Session lifecycle mutations must call topology/exchange store APIs directly.
- Keep tmux metadata only as live substrate evidence and repair input, not durable lifecycle truth.

## Tmux Bindings And Fast Control

Audit commands:

```bash
rg -n "sessionTmuxTargets|setWindowMetadata|getWindowMetadata|listManagedWindows|listProjectManagedWindows|tmux-control|switchable-agents|switch-next|switch-prev|switch-attention" src scripts
rg -n "statusline\\.json|last-used|markLastUsed|getRecentRankMap" src scripts
```

- Keep `sessionTmuxTargets` only as a process-local handle cache.
- Keep `scripts/tmux-control.sh` as the latency-sensitive local navigation path.
- Remove durable binding recovery that depends only on tmux window names or metadata once topology has binding records.
- Keep last-used/statusline data as navigation ranking projection only.

## Services

Audit commands:

```bash
rg -n "offlineServices|ServiceState|state\\.services|getStatePath\\(|persistProjectRuntimeSnapshotsBeforeTmuxStop|persistProjectServiceSnapshotsBeforeRuntimeStop|removeOfflineService|resumeOfflineService|stopService|createService" src
rg -n "metadata\\.kind === \"service\"|kind: \"service\"|launchCommandLine" src
```

- Replace `.aimux/state.json` service authority with topology service records.
- Remove direct JSON service edits in `removeOfflineService` and snapshot writers.
- Keep `offlineServices` only as a rebuilt UI cache.
- Keep tmux service metadata only as live substrate evidence.

## Worktrees

Audit commands:

```bash
rg -n "listWorktrees|createDesktopWorktree|removeDesktopWorktree|pendingWorktree|dashboardPendingActions|operationFailure|worktree-graveyard|WorktreeGraveyard" src app
rg -n "git worktree|worktree add|worktree remove|worktree repair" src scripts
```

- Replace durable worktree status and worktree graveyard authority with topology worktree records.
- Keep git worktrees as substrate evidence and execution mechanism.
- Keep dashboard pending actions as transient optimistic UI only.
- Remove `.aimux/worktree-graveyard.json` authority after topology graveyard records exist.

## Exchange: Threads, Messages, Handoffs

Audit commands:

```bash
rg -n "getThreadsDir|createThread|readThread|updateThread|listThreads|appendMessage|readMessages|updateMessage|markThreadSeen|setThreadStatus|sendDirectMessage|sendThreadMessage|sendHandoff|acceptHandoff|completeHandoff" src app
rg -n "\"/threads|\"/handoff|threadId|waitingOn|unreadBy|deliveredTo|deliveredAt" src app
```

- Replace `.aimux/threads/*.json` and `.jsonl` authority with runtime exchange records.
- Keep thread/message API DTOs and GUI summaries as projections.
- Move delivery state into exchange; do not leave `deliveredTo`/`deliveredAt` only in JSONL message records.
- Model handoff lifecycle as first-class exchange state, not just thread kind/status/message metadata conventions.

## Exchange: Tasks And Reviews

Audit commands:

```bash
rg -n "getTasksDir|readTask|readAllTasks|writeTask|hasActiveTask|cleanupTasks|assignTask|acceptTask|blockTask|completeTask|reopenTask|requestReview|approveReview|requestTaskChanges|TaskWorkflow|listPendingReviews|listTasksForRole" src app
rg -n "\"/tasks|\"/reviews|reviewStatus|reviewFeedback|reviewOf|assignee|assigner" src app
```

- Replace `.aimux/tasks/*.json` authority with runtime exchange records.
- Keep task/review cards and workflow lists as projections.
- Remove task side effects from metadata watchers once exchange emits activity directly.
- Attach role and assignee resolution to topology identity, not detached task JSON fields.
- Model review lifecycle as first-class exchange state, not only task subtype/status.

## Waiting, Inbox, Attention

Audit commands:

```bash
rg -n "waitingOn|unreadBy|threadUnreadCount|threadPendingCount|threadWaitingOnMeCount|threadWaitingOnThemCount|hasActiveTask|deriveSessionSemantics|attention|unseenCount|workflowOnMeCount" src app
rg -n "unreadNotificationCount|summarizeUnreadNotificationsBySession|markNotificationsRead|clearNotifications" src app
```

- Replace scattered wait/inbox truth with exchange-derived inbox state.
- Keep session semantics, notification badges, and statusline attention as projections.
- Do not let notification read/clear state be the only source for agent waits or task state.

## Projections

Audit commands:

```bash
rg -n "metadata\\.json|loadMetadataState|saveMetadataState|updateSessionMetadata|clearSessionLogs|clearSessionTranscriptPath|metadata-api" src app
rg -n "notifications\\.json|addNotification|upsertNotification|listNotifications|statusline\\.json|buildStatuslineSnapshot|writeStatuslineFile|desktop-state|buildDesktopState|refreshDesktopStateSnapshot" src app scripts
```

- Keep metadata, notifications, statusline, desktop snapshots, and GUI stores as derived views.
- Remove any projection write path that changes lifecycle, worktree, ownership, or exchange truth.
- Endpoint discovery files such as `metadata-api.json` may remain daemon/project-service plumbing.

## GUI, CLI, And API Surfaces

Audit commands:

```bash
rg -n "postProjectServiceJson|postLiveProjectServiceJsonOrLocal|callProjectJson|callDaemonViaRelay|/desktop|/worktrees|/graveyard|/workflow|/notifications|/control/" src app
rg -n "readAllTasks|readTask|listThreadSummaries|readMessages|listTopologySessionStates|moveTopologySessionToGraveyard|resurrectTopologySession" src/main.ts src/metadata-server.ts app/lib
```

- GUI and CLI should become clients over topology/exchange/projection APIs.
- Remove local CLI mutations of legacy files after authoritative APIs exist.
- Keep HTTP/SSE DTOs and app stores as transport/UI state only.
- Keep blocked compatibility routes only when they fail closed with clear replacement errors.

## Daemon, Remote, And Presence

Audit commands:

```bash
rg -n "daemon-state|/projects|ensureProject|stopProject|loadMetadataEndpoint|saveMetadataEndpoint|relay|shareId|ownerUserId|instances\\.json|registerInstance|updateHeartbeat|getRemoteInstances|localInstancesPath" src app relay
```

- Keep daemon project registry as daemon-private project supervision state.
- Do not let daemon registry carry per-agent lifecycle or exchange truth.
- Replace `instances.json` ownership/presence semantics with topology presence or remove them.
- Keep relay/share state as transport/security state unless explicitly mirrored from topology ownership.

## Debug And Migration

Audit commands:

```bash
rg -n "debug-state|runtimeTopology|metadata|notifications|graveyard|worktreeGraveyard|instancesPath|localInstancesPath|backward compat|compatibility|legacy|migration" src docs
```

- Keep debug state read-only and recomputable.
- Keep compatibility code only as a named importer/exporter or fail-closed route.
- Remove silent dual writes after the importer exists.
- Add tests that assert removed paths fail closed or no longer write.

## Completion Gate

A hard-cut phase is not complete until:

- the relevant audit commands have no authority-bearing matches outside the new topology/exchange/projection stores;
- remaining matches are named as projection/cache/importer/exporter/test/fail-closed compatibility;
- source verification passes;
- runtime verification is run when `src/*.ts` behavior changes, including `yarn build` before manual runtime testing.
