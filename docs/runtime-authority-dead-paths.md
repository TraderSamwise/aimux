# Runtime Authority Dead-Path Checklist

This checklist is the audit handle for the runtime-core hard cut. Each item names the old path to find, what must happen to it, and the condition under which it can remain.

Use this file with [runtime-authority-inventory.md](runtime-authority-inventory.md). The inventory maps authority by domain; this checklist maps concrete search patterns.

## Audit Rule

Every future implementation phase should run the relevant `rg` commands before planning, after implementation, and before commit. A match is acceptable only when the code is a projection/cache, a one-way importer/exporter, a test asserting the cut, or an intentionally blocked compatibility route.

## Agent Lifecycle

Audit commands:

```bash
rg -n "RuntimeCoreOperation|RuntimeCoreDisabledError|disabledRuntimeCore|agent\\.spawn|agent\\.fork|agent\\.createTeammate|agent\\.rename|agent\\.stop|agent\\.kill|agent\\.migrate|agent\\.interrupt|offlineSessions|graveyardEntries|saveState\\(|loadState\\(|state\\.sessions|sessionsToResume|restoreSessions|resumeSessions|resumeOfflineSession|resumeOfflineSessionWithFeedback|/agents/resume|/agents/teammates/resume|resurrectGraveyardSession|resurrectGraveyardEntry|graveyard/resurrect|teammates/resurrect" src
rg -n "upsertTopologySession|saveRuntimeTopologySessions|moveTopologySessionToGraveyard|resurrectTopologySession|listTopologySessionStates" src
```

- Remove or demote `offlineSessions` as lifecycle authority. It may remain only as a rebuilt in-memory/UI cache sourced from topology.
- Track the fail-closed `RuntimeCoreOperation` surface (`agent.spawn`, `agent.fork`, `agent.createTeammate`, `agent.rename`, `agent.stop`, `agent.kill`, `agent.migrate`, `agent.interrupt`) until each public lifecycle route is wired to the replacement.
- Cut the GUI/project-service resume path (`resumeOfflineSession*`, `/agents/resume`) to topology-owned resume semantics; do not leave it as an `offlineSessions` mutation plus relaunch side path.
- Cut teammate resume routes (`/agents/teammates/resume`) through the same topology-owned lifecycle semantics.
- Remove `graveyardEntries` as a competing agent graveyard path. Graveyard truth must be topology status.
- Wire or remove fail-closed public resurrection paths (`/graveyard/resurrect`, `/agents/teammates/resurrect`, dashboard graveyard resurrection, CLI `graveyard resurrect`) so topology resurrection is not just an unused helper.
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

## Teams And Role Routing

Audit commands:

```bash
rg -n "team\\.json|getProjectTeamPath|getGlobalTeamPath|loadTeamConfig|saveTeamConfig|saveGlobalTeamConfig|reviewedBy|defaultRole|buildRolePreamble|SessionTeamMetadata" src app
```

- Classify project/global `team.json` as role config authority or migrate it into topology/team schema.
- Do not leave review routing, role preambles, or default teammate roles owned by an untracked JSON file.
- Keep session `team` metadata synchronized with topology; tmux/UI copies are projections.

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
rg -n "getThreadsDir|createThread|readThread|updateThread|listThreads|appendMessage|readMessages|updateMessage|markMessageDelivered|markThreadSeen|setThreadStatus|sendDirectMessage|sendThreadMessage|sendHandoff|acceptHandoff|completeHandoff|resolveOrchestrationRecipients|orchestration-routing|buildWorkflowEntries|filterWorkflowEntries|describeWorkflowNextAction" src app
rg -n "\"/threads|\"/handoff|\"/tasks/handoff|threadId|waitingOn|unreadBy|deliveredTo|deliveredAt|exchangeRefs|runtime-exchange" src app
```

- Replace `.aimux/threads/*.json` and `.jsonl` authority with runtime exchange records.
- Keep thread/message API DTOs and GUI summaries as projections.
- Move delivery state into exchange; do not leave `deliveredTo`/`deliveredAt` only in JSONL message records.
- Move recipient routing/scoring into exchange-owned routing semantics; do not leave `src/orchestration-routing.ts` as a hidden authority over assignee/tool/worktree/liveness selection.
- Model handoff lifecycle as first-class exchange state, not just thread kind/status/message metadata conventions.
- Audit both `/handoff*` and `/tasks/handoff`; the dashboard currently posts to `/tasks/handoff`, but no project-service route backs it, so treat it as a dead/client-only path to remove or rewire rather than authoritative handoff persistence.
- Keep topology limited to `exchangeRefs`; do not reintroduce a topology-owned task/handoff/message queue now that `runtime-exchange.yaml` exists.

## Plans

Audit commands:

```bash
rg -n "getPlansDir|/plans|readPlan|writePlan|session-bootstrap|initialize.*plan|plan.*progress|plansAtom|savePlan|loadPlan" src app
```

- Classify `.aimux/plans/*.md` as runtime exchange state or as an explicitly separate durable plan authority.
- Route plan creation/save/update through the chosen authority instead of project-service route handlers writing markdown directly.
- Keep metadata progress derived from plans as projection only.

## Continuity Context, History, Status, Attachments

Audit commands:

```bash
rg -n "getHistoryDir|appendTurn|readHistory|readAllHistories|history\\.jsonl|getContextDir|getContextPathForDate|context/|summary\\.md|live\\.md|getRecordingsDir|Recorder|recordings/|\\.log|\\.txt|getStatusDir|status\\.md|parseStatusHeadline|attachment-store|getAttachmentsDir|/attachments|AttachmentRecord|contentUrl" src app relay
```

- Classify `.aimux/history/*.jsonl`, `.aimux/context/*`, and `.aimux/recordings/*` as exchange-owned continuity state or as an explicitly separate continuity authority.
- Do not inject history/context into restore, fork, or session bootstrap flows without a single authority boundary.
- Treat recordings as continuity backfill/projection only unless they become part of the explicit continuity authority.
- Classify `.aimux/status/*.md` as projection or exchange-owned standing status; do not leave status files as hidden agent coordination state.
- Classify `.aimux/attachments/*.json` and payload files as exchange payload storage or separate blob authority; relay sharing allowlists must follow that authority.

## Exchange: Tasks And Reviews

Audit commands:

```bash
rg -n "getTasksDir|readTask|readAllTasks|writeTask|hasActiveTask|cleanupTasks|assignTask|acceptTask|blockTask|completeTask|reopenTask|requestReview|approveReview|requestTaskChanges|TaskWorkflow|listPendingReviews|listTasksForRole|buildWorkflowEntries|filterWorkflowEntries|describeWorkflowNextAction" src app
rg -n "\"/tasks|\"/reviews|/agents/teammates/tasks|/agents/teammates/create|initialTask|reviewStatus|reviewFeedback|reviewOf|assignee|assigner|exchangeRefs|runtime-exchange" src app
```

- Replace `.aimux/tasks/*.json` authority with runtime exchange records.
- Keep task/review cards and workflow lists as projections.
- Remove task side effects from metadata watchers once exchange emits activity directly.
- Audit `/agents/teammates/tasks` and `/agents/teammates/create` `initialTask` with the task routes; both are public task-authority surfaces over `assignTask`.
- Attach role and assignee resolution to topology identity, not detached task JSON fields.
- Model review lifecycle as first-class exchange state, not only task subtype/status.
- Keep task/review exchange records in `runtime-exchange.yaml`; topology may reference them through `exchangeRefs` only.

## Waiting, Inbox, Attention

Audit commands:

```bash
rg -n "waitingOn|unreadBy|threadUnreadCount|threadPendingCount|threadWaitingOnMeCount|threadWaitingOnThemCount|hasActiveTask|deriveSessionSemantics|attention|unseenCount|workflowOnMeCount|buildWorkflowEntries|filterWorkflowEntries|describeWorkflowNextAction|resolveAlertRecipients" src app
rg -n "unreadNotificationCount|summarizeUnreadNotificationsBySession|markNotificationsRead|clearNotifications" src app
```

- Replace scattered wait/inbox truth with exchange-derived inbox state.
- Rebuild `src/workflow.ts` from exchange state; do not leave workflow rollups reading legacy task/thread files.
- Move alert recipient derivation out of metadata-server as hidden inbox routing authority.
- Keep session semantics, notification badges, and statusline attention as projections.
- Do not let notification read/clear state be the only source for agent waits or task state.

## Projections

Audit commands:

```bash
rg -n "metadata\\.json|loadMetadataState|saveMetadataState|updateSessionMetadata|clearSessionLogs|clearSessionTranscriptPath|metadata-api|AgentTracker|/event|/mark-seen|/set-activity|/set-attention|/shell-state" src app
rg -n "notifications\\.json|notification-context\\.json|getNotificationContextPath|updateNotificationContext|loadNotificationContexts|isSessionNotificationFocused|shouldSuppressNotification|/notification-context|addNotification|upsertNotification|listNotifications|statusline\\.json|buildStatuslineSnapshot|writeStatuslineFile|desktop-state|buildDesktopState|refreshDesktopStateSnapshot" src app scripts
```

- Keep metadata, notifications, statusline, desktop snapshots, and GUI stores as derived views.
- Remove any projection write path that changes lifecycle, worktree, ownership, or exchange truth.
- Route activity/attention/event/shell-state writes through projection rules; they must not become hidden wait or lifecycle authority.
- Keep notification focus/suppression context projection-only; it must not become hidden inbox, attention, or delivery authority.
- Endpoint discovery files such as `metadata-api.json` may remain daemon/project-service plumbing.

## GUI, CLI, And API Surfaces

Audit commands:

```bash
rg -n "postProjectServiceJson|postLiveProjectServiceJsonOrLocal|callProjectJson|callDaemonViaRelay|/desktop|/worktrees|/graveyard|/workflow|/plans|/notifications|/control/" src app
rg -n "readAllTasks|readTask|listThreadSummaries|readMessages|listTopologySessionStates|moveTopologySessionToGraveyard|resurrectTopologySession" src/main.ts src/metadata-server.ts app/lib
```

- GUI and CLI should become clients over topology/exchange/projection APIs.
- Remove local CLI mutations of legacy files after authoritative APIs exist.
- Keep HTTP/SSE DTOs and app stores as transport/UI state only.
- Keep blocked compatibility routes only when they fail closed with clear replacement errors.

## Daemon, Remote, And Presence

Audit commands:

```bash
rg -n "daemon-state|/projects|ensureProject|stopProject|loadMetadataEndpoint|saveMetadataEndpoint|relay|shareId|ownerUserId|instances\\.json|registerInstance|updateHeartbeat|getRemoteInstances|localInstancesPath|security-state:v1|sharing-state:v1|loadSecurityState|saveSecurityState|loadSharingState|saveSharingState|/security/|/shares/" src app relay
```

- Keep daemon project registry as daemon-private project supervision state.
- Do not let daemon registry carry per-agent lifecycle or exchange truth.
- Replace `instances.json` ownership/presence semantics with topology presence or remove them.
- Keep relay/share state as transport/security state unless explicitly mirrored from topology ownership.
- Classify relay Durable Object security/share stores as relay-owned policy authority, then ensure they do not decide runtime topology ownership or exchange state.

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
- source verification passes with `yarn typecheck && yarn lint && yarn test`;
- runtime verification is run when `src/*.ts` behavior changes, including `yarn build` before manual runtime testing.
