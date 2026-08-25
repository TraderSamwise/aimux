import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { PassThrough } from "node:stream";
import type { Worker } from "node:worker_threads";
import {
  getDashboardClientUiStatePath,
  getProjectId,
  getProjectStateDir,
  getProjectStateDirFor,
  getRepoRoot,
  withProjectPaths,
} from "./paths.js";
import { writeJsonAtomic } from "./atomic-write.js";
import {
  type MetadataTone,
  updateSessionMetadata,
  clearSessionLogs,
  saveMetadataEndpoint,
  loadMetadataEndpoint,
  loadMetadataState,
  setSessionLoop,
  clearSessionLoop,
  setSessionOverseer,
  type SessionLogEntry,
  type SessionContextMetadata,
  type SessionLoopAction,
  type SessionLoopActionMetadata,
  type SessionLoopMetadata,
  type SessionLoopProvenance,
  type SessionLoopSource,
  type SessionServiceMetadata,
  type SessionStatuslineSegment,
  dropStatuslineSegment,
  putStatuslineSegment,
  segmentRejection,
  MAX_SEGMENT_TTL_SECONDS,
} from "./metadata-store.js";
import {
  contextualizeAlertInput,
  mergeDisplayContext,
  metadataDisplayContext,
  type SessionAlertDisplayContext,
} from "./alert-display.js";
import { notifyAlert } from "./notify.js";
import { clearNotifications, listNotificationSnapshot, markNotificationsRead } from "./notifications.js";
import { updateNotificationContext } from "./notification-context.js";
import { markSessionViewed } from "./session-viewed.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import { InteractionRegistry } from "./interaction-requests.js";
import type {
  InteractionPayload,
  InteractionRequest,
  InteractionResponse,
  InteractionType,
} from "./interaction-requests.js";
import {
  createThread,
  listThreadSummaries,
  markMessageDelivered,
  markThreadSeen,
  type OrchestrationMessage,
  type OrchestrationThread,
  readMessageSnapshot,
  readThread,
  setThreadStatus,
  type MessageKind,
  type ThreadKind,
  type ThreadStatus,
} from "./threads.js";
import { sendDirectMessage, sendThreadMessage } from "./orchestration.js";
import {
  acceptHandoff,
  approveReview,
  acceptTask,
  assignTask,
  blockTask,
  completeHandoff,
  completeTask,
  reopenTask,
  requestTaskChanges,
  sendHandoff,
  type TaskLifecycleResult,
  type AssignTaskResult,
} from "./orchestration-actions.js";
import { readAllTaskSnapshots, readTaskSnapshot } from "./tasks.js";
import { buildCoordinationThreadEntries } from "./workflow.js";
import { buildCoordinationView } from "./coordination-model.js";
import { buildProjectObservability } from "./project-observability.js";
import { buildProjectTopology } from "./project-topology.js";
import {
  type DashboardControlScreen,
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEW_INVALIDATIONS,
  type OrchestrationRouteOption,
  type ProjectLifecycleTransition,
  type ProjectLifecycleTransitionOperation,
  type ProjectLifecycleTransitionPhase,
  type ProjectLifecycleTransitionTargetKind,
  type ProjectApiView,
  type ExposePreviewSnapshot,
  projectApiMutationReasonForRoute,
  projectApiViewsForMutationRoute,
} from "./project-api-contract.js";
import { loadLastUsedState, markLastUsed } from "./last-used.js";
import { log } from "./debug.js";
import { userFacingErrorMessage } from "./error-display.js";
import { loadLibraryEntries } from "./library.js";
import { getWorktreeCreatePath } from "./worktree.js";
import {
  acknowledgeAgentRestoreOffer,
  readAgentRestoreOffer,
  writeAgentRestoreRetryOffer,
} from "./runtime-core/agent-restore-state.js";
import type { LaunchOverride } from "./shell-args.js";
import { formatRelativeRecency } from "./recency.js";
import type { ParsedAgentOutput } from "./agent-output-parser.js";
import { agentOutputCaptureWindow } from "./agent-output-bounds.js";
import type { AgentTranscriptMessage } from "./agent-transcript.js";
import type { PluginRuntimePluginStatus } from "./plugin-runtime.js";
import {
  createPathAttachment,
  createUploadedAttachment,
  getAttachment,
  getAttachmentContent,
  getAttachmentRecord,
  type AttachmentRecord,
  type HostedAttachmentReference,
} from "./attachment-store.js";
import { ProjectEventBus, type AlertKind } from "./project-events.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import { applyShellStateTransition } from "./shell-state.js";
import {
  getPlanAuthorityDir,
  readPlanContent,
  validatePlanSessionId,
  writePlanContent,
} from "./runtime-core/plan-authority.js";
import { TMUX_DASHBOARD_READY_OPTION } from "./runtime-owner.js";
import {
  getDefaultTeamConfig,
  isTeammateSession,
  loadTeamConfig,
  saveTeamConfig,
  selectDirectTeammates,
  type RoleConfig,
  type SessionTeamMetadata,
} from "./team.js";
import { resolveOrchestrationRecipients, type RoutingCandidate } from "./orchestration-routing.js";
import { parseRemoteActor } from "./remote-access.js";
import {
  listSwitchableAgentItems,
  resolveAttentionAgent,
  resolveNextAgent,
  resolvePrevAgent,
  serializeFastControlItem,
  type FastControlItem,
} from "./fast-control.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { TmuxTarget, TmuxWindowMetadata } from "./tmux/runtime-manager.js";
import { isTmuxClientSessionForHost } from "./tmux/session-names.js";
import { openTargetForClient } from "./tmux/window-open.js";
import { getDashboardCommandSpec } from "./dashboard/command-spec.js";
import { resolveDashboardTarget } from "./dashboard/targets.js";
import { isUsableDashboardTarget } from "./dashboard/targets.js";
import { clearDashboardOperationFailures } from "./dashboard/operation-failures.js";
import { listTopologySessionStates, type RuntimeTopologySessionState } from "./runtime-core/topology-sessions.js";
import type { RuntimeTopologySessionStatus } from "./runtime-core/topology-store.js";
import {
  resolveExchangeMessageAlertRecipients,
  resolveExchangeReviewOutcomeRecipient,
  resolveExchangeTaskAssignmentRecipient,
  resolveExchangeTaskOutcomeRecipient,
} from "./runtime-core/exchange-alert-routing.js";
import { loadConfig } from "./config.js";
import { describeSessionRestorability } from "./session-restorability.js";
import { shouldRelaunchFreshSession } from "./session-fresh-relaunch.js";
import { ExposePreviewCache, type ExposePreviewCacheLike } from "./expose-preview-cache.js";
import { ExposePaneOutputTap, type ExposePaneOutputTapLike } from "./expose-pane-output-tap.js";
import { VisualClientLeaseRegistry, parseVisualClientKind } from "./visual-client-leases.js";
import { startExposeHotSnapshotWorker } from "./expose-hot-snapshot-worker.js";
import { pruneExpiredHotExposeSnapshots } from "./tmux/expose-hot-snapshot.js";
import { runTmuxExpose } from "./tmux/expose.js";
import { assignWorktreeTones, exposeTileContextForItem, orderExposeItems } from "./tmux/expose-ordering.js";
import { agentStatusChip } from "./tui/render/agent-status.js";
import { buildGraveyardViewModel } from "./multiplexer/graveyard-view-model.js";
import {
  PROMPT_CONTEXT_MAX_BYTES,
  PromptContextStore,
  composeWithPromptContext,
  normalizePromptContext,
  promptContextByteLength,
} from "./prompt-context.js";
import {
  permissionRequestHookOutput,
  summarizeClaudeNotification,
  summarizeClaudePermissionRequest,
  summarizeClaudeStop,
  type ClaudeHookPayload,
} from "./claude-hooks.js";
import type { CodexHookPayload } from "./codex-hooks.js";
import {
  getAgentOutputReadMetrics,
  recordAgentOutputReadMetric,
  type AgentOutputReadSource,
} from "./agent-output-read-metrics.js";

const LIBRARY_DOC_ALLOWLIST = [
  { path: "AGENTS.md", kind: "instructions", title: "AGENTS.md" },
  { path: "CLAUDE.md", kind: "adapter", title: "CLAUDE.md" },
  { path: "CODEX.md", kind: "adapter", title: "CODEX.md" },
  { path: "README.md", kind: "project", title: "README.md" },
] as const;

function buildLifecycleTransition(input: {
  operation: ProjectLifecycleTransitionOperation;
  targetKind: ProjectLifecycleTransitionTargetKind;
  targetId?: string;
  targetPath?: string;
  phase?: ProjectLifecycleTransitionPhase;
  error?: string;
}): ProjectLifecycleTransition {
  const now = new Date().toISOString();
  const targetKey = input.targetId ?? input.targetPath ?? "unknown";
  return {
    operationId: `${input.operation}:${targetKey}:${randomUUID()}`,
    operation: input.operation,
    targetKind: input.targetKind,
    phase: input.phase ?? "succeeded",
    startedAt: now,
    updatedAt: now,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function lifecycleOk<T extends object>(
  result: T,
  input: Parameters<typeof buildLifecycleTransition>[0],
): { ok: true; transition: ProjectLifecycleTransition } & T {
  return { ...result, ok: true, transition: buildLifecycleTransition(input) };
}

type LifecycleTransitionInput = Parameters<typeof buildLifecycleTransition>[0];
type EarlyLifecycleResult<T> =
  | { kind: "resolved"; result: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "pending" };
type LifecycleMutationTelemetry = {
  enqueued: number;
  started: number;
  succeeded: number;
  failed: number;
  released: number;
  rejectedConflicts: number;
  rejectedQueueFull: number;
  maxQueuedCount: number;
  maxQueuedMs: number;
  maxDurationMs: number;
  lastStartedAt: string | null;
  lastSettledAt: string | null;
  lastError: string | null;
};

class LifecycleMutationConflictError extends Error {
  readonly status = 409;

  constructor(
    readonly requested: LifecycleTransitionInput,
    readonly active: LifecycleTransitionInput,
  ) {
    const target = requested.targetId ?? requested.targetPath ?? "unknown";
    super(`lifecycle mutation already in progress for ${requested.targetKind} ${target}`);
  }
}

class LifecycleMutationQueueFullError extends Error {
  readonly status = 429;

  constructor(
    readonly requested: LifecycleTransitionInput,
    readonly queuedCount: number,
    readonly limit: number,
  ) {
    super(`lifecycle mutation queue is full (${queuedCount}/${limit}); wait for current operations to settle`);
  }
}

function lifecycleTargetKey(input: LifecycleTransitionInput): string | undefined {
  const target =
    input.targetKind === "worktree"
      ? input.targetPath?.trim() || input.targetId?.trim()
      : input.targetId?.trim() || input.targetPath?.trim();
  return target ? `${input.targetKind}:${target}` : `${input.targetKind}:${input.operation}:__project__`;
}

function safeWorktreeCreatePath(name: string, projectRoot: string): string {
  try {
    return getWorktreeCreatePath(name, projectRoot);
  } catch {
    return join(projectRoot, ".aimux", "worktrees", name);
  }
}

async function waitForEarlyLifecycleResult<T>(promise: Promise<T>, timeoutMs = 50): Promise<EarlyLifecycleResult<T>> {
  return Promise.race([
    promise.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "pending" }>((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), timeoutMs);
    }),
  ]);
}

function buildTopologyWorktreesFromDesktopState(state: {
  sessions?: any[];
  teammates?: any[];
  services?: any[];
  worktrees?: any[];
}): any[] {
  const sessions = [...(state.sessions ?? []), ...(state.teammates ?? [])];
  const services = state.services ?? [];
  return (state.worktrees ?? []).map((worktree, index) => {
    const worktreeSessions = sessions.filter(
      (session) => session.worktreePath === worktree.path || (!session.worktreePath && index === 0),
    );
    const worktreeServices = services.filter(
      (service) => service.worktreePath === worktree.path || (!service.worktreePath && index === 0),
    );
    return {
      ...worktree,
      status: worktree.status ?? (worktreeSessions.length > 0 || worktreeServices.length > 0 ? "active" : "offline"),
      sessions: worktreeSessions,
      services: worktreeServices,
    };
  });
}

function formatRoutePreview(recipientIds: string[]): string {
  if (recipientIds.length === 0) return "";
  const preview = recipientIds.slice(0, 2).join(", ");
  const remainder = recipientIds.length > 2 ? `, +${recipientIds.length - 2}` : "";
  return ` [${recipientIds.length}: ${preview}${remainder}]`;
}

function orchestrationCandidateFromSession(session: any): RoutingCandidate {
  const status = session.semantic?.user?.label ?? session.status;
  const runtime = session.semantic?.runtime;
  return {
    id: session.id,
    tool: session.tool ?? session.toolConfigKey ?? session.command,
    role: session.role ?? session.team?.role,
    worktreePath: session.worktreePath,
    status,
    canReceiveInput: runtime?.canReceiveInput ?? (status === "running" || status === "idle" || status === "waiting"),
    isAlive: runtime?.isAlive ?? (status !== "exited" && status !== "offline"),
    workflowPressure:
      (session.workflowOnMeCount ?? 0) * 5 +
      (session.workflowBlockedCount ?? 0) * 6 +
      (session.threadPendingCount ?? 0) * 3 +
      (session.notificationUnreadCount ?? 0) * 2 +
      (session.threadWaitingOnThemCount ?? 0),
    exited: Boolean(session.exited) || status === "exited",
  };
}

function buildOrchestrationRouteOptions(input: {
  state: { sessions?: any[]; teammates?: any[] };
  selectedSessionId?: string;
  worktreePath?: string;
}): OrchestrationRouteOption[] {
  const sessions = [...(input.state.sessions ?? []), ...(input.state.teammates ?? [])];
  const candidates = sessions.map(orchestrationCandidateFromSession);
  const options: OrchestrationRouteOption[] = [];
  const selected = input.selectedSessionId ? sessions.find((session) => session.id === input.selectedSessionId) : null;
  if (selected) {
    options.push({
      label: `${selected.label ?? selected.command ?? selected.id} (${selected.id})`,
      sessionId: selected.id,
    });
  }

  const team = loadTeamConfig();
  for (const [role, cfg] of Object.entries(team.roles as Record<string, { description?: string }>)) {
    const recipientIds = resolveOrchestrationRecipients({
      candidates,
      assignee: role,
      worktreePath: input.worktreePath,
    });
    if (recipientIds.length === 0) continue;
    options.push({
      label: `Role: ${role}${cfg.description ? ` — ${cfg.description}` : ""}${formatRoutePreview(recipientIds)}`,
      assignee: role,
      worktreePath: input.worktreePath,
      recipientIds,
    });
  }

  const config = loadConfig();
  for (const [toolKey, toolCfg] of Object.entries(config.tools)) {
    if (!toolCfg.enabled) continue;
    const recipientIds = resolveOrchestrationRecipients({
      candidates,
      tool: toolKey,
      worktreePath: input.worktreePath,
    });
    if (recipientIds.length === 0) continue;
    options.push({
      label: `Tool: ${toolKey}${formatRoutePreview(recipientIds)}`,
      tool: toolKey,
      worktreePath: input.worktreePath,
      recipientIds,
    });
  }
  return options;
}

function isLibraryPathExposed(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return !normalized.startsWith(".aimux/") && !normalized.endsWith("config.json");
}

function listLibraryDocuments(projectRoot = process.cwd()) {
  return LIBRARY_DOC_ALLOWLIST.flatMap((entry) => {
    if (!isLibraryPathExposed(entry.path)) return [];
    try {
      const fullPath = join(projectRoot, entry.path);
      if (!existsSync(fullPath)) return [];
      const stat = statSync(fullPath);
      if (!stat.isFile()) return [];
      const content = readFileSync(fullPath, "utf8");
      return [
        {
          id: entry.path,
          title: entry.title,
          path: entry.path,
          kind: entry.kind,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          content: content.slice(0, 40_000),
          truncated: content.length > 40_000,
        },
      ];
    } catch {
      return [];
    }
  });
}

function metadataProjectRoot(): string | undefined {
  try {
    return getRepoRoot();
  } catch {
    return undefined;
  }
}

const EXPOSE_SOCKET_HEADER_LINES = 15;
const EXPOSE_SOCKET_HEADER_MAX_BYTES = 8192;
const EXPOSE_SOCKET_HEADER_TIMEOUT_MS = 2000;

function parsePositiveHeaderInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitExposeHeader(buffer: Buffer): { header: string[]; rest: Buffer } | null {
  let newlineCount = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    newlineCount += 1;
    if (newlineCount !== EXPOSE_SOCKET_HEADER_LINES) continue;
    const header = buffer
      .subarray(0, index)
      .toString("utf8")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""));
    return { header, rest: buffer.subarray(index + 1) };
  }
  return null;
}

async function readExposeSocketHeader(socket: Socket): Promise<{ header: string[]; rest: Buffer }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("timed out reading expose socket launch header"));
    }, EXPOSE_SOCKET_HEADER_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("expose socket closed before launch header"));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > EXPOSE_SOCKET_HEADER_MAX_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error("expose socket launch header is too large"));
        return;
      }
      const parsed = splitExposeHeader(Buffer.concat(chunks, total));
      if (!parsed) return;
      cleanup();
      resolve(parsed);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

export interface MetadataServerOptions {
  projectRoot?: string;
  lifecycleMutationQueueLimit?: number;
  onChange?: () => void;
  events?: {
    bus?: ProjectEventBus;
  };
  diagnostics?: {
    pluginStatuses?: () => PluginRuntimePluginStatus[];
  };
  desktop?: {
    getState?: () => Record<string, unknown>;
    listWorktrees?: () => unknown[];
    getSessionDisplayContext?: (sessionId: string) => SessionAlertDisplayContext | undefined;
    refreshStatusline?: (input?: { sessionId?: string; force?: boolean }) => Promise<{ ok: true }> | { ok: true };
    createWorktree?: (input: {
      name: string;
    }) => Promise<{ path: string; status?: string }> | { path: string; status?: string };
    removeWorktree?: (input: { path: string }) => Promise<{ path: string }> | { path: string };
    graveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "graveyarded" }> | { path: string; status: "graveyarded" };
    listWorktreeGraveyard?: () => unknown[];
    resurrectGraveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "active" }> | { path: string; status: "active" };
    deleteGraveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "removed" }> | { path: string; status: "removed" };
    cleanupGraveyard?: (input: { dryRun?: boolean }) => Promise<unknown> | unknown;
    cleanupWorktreeCaches?: (input: { dryRun?: boolean; includeActive?: boolean }) => Promise<unknown> | unknown;
    createService?: (input: {
      command?: string;
      worktreePath?: string;
    }) => Promise<{ serviceId: string }> | { serviceId: string };
    stopService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "stopped" }> | { serviceId: string; status: "stopped" };
    resumeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "running" }> | { serviceId: string; status: "running" };
    removeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "removed" }> | { serviceId: string; status: "removed" };
    resumeAgent?: (input: {
      sessionId: string;
      session?: Record<string, unknown>;
    }) =>
      | Promise<{ sessionId: string; status: "running" | "offline" }>
      | { sessionId: string; status: "running" | "offline" };
    restoreAgent?: (input: {
      sessionId: string;
      session?: Record<string, unknown>;
    }) =>
      | Promise<{ sessionId: string; status: "running" | "offline" }>
      | { sessionId: string; status: "running" | "offline" };
    listGraveyard?: () => unknown[];
    resurrectGraveyard?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
  };
  threads?: {
    sendMessage?: (input: {
      threadId?: string;
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      worktreePath?: string;
      kind?: MessageKind;
      body: string;
      title?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
  };
  actions?: {
    sendHandoff?: (input: {
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      body: string;
      title?: string;
      worktreePath?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
    acceptHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    completeHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    acceptTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    blockTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    completeTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    approveReview?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    requestTaskChanges?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    reopenTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
  };
  lifecycle?: {
    spawnAgent?: (input: {
      tool: string;
      sessionId?: string;
      worktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
      overseer?: boolean;
    }) => Promise<{ sessionId: string }> | { sessionId: string };
    createTeammateAgent?: (input: {
      parentSessionId: string;
      role?: string;
      label?: string;
      tool?: string;
      sessionId?: string;
      worktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
      order?: number;
    }) =>
      | Promise<{
          sessionId: string;
          parentSessionId: string;
          teamId: string;
          role?: string;
          label?: string;
          reused?: true;
        }>
      | { sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string; reused?: true };
    forkAgent?: (input: {
      sourceSessionId: string;
      tool: string;
      targetSessionId?: string;
      instruction?: string;
      worktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
    }) => Promise<{ sessionId: string; threadId: string }> | { sessionId: string; threadId: string };
    switchAgentTool?: (input: {
      sessionId: string;
      tool: string;
      instruction?: string;
      launchOverride?: LaunchOverride;
    }) =>
      | Promise<{
          sessionId: string;
          tool: string;
          status: "running";
        }>
      | {
          sessionId: string;
          tool: string;
          status: "running";
        };
    stopAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
    interruptAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string }>
      | {
          sessionId: string;
        };
    resizeAgentPane?: (input: {
      sessionId: string;
      cols: number;
      rows: number;
    }) =>
      | Promise<{ sessionId: string; cols: number; rows: number }>
      | { sessionId: string; cols: number; rows: number };
    renameAgent?: (input: { sessionId: string; label?: string }) =>
      | Promise<{ sessionId: string; label?: string }>
      | {
          sessionId: string;
          label?: string;
        };
    migrateAgent?: (input: {
      sessionId: string;
      worktreePath: string;
    }) => Promise<{ sessionId: string; worktreePath?: string }> | { sessionId: string; worktreePath?: string };
    killAgent?: (input: { sessionId: string }) =>
      | Promise<{
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        }>
      | {
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        };
    recordBackendSessionId?: (input: {
      sessionId: string;
      backendSessionId: string;
    }) => Promise<{ sessionId: string; backendSessionId: string }> | { sessionId: string; backendSessionId: string };
    sendAgentInput?: (input: {
      sessionId: string;
      text: string;
      // When false, the call returns once the input is accepted and confirms the
      // tmux submit in the background (output arrives via SSE, not this response).
      waitForSubmit?: boolean;
      waitForActiveDraftIdle?: boolean;
    }) => Promise<{ sessionId: string; accepted: true }> | { sessionId: string; accepted: true };
    readAgentOutput?: (input: { sessionId: string; startLine?: number }) =>
      | Promise<{
          sessionId: string;
          output: string;
          outputAnsi?: string;
          startLine?: number;
          requestedStartLine?: number;
          endLine?: number;
          captureLineLimit?: number;
          outputTailOnly?: boolean;
          outputStartLineClamped?: boolean;
          parsed?: ParsedAgentOutput;
          messages?: AgentTranscriptMessage[];
          activity?: AgentActivityState;
          activityText?: string;
          attention?: AgentAttentionState;
        }>
      | {
          sessionId: string;
          output: string;
          outputAnsi?: string;
          startLine?: number;
          requestedStartLine?: number;
          endLine?: number;
          captureLineLimit?: number;
          outputTailOnly?: boolean;
          outputStartLineClamped?: boolean;
          parsed?: ParsedAgentOutput;
          messages?: AgentTranscriptMessage[];
          activity?: AgentActivityState;
          activityText?: string;
          attention?: AgentAttentionState;
        };
  };
  exposePreviewCache?: ExposePreviewCacheLike | false;
  exposePaneOutputTap?: ExposePaneOutputTapLike | false;
  exposeHotSnapshots?: boolean;
}

type MetadataReadAgentOutputResult = Awaited<
  ReturnType<NonNullable<NonNullable<MetadataServerOptions["lifecycle"]>["readAgentOutput"]>>
>;
type MetadataReadAgentOutputMeasurement = {
  result: MetadataReadAgentOutputResult;
  durationMs: number;
  coalesced: boolean;
};
type AgentOutputReadCoalescerEntry = {
  promise: Promise<MetadataReadAgentOutputResult>;
  expiresAt: number;
};
type AgentChatPreviewCacheEntry = {
  expiresAt: number;
  preview: NonNullable<FastControlItem["chatPreview"]> | null;
};

const AGENT_OUTPUT_READ_COALESCE_MS = 150;
const EXPOSE_HOT_SNAPSHOT_INITIAL_MS = 1500;
const EXPOSE_HOT_SNAPSHOT_INITIAL_JITTER_MS = 1500;
const EXPOSE_HOT_SNAPSHOT_REFRESH_MS = 3000;
const DESKTOP_STATE_CHAT_PREVIEW_CACHE_MS = 1500;
const WORKTREE_CACHE_CLEANUP_INITIAL_JITTER_MS = 300_000;
type InteractionDisplay = {
  title: string;
  message: string;
  summary?: string;
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stableJitterMs(value: string, rangeMs: number): number {
  if (rangeMs <= 0) return 0;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % rangeMs;
}

function parseObjectString(value: unknown): Record<string, unknown> | undefined {
  const text = trimmedString(value);
  if (!text || !text.startsWith("{")) return undefined;
  try {
    return objectRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function questionRecordsFromSource(source: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const questions = Array.isArray(source?.questions) ? source.questions : undefined;
  if (questions)
    return questions.map(objectRecord).filter((question): question is Record<string, unknown> => Boolean(question));
  const question = objectRecord(source);
  return question ? [question] : [];
}

function questionRecords(payload: InteractionPayload, summary?: string): Record<string, unknown>[] {
  const payloadQuestions = questionRecordsFromSource(objectRecord(payload)).filter((question) =>
    trimmedString(question.question),
  );
  if (payloadQuestions.length > 0) return payloadQuestions;
  return questionRecordsFromSource(parseObjectString(summary)).filter((question) => trimmedString(question.question));
}

function questionOptionLabels(question: Record<string, unknown>): string[] {
  const options = Array.isArray(question.options) ? question.options : [];
  return options
    .map((option) => {
      if (typeof option === "string") return option.trim();
      return trimmedString(objectRecord(option)?.label);
    })
    .filter((label): label is string => Boolean(label));
}

function formatQuestionText(question: Record<string, unknown>, index: number, total: number): string {
  const prompt = trimmedString(question.question) ?? "";
  const prefix = total > 1 ? `${index + 1}. ` : "";
  const labels = questionOptionLabels(question);
  return labels.length > 0 ? `${prefix}${prompt}\nOptions: ${labels.join("; ")}` : `${prefix}${prompt}`;
}

function summarizeInteractionForDisplay(input: {
  sessionId: string;
  type: InteractionType;
  payload: InteractionPayload;
  summary?: string;
}): InteractionDisplay {
  if (input.type === "question") {
    const questions = questionRecords(input.payload, input.summary);
    if (questions.length > 0) {
      const prompts = questions
        .map((question) => trimmedString(question.question))
        .filter((prompt): prompt is string => Boolean(prompt));
      return {
        title: "AskUserQuestion",
        message: questions.map((question, index) => formatQuestionText(question, index, questions.length)).join("\n\n"),
        summary: prompts.join("; "),
      };
    }
  }

  const summary = trimmedString(input.summary);
  const readableSummary = parseObjectString(summary) ? undefined : summary;
  return {
    title: `${input.sessionId} needs a response`,
    message: readableSummary ?? `Agent is waiting on a ${input.type} response.`,
    summary: readableSummary,
  };
}

function dashboardClientKeyFromSession(sessionName: string): string {
  return sessionName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function persistDashboardClientPreference(
  clientSession: string,
  update: (snapshot: Record<string, unknown>) => void,
): void {
  const path = getDashboardClientUiStatePath(dashboardClientKeyFromSession(clientSession));
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {}
  update(snapshot);
  writeJsonAtomic(path, snapshot);
}

function parseDashboardControlScreen(input: unknown): DashboardControlScreen | undefined {
  if (typeof input !== "string") return undefined;
  const screen = input.trim();
  if (
    screen === "dashboard" ||
    screen === "coordination" ||
    screen === "project" ||
    screen === "library" ||
    screen === "topology" ||
    screen === "graveyard"
  ) {
    return screen;
  }
  return undefined;
}

function persistDashboardReturnSelection(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string,
  currentWindowId?: string,
): void {
  persistDashboardClientPreference(currentClientSession, (snapshot) => {
    snapshot.screen = "dashboard";
    if (!currentWindowId) return;
    const match = tmux
      .listProjectManagedWindows(projectRoot)
      .find((entry) => entry.target.windowId === currentWindowId);
    if (!match) return;
    if (!tmux.isWindowAlive(match.target)) {
      delete snapshot.focusedWorktreePath;
      delete snapshot.level;
      delete snapshot.selectedEntryKind;
      delete snapshot.selectedEntryId;
      return;
    }
    snapshot.focusedWorktreePath = match.metadata.worktreePath;
    snapshot.level = "sessions";
    snapshot.selectedEntryKind = match.metadata.kind === "service" ? "service" : "session";
    snapshot.selectedEntryId = match.metadata.sessionId;
  });
}

function markActiveWindowFocused(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string | undefined,
  currentWindow: string | undefined,
  currentWindowId: string | undefined,
): boolean {
  if (currentWindow && isDashboardWindowName(currentWindow)) {
    if (!currentWindowId) return false;
    const dashboardTarget = findExistingDashboardTarget(tmux, projectRoot, currentClientSession);
    if (dashboardTarget?.windowId !== currentWindowId) return false;
    updateNotificationContext(
      "tui",
      {
        focused: true,
        screen: "dashboard",
        panelOpen: false,
        sessionId: undefined,
      },
      metadataProjectRoot() ?? projectRoot,
    );
    return true;
  }
  if (!currentWindowId) return false;
  const match = findProjectManagedWindow(tmux, projectRoot, { windowId: currentWindowId });
  if (!match) return false;
  updateNotificationContext(
    "tui",
    {
      focused: true,
      screen: match.metadata.kind === "service" ? "service" : "agent",
      sessionId: match.metadata.sessionId,
      panelOpen: false,
    },
    metadataProjectRoot() ?? projectRoot,
  );
  if (match.metadata.kind === "agent") {
    markSessionViewed(match.metadata.sessionId, metadataProjectRoot() ?? projectRoot);
  }
  markTargetUsed(tmux, projectRoot, match.target, currentClientSession, match.metadata.sessionId);
  return true;
}

function markTargetUsed(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  target: TmuxTarget,
  currentClientSession?: string,
  itemId?: string,
): void {
  const resolvedItemId =
    itemId ||
    tmux
      .listManagedWindows(tmux.getProjectSession(projectRoot).sessionName)
      .find((entry) => entry.target.windowId === target.windowId)?.metadata.sessionId;
  if (!resolvedItemId) return;
  markLastUsed(projectRoot, {
    itemId: resolvedItemId,
    clientSession: currentClientSession,
  });
}

function desiredPort(): number {
  const hash = createHash("sha1").update(getProjectId()).digest("hex").slice(0, 6);
  return 43000 + (parseInt(hash, 16) % 10000);
}

// Plan paths join this directly into `${sessionId}.md`, so restrict to a
// conservative charset (no whitespace, no separators, no traversal) and
// cap length so we don't produce surprising filenames.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const PROJECT_SERVICE_SLOW_REQUEST_MS = 250;
const PROJECT_SERVICE_RECENT_SLOW_REQUEST_LIMIT = 25;
const PROJECT_SERVICE_SLOW_REQUEST_EXCLUDED_PATHS = new Set<string>([
  PROJECT_API_ROUTES.events,
  PROJECT_API_ROUTES.agents.outputStream,
  PROJECT_API_ROUTES.agents.interactionStream,
  PROJECT_API_ROUTES.agents.interactionRequest,
  PROJECT_API_ROUTES.agents.interactionWait,
]);
const CORS_ALLOWED_ORIGINS = new Set([
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:8091",
  "http://127.0.0.1:8091",
  "http://localhost:43192",
  "http://127.0.0.1:43192",
]);
const DESKTOP_STATE_CACHE_TTL_MS = 10_000;
const DESKTOP_STATE_STALE_REFRESH_DELAY_MS = 1_000;
const DESKTOP_STATE_PREVIEW_MAX_CHARS = 8_192;
const DESKTOP_STATE_CHAT_PREVIEW_START_LINE = -80;
const DESKTOP_STATE_CHAT_PREVIEW_MAX_MESSAGES = 3;

function mergeExposePreviewSnapshots(
  captureSnapshot: ExposePreviewSnapshot | undefined,
  tapSnapshot:
    | {
        output: string;
        capturedAt: string;
        source: "tap";
        windowId: string;
      }
    | undefined,
): ExposePreviewSnapshot | undefined {
  if (!tapSnapshot) return captureSnapshot;
  if (!captureSnapshot) {
    return {
      output: tapSnapshot.output,
      capturedAt: tapSnapshot.capturedAt,
      source: tapSnapshot.source,
      windowId: tapSnapshot.windowId,
    };
  }
  if (!tapSnapshot.output) return captureSnapshot;
  if (!captureSnapshot.output) {
    return {
      output: tapSnapshot.output,
      capturedAt: tapSnapshot.capturedAt,
      source: tapSnapshot.source,
      windowId: tapSnapshot.windowId,
    };
  }
  if (captureSnapshot.output.endsWith(tapSnapshot.output)) return captureSnapshot;
  if (tapSnapshot.output.startsWith(captureSnapshot.output)) {
    return {
      output: tapSnapshot.output,
      capturedAt: tapSnapshot.capturedAt,
      source: tapSnapshot.source,
      windowId: tapSnapshot.windowId,
    };
  }
  const separator = captureSnapshot.output.endsWith("\n") || tapSnapshot.output.startsWith("\n") ? "" : "\n";
  return {
    output: `${captureSnapshot.output}${separator}${tapSnapshot.output}`,
    capturedAt: tapSnapshot.capturedAt,
    source: tapSnapshot.source,
    windowId: tapSnapshot.windowId,
  };
}

/**
 * How long a forced rebuild answers for the forced rebuilds behind it.
 *
 * Sized under the tightest caller cadence — the worktree settle poll's 100ms —
 * so a loop that forces in order to watch for an async completion still gets a
 * real rebuild every poll. It exists only to absorb the burst of every
 * connected dashboard forcing within a beat of one change event.
 */
const DESKTOP_STATE_FORCED_COALESCE_MS = 90;

interface ProjectServiceResourceSnapshot {
  uptimeMs: number;
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
  activeHandles?: number;
  activeRequests?: number;
  openFileDescriptors?: number;
}

interface ProjectServiceSlowRequest {
  ts: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  resources: ProjectServiceResourceSnapshot;
}

interface PendingShellStateUpdate {
  state: string;
  sessionId: string;
  tool?: string;
  command?: string;
}

const SHELL_STATES = new Set(["running", "command", "busy", "prompt", "idle"]);

function validateSessionId(raw: string): { ok: true; value: string } | { ok: false } {
  if (!SESSION_ID_PATTERN.test(raw)) return { ok: false };
  if (raw.includes("..")) return { ok: false };
  return { ok: true, value: raw };
}

function consumeShellStateSuppressFile(sessionId: string): boolean {
  const validated = validateSessionId(sessionId);
  if (!validated.ok) return false;
  const path = join(getProjectStateDir(), "shell-state-suppress", validated.value);
  if (!existsSync(path)) return false;
  try {
    const remaining = Math.max(1, Number.parseInt(readFileSync(path, "utf-8").trim(), 10) || 1) - 1;
    if (remaining > 0) {
      writeFileSync(path, String(remaining));
    } else {
      rmSync(path, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Generous for every body this server takes — the largest is a prompt — and
 * far below anything that threatens the process.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Thrown when a request body is refused before it is parsed. */
class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

/**
 * Read a body, refusing one too big to hold.
 *
 * The cap is enforced while the stream arrives, not after: buffering a
 * gigabyte and then rejecting it has already done the damage. This server
 * binds loopback and has no authentication, so anything local — including a
 * page in a browser, since it answers with `access-control-allow-origin: *` —
 * can post to it, and an unbounded read is an out-of-memory away.
 */
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      req.destroy();
      throw new BodyTooLarge(limit);
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  if (!res.hasHeader("access-control-allow-origin")) {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader("connection", "close");
  res.end(payload);
}

function requestHeaderRecord(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[name] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[name] = value.join(", ");
    }
  }
  return headers;
}

type SharedChatActorRole = "owner" | "guest";

interface SharedChatActorForPrompt {
  role: SharedChatActorRole;
  displayName?: string;
  email?: string;
}

function trimmedBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodySharedChatActor(body: unknown): SharedChatActorForPrompt | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).sharedChatActor;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = record.role;
  if (role !== "owner" && role !== "guest") return null;
  const displayName = trimmedBodyString(record.displayName);
  const email = trimmedBodyString(record.email);
  if (!displayName && !email) return null;
  return { role, displayName, email };
}

function hostedAttachmentFromBody(value: unknown): HostedAttachmentReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.contentUrl !== "string" || typeof record.expiresAt !== "string") return undefined;
  return {
    contentUrl: record.contentUrl,
    expiresAt: record.expiresAt,
    sha256: typeof record.sha256 === "string" ? record.sha256 : undefined,
    sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
  };
}

function safeSharedChatActorName(actor: SharedChatActorForPrompt): string {
  const fallback = actor.role === "owner" ? "chat owner" : "shared guest";
  const raw = actor.displayName?.trim() || actor.email?.trim() || fallback;
  return raw.replace(/\s+/g, " ").slice(0, 80) || fallback;
}

function formatSharedChatAgentInput(text: string, actor: SharedChatActorForPrompt): string {
  return `[${safeSharedChatActorName(actor)}] ${text.trim()}`;
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, mimeType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", mimeType);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader("x-content-type-options", "nosniff");
  if (!res.hasHeader("access-control-allow-origin")) {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader("connection", "close");
  res.end(body);
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (CORS_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && !isAllowedCorsOrigin(origin)) return false;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (origin && req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  return true;
}

function rejectCors(res: ServerResponse): void {
  const payload = JSON.stringify({ ok: false, error: "origin not allowed" });
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("connection", "close");
  res.end(payload);
}

function countOpenFileDescriptors(): number | undefined {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return undefined;
  }
}

function activeProcessCount(kind: "_getActiveHandles" | "_getActiveRequests"): number | undefined {
  const fn = (process as unknown as Record<string, unknown>)[kind];
  if (typeof fn !== "function") return undefined;
  try {
    const value = (fn as () => unknown[])();
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function projectServiceResourceSnapshot(
  options: { includeFileDescriptors?: boolean } = {},
): ProjectServiceResourceSnapshot {
  const memory = process.memoryUsage();
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    memoryRssBytes: memory.rss,
    memoryHeapUsedBytes: memory.heapUsed,
    activeHandles: activeProcessCount("_getActiveHandles"),
    activeRequests: activeProcessCount("_getActiveRequests"),
    ...(options.includeFileDescriptors ? { openFileDescriptors: countOpenFileDescriptors() } : {}),
  };
}

function controlFocusRequested(body: Record<string, unknown>, url: URL): boolean {
  const raw = body.focus ?? url.searchParams.get("focus");
  return raw === true || raw === "true" || raw === "1";
}

function isProjectClientSession(tmux: TmuxRuntimeManager, projectRoot: string, sessionName: string): boolean {
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  return sessionName === hostSession || isTmuxClientSessionForHost(sessionName, hostSession);
}

function validateProjectClientSession(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string | undefined,
): string | undefined {
  if (!currentClientSession) return undefined;
  if (!isProjectClientSession(tmux, projectRoot, currentClientSession) || !tmux.hasSession(currentClientSession)) {
    return "currentClientSession is not a project client";
  }
  return undefined;
}

function validateControlFocusContext(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string | undefined,
  clientTty: string | undefined,
  focus: boolean,
): string | undefined {
  if (!focus) return undefined;
  if (!clientTty) return "clientTty is required";
  const client = tmux.findClientByTty(clientTty);
  if (!client) return "clientTty is not attached";
  if (!isProjectClientSession(tmux, projectRoot, client.sessionName)) {
    return "clientTty is not attached to this project";
  }
  return undefined;
}

function resolveControlFocusClientSession(
  tmux: TmuxRuntimeManager,
  currentClientSession: string | undefined,
  clientTty: string | undefined,
  focus: boolean,
): string | undefined {
  if (!focus) return currentClientSession;
  return (clientTty ? tmux.findClientByTty(clientTty)?.sessionName : undefined) ?? currentClientSession;
}

function findExistingDashboardTarget(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string | undefined,
): TmuxTarget | null {
  const { dashboardBuildStamp } = getDashboardCommandSpec(projectRoot);
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  const sessionNames = tmux
    .listSessionNames()
    .filter((sessionName) => sessionName === hostSession || isTmuxClientSessionForHost(sessionName, hostSession));
  const orderedSessionNames = [
    ...(currentClientSession && sessionNames.includes(currentClientSession) ? [currentClientSession] : []),
    ...sessionNames,
  ].filter((sessionName, index, array) => array.indexOf(sessionName) === index);

  for (const sessionName of orderedSessionNames) {
    for (const window of tmux.listWindows(sessionName)) {
      if (!isDashboardWindowName(window.name)) continue;
      const target = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
      };
      if (!isUsableDashboardTarget(tmux, projectRoot, dashboardBuildStamp, target)) continue;
      return target;
    }
  }
  return null;
}

function findProjectManagedWindow(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  matcher: { windowId?: string; sessionId?: string },
): { target: TmuxTarget; metadata: TmuxWindowMetadata } | null {
  const candidates = tmux.listProjectManagedWindows(projectRoot).filter((entry) => tmux.isWindowAlive(entry.target));
  const exact =
    candidates.find(
      (entry) =>
        (matcher.windowId ? entry.target.windowId === matcher.windowId : true) &&
        (matcher.sessionId ? entry.metadata.sessionId === matcher.sessionId : true),
    ) ?? null;
  if (exact || !matcher.windowId || !matcher.sessionId) return exact;
  return candidates.find((entry) => entry.metadata.sessionId === matcher.sessionId) ?? null;
}

function serializeControlTarget(target: TmuxTarget): Record<string, unknown> {
  return {
    sessionName: target.sessionName,
    windowId: target.windowId,
    windowIndex: target.windowIndex,
    windowName: target.windowName,
  };
}

function focusControlTarget(
  tmux: TmuxRuntimeManager,
  target: TmuxTarget,
  currentClientSession: string | undefined,
  clientTty: string | undefined,
  focus: boolean,
): { focused: boolean; focusMode?: string } {
  if (!focus) return { focused: false };
  return openTargetForClient(tmux, target, currentClientSession, clientTty);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDashboardReady(
  tmux: TmuxRuntimeManager,
  target: TmuxTarget,
  dashboardBuildStamp: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tmux.getWindowOption(target, TMUX_DASHBOARD_READY_OPTION) === dashboardBuildStamp) return true;
    await sleep(50);
  }
  return false;
}

function sendControlAction(
  res: ServerResponse,
  action: string,
  target: TmuxTarget | undefined,
  focusResult: { focused: boolean; focusMode?: string },
  itemId?: string,
): void {
  send(res, 200, {
    ok: true,
    action,
    ...focusResult,
    ...(target ? { target: serializeControlTarget(target) } : {}),
    ...(itemId ? { itemId } : {}),
  });
}

function formatAgentInputWithAttachments(text: string, attachments: AttachmentRecord[]): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) return text;

  const body = trimmedText || "Please review the attached file(s).";
  const attachmentLines = attachments.map((attachment) => {
    return `- ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.contentPath}`;
  });

  return `${body}\n\nAttached files:\n${attachmentLines.join("\n")}`;
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseOptionalInteger(
  raw: string | null,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true };
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${field} must be an integer` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} must be a safe integer` };
  return { ok: true, value };
}

function parseIntegerValue(value: unknown, field: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} must be an integer` };
    return { ok: true, value };
  }
  if (typeof value !== "string") return { ok: false, error: `${field} must be an integer` };
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${field} must be an integer` };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { ok: false, error: `${field} must be a safe integer` };
  return { ok: true, value: parsed };
}

function parsePositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseIntegerValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value < 1) return { ok: false, error: `${field} must be an integer >= 1` };
  return parsed;
}

const DEFAULT_PROJECT_LIST_LIMIT = 200;
const MAX_PROJECT_LIST_LIMIT = 500;
const DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT = 500;
const MAX_PROJECT_DETAIL_MESSAGE_LIMIT = 1_000;

function parseBoundedLimit(
  raw: string | null,
  field: string,
  defaults: { defaultValue: number; maxValue: number },
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, value: defaults.defaultValue };
  const parsed = parsePositiveInteger(raw, field);
  if (!parsed.ok) return parsed;
  return { ok: true, value: Math.min(parsed.value, defaults.maxValue) };
}

type DesktopSessionRecord = Record<string, unknown> & {
  id: string;
  createdAt?: string;
  status?: string;
  team?: SessionTeamMetadata;
};

interface TeammateTaskBody {
  title?: string;
  description?: string;
  body?: string;
  prompt?: string;
  worktreePath?: string;
}

function topologyDesktopSessionList(statuses: RuntimeTopologySessionStatus[]): DesktopSessionRecord[] {
  const tools = loadConfig().tools;
  return listTopologySessionStates({ statuses }).map((session: RuntimeTopologySessionState) => {
    const status = session.status ?? "offline";
    const restorability =
      status === "offline"
        ? describeSessionRestorability(
            { ...session, status, freshRelaunchAllowed: shouldRelaunchFreshSession(session, getRepoRoot()) },
            tools,
          )
        : undefined;
    return {
      ...session,
      status,
      restoreState: restorability?.restoreState,
      restoreBlockedReason: restorability?.restoreBlockedReason,
      team: session.team as SessionTeamMetadata | undefined,
    };
  });
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function teammateTaskDescription(body: TeammateTaskBody): string {
  const explicitTitle = typeof body.title === "string" ? body.title.trim() : "";
  if (explicitTitle) return explicitTitle;
  const explicitDescription = typeof body.description === "string" ? body.description.trim() : "";
  if (explicitDescription) return explicitDescription;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const bodyText = typeof body.body === "string" ? body.body.trim() : "";
  const text = bodyText || prompt;
  const line = firstLine(text);
  return line ? line.slice(0, 120) : "Teammate task";
}

function teammateTaskPrompt(body: TeammateTaskBody): string | undefined {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt) return prompt;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  return text || undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SESSION_LOOP_SOURCES = new Set<SessionLoopSource>([
  "human",
  "dashboard",
  "overseer",
  "agent",
  "task",
  "system",
  "unknown",
]);

const SESSION_LOOP_ACTIONS = new Set<SessionLoopAction>(["add", "remove", "done", "block"]);

function boundedOptionalString(value: unknown, maxLength = 500): string | undefined {
  const text = optionalString(value);
  return text ? text.slice(0, maxLength) : undefined;
}

function sessionLoopSource(value: unknown): SessionLoopSource | undefined {
  const text = optionalString(value);
  return text && SESSION_LOOP_SOURCES.has(text as SessionLoopSource) ? (text as SessionLoopSource) : undefined;
}

function sessionLoopAction(value: unknown, fallback: SessionLoopAction): SessionLoopAction {
  const text = optionalString(value);
  return text && SESSION_LOOP_ACTIONS.has(text as SessionLoopAction) ? (text as SessionLoopAction) : fallback;
}

function sessionLoopProvenance(body: Record<string, unknown>): SessionLoopProvenance {
  return {
    source: sessionLoopSource(body.source),
    updatedBy: boundedOptionalString(body.updatedBy),
    updatedBySessionId: boundedOptionalString(body.updatedBySessionId),
    updatedByRole: boundedOptionalString(body.updatedByRole),
    reason: boundedOptionalString(body.reason, 2000),
  };
}

function optionalStringOrFirst(value: unknown): string | undefined {
  if (typeof value === "string") return optionalString(value);
  if (!Array.isArray(value)) return undefined;
  return value.map(optionalString).find(Boolean);
}

function optionalStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const entry = optionalString(value);
    return entry ? [entry] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map(optionalString).filter((entry): entry is string => Boolean(entry));
}

function routeRecipients(input: { to?: unknown; assignee?: unknown; tool?: unknown }): string[] {
  const explicit = optionalStringArray(input.to);
  if (explicit.length > 0) return explicit;
  return [optionalString(input.assignee), optionalString(input.tool)].filter((entry): entry is string =>
    Boolean(entry),
  );
}

function teammateApiRecord(session: DesktopSessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    sessionId: session.id,
    tool: session.command,
    command: session.command,
    label: session.team?.label ?? session.label,
    role: session.team?.role,
    status: session.status,
    worktreePath: session.worktreePath,
    headline: session.headline,
    preview: session.preview,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    pending: session.pending,
    pendingAction: session.pendingAction,
    team: session.team,
  };
}

export class MetadataServer {
  private server: Server | null = null;
  private port = 0;
  private readonly projectRoot: string | undefined;
  private tracker = new AgentTracker();
  private readonly interactions = new InteractionRegistry();
  private interactionWatchers = 0;
  private readonly eventBus: ProjectEventBus;
  private unsubscribeAlertSink: (() => void) | null = null;
  private readonly recentSlowRequests: ProjectServiceSlowRequest[] = [];
  private desktopStateCache: { ts: number; state: Record<string, unknown> } | null = null;
  private desktopStateCacheDirty = false;
  private desktopStateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private desktopStateRefreshing = false;
  private lastProjectChangeAt = 0;
  private readonly pendingShellStateUpdates: PendingShellStateUpdate[] = [];
  private shellStateFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private exposeServer: NetServer | null = null;
  private exposeSocketPath: string | null = null;
  private readonly exposePreviewCache: ExposePreviewCacheLike | null;
  private readonly exposePaneOutputTap: ExposePaneOutputTapLike | null;
  private readonly visualClientLeases = new VisualClientLeaseRegistry();
  private readonly exposeHotSnapshotsEnabled: boolean;
  private readonly agentOutputReadCoalescer = new Map<string, AgentOutputReadCoalescerEntry>();
  private readonly agentChatPreviewCache = new Map<string, AgentChatPreviewCacheEntry>();
  private exposeHotSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private exposeHotSnapshotRefreshing = false;
  private exposeHotSnapshotWorker: Worker | null = null;
  private worktreeCacheCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private worktreeCacheCleanupRunning = false;
  private readonly promptContexts = new PromptContextStore();
  private lifecycleMutationQueue: Promise<void> = Promise.resolve();
  private readonly lifecycleMutationTargets = new Map<string, LifecycleTransitionInput>();
  private lifecycleMutationQueuedCount = 0;
  private readonly lifecycleMutationTelemetry: LifecycleMutationTelemetry = {
    enqueued: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    released: 0,
    rejectedConflicts: 0,
    rejectedQueueFull: 0,
    maxQueuedCount: 0,
    maxQueuedMs: 0,
    maxDurationMs: 0,
    lastStartedAt: null,
    lastSettledAt: null,
    lastError: null,
  };

  constructor(private readonly options: MetadataServerOptions = {}) {
    this.projectRoot = options.projectRoot?.trim() || metadataProjectRoot();
    const defaultExposePreviewCache = options.lifecycle?.readAgentOutput
      ? new ExposePreviewCache({
          projectRoot: this.currentProjectRoot(),
        })
      : null;
    const defaultExposePaneOutputTap = options.lifecycle?.readAgentOutput
      ? new ExposePaneOutputTap({
          projectStateDir: getProjectStateDirFor(this.currentProjectRoot()),
        })
      : null;
    this.exposePreviewCache =
      options.exposePreviewCache === false ? null : (options.exposePreviewCache ?? defaultExposePreviewCache);
    this.exposePaneOutputTap =
      options.exposePaneOutputTap === false ? null : (options.exposePaneOutputTap ?? defaultExposePaneOutputTap);
    this.exposeHotSnapshotsEnabled = options.exposeHotSnapshots ?? Boolean(options.lifecycle?.readAgentOutput);
    this.eventBus = options.events?.bus ?? new ProjectEventBus();
    this.unsubscribeAlertSink = this.eventBus.subscribe((event) => {
      if (event.type !== "alert") return;
      this.scheduleDesktopStateRefresh();
      notifyAlert(event);
    });
  }

  private enqueueLifecycleMutation<T>(action: () => Promise<T> | T, transition?: LifecycleTransitionInput): Promise<T> {
    const targetKey = transition ? lifecycleTargetKey(transition) : undefined;
    if (targetKey && transition && this.lifecycleMutationTargets.has(targetKey)) {
      this.lifecycleMutationTelemetry.rejectedConflicts += 1;
      throw new LifecycleMutationConflictError(transition, this.lifecycleMutationTargets.get(targetKey)!);
    }
    const queueLimit = this.options.lifecycleMutationQueueLimit ?? 32;
    if (transition && this.lifecycleMutationQueuedCount >= queueLimit) {
      this.lifecycleMutationTelemetry.rejectedQueueFull += 1;
      throw new LifecycleMutationQueueFullError(transition, this.lifecycleMutationQueuedCount, queueLimit);
    }
    if (targetKey && transition) this.lifecycleMutationTargets.set(targetKey, transition);
    const queueDepthAtEnqueue = this.lifecycleMutationQueuedCount;
    const queueDepthAfterEnqueue = queueDepthAtEnqueue + 1;
    this.lifecycleMutationTelemetry.enqueued += 1;
    this.lifecycleMutationTelemetry.maxQueuedCount = Math.max(
      this.lifecycleMutationTelemetry.maxQueuedCount,
      queueDepthAfterEnqueue,
    );
    const operationId = transition
      ? `${transition.operation}:${transition.targetId ?? transition.targetPath ?? "unknown"}:${randomUUID()}`
      : undefined;
    if (transition) {
      log.info("lifecycle mutation enqueued", "api", {
        operationId,
        operation: transition.operation,
        targetKind: transition.targetKind,
        targetId: transition.targetId,
        targetPath: transition.targetPath,
        queueDepth: queueDepthAtEnqueue,
        queueLimit,
      });
    }
    this.lifecycleMutationQueuedCount += 1;
    const queuedAt = Date.now();
    const queued = this.lifecycleMutationQueue
      .catch(() => undefined)
      .then(async () => {
        if (transition) {
          const queuedMs = Date.now() - queuedAt;
          this.lifecycleMutationTelemetry.started += 1;
          this.lifecycleMutationTelemetry.maxQueuedMs = Math.max(this.lifecycleMutationTelemetry.maxQueuedMs, queuedMs);
          this.lifecycleMutationTelemetry.lastStartedAt = new Date().toISOString();
          log.info("lifecycle mutation started", "api", {
            operationId,
            operation: transition.operation,
            targetKind: transition.targetKind,
            targetId: transition.targetId,
            targetPath: transition.targetPath,
            queuedMs,
            queueDepthAtStart: this.lifecycleMutationQueuedCount,
          });
        }
        const startedAt = Date.now();
        try {
          const result = await action();
          const durationMs = Date.now() - startedAt;
          this.lifecycleMutationTelemetry.succeeded += 1;
          this.lifecycleMutationTelemetry.maxDurationMs = Math.max(
            this.lifecycleMutationTelemetry.maxDurationMs,
            durationMs,
          );
          this.lifecycleMutationTelemetry.lastSettledAt = new Date().toISOString();
          this.lifecycleMutationTelemetry.lastError = null;
          if (transition) {
            log.info("lifecycle mutation succeeded", "api", {
              operationId,
              operation: transition.operation,
              targetKind: transition.targetKind,
              targetId: transition.targetId,
              targetPath: transition.targetPath,
              durationMs,
            });
          }
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          this.lifecycleMutationTelemetry.failed += 1;
          this.lifecycleMutationTelemetry.maxDurationMs = Math.max(
            this.lifecycleMutationTelemetry.maxDurationMs,
            durationMs,
          );
          this.lifecycleMutationTelemetry.lastSettledAt = new Date().toISOString();
          this.lifecycleMutationTelemetry.lastError = userFacingErrorMessage(error);
          if (transition) {
            log.warn("lifecycle mutation failed", "api", {
              operationId,
              operation: transition.operation,
              targetKind: transition.targetKind,
              targetId: transition.targetId,
              targetPath: transition.targetPath,
              durationMs,
              error: userFacingErrorMessage(error),
            });
          }
          throw error;
        }
      });
    const tracked = queued.finally(() => {
      this.lifecycleMutationQueuedCount = Math.max(0, this.lifecycleMutationQueuedCount - 1);
      this.lifecycleMutationTelemetry.released += 1;
      if (targetKey && this.lifecycleMutationTargets.get(targetKey) === transition) {
        this.lifecycleMutationTargets.delete(targetKey);
      }
      if (transition) {
        log.info("lifecycle mutation released", "api", {
          operationId,
          operation: transition.operation,
          targetKind: transition.targetKind,
          targetId: transition.targetId,
          targetPath: transition.targetPath,
          queueDepth: this.lifecycleMutationQueuedCount,
        });
      }
    });
    this.lifecycleMutationQueue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private lifecycleDiagnostics() {
    const queueLimit = this.options.lifecycleMutationQueueLimit ?? 32;
    const activeTargets = [...this.lifecycleMutationTargets.entries()].map(([key, transition]) => ({
      key,
      operation: transition.operation,
      targetKind: transition.targetKind,
      targetId: transition.targetId,
      targetPath: transition.targetPath,
    }));
    return {
      ok: true,
      pid: process.pid,
      projectRoot: this.currentProjectRoot(),
      queuedCount: this.lifecycleMutationQueuedCount,
      queueLimit,
      activeTargets,
      telemetry: { ...this.lifecycleMutationTelemetry },
    };
  }

  private notifyLifecycleSettled(
    promise: Promise<unknown>,
    notifyCurrentRouteChange: () => void,
    action: string,
  ): void {
    void promise.then(
      () => notifyCurrentRouteChange(),
      (error: unknown) => {
        log.warn(`${action} failed after async acceptance`, "api", {
          error: userFacingErrorMessage(error),
        });
        notifyCurrentRouteChange();
      },
    );
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      void this.runInProjectContext(() => this.handle(req, res)).catch((error: unknown) => {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
    await this.listen(desiredPort()).catch(async () => {
      await this.listen(0);
    });
    this.publishEndpoint();
    await this.startExposeSocket().catch((error: unknown) => {
      this.stopExposeSocket();
      log.warn("expose socket startup failed", "api", {
        projectRoot: this.currentProjectRoot(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.exposePreviewCache?.start();
    this.exposePaneOutputTap?.start();
    const initialDelay =
      EXPOSE_HOT_SNAPSHOT_INITIAL_MS + stableJitterMs(this.currentProjectRoot(), EXPOSE_HOT_SNAPSHOT_INITIAL_JITTER_MS);
    this.scheduleExposeHotSnapshotRefresh(initialDelay);
    const config = loadConfig({ projectRoot: this.currentProjectRoot() });
    const cacheCleanupDelay =
      config.worktrees.cacheCleanupInitialDelayMs +
      stableJitterMs(
        this.currentProjectRoot(),
        Math.min(config.worktrees.cacheCleanupInitialDelayMs, WORKTREE_CACHE_CLEANUP_INITIAL_JITTER_MS),
      );
    this.scheduleWorktreeCacheCleanup(cacheCleanupDelay);
  }

  private publishEndpoint(): void {
    const existing = loadMetadataEndpoint(this.projectRoot);
    if (existing?.host === "127.0.0.1" && existing.port === this.port && existing.pid === process.pid) return;
    saveMetadataEndpoint(
      {
        host: "127.0.0.1",
        port: this.port,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      },
      this.projectRoot,
    );
  }

  ensureEndpointPublished(): void {
    if (!this.server || this.port === 0) return;
    this.publishEndpoint();
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.stopExposeSocket();
    this.exposePreviewCache?.stop();
    this.exposePaneOutputTap?.stop();
    if (this.exposeHotSnapshotTimer) clearTimeout(this.exposeHotSnapshotTimer);
    this.exposeHotSnapshotTimer = null;
    this.exposeHotSnapshotRefreshing = false;
    if (this.worktreeCacheCleanupTimer) clearTimeout(this.worktreeCacheCleanupTimer);
    this.worktreeCacheCleanupTimer = null;
    this.worktreeCacheCleanupRunning = false;
    this.exposeHotSnapshotWorker?.terminate().catch(() => {});
    this.exposeHotSnapshotWorker = null;
    if (this.desktopStateRefreshTimer) clearTimeout(this.desktopStateRefreshTimer);
    this.desktopStateRefreshTimer = null;
    if (this.shellStateFlushTimer) clearTimeout(this.shellStateFlushTimer);
    this.shellStateFlushTimer = null;
    this.pendingShellStateUpdates.length = 0;
    this.desktopStateRefreshing = false;
    this.unsubscribeAlertSink?.();
    this.unsubscribeAlertSink = null;
  }

  private stopExposeSocket(): void {
    this.exposeServer?.close();
    this.exposeServer = null;
    if (this.exposeSocketPath) rmSync(this.exposeSocketPath, { force: true });
    rmSync(join(getProjectStateDirFor(this.currentProjectRoot()), "expose.sock.path"), { force: true });
    this.exposeSocketPath = null;
  }

  private async startExposeSocket(): Promise<void> {
    if (this.exposeServer) return;
    const projectStateDir = getProjectStateDirFor(this.currentProjectRoot());
    const legacySocketPath = join(projectStateDir, "expose.sock");
    const socketPath =
      Buffer.byteLength(legacySocketPath) < 100
        ? legacySocketPath
        : join(tmpdir(), `aimux-expose-${createHash("sha1").update(projectStateDir).digest("hex").slice(0, 16)}.sock`);
    rmSync(socketPath, { force: true });
    rmSync(join(projectStateDir, "expose.sock.path"), { force: true });
    this.exposeServer = createNetServer((socket) => {
      socket.on("error", () => {
        socket.destroy();
      });
      void this.runInProjectContext(() => this.handleExposeSocket(socket)).catch(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.exposeServer!.once("error", reject);
      this.exposeServer!.listen(socketPath, () => {
        this.exposeServer!.off("error", reject);
        this.exposeSocketPath = socketPath;
        writeFileSync(join(projectStateDir, "expose.sock.path"), `${socketPath}\n`);
        resolve();
      });
    });
  }

  private async handleExposeSocket(socket: Socket): Promise<void> {
    const { header, rest } = await readExposeSocketHeader(socket);
    const input = new PassThrough();
    if (rest.length) input.write(rest);
    socket.pipe(input);
    const code = await runTmuxExpose({
      projectRoot: header[0] || this.currentProjectRoot(),
      projectStateDir: header[1] || getProjectStateDirFor(this.currentProjectRoot()),
      currentClientSession: header[2] || undefined,
      clientTty: header[3] || undefined,
      currentWindow: header[4] || undefined,
      currentWindowId: header[5] || undefined,
      currentPath: header[6] || undefined,
      paneId: header[7] || undefined,
      aimuxHome: header[8] || undefined,
      daemonEndpoint: header[13] || undefined,
      selectionFile: header[14] || undefined,
      input,
      output: socket,
      manageTerminal: false,
      columns: parsePositiveHeaderInteger(header[11]),
      rows: parsePositiveHeaderInteger(header[12]),
    });
    if (header[10]) {
      try {
        writeFileSync(header[10], `${code}\n`);
      } catch {}
    }
    socket.unpipe(input);
    input.destroy();
    socket.end();
    socket.destroy();
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server || this.port === 0) return null;
    return { host: "127.0.0.1", port: this.port };
  }

  getEventBus(): ProjectEventBus {
    return this.eventBus;
  }

  private runInProjectContext<T>(fn: () => T): T {
    return this.projectRoot ? withProjectPaths(this.projectRoot, fn) : fn();
  }

  private async measureAgentOutputRead(
    source: AgentOutputReadSource,
    input: { sessionId: string; startLine?: number },
  ): Promise<MetadataReadAgentOutputMeasurement> {
    if (!this.options.lifecycle?.readAgentOutput) {
      throw new Error("agent output not supported by this service");
    }
    const startedAt = performance.now();
    const coalesceKey = `${input.sessionId}\0${input.startLine ?? ""}`;
    const now = Date.now();
    const existing = this.agentOutputReadCoalescer.get(coalesceKey);
    if (existing && existing.expiresAt > now) {
      try {
        return {
          result: await existing.promise,
          durationMs: performance.now() - startedAt,
          coalesced: true,
        };
      } catch (error) {
        recordAgentOutputReadMetric({
          source,
          sessionId: input.sessionId,
          requestedStartLine: input.startLine,
          durationMs: performance.now() - startedAt,
          coalesced: true,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const promise = Promise.resolve(this.options.lifecycle.readAgentOutput(input));
    const entry: AgentOutputReadCoalescerEntry = {
      promise,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.agentOutputReadCoalescer.set(coalesceKey, entry);
    let retainSettledResult = false;

    try {
      const result = await promise;
      retainSettledResult = true;
      return { result, durationMs: performance.now() - startedAt, coalesced: false };
    } catch (error) {
      recordAgentOutputReadMetric({
        source,
        sessionId: input.sessionId,
        requestedStartLine: input.startLine,
        durationMs: performance.now() - startedAt,
        coalesced: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (!retainSettledResult) {
        if (this.agentOutputReadCoalescer.get(coalesceKey) === entry) {
          this.agentOutputReadCoalescer.delete(coalesceKey);
        }
      } else {
        entry.expiresAt = Date.now() + AGENT_OUTPUT_READ_COALESCE_MS;
        const cleanup = setTimeout(() => {
          if (this.agentOutputReadCoalescer.get(coalesceKey) === entry) {
            this.agentOutputReadCoalescer.delete(coalesceKey);
          }
        }, AGENT_OUTPUT_READ_COALESCE_MS);
        cleanup.unref?.();
      }
    }
  }

  private recordAgentOutputRead(
    source: AgentOutputReadSource,
    input: { sessionId: string; startLine?: number },
    result: MetadataReadAgentOutputResult,
    durationMs: number,
    changed?: boolean,
    coalesced = false,
  ): void {
    recordAgentOutputReadMetric({
      source,
      sessionId: input.sessionId,
      requestedStartLine: input.startLine,
      startLine: result.startLine,
      endLine: result.endLine,
      captureLineLimit: result.captureLineLimit,
      outputBytes: Buffer.byteLength(result.output ?? "", "utf8"),
      durationMs,
      coalesced,
      changed,
    });
  }

  private currentProjectRoot(): string {
    return this.projectRoot ?? process.cwd();
  }

  private touchVisualClientLease(
    req: IncomingMessage,
    url: URL,
    input: {
      surface: string;
      requestedPreview: boolean;
      requestedChatPreview?: boolean;
      defaultKind?: string;
    },
  ): boolean {
    if (!input.requestedPreview && !input.requestedChatPreview) return false;
    const kind = parseVisualClientKind(url.searchParams.get("clientKind") ?? input.defaultKind);
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "") || "local";
    this.visualClientLeases.touch({
      id: url.searchParams.get("clientId") || `${kind}:${remote}`,
      kind,
      surface: input.surface,
      requestedPreview: input.requestedPreview,
      requestedChatPreview: input.requestedChatPreview === true,
      ttlMs: url.searchParams.get("clientTtlMs"),
    });
    return this.visualClientLeases.hasActivePreviewClients();
  }

  private attachExposePreviewSnapshots(
    rawItems: FastControlItem[],
    options: { trackPaneOutput?: boolean; trackPreview?: boolean; maxOutputChars?: number } = {},
  ): FastControlItem[] {
    const captureSnapshots = new Map<string, ReturnType<ExposePreviewCacheLike["get"]>>();
    const tapSnapshots = new Map<string, ReturnType<ExposePaneOutputTapLike["read"]>>();
    const trackPreview = options.trackPreview !== false;
    if (trackPreview && options.trackPaneOutput !== false) this.exposePaneOutputTap?.trackItems(rawItems);
    for (const item of rawItems) {
      tapSnapshots.set(item.target.windowId, this.exposePaneOutputTap?.read(item.target.windowId));
    }
    if (trackPreview) this.exposePreviewCache?.trackItems(rawItems);
    for (const item of rawItems) {
      captureSnapshots.set(item.target.windowId, this.exposePreviewCache?.get(item.target.windowId));
    }
    return rawItems.map((item) => {
      const tapSnapshot = tapSnapshots.get(item.target.windowId);
      const captureSnapshot = captureSnapshots.get(item.target.windowId);
      const previewSnapshot = mergeExposePreviewSnapshots(captureSnapshot, tapSnapshot);
      if (!previewSnapshot) return item;
      const output =
        options.maxOutputChars && previewSnapshot.output.length > options.maxOutputChars
          ? previewSnapshot.output.slice(-options.maxOutputChars)
          : previewSnapshot.output;
      return { ...item, previewSnapshot: { ...previewSnapshot, output } };
    });
  }

  private async readAgentChatPreviews(
    sessionIds: readonly string[],
  ): Promise<Map<string, NonNullable<FastControlItem["chatPreview"]>>> {
    const previewsBySessionId = new Map<string, NonNullable<FastControlItem["chatPreview"]>>();
    if (!this.options.lifecycle?.readAgentOutput) return previewsBySessionId;
    const uncachedSessionIds: string[] = [];
    const now = Date.now();
    for (const sessionId of new Set(sessionIds)) {
      const cached = this.agentChatPreviewCache.get(sessionId);
      if (cached && cached.expiresAt > now) {
        if (cached.preview) previewsBySessionId.set(sessionId, cached.preview);
        continue;
      }
      uncachedSessionIds.push(sessionId);
    }
    if (uncachedSessionIds.length === 0) return previewsBySessionId;

    await Promise.all(
      uncachedSessionIds.map(async (sessionId) => {
        try {
          const readInput = {
            sessionId,
            startLine: DESKTOP_STATE_CHAT_PREVIEW_START_LINE,
          };
          const { result, durationMs, coalesced } = await this.measureAgentOutputRead("chat-preview", readInput);
          this.recordAgentOutputRead("chat-preview", readInput, result, durationMs, undefined, coalesced);
          const messages = (result.messages ?? []).slice(-DESKTOP_STATE_CHAT_PREVIEW_MAX_MESSAGES);
          const preview =
            messages.length > 0
              ? {
                  messages,
                  capturedAt: new Date().toISOString(),
                  source: "readAgentOutput" as const,
                }
              : null;
          this.agentChatPreviewCache.set(sessionId, {
            preview,
            expiresAt: Date.now() + DESKTOP_STATE_CHAT_PREVIEW_CACHE_MS,
          });
          if (preview) previewsBySessionId.set(sessionId, preview);
        } catch (error) {
          log.debug?.("agent chat preview failed", "api", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    return previewsBySessionId;
  }

  private async attachExposeChatPreviews(rawItems: FastControlItem[]): Promise<FastControlItem[]> {
    const sessionIds = rawItems.map((item) => item.metadata.sessionId).filter((id): id is string => Boolean(id));
    const chatPreviewsBySessionId = await this.readAgentChatPreviews(sessionIds);
    if (chatPreviewsBySessionId.size === 0) return rawItems;
    return rawItems.map((item) => {
      const chatPreview = item.metadata.sessionId ? chatPreviewsBySessionId.get(item.metadata.sessionId) : undefined;
      return chatPreview ? { ...item, chatPreview } : item;
    });
  }

  private async attachDesktopStatePreviews(
    state: Record<string, unknown>,
    options: { includeChatPreview?: boolean; trackPreview?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const sessions = Array.isArray((state as any).sessions) ? (state as any).sessions : [];
    const previewItems: FastControlItem[] = sessions
      .filter((session: any) => typeof session?.id === "string" && typeof session?.tmuxWindowId === "string")
      .map((session: any) => ({
        id: session.id,
        target: {
          windowId: session.tmuxWindowId,
          windowIndex: typeof session.tmuxWindowIndex === "number" ? session.tmuxWindowIndex : 0,
          windowName: session.label ?? session.id,
          sessionName: "",
        },
        metadata: {
          kind: "agent" as const,
          sessionId: session.id,
          command: session.command ?? "",
          label: session.label,
          worktreePath: session.worktreePath,
          createdAt: session.createdAt,
        },
        label: session.label ?? session.command ?? session.id,
        urgency: 0,
        activity: 0,
        lastUsedAt: session.lastUsedAt,
        recentRank: Number.MAX_SAFE_INTEGER,
      }));

    const snapshotsBySessionId =
      previewItems.length > 0
        ? new Map(
            this.attachExposePreviewSnapshots(previewItems, {
              maxOutputChars: DESKTOP_STATE_PREVIEW_MAX_CHARS,
              trackPreview: options.trackPreview,
            })
              .filter((item) => item.previewSnapshot)
              .map((item) => [item.id, item.previewSnapshot] as const),
          )
        : new Map<string, FastControlItem["previewSnapshot"]>();

    const chatPreviewsBySessionId = options.includeChatPreview
      ? await this.readAgentChatPreviews(
          sessions.map((session: any) => session?.id).filter((id: unknown): id is string => typeof id === "string"),
        )
      : new Map<string, NonNullable<FastControlItem["chatPreview"]>>();

    if (snapshotsBySessionId.size === 0 && chatPreviewsBySessionId.size === 0) return state;

    const attachSessionSnapshot = (session: any) => {
      const previewSnapshot = typeof session?.id === "string" ? snapshotsBySessionId.get(session.id) : undefined;
      const chatPreview = typeof session?.id === "string" ? chatPreviewsBySessionId.get(session.id) : undefined;
      if (!previewSnapshot && !chatPreview) return session;
      return { ...session, previewSnapshot, chatPreview };
    };
    return {
      ...state,
      sessions: sessions.map(attachSessionSnapshot),
    };
  }

  private scheduleExposeHotSnapshotRefresh(delayMs = EXPOSE_HOT_SNAPSHOT_REFRESH_MS): void {
    if (!this.exposeHotSnapshotsEnabled || this.exposeHotSnapshotTimer || !this.server) return;
    this.exposeHotSnapshotTimer = setTimeout(() => {
      this.exposeHotSnapshotTimer = null;
      this.runInProjectContext(() => this.refreshExposeHotSnapshots());
    }, delayMs);
    this.exposeHotSnapshotTimer.unref?.();
  }

  private scheduleWorktreeCacheCleanup(delayMs?: number): void {
    if (!this.server || !this.options.desktop?.cleanupWorktreeCaches) return;
    if (this.worktreeCacheCleanupTimer) clearTimeout(this.worktreeCacheCleanupTimer);
    const config = loadConfig({ projectRoot: this.currentProjectRoot() });
    if (!config.worktrees.cacheCleanupEnabled) return;
    const nextDelayMs = Math.max(1, delayMs ?? config.worktrees.cacheCleanupIntervalMs);
    this.worktreeCacheCleanupTimer = setTimeout(() => {
      this.worktreeCacheCleanupTimer = null;
      void this.runInProjectContext(() => this.runScheduledWorktreeCacheCleanup());
    }, nextDelayMs);
    this.worktreeCacheCleanupTimer.unref?.();
  }

  private async runScheduledWorktreeCacheCleanup(): Promise<void> {
    if (!this.server || this.worktreeCacheCleanupRunning || !this.options.desktop?.cleanupWorktreeCaches) return;
    this.worktreeCacheCleanupRunning = true;
    let intervalMs = 86_400_000;
    try {
      const config = loadConfig({ projectRoot: this.currentProjectRoot() });
      intervalMs = config.worktrees.cacheCleanupIntervalMs;
      if (!config.worktrees.cacheCleanupEnabled) return;
      const dryRun = !config.worktrees.cacheCleanupApply;
      const transitionInput: LifecycleTransitionInput = {
        operation: "worktree.cacheCleanup",
        targetKind: "worktree",
      };
      const result = await this.enqueueLifecycleMutation(
        () => this.options.desktop!.cleanupWorktreeCaches!({ dryRun, includeActive: false }),
        transitionInput,
      );
      const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const plan = record.plan && typeof record.plan === "object" ? (record.plan as Record<string, unknown>) : {};
      const results = Array.isArray(record.results) ? record.results : [];
      const targets = Array.isArray(plan.targets) ? plan.targets : [];
      const reclaimableBytes = typeof plan.reclaimableBytes === "number" ? plan.reclaimableBytes : 0;
      const reclaimedBytes = typeof record.reclaimedBytes === "number" ? record.reclaimedBytes : 0;
      const failed = results.filter((entry) => {
        return entry && typeof entry === "object" && (entry as { status?: unknown }).status === "failed";
      }).length;
      if (dryRun) {
        if (targets.length > 0 || reclaimableBytes > 0) {
          log.info("worktree cache cleanup found inactive generated caches", "api", {
            projectRoot: this.currentProjectRoot(),
            reclaimableBytes,
            targets: targets.length,
          });
        } else {
          log.debug("worktree cache cleanup found no inactive generated caches", "api", {
            projectRoot: this.currentProjectRoot(),
          });
        }
      } else {
        log.info("worktree cache cleanup removed inactive generated caches", "api", {
          projectRoot: this.currentProjectRoot(),
          reclaimedBytes,
          targets: targets.length,
          failed,
        });
      }
    } catch (error) {
      log.warn("worktree cache cleanup failed", "api", {
        projectRoot: this.currentProjectRoot(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.worktreeCacheCleanupRunning = false;
      this.scheduleWorktreeCacheCleanup(intervalMs);
    }
  }

  private refreshExposeHotSnapshots(): void {
    if (!this.exposeHotSnapshotsEnabled || !this.server) return;
    pruneExpiredHotExposeSnapshots(getProjectStateDir());
    if (this.exposeHotSnapshotRefreshing) {
      this.scheduleExposeHotSnapshotRefresh();
      return;
    }
    this.exposeHotSnapshotRefreshing = true;
    const timeoutMs = 10_000;
    try {
      const worker = startExposeHotSnapshotWorker(
        { kind: "project", projectRoot: this.currentProjectRoot() },
        {
          category: "api",
          description: "expose hot snapshot refresh",
          timeoutMs,
        },
      );
      this.exposeHotSnapshotWorker = worker;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        if (this.exposeHotSnapshotWorker === worker) this.exposeHotSnapshotWorker = null;
        this.exposeHotSnapshotRefreshing = false;
        if (this.server) this.scheduleExposeHotSnapshotRefresh();
      };
      const fallback = setTimeout(() => {
        worker.terminate().catch(() => {});
        finish();
      }, timeoutMs + 1_000);
      fallback.unref?.();
      worker.once("exit", finish);
    } catch (error) {
      this.exposeHotSnapshotRefreshing = false;
      log.debug("expose hot snapshot refresh failed", "api", {
        projectRoot: this.currentProjectRoot(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleExposeHotSnapshotRefresh();
    }
  }

  private readTeamConfigResponse(): { ok: true; config: ReturnType<typeof loadTeamConfig> } {
    return { ok: true, config: loadTeamConfig() };
  }

  private addTeamRole(input: {
    role?: unknown;
    description?: unknown;
    reviewedBy?: unknown;
    canEdit?: unknown;
  }):
    | { ok: true; config: ReturnType<typeof loadTeamConfig>; role: string }
    | { ok: false; status: number; error: string } {
    const role = typeof input.role === "string" ? input.role.trim() : "";
    if (!role) return { ok: false, status: 400, error: "role is required" };
    const config = loadTeamConfig();
    const existing = config.roles[role];
    const nextRole: RoleConfig = {
      description:
        typeof input.description === "string" && input.description.trim()
          ? input.description.trim()
          : (existing?.description ?? `${role} agent`),
    };
    const reviewedBy =
      typeof input.reviewedBy === "string" && input.reviewedBy.trim() ? input.reviewedBy.trim() : existing?.reviewedBy;
    if (reviewedBy) nextRole.reviewedBy = reviewedBy;
    if (input.canEdit === true || (input.canEdit === undefined && existing?.canEdit)) nextRole.canEdit = true;
    config.roles[role] = nextRole;
    saveTeamConfig(config);
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.team],
      reason: "team-role-add",
    });
    return { ok: true, config, role };
  }

  private removeTeamRole(input: {
    role?: unknown;
  }):
    | { ok: true; config: ReturnType<typeof loadTeamConfig>; role: string }
    | { ok: false; status: number; error: string } {
    const role = typeof input.role === "string" ? input.role.trim() : "";
    if (!role) return { ok: false, status: 400, error: "role is required" };
    const config = loadTeamConfig();
    if (!config.roles[role]) return { ok: false, status: 404, error: `Role "${role}" not found.` };
    if (Object.keys(config.roles).length <= 1) {
      return { ok: false, status: 400, error: "cannot remove the last team role" };
    }
    delete config.roles[role];
    if (config.defaultRole === role) {
      const defaultRole = getDefaultTeamConfig().defaultRole;
      const nextDefault = config.roles[defaultRole] ? defaultRole : Object.keys(config.roles)[0];
      config.defaultRole = nextDefault;
    }
    saveTeamConfig(config);
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.team],
      reason: "team-role-remove",
    });
    return { ok: true, config, role };
  }

  private setDefaultTeamRole(input: {
    role?: unknown;
  }):
    | { ok: true; config: ReturnType<typeof loadTeamConfig>; role: string }
    | { ok: false; status: number; error: string } {
    const role = typeof input.role === "string" ? input.role.trim() : "";
    if (!role) return { ok: false, status: 400, error: "role is required" };
    const config = loadTeamConfig();
    if (!config.roles[role]) {
      return { ok: false, status: 404, error: `Role "${role}" not found. Add it first with: aimux team add ${role}` };
    }
    config.defaultRole = role;
    saveTeamConfig(config);
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.team],
      reason: "team-default-role",
    });
    return { ok: true, config, role };
  }

  private initTeamConfig(): { ok: true; config: ReturnType<typeof getDefaultTeamConfig> } {
    const config = getDefaultTeamConfig();
    saveTeamConfig(config);
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.team],
      reason: "team-init",
    });
    return { ok: true, config };
  }

  /** Pending interaction requests (permission/input prompts) the loop watcher
   * uses to avoid nudging an agent that is actually waiting on a human. */
  listPendingInteractions(sessionId?: string) {
    return this.interactions.listPending(sessionId);
  }

  private notifyProjectChanged(
    input: {
      views?: ProjectApiView[];
      reason?: string;
      sessionId?: string;
      worktreePath?: string;
    } = {},
  ): void {
    this.lastProjectChangeAt = Date.now();
    this.desktopStateCacheDirty = true;
    this.eventBus.publishProjectUpdate(input);
    this.options.onChange?.();
  }

  private refreshDesktopStateCache(): Record<string, unknown> {
    if (this.desktopStateRefreshTimer) {
      clearTimeout(this.desktopStateRefreshTimer);
      this.desktopStateRefreshTimer = null;
    }
    // Cleared before the build, not after: the build itself renames tmux windows
    // and reconciles topology, so a change published during it would otherwise
    // be marked and then immediately unmarked, and the snapshot would be pinned
    // as clean while already out of date.
    this.desktopStateCacheDirty = false;
    const state = this.options.desktop?.getState?.() ?? {};
    this.desktopStateCache = { ts: Date.now(), state };
    return state;
  }

  private scheduleDesktopStateRefresh(delayMs = 0): void {
    if (!this.options.desktop?.getState || this.desktopStateRefreshTimer || this.desktopStateRefreshing) return;
    this.desktopStateRefreshTimer = setTimeout(() => {
      this.desktopStateRefreshTimer = null;
      const quietFor = Date.now() - this.lastProjectChangeAt;
      if (this.desktopStateCacheDirty && quietFor < DESKTOP_STATE_STALE_REFRESH_DELAY_MS) {
        this.scheduleDesktopStateRefresh(DESKTOP_STATE_STALE_REFRESH_DELAY_MS - quietFor);
        return;
      }
      this.desktopStateRefreshing = true;
      try {
        this.refreshDesktopStateCache();
      } catch (error) {
        log.warn("desktop-state refresh failed", "api", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.desktopStateRefreshing = false;
      }
    }, delayMs);
    this.desktopStateRefreshTimer.unref?.();
  }

  private scheduleShellStateUpdate(input: PendingShellStateUpdate): void {
    this.pendingShellStateUpdates.push(input);
    if (this.shellStateFlushTimer) return;
    this.shellStateFlushTimer = setTimeout(() => this.flushShellStateUpdates(), DESKTOP_STATE_STALE_REFRESH_DELAY_MS);
    this.shellStateFlushTimer.unref?.();
  }

  private flushShellStateUpdates(): void {
    this.shellStateFlushTimer = null;
    const quietFor = Date.now() - this.lastProjectChangeAt;
    if (quietFor < DESKTOP_STATE_STALE_REFRESH_DELAY_MS) {
      this.shellStateFlushTimer = setTimeout(
        () => this.flushShellStateUpdates(),
        DESKTOP_STATE_STALE_REFRESH_DELAY_MS - quietFor,
      );
      this.shellStateFlushTimer.unref?.();
      return;
    }
    const updates = this.pendingShellStateUpdates.splice(0);
    for (const update of updates) {
      try {
        const result = applyShellStateTransition({
          ...update,
          tracker: this.tracker,
          emitAlert: (input) => this.emitAlert(input),
        });
        this.notifyProjectChanged({
          views: [...PROJECT_API_VIEW_INVALIDATIONS.runtime],
          reason: "shell-state",
          sessionId: result.sessionId,
        });
      } catch (error) {
        log.warn("shell-state update failed", "api", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private getDesktopStateSnapshot(force = false): Record<string, unknown> {
    const now = Date.now();
    if (force) {
      // Every open dashboard forces a refresh within a beat of the same change
      // event, so one agent tool call rebuilt the whole project snapshot once
      // per connected client. Collapse only that: a window shorter than any
      // caller's poll cadence, so the settle loops that force precisely to
      // observe an async completion still see one rebuild per poll.
      //
      // Deliberately not "serve any clean cache". The dirty flag does not cover
      // everything the build reads — a window killed in tmux directly, a git
      // worktree change, another process writing topology — so suppressing on
      // it alone would freeze the snapshot for a project nobody is polling.
      const coalescable =
        this.desktopStateCache &&
        !this.desktopStateCacheDirty &&
        now - this.desktopStateCache.ts < DESKTOP_STATE_FORCED_COALESCE_MS;
      if (coalescable) return this.desktopStateCache!.state;
      return this.refreshDesktopStateCache();
    }
    if (this.desktopStateCache && this.desktopStateCacheDirty) {
      this.scheduleDesktopStateRefresh(DESKTOP_STATE_STALE_REFRESH_DELAY_MS);
      return this.desktopStateCache.state;
    }
    if (this.desktopStateCache) {
      if (now - this.desktopStateCache.ts >= DESKTOP_STATE_CACHE_TTL_MS) this.scheduleDesktopStateRefresh();
      return this.desktopStateCache.state;
    }
    return this.refreshDesktopStateCache();
  }

  // Settle a session the transcript reconciler found stuck "working": drop the
  // stale activity to idle so it derives "ready". Not a task_done — this is a
  // correction, so it must not bump unseen counts or fire a completion alert.
  reconcileSettleActivity(sessionId: string): void {
    this.tracker.setActivity(sessionId, "idle");
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.runtime],
      sessionId,
      reason: "reconcile-settle-activity",
    });
  }

  // Clear a needs_response attention stranded by a lost in-memory interaction
  // registry (e.g. after a daemon restart) once no live interaction remains.
  reconcileClearResponse(sessionId: string): void {
    this.tracker.setAttention(sessionId, "normal");
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.runtime],
      sessionId,
      reason: "reconcile-clear-response",
    });
  }

  notifyChange(): void {
    this.notifyProjectChanged({
      views: [...PROJECT_API_VIEW_INVALIDATIONS.runtime],
      reason: "notify-change",
    });
  }

  private resolveDirectTeammates(parentSessionId: string):
    | {
        ok: true;
        parent: DesktopSessionRecord;
        teammates: DesktopSessionRecord[];
      }
    | {
        ok: false;
        status: number;
        error: string;
      } {
    if (!parentSessionId.trim()) {
      return { ok: false, status: 400, error: "parentSessionId is required" };
    }
    const topologySessions = topologyDesktopSessionList(["starting", "running", "idle", "offline"]);
    const sessions = topologySessions.filter((session) => !isTeammateSession(session));
    const teammates = topologySessions.filter(isTeammateSession);
    const parent = [...sessions, ...teammates].find((session) => session.id === parentSessionId);
    if (!parent) {
      return { ok: false, status: 404, error: `parent agent "${parentSessionId}" not found` };
    }
    if (isTeammateSession(parent)) {
      return { ok: false, status: 400, error: "teammate agents cannot create or delegate to nested teams" };
    }

    return {
      ok: true,
      parent,
      teammates: selectDirectTeammates(teammates, parentSessionId),
    };
  }

  private resolveDirectTeammate(
    parentSessionId: string,
    teammateSessionId: string,
  ):
    | {
        ok: true;
        parent: DesktopSessionRecord;
        teammate: DesktopSessionRecord;
      }
    | {
        ok: false;
        status: number;
        error: string;
      } {
    if (!teammateSessionId.trim()) {
      return { ok: false, status: 400, error: "teammateSessionId is required" };
    }
    const resolved = this.resolveDirectTeammates(parentSessionId);
    if (!resolved.ok) return resolved;
    const teammate = resolved.teammates.find((session) => session.id === teammateSessionId);
    if (!teammate) {
      return {
        ok: false,
        status: 404,
        error: `teammate "${teammateSessionId}" is not attached to parent "${parentSessionId}"`,
      };
    }
    return { ok: true, parent: resolved.parent, teammate };
  }

  private resolveDirectGraveyardTeammate(
    parentSessionId: string,
    teammateSessionId: string,
  ):
    | {
        ok: true;
        parent: DesktopSessionRecord;
        teammate: DesktopSessionRecord;
      }
    | {
        ok: false;
        status: number;
        error: string;
      } {
    const resolved = this.resolveDirectTeammates(parentSessionId);
    if (!resolved.ok) return resolved;
    const teammate = selectDirectTeammates(topologyDesktopSessionList(["graveyard"]), resolved.parent.id).find(
      (session) => session.id === teammateSessionId,
    );
    if (!teammate) {
      return {
        ok: false,
        status: 404,
        error: `graveyard teammate "${teammateSessionId}" is not attached to parent "${parentSessionId}"`,
      };
    }
    return { ok: true, parent: resolved.parent, teammate };
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error("server not initialized"));
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server?.off("error", reject);
        const address = this.server?.address();
        if (!address || typeof address === "string") return reject(new Error("invalid address"));
        this.port = address.port;
        resolve();
      });
    });
  }

  private emitAlert(input: {
    kind: AlertKind;
    sessionId?: string;
    title: string;
    message: string;
    threadId?: string;
    taskId?: string;
    worktreePath?: string;
    worktreeName?: string;
    branch?: string;
    dedupeKey?: string;
    cooldownMs?: number;
    forceNotify?: boolean;
    interaction?: {
      id: string;
      type: InteractionType;
      summary?: string;
      telemetry?: boolean;
      toolName?: string;
      toolInputJSON?: string;
    };
  }): void {
    const displayContext = this.resolveSessionAlertDisplayContext(input.sessionId, input.worktreePath);
    this.eventBus.publishAlert(
      contextualizeAlertInput(
        displayContext?.worktreePath ? { ...input, worktreePath: displayContext.worktreePath } : input,
        displayContext,
      ),
    );
  }

  private interactionDedupeKey(input: {
    sessionId: string;
    type: InteractionType;
    payload: InteractionPayload;
    summary?: string;
  }): string {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ type: input.type, summary: input.summary ?? "", payload: input.payload }))
      .digest("base64url")
      .slice(0, 12);
    return `interaction:${input.sessionId}:${input.type}:${fingerprint}`;
  }

  private beginInteraction(input: {
    sessionId: string;
    type: InteractionType;
    payload: InteractionPayload;
    summary?: string;
    id?: string;
  }): InteractionRequest {
    const dedupeKey = this.interactionDedupeKey(input);
    const request = this.interactions.register({
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload,
      projectRoot: this.currentProjectRoot(),
      dedupeKey,
      id: input.id,
    });
    this.tracker.setAttention(input.sessionId, "needs_response");
    const display = summarizeInteractionForDisplay(input);
    this.emitAlert({
      kind: "interaction_request",
      sessionId: input.sessionId,
      title: display.title,
      message: display.message,
      interaction: { id: request.id, type: input.type, summary: display.summary },
      dedupeKey,
      cooldownMs: 60_000,
      forceNotify: true,
    });
    this.notifyChange();
    return request;
  }

  private resolveHookSessionId(explicitSessionId: string, backendSessionId?: string): string {
    const backend = backendSessionId?.trim();
    if (!backend) return explicitSessionId;
    const match = listTopologySessionStates().find((session) => session.backendSessionId === backend);
    return match?.id ?? explicitSessionId;
  }

  private async recordHookBackendSessionId(sessionId: string, backendSessionId?: string): Promise<void> {
    const backend = backendSessionId?.trim();
    if (!backend || !this.options.lifecycle?.recordBackendSessionId) return;
    try {
      await this.options.lifecycle.recordBackendSessionId({ sessionId, backendSessionId: backend });
    } catch (error) {
      log.warn("hook backend session id capture failed", "api", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearHookNotifications(sessionId: string): void {
    clearNotifications({ sessionId, projectRoot: this.currentProjectRoot() });
  }

  private setHookTranscriptPath(sessionId: string, payload: { transcript_path?: string }): void {
    const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";
    if (!transcriptPath) return;
    const context: SessionContextMetadata = { transcriptPath };
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        context: {
          ...(current.context ?? {}),
          ...context,
        },
      }),
      this.currentProjectRoot(),
    );
  }

  private markHookSessionRunning(sessionId: string): void {
    this.clearHookNotifications(sessionId);
    this.tracker.setActivity(sessionId, "running");
    this.tracker.setAttention(sessionId, "normal");
    markSessionViewed(sessionId, this.currentProjectRoot());
  }

  private emitHookEvent(sessionId: string, event: AgentEvent, worktreePath?: string): void {
    this.tracker.emit(sessionId, event);
    if (event.kind === "needs_input") {
      this.emitAlert({
        kind: "needs_input",
        sessionId,
        title: `${sessionId} needs input`,
        message: event.message || "Agent is waiting for input.",
        worktreePath,
        dedupeKey: `needs_input:${sessionId}`,
        cooldownMs: 15_000,
      });
    }
  }

  private async resolveHookPermissionRequest(
    sessionId: string,
    payload: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string },
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | null> {
    if (this.interactionWatchers <= 0) return {};
    const { toolName, input, summary } = summarizeClaudePermissionRequest(payload);
    const cwd = (typeof payload.cwd === "string" && payload.cwd.trim()) || this.currentProjectRoot();
    const request = this.beginInteraction({
      sessionId,
      type: "permission",
      payload: { toolName, input, cwd },
      summary,
    });
    const controller = new AbortController();
    let closed = false;
    const onClose = () => {
      closed = true;
      controller.abort();
    };
    req.on("close", onClose);
    req.on("aborted", onClose);
    res.on("close", onClose);
    const settled = await this.interactions.wait(request.id, { timeoutMs: 115_000, signal: controller.signal });
    req.off("close", onClose);
    req.off("aborted", onClose);
    res.off("close", onClose);
    if (settled.status !== "resolved" && this.interactions.listPending(sessionId).length === 0) {
      this.tracker.setAttention(sessionId, "normal");
      this.notifyChange();
    }
    if (closed) return null;
    return settled.status === "resolved" ? permissionRequestHookOutput(settled.response?.decision) : {};
  }

  private notifyCodexHookPermissionTelemetry(sessionId: string, payload: CodexHookPayload): void {
    const { toolName, input, summary } = summarizeClaudePermissionRequest(payload);
    const cwd = (typeof payload.cwd === "string" && payload.cwd.trim()) || this.currentProjectRoot();
    this.emitAlert({
      kind: "interaction_request",
      sessionId,
      title: `${sessionId} requests permission`,
      message: summary,
      interaction: {
        id: this.interactionDedupeKey({ sessionId, type: "permission", payload: { toolName, input, cwd }, summary }),
        type: "permission",
        summary,
        telemetry: true,
        toolName,
        toolInputJSON: input ? JSON.stringify(input) : undefined,
      },
      dedupeKey: this.interactionDedupeKey({
        sessionId,
        type: "permission",
        payload: { toolName, input, cwd },
        summary,
      }),
      cooldownMs: 60_000,
    });
  }

  private async handleClaudeHook(
    action: string,
    explicitSessionId: string,
    payload: ClaudeHookPayload,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = this.resolveHookSessionId(explicitSessionId, payload.session_id);
    await this.recordHookBackendSessionId(sessionId, payload.session_id);
    this.setHookTranscriptPath(sessionId, payload);
    switch (action) {
      case "session-start":
      case "active":
      case "session-end":
        break;
      case "prompt-submit":
      case "pre-tool-use":
        this.markHookSessionRunning(sessionId);
        break;
      case "notification":
      case "notify": {
        const summary = summarizeClaudeNotification(payload);
        this.emitHookEvent(sessionId, { kind: "needs_input", message: summary.body, tone: "warn" }, payload.cwd);
        break;
      }
      case "stop":
      case "idle": {
        const summary = summarizeClaudeStop(payload);
        this.emitHookEvent(sessionId, { kind: "task_done", message: summary.body, tone: "success" });
        break;
      }
      case "permission-request":
        return this.resolveHookPermissionRequest(sessionId, payload, req, res);
      default:
        throw new Error(`Unsupported claude hook action: ${action}`);
    }
    this.notifyChange();
    return {};
  }

  private async handleCodexHook(action: string, sessionId: string, payload: CodexHookPayload): Promise<void> {
    await this.recordHookBackendSessionId(sessionId, payload.session_id);
    switch (action) {
      case "session-start":
        break;
      case "prompt-submit":
        this.markHookSessionRunning(sessionId);
        break;
      case "stop":
        this.emitHookEvent(sessionId, {
          kind: "task_done",
          message: payload.message?.trim() || "Codex completed its turn.",
          tone: "success",
        });
        break;
      case "permission-request":
        this.notifyCodexHookPermissionTelemetry(sessionId, payload);
        break;
      default:
        throw new Error(`Unsupported codex hook action: ${action}`);
    }
    this.notifyChange();
  }

  private resolveSessionAlertDisplayContext(
    sessionId: string | undefined,
    worktreePath: string | undefined,
  ): SessionAlertDisplayContext | undefined {
    if (!sessionId) return worktreePath ? this.resolveWorktreeAlertDisplayContext(worktreePath) : undefined;
    let context: SessionAlertDisplayContext = {};
    try {
      context = metadataDisplayContext(loadMetadataState().sessions[sessionId]);
    } catch {}
    const liveContext = this.options.desktop?.getSessionDisplayContext?.(sessionId);
    context = mergeDisplayContext(context, liveContext ?? {});
    if (worktreePath) {
      const worktreeContext = this.resolveWorktreeAlertDisplayContext(worktreePath);
      context = mergeDisplayContext(context, worktreeContext);
    }
    return Object.values(context).some((value) => value !== undefined) ? context : undefined;
  }

  private resolveWorktreeAlertDisplayContext(worktreePath: string): SessionAlertDisplayContext {
    const target = pathResolve(worktreePath);
    const projectRoot = pathResolve(this.currentProjectRoot());
    const worktrees: Array<{ path: string; resolvedPath: string; name?: string; branch?: string }> = [];
    for (const entry of this.options.desktop?.listWorktrees?.() ?? []) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const path = optionalString(record.path);
      if (!path) continue;
      worktrees.push({
        path,
        resolvedPath: pathResolve(path),
        name: optionalString(record.name),
        branch: optionalString(record.branch),
      });
    }
    worktrees.sort((a, b) => b.resolvedPath.length - a.resolvedPath.length);
    const match = worktrees.find(
      (entry) => target === entry.resolvedPath || target.startsWith(`${entry.resolvedPath}/`),
    );
    if (match) {
      const isMain = match.resolvedPath === projectRoot;
      return {
        worktreePath: match.path,
        worktreeName: isMain ? "Main Checkout" : (match.name ?? basename(match.resolvedPath)),
        branch: match.branch,
      };
    }
    if (target === projectRoot || target.startsWith(`${projectRoot}/`)) {
      return { worktreePath: this.currentProjectRoot(), worktreeName: "Main Checkout" };
    }
    return { worktreePath, worktreeName: basename(target) };
  }

  private emitThreadWaitingAlert(input: {
    kind: Extract<AlertKind, "message_waiting" | "handoff_waiting">;
    threadId: string;
    from?: string;
    recipients?: string[];
    title: string;
    message: string;
    worktreePath?: string;
    cooldownMs?: number;
  }): void {
    for (const recipient of [...new Set((input.recipients ?? []).map((value) => value?.trim()).filter(Boolean))]) {
      if (recipient === input.from?.trim()) continue;
      this.emitAlert({
        kind: input.kind,
        sessionId: recipient,
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        title: input.title,
        message: input.message,
        dedupeKey: `${input.kind}:${input.threadId}:${recipient}`,
        cooldownMs: input.cooldownMs ?? 15_000,
      });
    }
  }

  private emitAssignedTaskAlert(input: {
    task: {
      id: string;
      description: string;
      assignedTo?: string;
      type?: "task" | "review";
    };
    thread?: {
      id?: string;
      worktreePath?: string;
    };
  }): void {
    const recipient = resolveExchangeTaskAssignmentRecipient(input.task);
    if (!recipient) return;
    const kind = input.task.type === "review" ? "review_waiting" : "task_assigned";
    const noun = input.task.type === "review" ? "Review" : "Task";
    this.emitAlert({
      kind,
      sessionId: recipient,
      taskId: input.task.id,
      threadId: input.thread?.id,
      worktreePath: input.thread?.worktreePath,
      title: `${noun} assigned: ${input.task.description}`,
      message:
        input.task.type === "review"
          ? "A review is waiting for your attention."
          : "A task is waiting for your attention.",
      dedupeKey: `${kind}:${input.task.id}:${recipient}`,
      cooldownMs: 15_000,
    });
  }

  private emitReviewOutcomeAlert(input: {
    task: {
      id: string;
      description: string;
      assignedBy: string;
      reviewFeedback?: string;
    };
    thread?: {
      id?: string;
      worktreePath?: string;
    };
    kind: Extract<AlertKind, "task_done" | "blocked">;
    fallbackMessage: string;
  }): void {
    const recipient = resolveExchangeReviewOutcomeRecipient(input.task);
    if (!recipient) return;
    const isBlocked = input.kind === "blocked";
    this.emitAlert({
      kind: input.kind,
      sessionId: recipient,
      taskId: input.task.id,
      threadId: input.thread?.id,
      worktreePath: input.thread?.worktreePath,
      title: `${isBlocked ? "Changes requested" : "Review approved"}: ${input.task.description}`,
      message: input.task.reviewFeedback?.trim() || input.fallbackMessage,
      dedupeKey: `${isBlocked ? "review-blocked" : "review-approved"}:${input.task.id}:${recipient}`,
      cooldownMs: 15_000,
    });
  }

  private async sendLiveExchangePrompt(sessionId: string, text: string): Promise<boolean> {
    const target = sessionId.trim();
    if (!target || target === "user" || target === "aimux") return false;
    if (!this.options.lifecycle?.sendAgentInput) return false;
    try {
      await this.options.lifecycle.sendAgentInput({
        sessionId: target,
        text,
        waitForSubmit: false,
        waitForActiveDraftIdle: true,
      });
      return true;
    } catch (error) {
      log.warn("live exchange delivery failed", "api", {
        sessionId: target,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private taskAssignmentPrompt(input: {
    task: AssignTaskResult["task"];
    thread?: Pick<OrchestrationThread, "id">;
    recipient: string;
  }): string {
    const noun = input.task.type === "review" ? "review" : "task";
    const thread = input.thread?.id ? `Thread: ${input.thread.id}\n` : "";
    return [
      `[aimux ${noun} assigned]`,
      `Task: ${input.task.description}`,
      `Task id: ${input.task.id}`,
      thread.trimEnd(),
      `From: ${input.task.assignedBy}`,
      "",
      `Accept before starting: aimux task accept ${input.task.id} --from ${input.recipient}`,
      `Complete when done: aimux task complete ${input.task.id} --from ${input.recipient} --body "<summary>"`,
      `Block if needed: aimux task block ${input.task.id} --from ${input.recipient} --body "<reason>"`,
      "",
      "Task prompt:",
      input.task.prompt,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private taskOutcomePrompt(input: {
    task: TaskLifecycleResult["task"];
    thread?: Pick<OrchestrationThread, "id">;
    message?: Pick<OrchestrationMessage, "from" | "body" | "kind">;
    action: "blocked" | "completed" | "review-approved" | "review-changes-requested";
    recipient: string;
  }): string {
    const label =
      input.action === "blocked"
        ? "blocked"
        : input.action === "review-approved"
          ? "review approved"
          : input.action === "review-changes-requested"
            ? "review changes requested"
            : "completed";
    const thread = input.thread?.id ? `Thread: ${input.thread.id}\n` : "";
    const body = input.message?.body?.trim() || input.task.result?.trim() || input.task.error?.trim() || "";
    return [
      `[aimux task ${label}]`,
      `Task: ${input.task.description}`,
      `Task id: ${input.task.id}`,
      thread.trimEnd(),
      input.message?.from ? `From: ${input.message.from}` : "",
      body ? "" : "",
      body,
      "",
      `Inspect: aimux task show ${input.task.id}`,
      input.thread?.id
        ? `Reply: aimux message send "<reply>" --thread ${input.thread.id} --from ${input.recipient} --kind reply`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private threadMessagePrompt(input: {
    thread: Pick<OrchestrationThread, "id" | "title" | "kind">;
    message: Pick<OrchestrationMessage, "from" | "kind" | "body">;
    recipient: string;
  }): string {
    const kind = input.thread.kind === "handoff" || input.message.kind === "handoff" ? "handoff" : "message";
    const action =
      kind === "handoff"
        ? `Accept: aimux handoff accept ${input.thread.id} --from ${input.recipient}`
        : `Reply: aimux message send "<reply>" --thread ${input.thread.id} --from ${input.recipient} --kind reply`;
    return [
      `[aimux ${kind}]`,
      `Thread: ${input.thread.id}`,
      `Title: ${input.thread.title}`,
      `From: ${input.message.from}`,
      `Kind: ${input.message.kind}`,
      "",
      input.message.body,
      "",
      action,
    ].join("\n");
  }

  private async deliverThreadMessageToLiveRecipients(input: {
    thread?: unknown;
    message?: unknown;
    explicitRecipients?: string[];
    fallbackRecipients?: string[];
    from?: string;
    alreadyDelivered?: string[];
  }): Promise<string[]> {
    const thread = input.thread as OrchestrationThread | undefined;
    const message = input.message as OrchestrationMessage | undefined;
    if (!thread?.id || !message?.id) return [];
    const alreadyDelivered = new Set(input.alreadyDelivered ?? []);
    const recipients = resolveExchangeMessageAlertRecipients({
      explicitRecipients: input.explicitRecipients,
      message,
      thread,
      fallbackRecipients: input.fallbackRecipients,
      from: input.from ?? message.from,
    });
    const deliveredTo: string[] = [];
    for (const recipient of recipients) {
      if (alreadyDelivered.has(recipient)) continue;
      const delivered = await this.sendLiveExchangePrompt(
        recipient,
        this.threadMessagePrompt({ thread, message, recipient }),
      );
      if (!delivered) continue;
      markMessageDelivered(thread.id, message.id, recipient);
      deliveredTo.push(recipient);
    }
    return deliveredTo;
  }

  private normalizeDeliveredTo(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }

  private async deliverAssignedTaskToLiveRecipient(input: AssignTaskResult): Promise<string[]> {
    const recipient = resolveExchangeTaskAssignmentRecipient(input.task);
    if (!recipient) return [];
    const delivered = await this.sendLiveExchangePrompt(
      recipient,
      this.taskAssignmentPrompt({ task: input.task, thread: input.thread, recipient }),
    );
    if (delivered && input.thread?.id && input.message?.id) {
      markMessageDelivered(input.thread.id, input.message.id, recipient);
    }
    return delivered ? [recipient] : [];
  }

  private async deliverTaskOutcomeToLiveRecipient(
    input: TaskLifecycleResult & { action: "blocked" | "completed" | "review-approved" | "review-changes-requested" },
  ): Promise<string[]> {
    const recipient =
      input.action === "review-approved" || input.action === "review-changes-requested"
        ? resolveExchangeReviewOutcomeRecipient(input.task)
        : resolveExchangeTaskOutcomeRecipient({
            task: input.task,
            thread: input.thread,
            from: input.message?.from,
          });
    if (!recipient) return [];
    const delivered = await this.sendLiveExchangePrompt(
      recipient,
      this.taskOutcomePrompt({
        task: input.task,
        thread: input.thread,
        message: input.message,
        action: input.action,
        recipient,
      }),
    );
    if (delivered && input.thread?.id && input.message?.id) {
      markMessageDelivered(input.thread.id, input.message.id, recipient);
    }
    return delivered ? [recipient] : [];
  }

  private recordSlowRequest(entry: ProjectServiceSlowRequest): void {
    this.recentSlowRequests.push(entry);
    while (this.recentSlowRequests.length > PROJECT_SERVICE_RECENT_SLOW_REQUEST_LIMIT) {
      this.recentSlowRequests.shift();
    }
    log.warn("slow project service request", "api", { ...entry });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!PROJECT_SERVICE_SLOW_REQUEST_EXCLUDED_PATHS.has(path)) {
      res.once("finish", () => {
        const durationMs = Date.now() - startedAt;
        if (durationMs < PROJECT_SERVICE_SLOW_REQUEST_MS) return;
        this.recordSlowRequest({
          ts: new Date().toISOString(),
          method,
          path,
          statusCode: res.statusCode,
          durationMs,
          resources: projectServiceResourceSnapshot({ includeFileDescriptors: true }),
        });
      });
    }
    await this.handleRoute(req, res);
  }

  private async handleRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!setCorsHeaders(req, res)) {
      rejectCors(res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const notifyCurrentRouteChange = (input: { reason?: string; sessionId?: string; worktreePath?: string } = {}) => {
      this.notifyProjectChanged({
        views: projectApiViewsForMutationRoute(req.method ?? "", url.pathname) ?? [
          ...PROJECT_API_VIEW_INVALIDATIONS.all,
        ],
        reason: input.reason ?? projectApiMutationReasonForRoute(req.method ?? "", url.pathname),
        sessionId: input.sessionId,
        worktreePath: input.worktreePath,
      });
    };

    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.events) {
      const sessionFilter = url.searchParams.get("sessionId")?.trim() || null;
      const startLineRaw = url.searchParams.get("startLine");
      const intervalMsRaw = url.searchParams.get("intervalMs");
      const parsedStartLine = parseOptionalInteger(startLineRaw, "startLine");
      if (!parsedStartLine.ok) {
        send(res, 400, { ok: false, error: parsedStartLine.error });
        return;
      }
      const captureWindow = agentOutputCaptureWindow(parsedStartLine.value);
      const startLine = captureWindow.startLine;
      const parsedIntervalMs =
        intervalMsRaw === null || intervalMsRaw.trim() === ""
          ? ({ ok: true, value: 500 } as const)
          : parsePositiveInteger(intervalMsRaw, "intervalMs");
      if (!parsedIntervalMs.ok || parsedIntervalMs.value < 100) {
        send(res, 400, { ok: false, error: "intervalMs must be an integer >= 100" });
        return;
      }
      const intervalMs = parsedIntervalMs.value;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.setHeader("access-control-allow-origin", "*");
      res.flushHeaders?.();

      let closed = false;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let outputPollTimer: ReturnType<typeof setInterval> | null = null;
      let lastOutput: string | undefined;
      // Activity changes without the pane changing — an agent finishing
      // leaves the last frame on screen — so a text-only gate would hold a
      // stream at "running" indefinitely.
      let lastLiveness: string | undefined;
      let outputPollInFlight = false;
      const unsubscribe = this.eventBus.subscribe((event) => {
        if (closed) return;
        if (sessionFilter && event.sessionId && event.sessionId !== sessionFilter) return;
        if (sessionFilter && !event.sessionId) return;
        sendSseEvent(res, event.type, event);
      });

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        if (outputPollTimer) clearInterval(outputPollTimer);
        outputPollTimer = null;
        res.end();
      };

      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);

      const pollSessionOutput = async () => {
        if (closed || !sessionFilter || !this.options.lifecycle?.readAgentOutput) return;
        if (outputPollInFlight) return;
        outputPollInFlight = true;
        try {
          const readInput = {
            sessionId: sessionFilter,
            startLine: parsedStartLine.value,
          };
          const { result, durationMs, coalesced } = await this.measureAgentOutputRead("events", readInput);
          if (closed) return;
          const liveness = `${result.activity ?? ""}:${result.attention ?? ""}`;
          const changed = result.output !== lastOutput || liveness !== lastLiveness;
          this.recordAgentOutputRead("events", readInput, result, durationMs, changed, coalesced);
          if (changed) {
            lastOutput = result.output;
            lastLiveness = liveness;
            sendSseEvent(res, PROJECT_API_EVENT_NAMES.agentOutput, {
              sessionId: result.sessionId,
              output: result.output,
              outputAnsi: result.outputAnsi,
              startLine: result.startLine ?? startLine,
              requestedStartLine: result.requestedStartLine ?? captureWindow.requestedStartLine,
              endLine: result.endLine ?? captureWindow.endLine,
              captureLineLimit: result.captureLineLimit ?? captureWindow.maxLines,
              outputTailOnly: result.outputTailOnly ?? captureWindow.tailOnly,
              outputStartLineClamped: result.outputStartLineClamped ?? captureWindow.clamped,
              parsed: result.parsed,
              // Forwarded explicitly: this payload is hand-picked, so a field
              // added to readAgentOutput does not reach a stream by itself.
              messages: result.messages,
              activity: result.activity,
              activityText: result.activityText,
              attention: result.attention,
            });
          }
        } catch (error) {
          sendSseEvent(res, PROJECT_API_EVENT_NAMES.error, {
            sessionId: sessionFilter,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        } finally {
          outputPollInFlight = false;
        }
      };

      sendSseEvent(res, PROJECT_API_EVENT_NAMES.ready, {
        projectId: getProjectId(),
        ts: new Date().toISOString(),
        sessionId: sessionFilter,
        startLine,
        requestedStartLine: captureWindow.requestedStartLine,
        endLine: captureWindow.endLine,
        captureLineLimit: captureWindow.maxLines,
        outputTailOnly: captureWindow.tailOnly,
        outputStartLineClamped: captureWindow.clamped,
        intervalMs,
      });
      if (sessionFilter && this.options.lifecycle?.readAgentOutput) {
        await pollSessionOutput();
        outputPollTimer = setInterval(() => {
          void pollSessionOutput();
        }, intervalMs);
        outputPollTimer.unref?.();
      }
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        res.write(": keepalive\n\n");
      }, 15_000);
      keepaliveTimer.unref?.();
      return;
    }

    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.notifications.list) {
      const unreadOnly = url.searchParams.get("unread") === "1";
      const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
      const parsedLimit = parseBoundedLimit(url.searchParams.get("limit"), "limit", {
        defaultValue: DEFAULT_PROJECT_LIST_LIMIT,
        maxValue: MAX_PROJECT_LIST_LIMIT,
      });
      if (!parsedLimit.ok) {
        send(res, 400, { ok: false, error: parsedLimit.error });
        return;
      }
      const snapshot = listNotificationSnapshot({ unreadOnly, sessionId, limit: parsedLimit.value });
      send(res, 200, {
        ok: true,
        notifications: snapshot.notifications,
        unreadCount: snapshot.unreadCount,
        total: snapshot.total,
        limit: snapshot.limit,
        truncated: snapshot.truncated,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.orchestration.routes) {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      const selectedSessionId = url.searchParams.get("selectedSessionId")?.trim() || undefined;
      const worktreePath = url.searchParams.get("worktreePath")?.trim() || undefined;
      const state = this.options.desktop.getState() as { sessions?: any[]; teammates?: any[] };
      send(res, 200, {
        ok: true,
        serviceInfo: getProjectServiceManifest(),
        options: buildOrchestrationRouteOptions({ state, selectedSessionId, worktreePath }),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.library) {
      const plansDir = getPlanAuthorityDir();
      send(res, 200, {
        ok: true,
        documents: listLibraryDocuments(this.currentProjectRoot()),
        entries: loadLibraryEntries({
          repoRoot: dirname(dirname(plansDir)),
          plansDir,
          resolveLabel: (sessionId) => this.options.desktop?.getSessionDisplayContext?.(sessionId)?.label ?? undefined,
        }),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.health) {
      this.publishEndpoint();
      send(res, 200, {
        ok: true,
        projectStateDir: getProjectStateDir(),
        pid: process.pid,
        serviceInfo: getProjectServiceManifest(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.diagnostics) {
      this.publishEndpoint();
      send(res, 200, {
        ok: true,
        projectStateDir: getProjectStateDir(),
        pid: process.pid,
        serviceInfo: getProjectServiceManifest(),
        resources: projectServiceResourceSnapshot({ includeFileDescriptors: true }),
        recentSlowRequests: this.recentSlowRequests.slice(-10),
        plugins: this.options.diagnostics?.pluginStatuses?.() ?? [],
        previews: {
          clients: this.visualClientLeases.snapshot(),
          cache: this.exposePreviewCache?.stats?.() ?? null,
          taps: this.exposePaneOutputTap?.stats?.() ?? null,
        },
        agentOutputReads: getAgentOutputReadMetrics(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.diagnosticsLifecycle) {
      this.publishEndpoint();
      send(res, 200, this.lifecycleDiagnostics());
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.state) {
      send(res, 200, loadMetadataState());
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.desktopState) {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
      const includePreview =
        url.searchParams.get("includePreview") === "1" || url.searchParams.get("includePreview") === "true";
      const includeChatPreview =
        url.searchParams.get("includeChatPreview") === "1" || url.searchParams.get("includeChatPreview") === "true";
      const trackPreview = this.touchVisualClientLease(req, url, {
        surface: "desktop-state",
        requestedPreview: includePreview,
        requestedChatPreview: includeChatPreview,
      });
      const state = this.getDesktopStateSnapshot(force);
      send(res, 200, {
        ok: true,
        serviceInfo: getProjectServiceManifest(),
        pendingInteractions: this.interactions.listPending(),
        ...(includePreview
          ? await this.attachDesktopStatePreviews(state, { includeChatPreview, trackPreview })
          : state),
        agentRestoreOffer: readAgentRestoreOffer(this.currentProjectRoot()),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.coordinationWorklist) {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      const participant = url.searchParams.get("participant")?.trim() || "user";
      const state = this.options.desktop.getState() as { sessions?: any[]; teammates?: any[]; services?: any[] };
      const threads = buildCoordinationThreadEntries(participant, { readOnly: true });
      const notificationSnapshot = listNotificationSnapshot({ limit: DEFAULT_PROJECT_LIST_LIMIT });
      const { model, worklist } = buildCoordinationView({
        sessions: state.sessions ?? [],
        teammates: state.teammates ?? [],
        services: state.services ?? [],
        notifications: notificationSnapshot.notifications,
        threads,
        currentParticipant: participant,
      });
      send(res, 200, { ok: true, serviceInfo: getProjectServiceManifest(), worklist, model, threads });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.projectObservability) {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      const state = this.options.desktop.getState() as {
        sessions?: any[];
        teammates?: any[];
        services?: any[];
        worktrees?: any[];
      };
      const notificationSnapshot = listNotificationSnapshot({ limit: DEFAULT_PROJECT_LIST_LIMIT });
      const project = buildProjectObservability({
        sessions: [...(state.sessions ?? []), ...(state.teammates ?? [])],
        services: state.services ?? [],
        worktrees: state.worktrees ?? [],
        tasks: readAllTaskSnapshots(),
        notifications: notificationSnapshot.notifications,
        notificationUnreadCount: notificationSnapshot.unreadCount,
      });
      send(res, 200, { ok: true, serviceInfo: getProjectServiceManifest(), project });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.topology) {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      const state = this.options.desktop.getState() as {
        mainCheckoutInfo?: { name?: string };
        sessions?: any[];
        teammates?: any[];
        services?: any[];
        worktrees?: any[];
      };
      const topology = buildProjectTopology({
        projectName: state.mainCheckoutInfo?.name ?? "project",
        worktrees: buildTopologyWorktreesFromDesktopState(state),
      });
      send(res, 200, { ok: true, serviceInfo: getProjectServiceManifest(), topology });
      return;
    }
    if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.statuslineRefresh) {
      if (!this.options.desktop?.refreshStatusline) {
        send(res, 501, { ok: false, error: "statusline refresh not supported by this service" });
        return;
      }
      const body = (await readJson(req).catch(() => ({}))) as { sessionId?: string; force?: boolean };
      await this.options.desktop.refreshStatusline({
        sessionId: body.sessionId?.trim() || undefined,
        force: body.force === true,
      });
      notifyCurrentRouteChange({ sessionId: body.sessionId?.trim() || undefined });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.worktrees) {
      if (!this.options.desktop?.listWorktrees) {
        send(res, 501, { ok: false, error: "worktree listing not supported by this service" });
        return;
      }
      send(res, 200, { ok: true, worktrees: this.options.desktop.listWorktrees() });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.graveyard) {
      if (!this.options.desktop?.listGraveyard) {
        send(res, 501, { ok: false, error: "graveyard listing not supported by this service" });
        return;
      }
      const entries = this.options.desktop.listGraveyard();
      const worktrees = this.options.desktop.listWorktreeGraveyard?.() ?? [];
      const state = this.options.desktop.getState?.() as
        | { sessions?: any[]; teammates?: any[]; services?: any[] }
        | undefined;
      send(res, 200, {
        ok: true,
        entries,
        worktrees,
        viewModel: buildGraveyardViewModel({
          agents: entries as any[],
          worktrees: worktrees as any[],
          parentSessions: [...(state?.sessions ?? []), ...(state?.teammates ?? [])],
          teammates: state?.teammates ?? [],
          lastUsedById: loadLastUsedState(this.currentProjectRoot()).items,
        }),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.list) {
      const metadataState = loadMetadataState();
      const tasks = readAllTaskSnapshots();
      const activeTaskFor = (sessionId: string) =>
        tasks.find((task) => task.assignedTo === sessionId && task.status !== "done" && task.status !== "failed");
      const agents = topologyDesktopSessionList(["starting", "running", "idle", "offline"]).map((session) => {
        const meta = metadataState.sessions[session.id];
        const task = activeTaskFor(session.id);
        return {
          id: session.id,
          tool: session.tool ?? session.toolConfigKey ?? session.command,
          toolConfigKey: session.toolConfigKey,
          command: session.command,
          backendSessionId: session.backendSessionId,
          role: session.team?.role,
          status: session.status,
          restoreState: session.restoreState,
          restoreBlockedReason: session.restoreBlockedReason,
          worktreePath: session.worktreePath,
          label: session.label,
          activity: meta?.derived?.activity,
          attention: meta?.derived?.attention,
          loop: meta?.loop,
          loopLastAction: meta?.loopLastAction,
          overseer: meta?.overseer ?? false,
          task: task ? { id: task.id, description: task.description, status: task.status } : undefined,
        };
      });
      send(res, 200, { ok: true, agents });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.threads.list) {
      const parsedLimit = parseBoundedLimit(url.searchParams.get("limit"), "limit", {
        defaultValue: DEFAULT_PROJECT_LIST_LIMIT,
        maxValue: MAX_PROJECT_LIST_LIMIT,
      });
      if (!parsedLimit.ok) {
        send(res, 400, { ok: false, error: parsedLimit.error });
        return;
      }
      send(
        res,
        200,
        listThreadSummaries(url.searchParams.get("session") ?? undefined, {
          limit: parsedLimit.value,
          includeMessageGroups: false,
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.tasks.list) {
      const sessionId = url.searchParams.get("session")?.trim();
      const status = url.searchParams.get("status")?.trim();
      const parsedLimit = parseBoundedLimit(url.searchParams.get("limit"), "limit", {
        defaultValue: DEFAULT_PROJECT_LIST_LIMIT,
        maxValue: MAX_PROJECT_LIST_LIMIT,
      });
      if (!parsedLimit.ok) {
        send(res, 400, { ok: false, error: parsedLimit.error });
        return;
      }
      const allTasks = readAllTaskSnapshots()
        .filter((task) => !sessionId || task.assignedTo === sessionId || task.assignedBy === sessionId)
        .filter((task) => !status || task.status === status);
      const tasks = allTasks.slice(0, parsedLimit.value);
      send(res, 200, {
        ok: true,
        tasks,
        total: allTasks.length,
        limit: parsedLimit.value,
        truncated: tasks.length < allTasks.length,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.usageMark) {
      const body = (await readJson(req)) as { itemId?: string; clientSession?: string; usedAt?: string };
      const itemId = body.itemId?.trim() || "";
      if (!itemId) {
        send(res, 400, { ok: false, error: "itemId is required" });
        return;
      }
      const state = markLastUsed(metadataProjectRoot() ?? this.currentProjectRoot(), {
        itemId,
        clientSession: body.clientSession?.trim() || undefined,
        usedAt: body.usedAt?.trim() || undefined,
      });
      send(res, 200, {
        ok: true,
        itemId,
        lastUsedAt: state.items[itemId]?.lastUsedAt ?? null,
      });
      notifyCurrentRouteChange();
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.controls.switchableAgents) {
      const currentClientSession = url.searchParams.get("currentClientSession")?.trim() || undefined;
      const currentWindow = url.searchParams.get("currentWindow")?.trim() || undefined;
      const currentWindowId = url.searchParams.get("currentWindowId")?.trim() || undefined;
      const currentPath = url.searchParams.get("currentPath")?.trim() || undefined;
      const scope = url.searchParams.get("scope") === "all" ? "all" : "worktree";
      const rawLabels = url.searchParams.get("labelFormat") === "raw";
      const includePreview = url.searchParams.get("includePreview") === "1";
      const includeChatPreview = url.searchParams.get("includeChatPreview") === "1";
      const includeOverseer = url.searchParams.get("includeOverseer") === "1";
      const expose = url.searchParams.get("expose") === "1";
      const trackPreview = this.touchVisualClientLease(req, url, {
        surface: expose ? "expose" : "switchable-agents",
        requestedPreview: includePreview,
        requestedChatPreview: includeChatPreview,
        defaultKind: expose ? "expose" : undefined,
      });
      const rawItems = listSwitchableAgentItems(
        {
          projectRoot: this.currentProjectRoot(),
          currentClientSession,
          currentWindow,
          currentWindowId,
          currentPath,
        },
        new TmuxRuntimeManager(),
        { scope, includeOverseer },
      );
      let itemsWithPreview = includePreview ? this.attachExposePreviewSnapshots(rawItems, { trackPreview }) : rawItems;
      if (includeChatPreview) itemsWithPreview = await this.attachExposeChatPreviews(itemsWithPreview);
      const sublabel = scope === "all" ? "worktree" : "none";
      const exposeItems = expose
        ? orderExposeItems(
            {
              scope: scope === "all" ? "project" : "worktree",
              items: itemsWithPreview,
              scopeLabel: scope === "all" ? "all worktrees" : "this worktree",
              sublabel,
            },
            this.currentProjectRoot(),
          )
        : itemsWithPreview;
      const exposeTones = expose ? assignWorktreeTones(exposeItems, this.currentProjectRoot()) : null;
      const items = exposeItems.map((item) => {
        const serialized = serializeFastControlItem(item);
        const chip = agentStatusChip(item.metadata);
        return {
          ...serialized,
          label:
            rawLabels || !item.lastUsedAt ? item.label : `${item.label} · ${formatRelativeRecency(item.lastUsedAt)}`,
          ...(expose && exposeTones
            ? {
                exposeContext: exposeTileContextForItem(item, sublabel, this.currentProjectRoot(), exposeTones),
                exposeStatus: chip ?? undefined,
              }
            : {}),
        };
      });
      send(res, 200, { ok: true, items });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.outputStream) {
      const outputEventName = "output";
      const sessionId = url.searchParams.get("sessionId")?.trim();
      const startLineRaw = url.searchParams.get("startLine");
      const intervalMsRaw = url.searchParams.get("intervalMs");
      if (!sessionId) {
        send(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (!this.options.lifecycle?.readAgentOutput) {
        send(res, 501, { ok: false, error: "agent output stream not supported by this service" });
        return;
      }

      const parsedStartLine = parseOptionalInteger(startLineRaw, "startLine");
      if (!parsedStartLine.ok) {
        send(res, 400, { ok: false, error: parsedStartLine.error });
        return;
      }
      const captureWindow = agentOutputCaptureWindow(parsedStartLine.value);
      const startLine = captureWindow.startLine;

      const parsedIntervalMs =
        intervalMsRaw === null || intervalMsRaw.trim() === ""
          ? ({ ok: true, value: 500 } as const)
          : parsePositiveInteger(intervalMsRaw, "intervalMs");
      if (!parsedIntervalMs.ok || parsedIntervalMs.value < 100) {
        send(res, 400, { ok: false, error: "intervalMs must be an integer >= 100" });
        return;
      }
      const intervalMs = parsedIntervalMs.value;

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.setHeader("access-control-allow-origin", "*");
      res.flushHeaders?.();

      let closed = false;
      let lastOutput: string | undefined;
      // Activity changes without the pane changing — an agent finishing
      // leaves the last frame on screen — so a text-only gate would hold a
      // stream at "running" indefinitely.
      let lastLiveness: string | undefined;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let pollInFlight = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        res.end();
      };

      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);

      const poll = async () => {
        if (closed) return;
        if (pollInFlight) return;
        pollInFlight = true;
        try {
          const readInput = {
            sessionId,
            startLine: parsedStartLine.value,
          };
          const { result, durationMs, coalesced } = await this.measureAgentOutputRead("output-stream", readInput);
          if (closed) return;
          const liveness = `${result.activity ?? ""}:${result.attention ?? ""}`;
          const changed = result.output !== lastOutput || liveness !== lastLiveness;
          this.recordAgentOutputRead("output-stream", readInput, result, durationMs, changed, coalesced);
          if (changed) {
            lastOutput = result.output;
            lastLiveness = liveness;
            sendSseEvent(res, outputEventName, {
              sessionId: result.sessionId,
              output: result.output,
              outputAnsi: result.outputAnsi,
              startLine: result.startLine ?? startLine,
              requestedStartLine: result.requestedStartLine ?? captureWindow.requestedStartLine,
              endLine: result.endLine ?? captureWindow.endLine,
              captureLineLimit: result.captureLineLimit ?? captureWindow.maxLines,
              outputTailOnly: result.outputTailOnly ?? captureWindow.tailOnly,
              outputStartLineClamped: result.outputStartLineClamped ?? captureWindow.clamped,
              parsed: result.parsed,
              // Forwarded explicitly: this payload is hand-picked, so a field
              // added to readAgentOutput does not reach a stream by itself.
              messages: result.messages,
              activity: result.activity,
              activityText: result.activityText,
              attention: result.attention,
            });
          } else {
            res.write(": keepalive\n\n");
          }
        } catch (error) {
          sendSseEvent(res, "error", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        } finally {
          pollInFlight = false;
        }
      };

      sendSseEvent(res, "ready", {
        sessionId,
        startLine,
        requestedStartLine: captureWindow.requestedStartLine,
        endLine: captureWindow.endLine,
        captureLineLimit: captureWindow.maxLines,
        outputTailOnly: captureWindow.tailOnly,
        outputStartLineClamped: captureWindow.clamped,
        intervalMs,
      });
      await poll();
      pollTimer = setInterval(() => {
        void poll();
      }, intervalMs);
      pollTimer.unref?.();
      return;
    }
    const threadRoutePrefix = `${PROJECT_API_ROUTES.threads.list}/`;
    if (req.method === "GET" && url.pathname.startsWith(threadRoutePrefix)) {
      let threadId: string;
      try {
        threadId = decodeURIComponent(url.pathname.slice(threadRoutePrefix.length));
      } catch {
        send(res, 400, { ok: false, error: "invalid threadId" });
        return;
      }
      const thread = readThread(threadId);
      if (!thread) {
        send(res, 404, { ok: false, error: "thread not found" });
        return;
      }
      const parsedLimit = parseBoundedLimit(url.searchParams.get("messageLimit"), "messageLimit", {
        defaultValue: DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT,
        maxValue: MAX_PROJECT_DETAIL_MESSAGE_LIMIT,
      });
      if (!parsedLimit.ok) {
        send(res, 400, { ok: false, error: parsedLimit.error });
        return;
      }
      const messageSnapshot = readMessageSnapshot(threadId, { limit: parsedLimit.value });
      send(res, 200, {
        thread,
        messages: messageSnapshot.messages,
        messageTotal: messageSnapshot.total,
        messageLimit: messageSnapshot.limit,
        messagesTruncated: messageSnapshot.truncated,
      });
      return;
    }
    const taskRoutePrefix = `${PROJECT_API_ROUTES.tasks.list}/`;
    if (req.method === "GET" && url.pathname.startsWith(taskRoutePrefix)) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(url.pathname.slice(taskRoutePrefix.length));
      } catch {
        send(res, 400, { ok: false, error: "invalid taskId" });
        return;
      }
      const task = readTaskSnapshot(taskId);
      if (!task) {
        send(res, 404, { ok: false, error: "task not found" });
        return;
      }
      const thread = task.threadId ? readThread(task.threadId) : undefined;
      const parsedLimit = parseBoundedLimit(url.searchParams.get("messageLimit"), "messageLimit", {
        defaultValue: DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT,
        maxValue: MAX_PROJECT_DETAIL_MESSAGE_LIMIT,
      });
      if (!parsedLimit.ok) {
        send(res, 400, { ok: false, error: parsedLimit.error });
        return;
      }
      const messageSnapshot = task.threadId
        ? readMessageSnapshot(task.threadId, { limit: parsedLimit.value })
        : { messages: [], total: 0, limit: parsedLimit.value, truncated: false };
      send(res, 200, {
        ok: true,
        task,
        thread,
        messages: messageSnapshot.messages,
        messageTotal: messageSnapshot.total,
        messageLimit: messageSnapshot.limit,
        messagesTruncated: messageSnapshot.truncated,
      });
      return;
    }

    let activeLifecycleTransition: LifecycleTransitionInput | undefined;
    let failedLifecycleTransition: LifecycleTransitionInput | undefined;
    const runLifecycle = async <T>(input: LifecycleTransitionInput, action: () => Promise<T> | T): Promise<T> => {
      activeLifecycleTransition = input;
      failedLifecycleTransition = undefined;
      try {
        return await action();
      } catch (error) {
        failedLifecycleTransition = input;
        throw error;
      } finally {
        activeLifecycleTransition = undefined;
      }
    };
    const sendQueuedLifecycle = async <T extends object, P extends object>(opts: {
      transition: LifecycleTransitionInput;
      resolvedTransition?: (result: T) => LifecycleTransitionInput;
      action: () => Promise<T> | T;
      pending: P;
      actionName: string;
      acceptedStatus?: number;
    }): Promise<void> => {
      const resultPromise = this.enqueueLifecycleMutation(
        () => runLifecycle(opts.transition, opts.action),
        opts.transition,
      );
      const earlyResult = await waitForEarlyLifecycleResult(resultPromise);
      if (earlyResult.kind === "resolved") {
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(earlyResult.result, opts.resolvedTransition?.(earlyResult.result) ?? opts.transition),
        );
        return;
      }
      if (earlyResult.kind === "rejected") {
        throw earlyResult.error;
      }
      notifyCurrentRouteChange();
      this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, opts.actionName);
      send(
        res,
        opts.acceptedStatus ?? 202,
        lifecycleOk(opts.pending, {
          ...opts.transition,
          phase: "settling",
        }),
      );
    };

    try {
      const planRoutePrefix = `${PROJECT_API_ROUTES.plans}/`;
      if (req.method === "GET" && url.pathname.startsWith(planRoutePrefix)) {
        let raw: string;
        try {
          raw = decodeURIComponent(url.pathname.slice(planRoutePrefix.length));
        } catch {
          send(res, 400, { ok: false, error: "invalid sessionId" });
          return;
        }
        const validation = validatePlanSessionId(raw);
        if (!validation.ok) {
          send(res, 400, { ok: false, error: "invalid sessionId" });
          return;
        }
        const sessionId = validation.value;
        try {
          const content = readPlanContent(sessionId);
          if (content === null) {
            send(res, 404, { ok: false, error: "Plan not found" });
            return;
          }
          send(res, 200, { ok: true, sessionId, content });
        } catch {
          send(res, 500, { ok: false, error: "Failed to read plan" });
          return;
        }
        return;
      }

      if (req.method === "PUT" && url.pathname.startsWith(planRoutePrefix)) {
        let raw: string;
        try {
          raw = decodeURIComponent(url.pathname.slice(planRoutePrefix.length));
        } catch {
          send(res, 400, { ok: false, error: "invalid sessionId" });
          return;
        }
        const validation = validatePlanSessionId(raw);
        if (!validation.ok) {
          send(res, 400, { ok: false, error: "invalid sessionId" });
          return;
        }
        const sessionId = validation.value;
        const body = (await readJson(req)) as { content?: unknown };
        if (typeof body.content !== "string") {
          send(res, 400, { ok: false, error: "content must be a string" });
          return;
        }
        try {
          writePlanContent(sessionId, body.content);
        } catch {
          send(res, 500, { ok: false, error: "Failed to write plan" });
          return;
        }
        notifyCurrentRouteChange({ sessionId });
        send(res, 200, { ok: true, sessionId });
        return;
      }

      if (url.pathname === PROJECT_API_ROUTES.statuslineSegment) {
        /**
         * One segment on one rail, published from outside this process.
         *
         * The in-process equivalent is the plugin API, which is not available
         * to a cron, a systemd unit or a shell script — and those are exactly
         * what tends to know something worth putting on a bar.
         *
         * Deliberately incurious about what a segment MEANS. `text` is
         * rendered, `data` is carried to whoever asked for it, and neither is
         * interpreted here.
         */
        let body: {
          session?: string;
          line?: "top" | "bottom";
          id?: string;
          text?: string;
          tone?: MetadataTone;
          ttlSeconds?: number;
          data?: unknown;
        };
        try {
          body = await readJson(req);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            send(res, 413, { ok: false, error: err.message });
            return;
          }
          send(res, 400, { ok: false, error: "body is not JSON" });
          return;
        }
        if (!body.session) {
          send(res, 400, { ok: false, error: "session is required" });
          return;
        }
        if (body.line !== undefined && body.line !== "top" && body.line !== "bottom") {
          send(res, 400, { ok: false, error: "line must be top or bottom" });
          return;
        }

        if (req.method === "DELETE") {
          if (!body.id) {
            send(res, 400, { ok: false, error: "id is required" });
            return;
          }
          // No default here. Omitting the line means "wherever it is", which
          // is the only way to withdraw a segment without knowing which rail
          // it was put on — defaulting first made that unreachable and turned
          // a wrong guess into a silent 200 that removed nothing.
          dropStatuslineSegment(body.session, body.id, body.line);
          notifyCurrentRouteChange({ sessionId: body.session });
          send(res, 200, { ok: true });
          return;
        }

        const line = body.line ?? "bottom";

        if (req.method !== "POST") {
          send(res, 405, { ok: false, error: "use POST or DELETE" });
          return;
        }

        // A TTL rather than an absolute time, because the publisher's clock is
        // not this one's and a skewed sender would otherwise post something
        // already expired, or expiring next year.
        const ttl = body.ttlSeconds;
        if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_SEGMENT_TTL_SECONDS)) {
          send(res, 400, {
            ok: false,
            error: `ttlSeconds must be between 1 and ${MAX_SEGMENT_TTL_SECONDS}`,
          });
          return;
        }
        const segment: SessionStatuslineSegment = {
          id: body.id,
          text: body.text ?? "",
          ...(body.tone ? { tone: body.tone } : {}),
          ...(ttl ? { expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } : {}),
          ...(body.data !== undefined ? { data: body.data } : {}),
        };
        const rejection = segmentRejection(segment);
        if (rejection) {
          send(res, 400, { ok: false, error: rejection });
          return;
        }
        putStatuslineSegment(body.session, line, segment);
        notifyCurrentRouteChange({ sessionId: body.session });
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setStatus) {
        const body = (await readJson(req)) as { session: string; text: string; tone?: MetadataTone };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          status: { text: body.text, tone: body.tone },
        }));
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        url.pathname === PROJECT_API_ROUTES.controls.openDashboard
      ) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindowId?: string;
                focus?: boolean;
                forceReload?: boolean;
                screen?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const currentWindowId =
          body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined;
        const rawScreen = body.screen ?? url.searchParams.get("screen") ?? undefined;
        const screen = parseDashboardControlScreen(rawScreen);
        const forceReload =
          body.forceReload === true ||
          url.searchParams.get("forceReload") === "1" ||
          url.searchParams.get("forceReload") === "true";
        if (rawScreen != null && !screen) {
          send(res, 400, { ok: false, error: "invalid dashboard screen" });
          return;
        }
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        const tmux = new TmuxRuntimeManager();
        if (!focus) {
          const sessionError = validateProjectClientSession(tmux, this.currentProjectRoot(), currentClientSession);
          if (sessionError) {
            send(res, 400, { ok: false, error: sessionError });
            return;
          }
          const target = findExistingDashboardTarget(tmux, this.currentProjectRoot(), currentClientSession);
          if (!target) {
            send(res, 404, { ok: false, error: "dashboard window not found" });
            return;
          }
          if (screen && currentClientSession) {
            persistDashboardClientPreference(currentClientSession, (snapshot) => {
              snapshot.screen = screen;
            });
          }
          sendControlAction(res, "open-dashboard", target, { focused: false });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusClientSession = resolveControlFocusClientSession(tmux, currentClientSession, clientTty, focus);
        if (focusClientSession) {
          persistDashboardReturnSelection(tmux, this.currentProjectRoot(), focusClientSession, currentWindowId);
          if (screen) {
            persistDashboardClientPreference(focusClientSession, (snapshot) => {
              snapshot.screen = screen;
            });
          }
        }
        const { dashboardBuildStamp } = getDashboardCommandSpec(this.currentProjectRoot());
        const { dashboardTarget: target } = resolveDashboardTarget(this.currentProjectRoot(), tmux, {
          forceReload,
          openInHostSession: true,
        });
        if (!(await waitForDashboardReady(tmux, target, dashboardBuildStamp))) {
          send(res, 503, { ok: false, error: "dashboard did not become ready" });
          return;
        }
        const focusResult = focusControlTarget(tmux, target, focusClientSession, clientTty, focus);
        sendControlAction(res, "open-dashboard", target, focusResult);
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        url.pathname === PROJECT_API_ROUTES.controls.openNotificationTarget
      ) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                sessionId?: string;
                currentClientSession?: string;
                clientTty?: string;
                focus?: boolean;
              })
            : {};
        const sessionId = body.sessionId?.trim() || url.searchParams.get("sessionId")?.trim() || undefined;
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.desktop?.getState) {
          send(res, 501, { ok: false, error: "desktop state not supported by this service" });
          return;
        }
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        const desktop = this.options.desktop.getState() as { sessions?: any[]; teammates?: any[]; services?: any[] };
        const session = [...(desktop.sessions ?? []), ...(desktop.teammates ?? [])].find(
          (entry) => entry.id === sessionId,
        );
        const service = (desktop.services ?? []).find((entry) => entry.id === sessionId);
        const tmux = new TmuxRuntimeManager();
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusClientSession = resolveControlFocusClientSession(tmux, currentClientSession, clientTty, focus);

        const openWindowId = (windowId: string, itemId?: string) => {
          const match = findProjectManagedWindow(tmux, this.currentProjectRoot(), { windowId, sessionId: itemId });
          if (!match) {
            send(res, 404, { ok: false, error: "window not found" });
            return;
          }
          const focusResult = focusControlTarget(tmux, match.target, focusClientSession, clientTty, focus);
          if (focus && itemId && session?.id === itemId) {
            markSessionViewed(itemId, metadataProjectRoot());
          }
          if (focus) {
            markTargetUsed(tmux, this.currentProjectRoot(), match.target, focusClientSession, itemId);
            notifyCurrentRouteChange();
          }
          sendControlAction(res, "open-notification-target", match.target, focusResult, itemId);
        };

        if (service && service.status !== "running") {
          send(res, 409, { ok: false, error: "service is offline", itemId: service.id });
          return;
        }
        if (session && (session.status === "offline" || session.status === "exited")) {
          send(res, 409, { ok: false, error: "agent is offline", itemId: session.id });
          return;
        }
        if (session?.tmuxWindowId) {
          openWindowId(session.tmuxWindowId, session.id);
          return;
        }
        if (service?.tmuxWindowId) {
          openWindowId(service.tmuxWindowId, service.id);
          return;
        }
        send(res, 404, { ok: false, error: "notification target is no longer available" });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === PROJECT_API_ROUTES.controls.focusWindow) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                windowId?: string;
                focus?: boolean;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const windowId = body.windowId?.trim() || url.searchParams.get("windowId")?.trim() || undefined;
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        if (!windowId) {
          send(res, 400, { ok: false, error: "windowId is required" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        const match = findProjectManagedWindow(tmux, this.currentProjectRoot(), { windowId });
        if (!match) {
          send(res, 404, { ok: false, error: "window not found" });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusClientSession = resolveControlFocusClientSession(tmux, currentClientSession, clientTty, focus);
        const focusResult = focusControlTarget(tmux, match.target, focusClientSession, clientTty, focus);
        const itemId =
          match?.metadata.kind === "agent" || match?.metadata.kind === "service" ? match.metadata.sessionId : undefined;
        if (focus && match?.metadata.kind === "agent") {
          markSessionViewed(match.metadata.sessionId, metadataProjectRoot());
        }
        if (focus) {
          markTargetUsed(tmux, this.currentProjectRoot(), match.target, focusClientSession, itemId);
          notifyCurrentRouteChange();
        }
        sendControlAction(res, "focus-window", match.target, focusResult, itemId);
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        url.pathname === PROJECT_API_ROUTES.controls.activeWindow
      ) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const currentWindow = body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined;
        const currentWindowId =
          body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined;
        const tmux = new TmuxRuntimeManager();
        if (!currentClientSession) {
          send(res, 400, { ok: false, error: "currentClientSession is required" });
          return;
        }
        if (!currentWindowId) {
          send(res, 400, { ok: false, error: "currentWindowId is required" });
          return;
        }
        const sessionError = validateProjectClientSession(tmux, this.currentProjectRoot(), currentClientSession);
        if (sessionError) {
          send(res, 400, { ok: false, error: sessionError });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          true,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const activeWindow = tmux.listWindows(currentClientSession).find((window) => window.active);
        if (activeWindow?.id !== currentWindowId || (currentWindow && activeWindow.name !== currentWindow)) {
          send(res, 404, { ok: false, error: "window not found" });
          return;
        }
        const ok = markActiveWindowFocused(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          activeWindow.name,
          currentWindowId,
        );
        if (!ok) {
          send(res, 404, { ok: false, error: "window not found" });
          return;
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, action: "active-window", focused: false });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === PROJECT_API_ROUTES.controls.switchNext) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
                focus?: boolean;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        const tmux = new TmuxRuntimeManager();
        const sessionError = validateProjectClientSession(tmux, this.currentProjectRoot(), currentClientSession);
        if (sessionError) {
          send(res, 400, { ok: false, error: sessionError });
          return;
        }
        const item = resolveNextAgent(
          {
            projectRoot: this.currentProjectRoot(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          tmux,
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no switchable agent found" });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusResult = focusControlTarget(tmux, item.target, currentClientSession, clientTty, focus);
        if (focus) {
          markSessionViewed(item.metadata.sessionId, metadataProjectRoot());
          markTargetUsed(tmux, this.currentProjectRoot(), item.target, currentClientSession, item.metadata.sessionId);
          notifyCurrentRouteChange();
        }
        sendControlAction(res, "switch-next", item.target, focusResult, item.metadata.sessionId);
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === PROJECT_API_ROUTES.controls.switchPrev) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
                focus?: boolean;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        const tmux = new TmuxRuntimeManager();
        const sessionError = validateProjectClientSession(tmux, this.currentProjectRoot(), currentClientSession);
        if (sessionError) {
          send(res, 400, { ok: false, error: sessionError });
          return;
        }
        const item = resolvePrevAgent(
          {
            projectRoot: this.currentProjectRoot(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          tmux,
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no switchable agent found" });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusResult = focusControlTarget(tmux, item.target, currentClientSession, clientTty, focus);
        if (focus) {
          markSessionViewed(item.metadata.sessionId, metadataProjectRoot());
          markTargetUsed(tmux, this.currentProjectRoot(), item.target, currentClientSession, item.metadata.sessionId);
          notifyCurrentRouteChange();
        }
        sendControlAction(res, "switch-prev", item.target, focusResult, item.metadata.sessionId);
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        url.pathname === PROJECT_API_ROUTES.controls.switchAttention
      ) {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
                focus?: boolean;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const focus = controlFocusRequested(body as Record<string, unknown>, url);
        const tmux = new TmuxRuntimeManager();
        const sessionError = validateProjectClientSession(tmux, this.currentProjectRoot(), currentClientSession);
        if (sessionError) {
          send(res, 400, { ok: false, error: sessionError });
          return;
        }
        const item = resolveAttentionAgent(
          {
            projectRoot: this.currentProjectRoot(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          tmux,
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no attention target found" });
          return;
        }
        const focusError = validateControlFocusContext(
          tmux,
          this.currentProjectRoot(),
          currentClientSession,
          clientTty,
          focus,
        );
        if (focusError) {
          send(res, 400, { ok: false, error: focusError });
          return;
        }
        const focusResult = focusControlTarget(tmux, item.target, currentClientSession, clientTty, focus);
        if (focus) {
          markSessionViewed(item.metadata.sessionId, metadataProjectRoot());
          markTargetUsed(tmux, this.currentProjectRoot(), item.target, currentClientSession, item.metadata.sessionId);
          notifyCurrentRouteChange();
        }
        sendControlAction(res, "switch-attention", item.target, focusResult, item.metadata.sessionId);
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setProgress) {
        const body = (await readJson(req)) as {
          session: string;
          current: number;
          total: number;
          label?: string;
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          progress: { current: body.current, total: body.total, label: body.label },
        }));
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setContext) {
        const body = (await readJson(req)) as {
          session: string;
          context?: SessionContextMetadata | null;
        };
        updateSessionMetadata(body.session, (current) => {
          const pr =
            current.context?.pr || body.context?.pr
              ? {
                  ...(current.context?.pr ?? {}),
                  ...(body.context?.pr ?? {}),
                }
              : undefined;
          return {
            ...current,
            context: {
              ...(current.context ?? {}),
              ...(body.context ?? {}),
              ...(pr ? { pr } : {}),
            },
          };
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setServices) {
        const body = (await readJson(req)) as {
          session: string;
          services: SessionServiceMetadata[];
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          derived: {
            ...(current.derived ?? {}),
            services: body.services,
          },
        }));
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.hooks.claude) {
        const action = url.searchParams.get("action")?.trim() ?? "";
        const sessionHeader = req.headers["x-aimux-session-id"];
        const sessionId =
          (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader)?.trim() ??
          url.searchParams.get("sessionId")?.trim() ??
          "";
        if (!action || !sessionId) {
          send(res, 400, { ok: false, error: "action and sessionId are required" });
          return;
        }
        const body = (await readJson(req).catch(() => ({}))) as ClaudeHookPayload;
        const output = await this.handleClaudeHook(action, sessionId, body, req, res);
        if (output === null) return;
        send(res, 200, output);
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.hooks.codex) {
        const action = url.searchParams.get("action")?.trim() ?? "";
        const sessionHeader = req.headers["x-aimux-session-id"];
        const sessionId =
          (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader)?.trim() ??
          url.searchParams.get("sessionId")?.trim() ??
          "";
        if (!action || !sessionId) {
          send(res, 400, { ok: false, error: "action and sessionId are required" });
          return;
        }
        const body = (await readJson(req).catch(() => ({}))) as CodexHookPayload;
        await this.handleCodexHook(action, sessionId, body);
        send(res, 200, {});
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.log) {
        const body = (await readJson(req)) as {
          session: string;
          message: string;
          source?: string;
          tone?: MetadataTone;
        };
        const entry: SessionLogEntry = {
          message: body.message,
          source: body.source,
          tone: body.tone,
          ts: new Date().toISOString(),
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          logs: [...(current.logs ?? []).slice(-19), entry],
        }));
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.event) {
        const body = (await readJson(req)) as { session: string; event: AgentEvent };
        this.tracker.emit(body.session, body.event);
        if (body.event.kind === "needs_input") {
          this.emitAlert({
            kind: "needs_input",
            sessionId: body.session,
            title: `${body.session} needs input`,
            message: body.event.message || "Agent is waiting for input.",
            dedupeKey: `needs_input:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.event.kind === "blocked") {
          this.emitAlert({
            kind: "blocked",
            sessionId: body.session,
            title: `${body.session} is blocked`,
            message: body.event.message || "Agent reported a blocked state.",
            dedupeKey: `blocked:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.event.kind === "task_failed" || body.event.tone === "error") {
          this.emitAlert({
            kind: "task_failed",
            sessionId: body.session,
            title: `${body.session} errored`,
            message: body.event.message || "Agent reported an error state.",
            dedupeKey: `error:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.event.kind === "notify") {
          this.emitAlert({
            kind: "notification",
            sessionId: body.session,
            title: body.event.source ?? "notification",
            message: body.event.message || "Agent notification.",
            dedupeKey: body.event.message ? `notify:${body.session}:${body.event.message}` : undefined,
            cooldownMs: 15_000,
          });
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.markSeen) {
        const body = (await readJson(req)) as { session: string };
        markSessionViewed(body.session, metadataProjectRoot());
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setActivity) {
        const body = (await readJson(req)) as { session: string; activity: AgentActivityState };
        this.tracker.setActivity(body.session, body.activity);
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.setAttention) {
        const body = (await readJson(req)) as { session: string; attention: AgentAttentionState };
        this.tracker.setAttention(body.session, body.attention);
        if (body.attention === "needs_input") {
          this.emitAlert({
            kind: "needs_input",
            sessionId: body.session,
            title: `${body.session} needs input`,
            message: "Agent is waiting for input.",
            dedupeKey: `needs_input:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.attention === "blocked") {
          this.emitAlert({
            kind: "blocked",
            sessionId: body.session,
            title: `${body.session} is blocked`,
            message: "Agent reported a blocked state.",
            dedupeKey: `blocked:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.attention === "error") {
          this.emitAlert({
            kind: "task_failed",
            sessionId: body.session,
            title: `${body.session} errored`,
            message: "Agent reported an error state.",
            dedupeKey: `error:${body.session}`,
            cooldownMs: 15_000,
          });
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.interactionRegister) {
        const body = (await readJson(req)) as {
          session?: string;
          type?: InteractionType;
          payload?: Record<string, unknown>;
          summary?: string;
          id?: string;
        };
        const sessionId = body.session?.trim();
        const type = body.type;
        const validTypes: InteractionType[] = ["permission", "exit_plan", "question", "input"];
        if (!sessionId || !type || !validTypes.includes(type)) {
          send(res, 400, { ok: false, error: "session and a valid type are required" });
          return;
        }
        const payload = body.payload;
        if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
          send(res, 400, { ok: false, error: "payload must be an object" });
          return;
        }
        const summary = body.summary?.trim() || undefined;
        const request = this.beginInteraction({ sessionId, type, payload: payload ?? {}, summary, id: body.id });
        send(res, 200, { ok: true, request });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.interactionNotify) {
        // Read-only telemetry (e.g. Codex, whose native TUI owns the decision):
        // emit a non-actionable interaction alert and flag attention, but never
        // register a blocking interaction. Returns immediately.
        const body = (await readJson(req).catch(() => null)) as {
          session?: string;
          summary?: string;
          payload?: { toolName?: string; input?: Record<string, unknown>; cwd?: string };
        } | null;
        const sessionId = body?.session?.trim();
        if (!body || !sessionId) {
          send(res, 400, { ok: false, error: "session is required" });
          return;
        }
        const toolName = body.payload?.toolName;
        const rawInput = body.payload?.input;
        const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
        const cwd = typeof body.payload?.cwd === "string" ? body.payload.cwd : undefined;
        const summary = body.summary?.trim() || undefined;
        this.tracker.setAttention(sessionId, "needs_input");
        this.emitAlert({
          kind: "interaction_request",
          sessionId,
          title: `${sessionId} needs a response`,
          message: summary ?? "Agent is waiting on a permission response.",
          worktreePath: cwd,
          interaction: {
            id: randomUUID(),
            type: "permission",
            summary,
            telemetry: true,
            toolName,
            toolInputJSON: JSON.stringify(input),
          },
          dedupeKey: this.interactionDedupeKey({
            sessionId,
            type: "permission",
            summary,
            payload: { toolName, input, cwd },
          }),
          cooldownMs: 60_000,
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, telemetry: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.interactionRequest) {
        const body = (await readJson(req)) as {
          session?: string;
          type?: InteractionType;
          payload?: Record<string, unknown>;
          summary?: string;
          id?: string;
          timeoutMs?: number;
        };
        const sessionId = body.session?.trim();
        const type = body.type;
        const validTypes: InteractionType[] = ["permission", "exit_plan", "question", "input"];
        if (!sessionId || !type || !validTypes.includes(type)) {
          send(res, 400, { ok: false, error: "session and a valid type are required" });
          return;
        }
        const payload = body.payload;
        if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
          send(res, 400, { ok: false, error: "payload must be an object" });
          return;
        }
        if (this.interactionWatchers <= 0) {
          send(res, 200, { ok: true, watching: false });
          return;
        }
        const summary = body.summary?.trim() || undefined;
        const request = this.beginInteraction({ sessionId, type, payload: payload ?? {}, summary, id: body.id });
        const timeoutMs =
          typeof body.timeoutMs === "number" && !Number.isNaN(body.timeoutMs)
            ? Math.min(Math.max(body.timeoutMs, 1_000), 600_000)
            : 110_000;
        const controller = new AbortController();
        let closed = false;
        const onClose = () => {
          closed = true;
          controller.abort();
        };
        req.on("close", onClose);
        req.on("aborted", onClose);
        res.on("close", onClose);
        const settled = await this.interactions.wait(request.id, { timeoutMs, signal: controller.signal });
        if (settled.status !== "resolved" && this.interactions.listPending(sessionId).length === 0) {
          this.tracker.setAttention(sessionId, "normal");
          notifyCurrentRouteChange();
        }
        if (closed) return;
        send(res, 200, { ok: true, request: settled });
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.interactionWait) {
        const id = url.searchParams.get("id")?.trim();
        if (!id) {
          send(res, 400, { ok: false, error: "id is required" });
          return;
        }
        const timeoutRaw = url.searchParams.get("timeoutMs");
        const parsed = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : Number.NaN;
        const timeoutMs = Number.isNaN(parsed) ? 110_000 : Math.min(Math.max(parsed, 1_000), 600_000);
        const controller = new AbortController();
        let closed = false;
        const onClose = () => {
          closed = true;
          controller.abort();
        };
        req.on("close", onClose);
        req.on("aborted", onClose);
        res.on("close", onClose);
        const request = await this.interactions.wait(id, { timeoutMs, signal: controller.signal });
        if (closed) return;
        send(res, 200, { ok: true, request });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.interactionRespond) {
        const body = (await readJson(req)) as { id?: string; response?: InteractionResponse };
        const id = body.id?.trim();
        if (!id) {
          send(res, 400, { ok: false, error: "id is required" });
          return;
        }
        const response = body.response;
        if (response !== undefined && (typeof response !== "object" || response === null || Array.isArray(response))) {
          send(res, 400, { ok: false, error: "response must be an object" });
          return;
        }
        const request = this.interactions.resolve(id, response ?? {});
        if (!request) {
          send(res, 409, { ok: false, error: "no pending interaction for id" });
          return;
        }
        if (request.sessionId && this.interactions.listPending(request.sessionId).length === 0) {
          this.tracker.setAttention(request.sessionId, "normal");
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, request });
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.interactionPending) {
        const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
        send(res, 200, { ok: true, requests: this.interactions.listPending(sessionId) });
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.interactionStream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders?.();

        this.interactionWatchers += 1;
        let closed = false;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        const unsubscribe = this.eventBus.subscribe((event) => {
          if (closed) return;
          if (event.type === "alert" && event.kind === "interaction_request") {
            sendSseEvent(res, "interaction", event);
          }
        });
        const cleanup = () => {
          if (closed) return;
          closed = true;
          this.interactionWatchers -= 1;
          unsubscribe();
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
          res.end();
        };
        req.on("close", cleanup);
        req.on("aborted", cleanup);
        res.on("close", cleanup);
        try {
          sendSseEvent(res, "ready", { pending: this.interactions.listPending() });
          keepaliveTimer = setInterval(() => {
            if (closed) return;
            res.write(": keepalive\n\n");
          }, 15_000);
          keepaliveTimer.unref?.();
        } catch {
          cleanup();
        }
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.clearLog) {
        const body = (await readJson(req)) as { session: string };
        clearSessionLogs(body.session);
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.notify) {
        const body = (await readJson(req)) as {
          title?: string;
          subtitle?: string;
          message?: string;
          sessionId?: string;
          kind?: string;
          force?: boolean;
          worktreePath?: string;
          worktreeName?: string;
          branch?: string;
        };
        const requestedKind = body.kind?.trim();
        const kind: AlertKind =
          requestedKind === "notification" || requestedKind === "generic"
            ? "notification"
            : requestedKind === "task_done" || requestedKind === "complete"
              ? "task_done"
              : requestedKind === "next_step"
                ? "next_step"
                : requestedKind === "task_failed" || requestedKind === "error"
                  ? "task_failed"
                  : requestedKind === "blocked"
                    ? "blocked"
                    : requestedKind === "message_waiting"
                      ? "message_waiting"
                      : requestedKind === "handoff_waiting"
                        ? "handoff_waiting"
                        : requestedKind === "task_assigned"
                          ? "task_assigned"
                          : requestedKind === "review_waiting"
                            ? "review_waiting"
                            : "needs_input";
        const sessionId = body.sessionId?.trim() || undefined;
        const dedupeKey = body.force
          ? undefined
          : kind === "needs_input" && sessionId
            ? `needs_input:${sessionId}`
            : kind === "next_step" && sessionId
              ? `idle-needs-input:${sessionId}`
              : kind === "blocked" && sessionId
                ? `blocked:${sessionId}`
                : kind === "task_failed" && sessionId
                  ? `error:${sessionId}`
                  : kind === "task_done"
                    ? `notify:complete:${body.title ?? body.message ?? "aimux"}`
                    : undefined;
        this.emitAlert({
          kind,
          sessionId,
          title: body.title ?? "",
          message: [body.subtitle?.trim(), body.message?.trim() || body.title?.trim() || "aimux"]
            .filter(Boolean)
            .join(" — "),
          worktreePath: optionalString(body.worktreePath),
          worktreeName: optionalString(body.worktreeName),
          branch: optionalString(body.branch),
          dedupeKey,
          forceNotify: Boolean(body.force),
        });
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.notificationContext) {
        const body = (await readJson(req)) as {
          source?: "desktop" | "tui";
          focused?: boolean;
          screen?: string;
          sessionId?: string;
          panelOpen?: boolean;
        };
        const source = body.source === "desktop" ? "desktop" : "tui";
        const context = updateNotificationContext(
          source,
          {
            focused: Boolean(body.focused),
            screen: body.screen?.trim() || undefined,
            sessionId: body.sessionId?.trim() || undefined,
            panelOpen: Boolean(body.panelOpen),
          },
          metadataProjectRoot(),
        );
        send(res, 200, { ok: true, context });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.notifications.read) {
        const body = (await readJson(req)) as { id?: string; ids?: unknown; sessionId?: string };
        const sessionId = body.sessionId?.trim() || undefined;
        const ids = parseNotificationMutationIds(body);
        const updated = markNotificationsRead({
          id: body.id?.trim() || undefined,
          ids,
          sessionId,
          projectRoot: metadataProjectRoot(),
        });
        this.notifyProjectChanged({
          views: [...PROJECT_API_VIEW_INVALIDATIONS.notifications],
          reason: "notifications-read",
          sessionId,
        });
        send(res, 200, { ok: true, updated });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.notifications.clear) {
        const body = (await readJson(req)) as { id?: string; ids?: unknown; sessionId?: string };
        const sessionId = body.sessionId?.trim() || undefined;
        const ids = parseNotificationMutationIds(body);
        const cleared = clearNotifications({
          id: body.id?.trim() || undefined,
          ids,
          sessionId,
          projectRoot: metadataProjectRoot(),
        });
        this.notifyProjectChanged({
          views: [...PROJECT_API_VIEW_INVALIDATIONS.notifications],
          reason: "notifications-clear",
          sessionId,
        });
        send(res, 200, { ok: true, cleared });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.operationFailuresClear) {
        const body = (await readJson(req)) as {
          targetKind?: "worktree" | "agent" | "service" | "dashboard";
          operation?: string;
          targetId?: string;
          worktreePath?: string;
        };
        const cleared = clearDashboardOperationFailures({
          targetKind: body.targetKind,
          operation: body.operation?.trim() || undefined,
          targetId: body.targetId?.trim() || undefined,
          worktreePath: body.worktreePath?.trim() || undefined,
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, cleared });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.runtime.shellState) {
        const body = (await readJson(req)) as { state: string; sessionId: string; tool?: string; command?: string };
        const state = typeof body.state === "string" ? body.state.trim() : "";
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId || !state || !SHELL_STATES.has(state)) {
          send(res, 400, { ok: false, error: "invalid shell-state payload" });
          return;
        }
        if (body.tool !== undefined && typeof body.tool !== "string") {
          send(res, 400, { ok: false, error: "invalid shell-state tool" });
          return;
        }
        if (body.command !== undefined && typeof body.command !== "string") {
          send(res, 400, { ok: false, error: "invalid shell-state command" });
          return;
        }
        if (consumeShellStateSuppressFile(sessionId)) {
          send(res, 202, { ok: true, suppressed: true, sessionId, state });
          return;
        }
        this.scheduleShellStateUpdate({
          state,
          sessionId,
          tool: body.tool,
          command: body.command,
        });
        send(res, 202, { ok: true, queued: true, sessionId, state });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.threads.open) {
        const body = (await readJson(req)) as {
          title: string;
          from: string;
          participants: string[];
          kind?: ThreadKind;
          worktreePath?: string;
        };
        const thread = createThread({
          title: body.title,
          createdBy: body.from,
          participants: [...new Set([body.from, ...(body.participants ?? [])])],
          kind: (body.kind as ThreadKind) ?? "conversation",
          worktreePath: body.worktreePath,
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.threads.send) {
        const body = (await readJson(req)) as {
          threadId?: string;
          from?: string;
          to?: string[];
          assignee?: string;
          tool?: string;
          worktreePath?: string;
          kind?: MessageKind;
          body: string;
          title?: string;
        };
        const recipients = routeRecipients(body);
        const explicitRecipients = optionalStringArray(body.to);
        const result = this.options.threads?.sendMessage
          ? this.options.threads.sendMessage(body)
          : body.threadId
            ? sendThreadMessage({
                threadId: body.threadId,
                from: body.from ?? "user",
                to: recipients,
                kind: body.kind,
                body: body.body,
              })
            : sendDirectMessage({
                from: body.from ?? "user",
                to: recipients,
                kind: body.kind as any,
                body: body.body,
                title: body.title,
                worktreePath: body.worktreePath,
              });
        const messageKind = body.kind ?? "request";
        const preDeliveredTo = (result as { deliveredTo?: unknown }).deliveredTo;
        const deliveredTo = this.normalizeDeliveredTo(preDeliveredTo);
        deliveredTo.push(
          ...(await this.deliverThreadMessageToLiveRecipients({
            thread: result.thread,
            message: result.message,
            explicitRecipients: explicitRecipients.length > 0 ? explicitRecipients : undefined,
            fallbackRecipients: recipients,
            from: body.from ?? "user",
            alreadyDelivered: deliveredTo,
          })),
        );
        if (messageKind === "handoff") {
          const alertRecipients = resolveExchangeMessageAlertRecipients({
            explicitRecipients: explicitRecipients.length > 0 ? explicitRecipients : undefined,
            message: result.message,
            thread: result.thread,
            fallbackRecipients: recipients,
            from: body.from ?? "user",
          });
          this.emitThreadWaitingAlert({
            kind: "handoff_waiting",
            threadId: (result.thread as { id: string }).id,
            from: body.from ?? "user",
            recipients: alertRecipients,
            title: `Handoff for ${alertRecipients.join(", ") || "agent"}`,
            message: body.body.trim() || "A handoff is waiting for you.",
            worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
          });
        } else if (messageKind === "request" || messageKind === "reply" || messageKind === "note") {
          const alertRecipients = resolveExchangeMessageAlertRecipients({
            explicitRecipients: explicitRecipients.length > 0 ? explicitRecipients : undefined,
            message: result.message,
            thread: result.thread,
            fallbackRecipients: recipients,
            from: body.from ?? "user",
          });
          this.emitThreadWaitingAlert({
            kind: "message_waiting",
            threadId: (result.thread as { id: string }).id,
            from: body.from ?? "user",
            recipients: alertRecipients,
            title: `Message for ${alertRecipients.join(", ") || "agent"}`,
            message: body.body.trim() || "A new message is waiting.",
            worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
          });
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.threads.markSeen) {
        const body = (await readJson(req)) as { threadId: string; session?: string; sessionId?: string };
        const sessionId = (body.session ?? body.sessionId ?? "").trim();
        if (!sessionId) {
          send(res, 400, { ok: false, error: "session is required" });
          return;
        }
        const thread = markThreadSeen(body.threadId, sessionId);
        if (!thread) {
          send(res, 404, { ok: false, error: "thread not found" });
          return;
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.threads.status) {
        const body = (await readJson(req)) as {
          threadId: string;
          status: ThreadStatus;
          owner?: string;
          waitingOn?: string[];
        };
        const thread = setThreadStatus(body.threadId, body.status, {
          owner: body.owner?.trim(),
          waitingOn: body.waitingOn?.map((value) => value.trim()).filter(Boolean),
        });
        if (!thread) {
          send(res, 404, { ok: false, error: "thread not found" });
          return;
        }
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.handoff.send) {
        const body = (await readJson(req)) as {
          from?: string;
          to?: string[];
          assignee?: string;
          tool?: string;
          body: string;
          title?: string;
          worktreePath?: string;
        };
        const result = this.options.actions?.sendHandoff
          ? this.options.actions.sendHandoff(body)
          : sendHandoff({
              from: body.from?.trim() || "user",
              to: body.to?.length
                ? body.to
                : [body.assignee, body.tool].map(optionalString).filter((value): value is string => Boolean(value)),
              body: body.body,
              title: body.title,
              worktreePath: body.worktreePath,
            });
        const explicitRecipients = optionalStringArray(body.to);
        const recipients = resolveExchangeMessageAlertRecipients({
          explicitRecipients,
          message: result.message,
          thread: result.thread,
          fallbackRecipients: explicitRecipients,
          from: body.from?.trim() || "user",
        });
        const preDeliveredTo = (result as { deliveredTo?: unknown }).deliveredTo;
        const deliveredTo = this.normalizeDeliveredTo(preDeliveredTo);
        deliveredTo.push(
          ...(await this.deliverThreadMessageToLiveRecipients({
            thread: result.thread,
            message: result.message,
            explicitRecipients,
            fallbackRecipients: explicitRecipients,
            from: body.from?.trim() || "user",
            alreadyDelivered: deliveredTo,
          })),
        );
        this.emitThreadWaitingAlert({
          kind: "handoff_waiting",
          threadId: (result.thread as { id: string }).id,
          from: body.from?.trim() || "user",
          recipients,
          title: `Handoff for ${recipients.join(", ") || "agent"}`,
          message: body.body.trim() || "A handoff is waiting for you.",
          worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.handoff.accept) {
        const body = (await readJson(req)) as { threadId: string; from?: string; body?: string };
        const result = this.options.actions?.acceptHandoff
          ? this.options.actions.acceptHandoff(body)
          : acceptHandoff({
              threadId: body.threadId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        const deliveredTo = await this.deliverThreadMessageToLiveRecipients({
          thread: result.thread,
          message: result.message,
          from: body.from?.trim() || "user",
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.handoff.complete) {
        const body = (await readJson(req)) as { threadId: string; from?: string; body?: string };
        const result = this.options.actions?.completeHandoff
          ? this.options.actions.completeHandoff(body)
          : completeHandoff({
              threadId: body.threadId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        const deliveredTo = await this.deliverThreadMessageToLiveRecipients({
          thread: result.thread,
          message: result.message,
          from: body.from?.trim() || "user",
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.tasks.assign) {
        const body = (await readJson(req)) as {
          from?: string;
          to?: string | string[];
          assignee?: string;
          tool?: string;
          description: string;
          prompt?: string;
          type?: "task" | "review";
          diff?: string;
          worktreePath?: string;
          assigner?: string;
          reviewOf?: string;
          iteration?: number;
        };
        const result = await assignTask({
          from: body.from?.trim() || "user",
          to: optionalStringOrFirst(body.to),
          assignee: body.assignee?.trim(),
          tool: body.tool?.trim(),
          description: body.description,
          prompt: body.prompt,
          type: body.type,
          diff: body.diff,
          worktreePath: body.worktreePath,
          assigner: body.assigner?.trim(),
          reviewOf: body.reviewOf?.trim(),
          iteration: body.iteration,
        });
        this.emitAssignedTaskAlert(result);
        const deliveredTo = await this.deliverAssignedTaskToLiveRecipient(result);
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.tasks.accept) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.acceptTask
          ? await this.options.actions.acceptTask(body)
          : await acceptTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.tasks.block) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.blockTask
          ? await this.options.actions.blockTask(body)
          : await blockTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        const recipient = resolveExchangeTaskOutcomeRecipient({
          task: result.task,
          thread: result.thread,
          from: body.from?.trim() || "user",
        });
        if (recipient) {
          this.emitAlert({
            kind: "blocked",
            sessionId: recipient,
            taskId: result.task.id,
            threadId: result.thread?.id,
            worktreePath: result.thread?.worktreePath,
            title: `Task blocked: ${result.task.description}`,
            message: result.task.error || body.body || "Task is blocked.",
            dedupeKey: `task-blocked:${result.task.id}:${recipient}`,
            cooldownMs: 15_000,
          });
        }
        const deliveredTo = await this.deliverTaskOutcomeToLiveRecipient({ ...result, action: "blocked" });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.tasks.complete) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.completeTask
          ? await this.options.actions.completeTask(body)
          : await completeTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        const recipient = resolveExchangeTaskOutcomeRecipient({
          task: result.task,
          thread: result.thread,
          from: body.from?.trim() || "user",
        });
        if (recipient) {
          this.emitAlert({
            kind: "task_done",
            sessionId: recipient,
            taskId: result.task.id,
            threadId: result.thread?.id,
            worktreePath: result.thread?.worktreePath,
            title: `Task done: ${result.task.description}`,
            message: body.body?.trim() || result.message?.body || "Task completed.",
            dedupeKey: `task-done:${result.task.id}:${recipient}`,
            cooldownMs: 15_000,
          });
        }
        const deliveredTo = await this.deliverTaskOutcomeToLiveRecipient({ ...result, action: "completed" });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.spawn) {
        const body = (await readJson(req)) as {
          tool: string;
          sessionId?: string;
          worktreePath?: string;
          open?: boolean;
          launchOverride?: LaunchOverride;
          overseer?: boolean;
        };
        if (!this.options.lifecycle?.spawnAgent) {
          send(res, 501, { ok: false, error: "agent spawn not supported by this service" });
          return;
        }
        const requestedSessionId = body.sessionId?.trim() || undefined;
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.spawn",
          targetKind: "agent",
          targetId: requestedSessionId,
        };
        if (requestedSessionId) {
          await sendQueuedLifecycle({
            transition: transitionInput,
            resolvedTransition: (result) => ({
              operation: "agent.spawn",
              targetKind: "agent",
              targetId: result.sessionId ?? requestedSessionId,
            }),
            action: () => this.options.lifecycle!.spawnAgent!(body),
            pending: { sessionId: requestedSessionId, status: "creating" },
            actionName: "agent spawn",
          });
          return;
        }
        const resultPromise = this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.spawnAgent!(body)),
          transitionInput,
        );
        const result = await resultPromise;
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.spawn",
            targetKind: "agent",
            targetId: result.sessionId ?? body.sessionId,
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.team.config) {
        send(res, 200, this.readTeamConfigResponse());
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.team.init) {
        send(res, 200, this.initTeamConfig());
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.team.addRole) {
        const result = this.addTeamRole((await readJson(req)) as Record<string, unknown>);
        send(res, result.ok ? 200 : result.status, result);
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.team.removeRole) {
        const result = this.removeTeamRole((await readJson(req)) as Record<string, unknown>);
        send(res, result.ok ? 200 : result.status, result);
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.team.defaultRole) {
        const result = this.setDefaultTeamRole((await readJson(req)) as Record<string, unknown>);
        send(res, result.ok ? 200 : result.status, result);
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.teammates) {
        const parentSessionId = url.searchParams.get("parentSessionId")?.trim() ?? "";
        const result = this.resolveDirectTeammates(parentSessionId);
        if (!result.ok) {
          send(res, result.status, { ok: false, error: result.error });
          return;
        }
        send(res, 200, {
          ok: true,
          parentSessionId: result.parent.id,
          teammates: result.teammates.map(teammateApiRecord),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.createTeammate) {
        const body = (await readJson(req)) as {
          parentSessionId: string;
          role?: string;
          label?: string;
          tool?: string;
          sessionId?: string;
          worktreePath?: string;
          open?: boolean;
          extraArgs?: string[];
          initialTask?: TeammateTaskBody;
          order?: number;
        };
        const parentSessionId = body.parentSessionId?.trim() ?? "";
        if (!parentSessionId) {
          send(res, 400, { ok: false, error: "parentSessionId is required" });
          return;
        }
        body.parentSessionId = parentSessionId;
        if (this.options.desktop?.getState) {
          const resolved = this.resolveDirectTeammates(parentSessionId);
          if (!resolved.ok) {
            send(res, resolved.status, { ok: false, error: resolved.error });
            return;
          }
        }
        const initialTaskPrompt = body.initialTask ? teammateTaskPrompt(body.initialTask) : undefined;
        if (body.initialTask && !initialTaskPrompt) {
          send(res, 400, { ok: false, error: "initialTask requires body or prompt" });
          return;
        }
        if (!this.options.lifecycle?.createTeammateAgent) {
          send(res, 501, { ok: false, error: "teammate creation not supported by this service" });
          return;
        }
        const createTeammate = async () => {
          const result = await this.options.lifecycle!.createTeammateAgent!({
            parentSessionId: body.parentSessionId,
            role: body.role,
            label: body.label,
            tool: body.tool,
            sessionId: body.sessionId,
            worktreePath: body.worktreePath,
            open: body.open,
            extraArgs: body.extraArgs,
            order: body.order,
          });
          const taskResult =
            body.initialTask && initialTaskPrompt
              ? await assignTask({
                  from: result.parentSessionId,
                  to: result.sessionId,
                  description: teammateTaskDescription(body.initialTask),
                  prompt: initialTaskPrompt,
                  worktreePath: optionalString(body.initialTask.worktreePath) ?? optionalString(body.worktreePath),
                })
              : undefined;
          if (taskResult) {
            this.emitAssignedTaskAlert(taskResult);
            await this.deliverAssignedTaskToLiveRecipient(taskResult);
          }
          return { ...result, task: taskResult?.task, thread: taskResult?.thread };
        };
        if (body.sessionId?.trim()) {
          await sendQueuedLifecycle({
            transition: { operation: "agent.spawn", targetKind: "agent", targetId: body.sessionId },
            resolvedTransition: (result) => ({
              operation: "agent.spawn",
              targetKind: "agent",
              targetId: result.sessionId,
            }),
            action: createTeammate,
            pending: {
              parentSessionId: body.parentSessionId,
              sessionId: body.sessionId,
              status: "creating",
            },
            actionName: "teammate create",
          });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.spawn",
          targetKind: "agent",
          targetId: body.sessionId,
        };
        const result = await this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, createTeammate),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.spawn",
            targetKind: "agent",
            targetId: result.sessionId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.createTeammateTask) {
        const body = (await readJson(req)) as {
          parentSessionId: string;
          teammateSessionId: string;
          title?: string;
          description?: string;
          body?: string;
          prompt?: string;
          worktreePath?: string;
        };
        const parentSessionId = body.parentSessionId?.trim() ?? "";
        const teammateSessionId = body.teammateSessionId?.trim() ?? "";
        if (!teammateSessionId) {
          send(res, 400, { ok: false, error: "teammateSessionId is required" });
          return;
        }
        const resolved = this.resolveDirectTeammates(parentSessionId);
        if (!resolved.ok) {
          send(res, resolved.status, { ok: false, error: resolved.error });
          return;
        }
        const teammate = resolved.teammates.find((session) => session.id === teammateSessionId);
        if (!teammate) {
          send(res, 404, {
            ok: false,
            error: `teammate "${teammateSessionId}" is not attached to parent "${parentSessionId}"`,
          });
          return;
        }
        const prompt = teammateTaskPrompt(body);
        if (!prompt) {
          send(res, 400, { ok: false, error: "teammate task requires body or prompt" });
          return;
        }
        const result = await assignTask({
          from: resolved.parent.id,
          to: teammate.id,
          description: teammateTaskDescription(body),
          prompt,
          worktreePath:
            optionalString(body.worktreePath) ??
            optionalString(teammate.worktreePath) ??
            optionalString(resolved.parent.worktreePath),
        });
        this.emitAssignedTaskAlert(result);
        const deliveredTo = await this.deliverAssignedTaskToLiveRecipient(result);
        notifyCurrentRouteChange();
        send(res, 200, {
          ok: true,
          parentSessionId: resolved.parent.id,
          teammateSessionId: teammate.id,
          ...result,
          deliveredTo,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.rawTeammateSend) {
        send(res, 410, {
          ok: false,
          error: `raw teammate send has been removed; create durable teammate work with ${PROJECT_API_ROUTES.agents.createTeammateTask}`,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.stopTeammate) {
        const body = (await readJson(req)) as { parentSessionId: string; teammateSessionId: string };
        const resolved = this.resolveDirectTeammate(
          body.parentSessionId?.trim() ?? "",
          body.teammateSessionId?.trim() ?? "",
        );
        if (!resolved.ok) {
          send(res, resolved.status, { ok: false, error: resolved.error });
          return;
        }
        if (!this.options.lifecycle?.stopAgent) {
          send(res, 501, { ok: false, error: "agent stop not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.stop",
          targetKind: "agent",
          targetId: resolved.teammate.id,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () =>
            runLifecycle(transitionInput, () =>
              this.options.lifecycle!.stopAgent!({ sessionId: resolved.teammate.id }),
            ),
          transitionInput,
        );
        const earlyResult = await waitForEarlyLifecycleResult(resultPromise);
        if (earlyResult.kind === "resolved") {
          notifyCurrentRouteChange();
          send(
            res,
            200,
            lifecycleOk(
              { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...earlyResult.result },
              { operation: "agent.stop", targetKind: "agent", targetId: resolved.teammate.id },
            ),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          throw earlyResult.error;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "agent stop teammate");
        send(
          res,
          202,
          lifecycleOk(
            {
              parentSessionId: resolved.parent.id,
              teammateSessionId: resolved.teammate.id,
              sessionId: resolved.teammate.id,
              status: "offline",
            },
            { operation: "agent.stop", targetKind: "agent", targetId: resolved.teammate.id, phase: "settling" },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.resumeTeammate) {
        const body = (await readJson(req)) as { parentSessionId: string; teammateSessionId: string };
        const resolved = this.resolveDirectTeammate(
          body.parentSessionId?.trim() ?? "",
          body.teammateSessionId?.trim() ?? "",
        );
        if (!resolved.ok) {
          send(res, resolved.status, { ok: false, error: resolved.error });
          return;
        }
        if (!this.options.desktop?.resumeAgent) {
          send(res, 501, { ok: false, error: "agent resume not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "agent.resume", targetKind: "agent", targetId: resolved.teammate.id },
          action: async () => ({
            parentSessionId: resolved.parent.id,
            teammateSessionId: resolved.teammate.id,
            ...(await this.options.desktop!.resumeAgent!({
              sessionId: resolved.teammate.id,
              session: resolved.teammate,
            })),
          }),
          pending: {
            parentSessionId: resolved.parent.id,
            teammateSessionId: resolved.teammate.id,
            sessionId: resolved.teammate.id,
            status: "running",
          },
          actionName: "agent resume teammate",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.killTeammate) {
        const body = (await readJson(req)) as { parentSessionId: string; teammateSessionId: string };
        const resolved = this.resolveDirectTeammate(
          body.parentSessionId?.trim() ?? "",
          body.teammateSessionId?.trim() ?? "",
        );
        if (!resolved.ok) {
          send(res, resolved.status, { ok: false, error: resolved.error });
          return;
        }
        if (!this.options.lifecycle?.killAgent) {
          send(res, 501, { ok: false, error: "agent kill not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.kill",
          targetKind: "agent",
          targetId: resolved.teammate.id,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () =>
            runLifecycle(transitionInput, () =>
              this.options.lifecycle!.killAgent!({
                sessionId: resolved.teammate.id,
              }),
            ),
          transitionInput,
        );
        this.promptContexts.clear(resolved.teammate.id);
        const earlyResult = await waitForEarlyLifecycleResult(resultPromise);
        if (earlyResult.kind === "resolved") {
          notifyCurrentRouteChange();
          send(
            res,
            200,
            lifecycleOk(
              { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...earlyResult.result },
              { operation: "agent.kill", targetKind: "agent", targetId: resolved.teammate.id },
            ),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          throw earlyResult.error;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "agent kill teammate");
        send(
          res,
          202,
          lifecycleOk(
            {
              parentSessionId: resolved.parent.id,
              teammateSessionId: resolved.teammate.id,
              sessionId: resolved.teammate.id,
              status: "graveyard",
              previousStatus: "running",
            },
            { operation: "agent.kill", targetKind: "agent", targetId: resolved.teammate.id, phase: "settling" },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.resurrectTeammate) {
        const body = (await readJson(req)) as { parentSessionId: string; teammateSessionId: string };
        const resolved = this.resolveDirectGraveyardTeammate(
          body.parentSessionId?.trim() ?? "",
          body.teammateSessionId?.trim() ?? "",
        );
        if (!resolved.ok) {
          send(res, resolved.status, { ok: false, error: resolved.error });
          return;
        }
        if (!this.options.desktop?.resurrectGraveyard) {
          send(res, 501, { ok: false, error: "agent graveyard resurrection not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: {
            operation: "graveyard.agent.resurrect",
            targetKind: "agent",
            targetId: resolved.teammate.id,
          },
          action: async () => ({
            parentSessionId: resolved.parent.id,
            teammateSessionId: resolved.teammate.id,
            ...(await this.options.desktop!.resurrectGraveyard!({ sessionId: resolved.teammate.id })),
          }),
          pending: {
            parentSessionId: resolved.parent.id,
            teammateSessionId: resolved.teammate.id,
            sessionId: resolved.teammate.id,
            status: "running",
          },
          actionName: "teammate resurrect",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.fork) {
        const body = (await readJson(req)) as {
          sourceSessionId: string;
          tool: string;
          targetSessionId?: string;
          instruction?: string;
          worktreePath?: string;
          open?: boolean;
          launchOverride?: LaunchOverride;
        };
        if (!this.options.lifecycle?.forkAgent) {
          send(res, 501, { ok: false, error: "agent fork not supported by this service" });
          return;
        }
        if (body.targetSessionId?.trim()) {
          await sendQueuedLifecycle({
            transition: { operation: "agent.fork", targetKind: "agent", targetId: body.targetSessionId },
            resolvedTransition: (result) => ({
              operation: "agent.fork",
              targetKind: "agent",
              targetId: result.sessionId ?? body.targetSessionId,
            }),
            action: () => this.options.lifecycle!.forkAgent!(body),
            pending: { sessionId: body.targetSessionId, status: "creating" },
            actionName: "agent fork",
          });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.fork",
          targetKind: "agent",
          targetId: body.targetSessionId,
        };
        const result = await this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.forkAgent!(body)),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, { operation: "agent.fork", targetKind: "agent", targetId: result.sessionId }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.switchTool) {
        const body = (await readJson(req)) as {
          sessionId: string;
          tool: string;
          instruction?: string;
          launchOverride?: LaunchOverride;
        };
        if (!this.options.lifecycle?.switchAgentTool) {
          send(res, 501, { ok: false, error: "agent tool switch not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "agent.switchTool", targetKind: "agent", targetId: body.sessionId },
          action: () => this.options.lifecycle!.switchAgentTool!(body),
          pending: { sessionId: body.sessionId, status: "switching", tool: body.tool },
          actionName: "agent switch tool",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.stop) {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.lifecycle?.stopAgent) {
          send(res, 501, { ok: false, error: "agent stop not supported by this service" });
          return;
        }
        const sessionId = body.sessionId?.trim() ?? "";
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.stop",
          targetKind: "agent",
          targetId: sessionId,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.stopAgent!({ sessionId })),
          transitionInput,
        );
        const earlyResult = await waitForEarlyLifecycleResult(resultPromise);
        if (earlyResult.kind === "resolved") {
          notifyCurrentRouteChange();
          send(
            res,
            200,
            lifecycleOk(earlyResult.result, {
              operation: "agent.stop",
              targetKind: "agent",
              targetId: sessionId,
            }),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          throw earlyResult.error;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "agent stop");
        send(
          res,
          202,
          lifecycleOk(
            { sessionId, status: "offline" },
            {
              operation: "agent.stop",
              targetKind: "agent",
              targetId: sessionId,
              phase: "settling",
            },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.resume) {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.desktop?.resumeAgent) {
          send(res, 501, { ok: false, error: "agent resume not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "agent.resume", targetKind: "agent", targetId: body.sessionId },
          action: () => this.options.desktop!.resumeAgent!({ sessionId: body.sessionId }),
          pending: { sessionId: body.sessionId, status: "running" },
          actionName: "agent resume",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.restorePrevious) {
        const restoreAgent = this.options.desktop?.restoreAgent ?? this.options.desktop?.resumeAgent;
        if (!restoreAgent) {
          send(res, 501, { ok: false, error: "agent resume not supported by this service" });
          return;
        }
        const offer = readAgentRestoreOffer(this.currentProjectRoot());
        if (!offer) {
          send(res, 200, {
            ok: true,
            accepted: false,
            total: 0,
            restored: [],
            failed: [],
            transitions: [],
            offer: null,
          });
          return;
        }
        acknowledgeAgentRestoreOffer(this.currentProjectRoot());
        type RestoreAttempt =
          | { sessionId: string; status: string; error?: never }
          | { sessionId: string; error: string; status?: never };
        const attempts: RestoreAttempt[] = [];
        const transitions = offer.sessionIds.map((sessionId) =>
          buildLifecycleTransition({
            operation: "agent.restore",
            targetKind: "agent",
            targetId: sessionId,
            phase: "queued",
          }),
        );
        void (async () => {
          for (const sessionId of offer.sessionIds) {
            const transitionInput: LifecycleTransitionInput = {
              operation: "agent.restore",
              targetKind: "agent",
              targetId: sessionId,
            };
            try {
              const result = await this.enqueueLifecycleMutation(
                () => runLifecycle(transitionInput, () => restoreAgent({ sessionId })),
                transitionInput,
              );
              attempts.push({ sessionId, status: result.status });
            } catch (error) {
              attempts.push({ sessionId, error: userFacingErrorMessage(error) });
            }
            notifyCurrentRouteChange();
          }
          const restored = attempts.filter((result): result is Extract<RestoreAttempt, { status: string }> => {
            return "status" in result;
          });
          const failed = attempts.filter((result): result is Extract<RestoreAttempt, { error: string }> => {
            return "error" in result;
          });
          log.info("agent restore previous completed", "api", {
            total: offer.sessionIds.length,
            restored: restored.length,
            failed: failed.length,
          });
          writeAgentRestoreRetryOffer(
            offer,
            failed.map((result) => result.sessionId),
            this.currentProjectRoot(),
          );
          notifyCurrentRouteChange();
        })().catch((error: unknown) => {
          log.warn("agent restore previous failed", "api", { error: userFacingErrorMessage(error) });
          writeAgentRestoreRetryOffer(offer, offer.sessionIds, this.currentProjectRoot());
          notifyCurrentRouteChange();
        });
        notifyCurrentRouteChange();
        send(res, 200, {
          ok: true,
          accepted: true,
          total: offer.sessionIds.length,
          restored: [],
          failed: [],
          transitions,
          offer,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.dismissRestorePrevious) {
        acknowledgeAgentRestoreOffer(this.currentProjectRoot());
        notifyCurrentRouteChange();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.recordBackendSession) {
        const body = (await readJson(req)) as { sessionId: string; backendSessionId: string };
        if (!this.options.lifecycle?.recordBackendSessionId) {
          send(res, 501, { ok: false, error: "backend session recording not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.recordBackendSessionId(body);
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === PROJECT_API_ROUTES.agents.interrupt || url.pathname === PROJECT_API_ROUTES.livePane.interrupt)
      ) {
        const body = (await readJson(req)) as { sessionId?: string };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.interruptAgent) {
          send(res, 501, { ok: false, error: "agent interrupt not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.interrupt",
          targetKind: "agent",
          targetId: sessionId,
        };
        const result = await this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.interruptAgent!({ sessionId })),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(res, 200, lifecycleOk(result, { operation: "agent.interrupt", targetKind: "agent", targetId: sessionId }));
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.livePane.resize) {
        const body = (await readJson(req)) as { sessionId?: string; cols?: unknown; rows?: unknown };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.resizeAgentPane) {
          send(res, 501, { ok: false, error: "live pane resize not supported by this service" });
          return;
        }
        const cols = parsePositiveInteger(body.cols, "cols");
        const rows = parsePositiveInteger(body.rows, "rows");
        if (!cols.ok) {
          send(res, 400, { ok: false, error: cols.error });
          return;
        }
        if (!rows.ok) {
          send(res, 400, { ok: false, error: rows.error });
          return;
        }
        const result = await this.options.lifecycle.resizeAgentPane({
          sessionId,
          cols: cols.value,
          rows: rows.value,
        });
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.rename) {
        const body = (await readJson(req)) as { sessionId: string; label?: string };
        if (!this.options.lifecycle?.renameAgent) {
          send(res, 501, { ok: false, error: "agent rename not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.rename",
          targetKind: "agent",
          targetId: body.sessionId,
        };
        const result = await this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.renameAgent!(body)),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.rename",
            targetKind: "agent",
            targetId: body.sessionId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.migrate) {
        const body = (await readJson(req)) as { sessionId: string; worktreePath: string };
        if (!this.options.lifecycle?.migrateAgent) {
          send(res, 501, { ok: false, error: "agent migrate not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: {
            operation: "agent.migrate",
            targetKind: "agent",
            targetId: body.sessionId,
            targetPath: body.worktreePath,
          },
          action: () => this.options.lifecycle!.migrateAgent!(body),
          pending: { sessionId: body.sessionId, worktreePath: body.worktreePath, status: "migrating" },
          actionName: "agent migrate",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.kill) {
        const body = (await readJson(req)) as { sessionId: string; session?: Record<string, unknown> };
        if (!this.options.lifecycle?.killAgent) {
          send(res, 501, { ok: false, error: "agent kill not supported by this service" });
          return;
        }
        const sessionId = body.sessionId?.trim() ?? "";
        const transitionInput: LifecycleTransitionInput = {
          operation: "agent.kill",
          targetKind: "agent",
          targetId: sessionId,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.lifecycle!.killAgent!({ sessionId })),
          transitionInput,
        );
        // A resurrected session comes back under the same id, so a context left
        // here would attach itself to a conversation that never asked for it.
        // Trimmed to match how `set` stored it, or a padded id misses.
        this.promptContexts.clear(sessionId);
        const earlyResult = await waitForEarlyLifecycleResult(resultPromise);
        if (earlyResult.kind === "resolved") {
          notifyCurrentRouteChange();
          send(
            res,
            200,
            lifecycleOk(earlyResult.result, {
              operation: "agent.kill",
              targetKind: "agent",
              targetId: sessionId,
            }),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          throw earlyResult.error;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "agent kill");
        send(
          res,
          202,
          lifecycleOk(
            { sessionId, status: "graveyard", previousStatus: "running" },
            {
              operation: "agent.kill",
              targetKind: "agent",
              targetId: sessionId,
              phase: "settling",
            },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.promptContext) {
        const body = (await readJson(req)) as { sessionId?: string; text?: unknown };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        // Absent, null and empty all mean the same thing on purpose: a client
        // clearing has one call to make, and a client whose state went empty
        // does not have to notice that it did.
        const raw = typeof body.text === "string" ? body.text : "";
        const normalized = normalizePromptContext(raw);
        const bytes = promptContextByteLength(normalized);
        if (bytes > PROMPT_CONTEXT_MAX_BYTES) {
          // Refused whole rather than truncated. Half a context is worse than
          // none: the agent cannot tell it was cut and answers confidently from
          // a sentence that stops mid-fact.
          send(res, 413, {
            ok: false,
            error: `prompt context too large: ${bytes} bytes exceeds ${PROMPT_CONTEXT_MAX_BYTES}`,
          });
          return;
        }
        const entry = this.promptContexts.set(sessionId, normalized);
        // Echoed back so a second client can see it clobbered the first.
        send(res, 200, {
          ok: true,
          sessionId,
          context: entry?.text ?? null,
          bytes: entry ? bytes : 0,
          expiresAt: entry?.expiresAt ?? null,
        });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === PROJECT_API_ROUTES.agents.input || url.pathname === PROJECT_API_ROUTES.livePane.input)
      ) {
        const body = (await readJson(req)) as {
          sessionId?: string;
          text?: string;
          attachmentIds?: unknown;
          sharedChatActor?: unknown;
        };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        const text = typeof body.text === "string" ? body.text : "";
        const attachmentIds = Array.isArray(body.attachmentIds)
          ? body.attachmentIds
              .filter((id): id is string => typeof id === "string")
              .map((id) => id.trim())
              .filter(Boolean)
          : [];
        const remoteActor = parseRemoteActor(requestHeaderRecord(req));
        if (remoteActor?.role === "guest") {
          if (url.pathname !== PROJECT_API_ROUTES.livePane.input) {
            send(res, 403, { ok: false, error: "shared guests can only write to their shared session" });
            return;
          }
          if (!remoteActor.shareSessionId || remoteActor.shareSessionId !== sessionId) {
            send(res, 403, { ok: false, error: "shared guest cannot access another session" });
            return;
          }
          if (!text.trim() && attachmentIds.length === 0) {
            send(res, 403, { ok: false, error: "shared guest input requires text or attachments" });
            return;
          }
        }
        const sharedChatActor =
          remoteActor?.role === "guest"
            ? {
                role: "guest" as const,
                displayName: remoteActor.displayName,
                email: remoteActor.email,
              }
            : bodySharedChatActor(body);
        if (remoteActor?.role !== "guest" && !text.trim() && attachmentIds.length === 0) {
          send(res, 400, { ok: false, error: "text is required" });
          return;
        }
        // Bound to THIS session, not merely existing. Without the second
        // argument a caller could name another session's attachment id here
        // and have the agent read those bytes off local disk and describe
        // them — an exfiltration path that no HTTP gate can see, because the
        // bytes never cross the transport. The refusal is deliberately the
        // same "not found" as a bogus id, so ids cannot be probed.
        const attachments = attachmentIds.map((id) => getAttachmentRecord(id, sessionId));
        const missingAttachmentId = attachmentIds.find((_, index) => attachments[index] === null);
        if (missingAttachmentId) {
          send(res, 400, { ok: false, error: `attachment not found: ${missingAttachmentId}` });
          return;
        }
        if (!this.options.lifecycle?.sendAgentInput) {
          send(res, 501, { ok: false, error: "agent input not supported by this service" });
          return;
        }
        // Both spellings of this route, deliberately. `/live-pane/input` is not
        // a raw terminal — it is this same submit-a-prompt operation under an
        // older name, and it is what the app's own chat screen calls. Keying
        // the context off the path would have left aimux's chat the one client
        // that never carried it. Raw pane work is attach/output/resize.
        const inputText = sharedChatActor && text.trim() ? formatSharedChatAgentInput(text, sharedChatActor) : text;
        const formattedText = composeWithPromptContext(
          formatAgentInputWithAttachments(
            inputText,
            attachments.filter((entry): entry is AttachmentRecord => !!entry),
          ),
          this.promptContexts.get(sessionId)?.text ?? null,
        );
        // Return as soon as the input is accepted; the tmux submit-confirmation
        // runs in the background. Agent output is delivered over /events (SSE),
        // so blocking this response on confirmation only risks a client timeout.
        const result = await this.options.lifecycle.sendAgentInput({
          sessionId,
          text: formattedText,
          waitForSubmit: false,
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.loop) {
        const body = (await readJson(req)) as Record<string, unknown>;
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (typeof body.active !== "boolean") {
          send(res, 400, { ok: false, error: "active (boolean) is required" });
          return;
        }
        if (body.active) {
          const goal = typeof body.goal === "string" ? body.goal.trim() : "";
          const loop: SessionLoopMetadata = {
            active: true,
            goal: goal || undefined,
            since: new Date().toISOString(),
            ...sessionLoopProvenance(body),
          };
          setSessionLoop(sessionId, loop);
          notifyCurrentRouteChange();
          send(res, 200, { ok: true, sessionId, loop });
        } else {
          const goal = typeof body.goal === "string" ? body.goal.trim() : "";
          const loopLastAction: SessionLoopActionMetadata = {
            action: sessionLoopAction(body.action, "remove"),
            at: new Date().toISOString(),
            goal: goal || undefined,
            ...sessionLoopProvenance(body),
          };
          clearSessionLoop(sessionId, undefined, loopLastAction);
          notifyCurrentRouteChange();
          send(res, 200, { ok: true, sessionId, loop: null, loopLastAction });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.overseer) {
        const body = (await readJson(req)) as { sessionId?: string; active?: boolean };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (typeof body.active !== "boolean") {
          send(res, 400, { ok: false, error: "active (boolean) is required" });
          return;
        }
        setSessionOverseer(sessionId, body.active);
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, sessionId, overseer: body.active });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.attachmentsPublish) {
        const remoteActor = parseRemoteActor(requestHeaderRecord(req));
        if (remoteActor) {
          send(res, 403, { ok: false, error: "attachment publish is local only" });
          return;
        }
        const body = (await readJson(req)) as {
          filename?: unknown;
          mimeType?: unknown;
          path?: unknown;
          sessionId?: unknown;
          sourcePath?: unknown;
          hostedAttachment?: unknown;
        };
        const rawSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!rawSessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        const sessionId = validateSessionId(rawSessionId);
        if (!sessionId.ok) {
          send(res, 400, { ok: false, error: "sessionId is invalid" });
          return;
        }
        const sourcePath =
          typeof body.path === "string"
            ? body.path.trim()
            : typeof body.sourcePath === "string"
              ? body.sourcePath.trim()
              : "";
        if (!sourcePath) {
          send(res, 400, { ok: false, error: "path is required" });
          return;
        }
        const allowedRoots = [
          this.currentProjectRoot(),
          ...(this.options.desktop?.listWorktrees?.() ?? [])
            .map((entry) =>
              entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string"
                ? entry.path
                : null,
            )
            .filter((entry): entry is string => Boolean(entry)),
        ];
        try {
          const attachment = createPathAttachment({
            filename: typeof body.filename === "string" ? body.filename : undefined,
            mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
            projectRoot: this.currentProjectRoot(),
            sourcePath,
            allowedRoots,
            sessionId: sessionId.value,
            hostedAttachment: hostedAttachmentFromBody(body.hostedAttachment),
          });
          const record = getAttachmentRecord(attachment.id, sessionId.value);
          if (!record) {
            send(res, 500, { ok: false, error: "published attachment could not be read" });
            return;
          }
          const referenceLine = `- ${record.filename} (${record.mimeType}, ${record.sizeBytes} bytes): ${record.contentPath}`;
          const referenceText = `Attached files:\n${referenceLine}`;
          send(res, 200, { ok: true, attachment, referenceText });
        } catch (error) {
          send(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid attachment" });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.attachments) {
        const body = (await readJson(req)) as {
          filename?: unknown;
          mimeType?: unknown;
          dataBase64?: unknown;
          sessionId?: unknown;
          hostedAttachment?: unknown;
        };
        if (
          typeof body.filename !== "string" ||
          typeof body.mimeType !== "string" ||
          typeof body.dataBase64 !== "string"
        ) {
          send(res, 400, { ok: false, error: "filename, mimeType, and dataBase64 are required" });
          return;
        }
        // Every attachment is owned from the moment it exists. Uploading first
        // and binding later would leave a window in which the record is
        // reachable by any session that guessed its id.
        const rawUploadSession = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!rawUploadSession) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        const uploadSession = validateSessionId(rawUploadSession);
        if (!uploadSession.ok) {
          send(res, 400, { ok: false, error: "sessionId is invalid" });
          return;
        }
        const remoteActor = parseRemoteActor(requestHeaderRecord(req));
        if (
          remoteActor?.role === "guest" &&
          (!remoteActor.shareSessionId || remoteActor.shareSessionId !== uploadSession.value)
        ) {
          send(res, 403, { ok: false, error: "shared guest cannot access another session" });
          return;
        }
        try {
          const attachment = createUploadedAttachment({
            filename: body.filename,
            mimeType: body.mimeType,
            dataBase64: body.dataBase64,
            sessionId: uploadSession.value,
            hostedAttachment: hostedAttachmentFromBody(body.hostedAttachment),
          });
          send(res, 200, { ok: true, attachment });
        } catch (error) {
          send(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid attachment" });
        }
        return;
      }

      // Omitting `sessionId` on a read is the local path and stays
      // unrestricted. Sending an EMPTY one is refused rather than treated as
      // omitted: `?sessionId=` should never be the way to widen access, even
      // though the operator gate already rejects it upstream. Relying on that
      // alone would make this fail open by construction rather than by check.
      const rawReadSession = url.searchParams.get("sessionId");
      const attachmentReadSession = rawReadSession === null ? undefined : rawReadSession.trim();
      const attachmentPathMatched = /^\/attachments\/[^/]+(\/content)?$/.test(url.pathname);
      if (req.method === "GET" && attachmentPathMatched && attachmentReadSession === "") {
        send(res, 400, { ok: false, error: "sessionId is invalid" });
        return;
      }
      const attachmentRemoteActor = parseRemoteActor(requestHeaderRecord(req));
      if (req.method === "GET" && attachmentPathMatched && attachmentRemoteActor?.role === "guest") {
        if (
          !attachmentRemoteActor.shareSessionId ||
          !attachmentReadSession ||
          attachmentRemoteActor.shareSessionId !== attachmentReadSession
        ) {
          send(res, 403, { ok: false, error: "shared guest cannot access another session" });
          return;
        }
        if (!/\/content$/.test(url.pathname)) {
          send(res, 403, { ok: false, error: "shared guests cannot read attachment metadata" });
          return;
        }
      }

      const attachmentContentMatch = url.pathname.match(/^\/attachments\/([^/]+)\/content$/);
      if (req.method === "GET" && attachmentContentMatch) {
        const content = getAttachmentContent(
          decodeURIComponent(attachmentContentMatch[1] || ""),
          attachmentReadSession,
        );
        if (!content) {
          send(res, 404, { ok: false, error: "attachment not found" });
          return;
        }
        sendBytes(res, 200, content.buffer, content.attachment.mimeType);
        return;
      }

      const attachmentMatch = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (req.method === "GET" && attachmentMatch) {
        const attachment = getAttachment(decodeURIComponent(attachmentMatch[1] || ""), attachmentReadSession);
        if (!attachment) {
          send(res, 404, { ok: false, error: "attachment not found" });
          return;
        }
        send(res, 200, { ok: true, attachment });
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname === PROJECT_API_ROUTES.agents.output || url.pathname === PROJECT_API_ROUTES.livePane.output)
      ) {
        const sessionId = url.searchParams.get("sessionId")?.trim();
        const startLineRaw = url.searchParams.get("startLine");
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.readAgentOutput) {
          send(res, 501, { ok: false, error: "agent output not supported by this service" });
          return;
        }
        const parsedStartLine = parseOptionalInteger(startLineRaw, "startLine");
        if (!parsedStartLine.ok) {
          send(res, 400, { ok: false, error: parsedStartLine.error });
          return;
        }
        const captureWindow = agentOutputCaptureWindow(parsedStartLine.value);
        const startLine = captureWindow.startLine;
        const readInput = { sessionId, startLine };
        const { result, durationMs, coalesced } = await this.measureAgentOutputRead("live-pane-output", readInput);
        this.recordAgentOutputRead("live-pane-output", readInput, result, durationMs, undefined, coalesced);
        send(res, 200, {
          ok: true,
          ...result,
          startLine: result.startLine ?? startLine,
          requestedStartLine: result.requestedStartLine ?? captureWindow.requestedStartLine,
          endLine: result.endLine ?? captureWindow.endLine,
          captureLineLimit: result.captureLineLimit ?? captureWindow.maxLines,
          outputTailOnly: result.outputTailOnly ?? captureWindow.tailOnly,
          outputStartLineClamped: result.outputStartLineClamped ?? captureWindow.clamped,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.livePane.attach) {
        const body = (await readJson(req)) as {
          sessionId?: string;
          startLine?: unknown;
          cols?: unknown;
          rows?: unknown;
        };
        const sessionId = body.sessionId?.trim() ?? "";
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.readAgentOutput) {
          send(res, 501, { ok: false, error: "live pane output not supported by this service" });
          return;
        }

        const parsedStartLine =
          body.startLine === undefined
            ? ({ ok: true, value: -120 } as const)
            : parseIntegerValue(body.startLine, "startLine");
        if (!parsedStartLine.ok) {
          send(res, 400, { ok: false, error: parsedStartLine.error });
          return;
        }
        const captureWindow = agentOutputCaptureWindow(parsedStartLine.value);
        const startLine = captureWindow.startLine;

        let resize: { cols: number; rows: number } | undefined;
        if (body.cols !== undefined || body.rows !== undefined) {
          if (!this.options.lifecycle?.resizeAgentPane) {
            send(res, 501, { ok: false, error: "live pane resize not supported by this service" });
            return;
          }
          const cols = parsePositiveInteger(body.cols, "cols");
          const rows = parsePositiveInteger(body.rows, "rows");
          if (!cols.ok) {
            send(res, 400, { ok: false, error: cols.error });
            return;
          }
          if (!rows.ok) {
            send(res, 400, { ok: false, error: rows.error });
            return;
          }
          const result = await this.options.lifecycle.resizeAgentPane({
            sessionId,
            cols: cols.value,
            rows: rows.value,
          });
          resize = { cols: result.cols, rows: result.rows };
        }

        const readInput = { sessionId, startLine };
        const {
          result: output,
          durationMs,
          coalesced,
        } = await this.measureAgentOutputRead("live-pane-attach", readInput);
        this.recordAgentOutputRead("live-pane-attach", readInput, output, durationMs, undefined, coalesced);
        send(res, 200, {
          ok: true,
          ...output,
          stream: {
            route: PROJECT_API_ROUTES.events,
            sessionId,
            startLine: output.startLine ?? startLine,
            requestedStartLine: output.requestedStartLine ?? captureWindow.requestedStartLine,
            endLine: output.endLine ?? captureWindow.endLine,
            captureLineLimit: output.captureLineLimit ?? captureWindow.maxLines,
            outputTailOnly: output.outputTailOnly ?? captureWindow.tailOnly,
            outputStartLineClamped: output.outputStartLineClamped ?? captureWindow.clamped,
          },
          ...(resize ? { resize } : {}),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.agents.history) {
        send(res, 410, { ok: false, error: "agent message history requires the runtime core replacement" });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.worktreeActions.create) {
        const body = (await readJson(req)) as { name: string };
        if (!this.options.desktop?.createWorktree) {
          send(res, 501, { ok: false, error: "worktree create not supported by this service" });
          return;
        }
        const desktop = this.options.desktop;
        const targetPath = safeWorktreeCreatePath(body.name, this.currentProjectRoot());
        const transitionInput: LifecycleTransitionInput = {
          operation: "worktree.create",
          targetKind: "worktree",
          targetId: body.name,
          targetPath,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => desktop.createWorktree!(body)),
          transitionInput,
        );
        const earlyResult:
          | { kind: "resolved"; result: any }
          | { kind: "rejected"; error: unknown }
          | { kind: "pending" } = await Promise.race([
          resultPromise.then(
            (result) => ({ kind: "resolved" as const, result }),
            (error) => ({ kind: "rejected" as const, error }),
          ),
          new Promise<{ kind: "pending" }>((resolve) => {
            setTimeout(() => resolve({ kind: "pending" }), 50);
          }),
        ]);
        if (earlyResult.kind === "resolved") {
          const status = typeof earlyResult.result.status === "string" ? earlyResult.result.status : undefined;
          const phase = status === "creating" ? "settling" : "succeeded";
          notifyCurrentRouteChange();
          send(
            res,
            phase === "settling" ? 202 : 200,
            lifecycleOk(earlyResult.result, {
              operation: "worktree.create",
              targetKind: "worktree",
              targetId: body.name,
              targetPath: earlyResult.result.path,
              phase,
            }),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          const message = earlyResult.error instanceof Error ? earlyResult.error.message : String(earlyResult.error);
          send(res, 422, {
            ok: false,
            error: message,
            transition: buildLifecycleTransition({
              operation: "worktree.create",
              targetKind: "worktree",
              targetId: body.name,
              phase: "failed",
              error: message,
            }),
          });
          return;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "worktree create");
        send(
          res,
          202,
          lifecycleOk(
            { path: targetPath, status: "creating" },
            {
              operation: "worktree.create",
              targetKind: "worktree",
              targetId: body.name,
              targetPath,
              phase: "settling",
            },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.worktreeActions.remove) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.removeWorktree) {
          send(res, 501, { ok: false, error: "worktree remove not supported by this service" });
          return;
        }
        const desktop = this.options.desktop;
        const transitionInput: LifecycleTransitionInput = {
          operation: "worktree.remove",
          targetKind: "worktree",
          targetPath: body.path,
        };
        const resultPromise = this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => desktop.removeWorktree!(body)),
          transitionInput,
        );
        const earlyResult:
          | { kind: "resolved"; result: any }
          | { kind: "rejected"; error: unknown }
          | { kind: "pending" } = await Promise.race([
          resultPromise.then(
            (result) => ({ kind: "resolved" as const, result }),
            (error) => ({ kind: "rejected" as const, error }),
          ),
          new Promise<{ kind: "pending" }>((resolve) => {
            setTimeout(() => resolve({ kind: "pending" }), 50);
          }),
        ]);
        if (earlyResult.kind === "resolved") {
          notifyCurrentRouteChange();
          send(
            res,
            200,
            lifecycleOk(earlyResult.result, {
              operation: "worktree.remove",
              targetKind: "worktree",
              targetPath: body.path,
            }),
          );
          return;
        }
        if (earlyResult.kind === "rejected") {
          const message = earlyResult.error instanceof Error ? earlyResult.error.message : String(earlyResult.error);
          send(res, 422, {
            ok: false,
            error: message,
            transition: buildLifecycleTransition({
              operation: "worktree.remove",
              targetKind: "worktree",
              targetPath: body.path,
              phase: "failed",
              error: message,
            }),
          });
          return;
        }
        notifyCurrentRouteChange();
        this.notifyLifecycleSettled(resultPromise, notifyCurrentRouteChange, "worktree remove");
        send(
          res,
          202,
          lifecycleOk(
            { path: body.path, status: "removing" },
            { operation: "worktree.remove", targetKind: "worktree", targetPath: body.path, phase: "settling" },
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.worktreeActions.graveyard) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.graveyardWorktree) {
          send(res, 501, { ok: false, error: "worktree graveyard not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "worktree.graveyard", targetKind: "worktree", targetPath: body.path },
          action: () => this.options.desktop!.graveyardWorktree!(body),
          pending: { path: body.path, status: "graveyarding" },
          actionName: "worktree graveyard",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.worktreeActions.cacheCleanup) {
        const body = (await readJson(req).catch(() => ({}))) as { dryRun?: boolean; includeActive?: boolean };
        if (!this.options.desktop?.cleanupWorktreeCaches) {
          send(res, 501, { ok: false, error: "worktree cache cleanup not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "worktree.cacheCleanup",
          targetKind: "worktree",
        };
        const result = await this.enqueueLifecycleMutation(
          () =>
            runLifecycle(transitionInput, () =>
              this.options.desktop!.cleanupWorktreeCaches!({
                dryRun: body.dryRun !== false,
                includeActive: body.includeActive === true,
              }),
            ),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.create) {
        const body = (await readJson(req)) as { command?: string; worktreePath?: string; serviceId?: string };
        if (!this.options.desktop?.createService) {
          send(res, 501, { ok: false, error: "service create not supported by this service" });
          return;
        }
        if (body.serviceId?.trim()) {
          await sendQueuedLifecycle({
            transition: { operation: "service.create", targetKind: "service", targetId: body.serviceId },
            resolvedTransition: (result) => ({
              operation: "service.create",
              targetKind: "service",
              targetId: result.serviceId ?? body.serviceId,
            }),
            action: () => this.options.desktop!.createService!(body),
            pending: { serviceId: body.serviceId, status: "running" },
            actionName: "service create",
          });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "service.create",
          targetKind: "service",
          targetId: body.serviceId,
        };
        const result = await this.enqueueLifecycleMutation(
          () => runLifecycle(transitionInput, () => this.options.desktop!.createService!(body)),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, { operation: "service.create", targetKind: "service", targetId: result.serviceId }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.stop) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.stopService) {
          send(res, 501, { ok: false, error: "service stop not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "service.stop", targetKind: "service", targetId: body.serviceId },
          action: () => this.options.desktop!.stopService!(body),
          pending: { serviceId: body.serviceId, status: "offline" },
          actionName: "service stop",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.resume) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.resumeService) {
          send(res, 501, { ok: false, error: "service resume not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "service.resume", targetKind: "service", targetId: body.serviceId },
          action: () => this.options.desktop!.resumeService!(body),
          pending: { serviceId: body.serviceId, status: "running" },
          actionName: "service resume",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.remove) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.removeService) {
          send(res, 501, { ok: false, error: "service remove not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "service.remove", targetKind: "service", targetId: body.serviceId },
          action: () => this.options.desktop!.removeService!(body),
          pending: { serviceId: body.serviceId, status: "removed" },
          actionName: "service remove",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.resurrectAgent) {
        const body = (await readJson(req)) as { sessionId?: string; id?: string };
        const sessionId = (body.sessionId ?? body.id ?? "").trim();
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.desktop?.resurrectGraveyard) {
          send(res, 501, { ok: false, error: "agent graveyard resurrection not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "graveyard.agent.resurrect", targetKind: "agent", targetId: sessionId },
          action: () => this.options.desktop!.resurrectGraveyard!({ sessionId }),
          pending: { sessionId, status: "running" },
          actionName: "graveyard agent resurrect",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.resurrectWorktree) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.resurrectGraveyardWorktree) {
          send(res, 501, { ok: false, error: "worktree graveyard resurrection not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "graveyard.worktree.resurrect", targetKind: "worktree", targetPath: body.path },
          action: () => this.options.desktop!.resurrectGraveyardWorktree!(body),
          pending: { path: body.path, status: "active" },
          actionName: "graveyard worktree resurrect",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.deleteWorktree) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.deleteGraveyardWorktree) {
          send(res, 501, { ok: false, error: "worktree graveyard delete not supported by this service" });
          return;
        }
        await sendQueuedLifecycle({
          transition: { operation: "graveyard.worktree.delete", targetKind: "worktree", targetPath: body.path },
          action: () => this.options.desktop!.deleteGraveyardWorktree!(body),
          pending: { path: body.path, status: "deleting" },
          actionName: "graveyard worktree delete",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.cleanup) {
        const body = (await readJson(req).catch(() => ({}))) as { dryRun?: boolean };
        if (!this.options.desktop?.cleanupGraveyard) {
          send(res, 501, { ok: false, error: "graveyard cleanup not supported by this service" });
          return;
        }
        const transitionInput: LifecycleTransitionInput = {
          operation: "graveyard.cleanup",
          targetKind: "worktree",
        };
        const result = await this.enqueueLifecycleMutation(
          () =>
            runLifecycle(transitionInput, () =>
              this.options.desktop!.cleanupGraveyard!({ dryRun: body.dryRun === true }),
            ),
          transitionInput,
        );
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...(typeof result === "object" && result ? result : { result }) });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.reviews.approve) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.approveReview
          ? await this.options.actions.approveReview(body)
          : await approveReview({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitReviewOutcomeAlert({
          kind: "task_done",
          task: result.task,
          thread: result.thread,
          fallbackMessage: body.body?.trim() || result.message?.body || "Review approved.",
        });
        const deliveredTo = await this.deliverTaskOutcomeToLiveRecipient({ ...result, action: "review-approved" });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.reviews.requestChanges) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.requestTaskChanges
          ? await this.options.actions.requestTaskChanges(body)
          : await requestTaskChanges({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitReviewOutcomeAlert({
          kind: "blocked",
          task: result.task,
          thread: result.thread,
          fallbackMessage: body.body?.trim() || result.message?.body || "Changes requested.",
        });
        const deliveredTo = await this.deliverTaskOutcomeToLiveRecipient({
          ...result,
          action: "review-changes-requested",
        });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result, deliveredTo });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.tasks.reopen) {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.reopenTask
          ? await this.options.actions.reopenTask(body)
          : await reopenTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
        return;
      }
    } catch (error) {
      const message = userFacingErrorMessage(error);
      if (error instanceof LifecycleMutationConflictError) {
        send(res, error.status, {
          ok: false,
          error: message,
          transition: buildLifecycleTransition({
            ...error.requested,
            phase: "failed",
            error: message,
          }),
          activeTransition: buildLifecycleTransition({
            ...error.active,
            phase: "settling",
          }),
        });
        return;
      }
      if (error instanceof LifecycleMutationQueueFullError) {
        send(res, error.status, {
          ok: false,
          error: message,
          queuedCount: error.queuedCount,
          limit: error.limit,
          transition: buildLifecycleTransition({
            ...error.requested,
            phase: "failed",
            error: message,
          }),
        });
        return;
      }
      const lifecycleTransition = activeLifecycleTransition ?? failedLifecycleTransition;
      failedLifecycleTransition = undefined;
      if (lifecycleTransition) {
        send(res, 500, {
          ok: false,
          error: message,
          transition: buildLifecycleTransition({
            ...lifecycleTransition,
            phase: "failed",
            error: message,
          }),
        });
        return;
      }
      send(res, 400, { ok: false, error: message });
      return;
    }

    send(res, 404, { ok: false, error: "not found" });
  }
}

function normalizeNotificationMutationIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
}

function parseNotificationMutationIds(body: { ids?: unknown }): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "ids")) return undefined;
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
    throw new Error("ids must be an array of strings");
  }
  return normalizeNotificationMutationIds(body.ids);
}
