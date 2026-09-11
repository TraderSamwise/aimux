# TUI Model Gap v1

Status: historical audit. This document records a Node-renderer parity gap
snapshot from the rewrite; after Phase 8, it is not a current backlog by
itself. Re-run the model inventory before citing any row as a live product gap.

## Scope

This was Phase 0 for restoring Node dashboard renderer parity. It answered one
question only: did the Rust dashboard model at the captured commit carry every
field consumed by the Node renderer?

Sources:

- Node renderer/types from `a9220736^`: `src/dashboard/index.ts`, `src/tui/screens/dashboard-renderers.ts`, `src/tui/screens/subscreen-renderers.ts`, `src/tui/screens/overlay-renderers.ts`.
- Rust model/render ingress at `150cb398`: `native/crates/aimux/src/dashboard_model.rs`, `native/crates/aimux/src/dashboard_renderer.rs`, `native/crates/aimux/src/dashboard_session_details.rs`, `native/crates/aimux/src/dashboard_internal.rs`, `native/crates/aimux/src/tui_screen_renderers.rs`.

Legend:

- `typed`: present as a typed Rust model/input field.
- `derived`: not stored, but available by deriving from typed fields.
- `raw`: preserved only through `serde_json::Value` / `extra`, not modeled.
- `missing`: no current Rust carrier found.

## Dashboard View Model

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `sessions` | typed | `DesktopStateSnapshot.sessions` |
| `services` | typed | `DesktopStateSnapshot.services` |
| `worktreeGroups` | typed | `DesktopStateSnapshot.worktree_groups` |
| `mainCheckout` | typed | `DesktopStateSnapshot.main_checkout_info` |
| `hasWorktrees` | derived | derivable from `worktrees` / `worktree_groups`; no stored field needed |
| `focusedWorktreePath` | typed input | `DashboardRenderInput.focused_worktree_path` from controller navigation |
| `navLevel` | typed input | `DashboardRenderInput.nav_level` |
| `selectedSessionId` | typed input | `DashboardRenderInput.selected_session_id` |
| `selectedServiceId` | typed input | `DashboardRenderInput.selected_service_id` |
| `runtimeLabel` | typed input | `DashboardRenderInput.runtime_label` |
| `isDevRuntime` | typed input | `DashboardRenderInput.is_dev_runtime` |
| `version` | missing at runtime | `DashboardRenderInput.version` exists, but `dashboard_internal.rs` passes `None` |
| `detailsPaneVisible` | typed input | `DashboardRenderInput.details_sidebar_visible` |
| `scrollOffset` | typed input | `DashboardRenderInput.scroll_offset` |
| `hideOfflineAgents` | typed input | `DashboardRenderInput.hide_offline_agents` |
| `hiddenOfflineAgentCount` | typed input | `DashboardVisibleModel.hidden_offline_agent_count` into `DashboardRenderInput.hidden_offline_agent_count` |
| `operationFailures` | raw | `DesktopStateSnapshot.operation_failures: Vec<Value>`; fields such as `title`, `createdAt`, `operation`, `message`, `worktreeName`, `targetId`, `worktreePath` are not typed |
| `agentRestoreOffer` | typed | `DesktopStateSnapshot.agent_restore_offer` |
| `overseerSessions` | derived | not a top-level field; derivable from `sessions` by `overseer` / `team.role` / `project_control` |
| `scribeSessions` | derived/raw | no top-level typed field; derivable from `sessions`, but existing interaction contracts also keep raw scribe caches |
| `selectedTeammates` | derived/raw | `DesktopStateSnapshot.teammates` exists, but the Node-selected teammate projection is not a typed render input |
| `previewSource` | typed UI state, not render input | `DashboardUiState.preview_source` exists and footer contract accepts it, but `render_dashboard_frame` does not receive it for the main details/preview body |
| `scribePreviewEntries` | raw/missing | contract host caches this as `Value`; no typed field in `DesktopStateSnapshot` or `DashboardRenderInput` |
| `worktreeRemoval` | missing | no typed active-removal field on `DesktopStateSnapshot` / `DashboardRenderInput` |
| `worktreeRemovals` | missing | no typed active-removal list on `DesktopStateSnapshot` / `DashboardRenderInput` |
| `derivedStatusLabel` | derived | Rust recomputes parts of this in row rendering; no model function field required |

## Dashboard Session

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `index` | typed | `DashboardSession.index` |
| `id` | typed | `DashboardSession.id` |
| `command` | typed | `DashboardSession.command` |
| `toolConfigKey` | typed | `DashboardSession.tool_config_key` |
| `tmuxWindowId` | typed | `DashboardSession.tmux_window_id` |
| `tmuxWindowIndex` | typed | `DashboardSession.tmux_window_index` |
| `lastUsedAt` | typed | `DashboardSession.last_used_at` |
| `createdAt` | typed | `DashboardSession.created_at` |
| `status` | typed | `DashboardSession.status` |
| `active` | typed | `DashboardSession.active` |
| `worktreePath` | typed | `DashboardSession.worktree_path` |
| `worktreeName` | typed | `DashboardSession.worktree_name` |
| `worktreeBranch` | typed | `DashboardSession.worktree_branch` |
| `team` | typed | `DashboardSession.team` |
| `overseer` | typed | `DashboardSession.overseer` |
| `scribe` | typed | `DashboardSession.scribe` |
| `projectControl` | typed | `DashboardSession.project_control` |
| `label` | typed | `DashboardSession.label` |
| `headline` | typed | `DashboardSession.headline` |
| `semantic` | typed partial | `DashboardSession.semantic`; see semantic table below |
| `pendingAction` | typed | `DashboardSession.pending_action` |
| `pendingStartedAt` | typed | `DashboardSession.pending_started_at` |
| `pending` | typed | `DashboardSession.pending` |
| `optimistic` | typed | `DashboardSession.optimistic` |
| `unseenCount` | typed | `DashboardSession.unseen_count` |
| `threadUnreadCount` | typed | `DashboardSession.thread_unread_count` |
| `threadWaitingOnMeCount` | typed | `DashboardSession.thread_waiting_on_me_count` |
| `threadWaitingOnThemCount` | typed | `DashboardSession.thread_waiting_on_them_count` |
| `threadPendingCount` | typed | `DashboardSession.thread_pending_count` |
| `workflowOnMeCount` | typed | `DashboardSession.workflow_on_me_count` |
| `workflowBlockedCount` | typed | `DashboardSession.workflow_blocked_count` |
| `workflowFamilyCount` | typed | `DashboardSession.workflow_family_count` |
| `notificationUnreadCount` | typed | `DashboardSession.notification_unread_count` |
| `notificationNeedsInputUnreadCount` | typed | `DashboardSession.notification_needs_input_unread_count` |
| `notificationStale` | typed | `DashboardSession.notification_stale` |
| `backendSessionId` | raw | preserved in `DashboardSession.extra`; details renderer reads it after serializing to `Value` |
| `restoreState` | raw | preserved in `DashboardSession.extra`; not typed, so restore affordances are not first-class |
| `restoreBlockedReason` | raw | preserved in `DashboardSession.extra` |
| `taskDescription` | raw | preserved in `DashboardSession.extra` |
| `role` | raw/derived | `team.role` is typed; direct `session.role` is only `extra` |
| `cwd` | raw | preserved in `DashboardSession.extra`; details renderer can read it from serialized `Value` |
| `repoOwner` | raw | preserved in `DashboardSession.extra` |
| `repoName` | raw | preserved in `DashboardSession.extra` |
| `repoRemote` | raw | preserved in `DashboardSession.extra` |
| `prNumber` | raw | preserved in `DashboardSession.extra` |
| `prTitle` | raw | preserved in `DashboardSession.extra` |
| `prUrl` | raw | preserved in `DashboardSession.extra` |
| `activity` | missing | Node type has it; no typed Rust carrier and no renderer access found |
| `attention` | missing | Node type has it; Rust carries `semantic.user.attention`, not direct `attention` |
| `lastOutputAt` | raw | preserved in `DashboardSession.extra`; row time logic in Rust does not use it |
| `becameIdleAt` | raw | preserved in `DashboardSession.extra`; recent-idle logic is not typed |
| `lastEvent` | raw | preserved in `DashboardSession.extra`; details renderer reads `lastEvent.message` from serialized `Value` |
| `services` | raw | preserved in `DashboardSession.extra`; details renderer reads attached `url` / `port` from serialized `Value` |
| `loop` | raw | preserved in `DashboardSession.extra`; current Rust details renderer does not render full loop metadata |
| `loopLastAction` | raw | preserved in `DashboardSession.extra`; current Rust details renderer does not render full loop action/source |
| `foregroundCommand` | raw | preserved in `DashboardSession.extra` |
| `pid` | raw | preserved in `DashboardSession.extra` |
| `previewLine` | raw | preserved in `DashboardSession.extra`; current Rust details renderer does not use it |
| `previewSnapshot` | raw | preserved in `DashboardSession.extra`; current main renderer does not reproduce Node preview snapshot rows |
| `threadId` | raw | preserved in `DashboardSession.extra`; details renderer can read it from serialized `Value` |
| `threadName` | raw | preserved in `DashboardSession.extra`; details renderer can read it from serialized `Value` |
| `threadWaitingCount` | missing | Node type has it; Rust has split `thread_waiting_on_me_count` / `thread_waiting_on_them_count` only |
| `workflowTopLabel` | raw | preserved in `DashboardSession.extra`; current Rust details renderer does not use it |
| `workflowNextAction` | raw | preserved in `DashboardSession.extra`; current Rust details renderer does not use it |
| `latestNotificationText` | missing/raw mismatch | Node type exposes it direct; Rust semantic model has `notifications.latest_text`, no direct typed field |

## Session Semantic State

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `semantic.user.label` | typed | `SessionUserState.label` |
| `semantic.user.attention` | typed | `SessionUserState.attention` |
| `semantic.notifications.unreadCount` | typed | `SessionNotificationState.unread_count` |
| `semantic.notifications.latestText` | typed | `SessionNotificationState.latest_text` |
| `semantic.notifications.latestUnread.createdAt` | raw | `SessionNotificationState.extra`; Node uses it for recency |
| `semantic.presentation.statusLabel` | typed | `SessionPresentationState.status_label` |
| `semantic.presentation.compactHint` | typed | `SessionPresentationState.compact_hint` |
| `semantic.presentation.attentionScore` | typed | `SessionPresentationState.attention_score` |
| `semantic.activityNewCount` | typed | `SessionSemanticState.activity_new_count` |
| `semantic.threadUnreadCount` | typed | `SessionSemanticState.thread_unread_count` |
| `semantic.pendingDeliveryCount` | typed | `SessionSemanticState.pending_delivery_count` |
| `semantic.waitingOnMeCount` | typed | `SessionSemanticState.waiting_on_me_count` |
| `semantic.waitingOnThemCount` | typed | `SessionSemanticState.waiting_on_them_count` |
| `semantic.blockedCount` | typed | `SessionSemanticState.blocked_count` |
| `semantic.familyCount` | typed | `SessionSemanticState.family_count` |

## Dashboard Service

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `id` | typed | `DashboardService.id` |
| `command` | typed | `DashboardService.command` |
| `args` | typed | `DashboardService.args` |
| `tmuxWindowId` | typed | `DashboardService.tmux_window_id` |
| `tmuxWindowIndex` | typed | `DashboardService.tmux_window_index` |
| `worktreePath` | typed | `DashboardService.worktree_path` |
| `worktreeName` | typed | `DashboardService.worktree_name` |
| `worktreeBranch` | typed | `DashboardService.worktree_branch` |
| `status` | typed | `DashboardService.status` |
| `active` | typed | `DashboardService.active` |
| `pending` | typed | `DashboardService.pending` |
| `optimistic` | typed | `DashboardService.optimistic` |
| `lastUsedAt` | raw | preserved in `DashboardService.extra`; row renderer does not use it |
| `createdAt` | raw | preserved in `DashboardService.extra` |
| `label` | raw | preserved in `DashboardService.extra`; row renderer falls back to `command` only |
| `cwd` | raw | preserved in `DashboardService.extra`; service details panel cannot currently receive a typed service detail model |
| `foregroundCommand` | raw | preserved in `DashboardService.extra` |
| `shellCommand` | raw | preserved in `DashboardService.extra` |
| `shellCommandState` | raw | preserved in `DashboardService.extra` |
| `pid` | raw | preserved in `DashboardService.extra` |
| `previewLine` | raw | preserved in `DashboardService.extra` |
| `pendingAction` | raw | preserved in `DashboardService.extra`; not typed |
| `pendingStartedAt` | raw | preserved in `DashboardService.extra`; not typed |

## Worktree Group

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `name` | typed | `WorktreeGroup.name` |
| `branch` | typed | `WorktreeGroup.branch` |
| `path` | typed | `WorktreeGroup.path` |
| `status` | typed | `WorktreeGroup.status` |
| `pending` | typed | `WorktreeGroup.pending` |
| `removing` | typed | `WorktreeGroup.removing` |
| `pendingAction` | typed | `WorktreeGroup.pending_action` |
| `sessions` | typed | `WorktreeGroup.sessions` |
| `services` | typed | `WorktreeGroup.services` |
| `operationFailure` | raw | `WorktreeGroup.operation_failure: Option<Value>`; fields `operation`, `message`, `createdAt` are not typed |
| `createdAt` | raw | preserved in `WorktreeGroup.extra` |
| `pendingStartedAt` | raw | preserved in `WorktreeGroup.extra` |
| `optimistic` | raw | preserved in `WorktreeGroup.extra` |
| quick-jump `digit` | derived | Node renderer receives this from `buildDashboardQuickJumpWorktrees`; no typed quick-jump view model in Rust |
| quick-jump `entries` | derived | Node renderer receives this from `buildDashboardQuickJumpWorktrees`; no typed quick-jump view model in Rust |
| done/working/needs rollup | derived incomplete | Rust can derive counts from session semantic state, but current `worktree_summary` only reports total agent/service counts |

## Main Checkout

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `name` | typed | `MainCheckoutInfo.name` |
| `branch` | typed | `MainCheckoutInfo.branch` |

## Agent Restore Offer

| Node field | Rust status | Rust carrier / gap |
|---|---:|---|
| `id` | typed | `AgentRestoreOffer.id` |
| `updatedAt` | typed | `AgentRestoreOffer.updated_at` |
| `sessionIds` | typed | `AgentRestoreOffer.session_ids` |
| `sessions[].id` | typed | `AgentRestoreSession.id` |
| `sessions[].team` | typed | `AgentRestoreSession.team` |
| `sessions[].overseer` | typed | `AgentRestoreSession.overseer` |
| `sessions[].scribe` | typed | `AgentRestoreSession.scribe` |
| `sessions[].projectControl` | typed | `AgentRestoreSession.project_control` |
| `source` | raw | preserved in `AgentRestoreOffer.extra` |
| `worktreeGroups` | raw | preserved in `AgentRestoreOffer.extra` |
| `sessions[].tool` | raw | preserved in `AgentRestoreSession.extra` |
| `sessions[].command` | raw | preserved in `AgentRestoreSession.extra` |
| `sessions[].label` | raw | preserved in `AgentRestoreSession.extra` |
| `sessions[].worktreePath` | raw | preserved in `AgentRestoreSession.extra` |

## Subscreen Models

The Node subscreen renderer consumes controller/resource fields, not `DashboardViewModel` directly. Current Rust `DashboardSubscreenRenderInput` carries `resource: Option<&Value>`, so these fields are transportable as raw JSON but are not modeled in `dashboard_model.rs`.

| Screen | Node fields consumed | Rust status |
|---|---|---:|
| Coordination list | `coordinationWorklist`, `coordinationIndex`, item `bucket`, `type`, `title`, `actionable`, `when`, `kind`, `reachability`, `stale`, `thread.stateLabel`, `thread.thread.status`, `thread.thread.waitingOn`, `thread.pendingDeliveries` | raw |
| Coordination details | notification `title`, `unreadCount`, `sessionId`, `reachability`, `latestUnread`, `notifications[].kind`, `notifications[].createdAt`, `notifications[].body`; thread `displayTitle`, `thread.kind`, `thread.status`, `thread.participants`, `thread.owner`, `thread.waitingOn`, `task.status`, `task.type`, `task.reviewStatus`, `task.prompt`, `task.result`, `task.error`, `familyTaskIds`, `pendingDeliveries`, `latestPendingRecipients`, `messages[].from/to/kind/body` | raw |
| Project | `projectObservabilityLoaded`, `projectObservability.summary.agentsRunning/agentsWaiting/agentsOffline/services/worktrees/unreadNotifications/openTasks/doneTasks`, `progress.total/pending/assigned/in_progress/blocked/done/failed`, story `kind`, `title`, `status`, `meta`, `createdAt`, `body` | raw |
| Topology | `topology.projectName`, `health`, `counts.worktrees/agents/services`, rows `kind`, `depth`, `label`, `detail`, `status`, `health`, `worktreePath`, `sessionId`, `serviceId` | raw |
| Graveyard | grouped rows `kind`, `label`, `actionIndex`, `actionNumber`, `entry.name`, `entry.branch`, `entry.path`, `entry.updatedAt`, `lastUsedAt`, `attachedAgents`, `attachedServices`, `hiddenAgentCount`, agent `entry.id/command/backendSessionId/label/headline`, service `label/status/lastUsedAt` | raw |
| Library | entries `kind`, `title`, `path`, `sessionId`, `updatedAt`, `preview` | raw |

## Overlay Models

The recovered overlay renderer consumes controller state and dashboard caches. Rust has several overlay contract modules, but the main model still does not carry these as typed dashboard data.

| Overlay | Node fields consumed | Rust status |
|---|---|---:|
| Service input | `serviceInputBuffer` | controller state, not dashboard model |
| Label input | `labelInputBuffer` | controller state, not dashboard model |
| Worktree list | `dashboardWorktreeGroupsCache` or `listAllWorktrees()` rows `name`, `branch`, `path`, `isBare` | raw/typed partial |
| Worktree removal confirm | `worktreeRemoveConfirm.name`, `path` | controller state |
| Worktree cache cleanup | `worktreeCacheCleanupConfirm.plan.targets`, `plan.reclaimableBytes` | controller state |
| Agent restore confirm | `dashboardAgentRestoreOfferCache.sessions/sessionIds`, session `id`, `tool`, `command`, `label`, `worktreePath`, `team.role`, `overseer`, `scribe`, `projectControl` | typed partial plus raw extras |
| Busy/error overlays | `dashboardBusyState.title/lines/startedAt/spinnerFrame`, `dashboardErrorState.title/lines` | controller state |
| Tool picker and command overlays | session/entry `id`, `command`, `label`, `headline`, `status`, `team`, `role`, `source`, `summary`, `topicKey`, `updatedAt`, `lastEvent`, `previewLine`, `loop`, `sessionIds`, `worktreePath`; selected `loop` | raw/typed partial |

## Findings

At capture time, the Rust model was not yet a faithful carrier for the Node
dashboard renderer.

Typed coverage is reasonable for the basic dashboard spine: sessions, worktrees, main checkout, semantic counts, thread/workflow counts, and restore-offer identity. The visible mismatch Sam reported comes from the fields Node used for richer row/detail rendering that are either only raw extras or not supplied to the renderer at all.

The hard gaps for 1:1 dashboard parity are:

1. Runtime version is supported by `DashboardRenderInput` but never supplied by `dashboard_internal.rs`.
2. Worktree rollups are not modeled/rendered like Node. Rust has enough typed session state to derive them, but current summary uses only raw counts.
3. Scribe preview state is not typed on the dashboard view model.
4. Selected teammate projection is not typed as render input.
5. Active worktree removal state is missing from the model/render input.
6. Session recency fields used for `output 9m ago`, recent-idle highlighting, and restore affordances are not typed: `lastOutputAt`, `becameIdleAt`, `lastEvent`, `restoreState`.
7. Agent detail fields are mostly raw extras: `backendSessionId`, `cwd`, PR/repo metadata, `loop`, `loopLastAction`, `foregroundCommand`, `pid`, `previewLine`, `previewSnapshot`, `services`, `workflowTopLabel`, `workflowNextAction`.
8. Service detail fields are mostly raw extras: `label`, `lastUsedAt`, `cwd`, `foregroundCommand`, `shellCommand`, `shellCommandState`, `pid`, `previewLine`, `pendingAction`, `pendingStartedAt`.
9. Operation-failure payloads are raw `Value`, so the renderer cannot have a typed parity contract for the failure panels.
10. Subscreens and overlays can still receive their data as raw `Value`, but they are not typed model parity with the Node renderer.

Conclusion: Phase 1 cannot be only a renderer port if the bar is 1:1 character-grid equality. The dashboard model/render ingress should first promote the Node renderer's first-class fields out of `extra`/raw resource access where the main dashboard depends on them, then port the Node renderer logic against that model.
