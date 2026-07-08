import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
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
  type SessionServiceMetadata,
} from "./metadata-store.js";
import {
  contextualizeAlertInput,
  mergeDisplayContext,
  metadataDisplayContext,
  type SessionAlertDisplayContext,
} from "./alert-display.js";
import { notifyAlert } from "./notify.js";
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "./notifications.js";
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
  markThreadSeen,
  readMessages,
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
} from "./orchestration-actions.js";
import { readAllTasks, readTask } from "./tasks.js";
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
  projectApiMutationReasonForRoute,
  projectApiViewsForMutationRoute,
} from "./project-api-contract.js";
import { loadLastUsedState, markLastUsed } from "./last-used.js";
import { log } from "./debug.js";
import { userFacingErrorMessage } from "./error-display.js";
import { loadLibraryEntries } from "./library.js";
import { getWorktreeCreatePath } from "./worktree.js";
import type { LaunchOverride } from "./shell-args.js";
import { formatRelativeRecency } from "./recency.js";
import type { ParsedAgentOutput } from "./agent-output-parser.js";
import type { PluginRuntimePluginStatus } from "./plugin-runtime.js";
import {
  createUploadedAttachment,
  getAttachment,
  getAttachmentContent,
  getAttachmentRecord,
  type AttachmentRecord,
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
import {
  listSwitchableAgentItems,
  resolveAttentionAgent,
  resolveNextAgent,
  resolvePrevAgent,
  serializeFastControlItem,
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
import {
  resolveExchangeMessageAlertRecipients,
  resolveExchangeReviewOutcomeRecipient,
  resolveExchangeTaskAssignmentRecipient,
  resolveExchangeTaskOutcomeRecipient,
} from "./runtime-core/exchange-alert-routing.js";
import { loadConfig } from "./config.js";
import { describeSessionRestorability } from "./session-restorability.js";
import { shouldRelaunchFreshSession } from "./session-fresh-relaunch.js";
import { runTmuxExpose } from "./tmux/expose.js";
import { buildGraveyardViewModel } from "./multiplexer/graveyard-view-model.js";
import {
  permissionRequestHookOutput,
  summarizeClaudeNotification,
  summarizeClaudePermissionRequest,
  summarizeClaudeStop,
  type ClaudeHookPayload,
} from "./claude-hooks.js";
import type { CodexHookPayload } from "./codex-hooks.js";

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

const EXPOSE_SOCKET_HEADER_LINES = 14;
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
    }) => Promise<{ sessionId: string; accepted: true }> | { sessionId: string; accepted: true };
    readAgentOutput?: (input: {
      sessionId: string;
      startLine?: number;
    }) =>
      | Promise<{ sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput }>
      | { sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput };
  };
}

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
const DESKTOP_STATE_CACHE_TTL_MS = 10_000;
const DESKTOP_STATE_STALE_REFRESH_DELAY_MS = 1_000;

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

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("connection", "close");
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, mimeType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", mimeType);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("connection", "close");
  res.end(body);
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

  const body = trimmedText || "Please review the attached image file(s).";
  const attachmentLines = attachments.map((attachment) => {
    return `- ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.contentPath}`;
  });

  return `${body}\n\nAttached image files:\n${attachmentLines.join("\n")}`;
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

function topologyDesktopSessionList(
  statuses: Array<"running" | "idle" | "offline" | "graveyard">,
): DesktopSessionRecord[] {
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

  constructor(private readonly options: MetadataServerOptions = {}) {
    this.projectRoot = options.projectRoot?.trim() || metadataProjectRoot();
    this.eventBus = options.events?.bus ?? new ProjectEventBus();
    this.unsubscribeAlertSink = this.eventBus.subscribe((event) => {
      if (event.type !== "alert") return;
      this.scheduleDesktopStateRefresh();
      notifyAlert(event);
    });
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
    await this.startExposeSocket();
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
    this.exposeServer?.close();
    this.exposeServer = null;
    if (this.exposeSocketPath) rmSync(this.exposeSocketPath, { force: true });
    rmSync(join(getProjectStateDirFor(this.currentProjectRoot()), "expose.sock.path"), { force: true });
    this.exposeSocketPath = null;
    if (this.desktopStateRefreshTimer) clearTimeout(this.desktopStateRefreshTimer);
    this.desktopStateRefreshTimer = null;
    if (this.shellStateFlushTimer) clearTimeout(this.shellStateFlushTimer);
    this.shellStateFlushTimer = null;
    this.pendingShellStateUpdates.length = 0;
    this.desktopStateRefreshing = false;
    this.unsubscribeAlertSink?.();
    this.unsubscribeAlertSink = null;
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
      backdropFile: header[9] || undefined,
      daemonEndpoint: header[13] || undefined,
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
    socket.end();
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

  private currentProjectRoot(): string {
    return this.projectRoot ?? process.cwd();
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
    const state = this.options.desktop?.getState?.() ?? {};
    this.desktopStateCache = { ts: Date.now(), state };
    this.desktopStateCacheDirty = false;
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
    if (force) return this.refreshDesktopStateCache();
    const now = Date.now();
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
    const topologySessions = topologyDesktopSessionList(["running", "idle", "offline"]);
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
    this.eventBus.publishAlert(contextualizeAlertInput(input, displayContext));
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

  private emitHookEvent(sessionId: string, event: AgentEvent): void {
    this.tracker.emit(sessionId, event);
    if (event.kind === "needs_input") {
      this.emitAlert({
        kind: "needs_input",
        sessionId,
        title: `${sessionId} needs input`,
        message: event.message || "Agent is waiting for input.",
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
        this.emitHookEvent(sessionId, { kind: "needs_input", message: summary.body, tone: "warn" });
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
    if (!sessionId) return worktreePath ? { worktreePath } : undefined;
    let context: SessionAlertDisplayContext = {};
    try {
      context = metadataDisplayContext(loadMetadataState().sessions[sessionId]);
    } catch {}
    const liveContext = this.options.desktop?.getSessionDisplayContext?.(sessionId);
    context = mergeDisplayContext(context, liveContext ?? {});
    if (worktreePath) context.worktreePath = worktreePath;
    return Object.values(context).some((value) => value !== undefined) ? context : undefined;
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
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
      const startLine = parsedStartLine.value;
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
        try {
          const result = await this.options.lifecycle.readAgentOutput({ sessionId: sessionFilter, startLine });
          if (closed) return;
          if (result.output !== lastOutput) {
            lastOutput = result.output;
            sendSseEvent(res, PROJECT_API_EVENT_NAMES.agentOutput, {
              sessionId: result.sessionId,
              output: result.output,
              startLine: result.startLine ?? startLine ?? -120,
              parsed: result.parsed,
            });
          }
        } catch (error) {
          sendSseEvent(res, PROJECT_API_EVENT_NAMES.error, {
            sessionId: sessionFilter,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        }
      };

      sendSseEvent(res, PROJECT_API_EVENT_NAMES.ready, {
        projectId: getProjectId(),
        ts: new Date().toISOString(),
        sessionId: sessionFilter,
        startLine: startLine ?? -120,
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
      const notifications = listNotifications({ unreadOnly, sessionId });
      send(res, 200, {
        ok: true,
        notifications,
        unreadCount: unreadNotificationCount({ sessionId }),
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
      });
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
      send(res, 200, {
        ok: true,
        serviceInfo: getProjectServiceManifest(),
        pendingInteractions: this.interactions.listPending(),
        ...this.getDesktopStateSnapshot(force),
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
      const threads = buildCoordinationThreadEntries(participant);
      const { model, worklist } = buildCoordinationView({
        sessions: state.sessions ?? [],
        teammates: state.teammates ?? [],
        services: state.services ?? [],
        notifications: listNotifications(),
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
      const project = buildProjectObservability({
        sessions: [...(state.sessions ?? []), ...(state.teammates ?? [])],
        services: state.services ?? [],
        worktrees: state.worktrees ?? [],
        tasks: readAllTasks(),
        notifications: listNotifications(),
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
      const tasks = readAllTasks();
      const activeTaskFor = (sessionId: string) =>
        tasks.find((task) => task.assignedTo === sessionId && task.status !== "done" && task.status !== "failed");
      const agents = topologyDesktopSessionList(["running", "idle", "offline"]).map((session) => {
        const meta = metadataState.sessions[session.id];
        const task = activeTaskFor(session.id);
        return {
          id: session.id,
          tool: session.tool,
          role: session.team?.role,
          status: session.status,
          restoreState: session.restoreState,
          restoreBlockedReason: session.restoreBlockedReason,
          worktreePath: session.worktreePath,
          label: session.label,
          activity: meta?.derived?.activity,
          attention: meta?.derived?.attention,
          loop: meta?.loop,
          overseer: meta?.overseer ?? false,
          task: task ? { id: task.id, description: task.description, status: task.status } : undefined,
        };
      });
      send(res, 200, { ok: true, agents });
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.threads.list) {
      send(res, 200, listThreadSummaries(url.searchParams.get("session") ?? undefined));
      return;
    }
    if (req.method === "GET" && url.pathname === PROJECT_API_ROUTES.tasks.list) {
      const sessionId = url.searchParams.get("session")?.trim();
      const status = url.searchParams.get("status")?.trim();
      const tasks = readAllTasks()
        .filter((task) => !sessionId || task.assignedTo === sessionId || task.assignedBy === sessionId)
        .filter((task) => !status || task.status === status);
      send(res, 200, { ok: true, tasks });
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
      const items = listSwitchableAgentItems(
        {
          projectRoot: this.currentProjectRoot(),
          currentClientSession,
          currentWindow,
          currentWindowId,
          currentPath,
        },
        new TmuxRuntimeManager(),
        { scope },
      ).map((item) => ({
        ...serializeFastControlItem(item),
        label: rawLabels || !item.lastUsedAt ? item.label : `${item.label} · ${formatRelativeRecency(item.lastUsedAt)}`,
      }));
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
      const startLine = parsedStartLine.value;

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
      let pollTimer: ReturnType<typeof setInterval> | null = null;

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
        try {
          const result = await this.options.lifecycle!.readAgentOutput!({ sessionId, startLine });
          if (closed) return;
          if (result.output !== lastOutput) {
            lastOutput = result.output;
            sendSseEvent(res, outputEventName, {
              sessionId: result.sessionId,
              output: result.output,
              startLine: result.startLine ?? startLine ?? -120,
              parsed: result.parsed,
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
        }
      };

      sendSseEvent(res, "ready", { sessionId, startLine: startLine ?? -120, intervalMs });
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
      send(res, 200, { thread, messages: readMessages(threadId) });
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
      const task = readTask(taskId);
      if (!task) {
        send(res, 404, { ok: false, error: "task not found" });
        return;
      }
      const thread = task.threadId ? readThread(task.threadId) : undefined;
      const messages = task.threadId ? readMessages(task.threadId) : [];
      send(res, 200, { ok: true, task, thread, messages });
      return;
    }

    let activeLifecycleTransition: LifecycleTransitionInput | undefined;
    const runLifecycle = async <T>(input: LifecycleTransitionInput, action: () => Promise<T> | T): Promise<T> => {
      activeLifecycleTransition = input;
      const result = await action();
      activeLifecycleTransition = undefined;
      return result;
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
        send(res, 200, { ok: true, ...result });
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
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        const result = await runLifecycle(
          { operation: "agent.spawn", targetKind: "agent", targetId: body.sessionId },
          () => this.options.lifecycle!.spawnAgent!(body),
        );
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
        const result = await runLifecycle(
          { operation: "agent.spawn", targetKind: "agent", targetId: body.sessionId },
          () =>
            this.options.lifecycle!.createTeammateAgent!({
              parentSessionId: body.parentSessionId,
              role: body.role,
              label: body.label,
              tool: body.tool,
              sessionId: body.sessionId,
              worktreePath: body.worktreePath,
              open: body.open,
              extraArgs: body.extraArgs,
              order: body.order,
            }),
        );
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
        }
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(
            { ...result, task: taskResult?.task, thread: taskResult?.thread },
            {
              operation: "agent.spawn",
              targetKind: "agent",
              targetId: result.sessionId,
            },
          ),
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, parentSessionId: resolved.parent.id, teammateSessionId: teammate.id, ...result });
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
        const result = await runLifecycle(
          { operation: "agent.stop", targetKind: "agent", targetId: resolved.teammate.id },
          () => this.options.lifecycle!.stopAgent!({ sessionId: resolved.teammate.id }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(
            { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...result },
            { operation: "agent.stop", targetKind: "agent", targetId: resolved.teammate.id },
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
        const result = await runLifecycle(
          { operation: "agent.resume", targetKind: "agent", targetId: resolved.teammate.id },
          () =>
            this.options.desktop!.resumeAgent!({
              sessionId: resolved.teammate.id,
              session: resolved.teammate,
            }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(
            { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...result },
            { operation: "agent.resume", targetKind: "agent", targetId: resolved.teammate.id },
          ),
        );
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
        const result = await runLifecycle(
          { operation: "agent.kill", targetKind: "agent", targetId: resolved.teammate.id },
          () =>
            this.options.lifecycle!.killAgent!({
              sessionId: resolved.teammate.id,
            }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(
            { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...result },
            { operation: "agent.kill", targetKind: "agent", targetId: resolved.teammate.id },
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
        const result = await runLifecycle(
          { operation: "graveyard.agent.resurrect", targetKind: "agent", targetId: resolved.teammate.id },
          () => this.options.desktop!.resurrectGraveyard!({ sessionId: resolved.teammate.id }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(
            { parentSessionId: resolved.parent.id, teammateSessionId: resolved.teammate.id, ...result },
            { operation: "graveyard.agent.resurrect", targetKind: "agent", targetId: resolved.teammate.id },
          ),
        );
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
        const result = await runLifecycle(
          { operation: "agent.fork", targetKind: "agent", targetId: body.targetSessionId },
          () => this.options.lifecycle!.forkAgent!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.fork",
            targetKind: "agent",
            targetId: result.sessionId ?? body.targetSessionId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.stop) {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.lifecycle?.stopAgent) {
          send(res, 501, { ok: false, error: "agent stop not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "agent.stop", targetKind: "agent", targetId: body.sessionId },
          () => this.options.lifecycle!.stopAgent!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.stop",
            targetKind: "agent",
            targetId: body.sessionId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.resume) {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.desktop?.resumeAgent) {
          send(res, 501, { ok: false, error: "agent resume not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "agent.resume", targetKind: "agent", targetId: body.sessionId },
          () => this.options.desktop!.resumeAgent!({ sessionId: body.sessionId }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.resume",
            targetKind: "agent",
            targetId: body.sessionId,
          }),
        );
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
        const result = await runLifecycle(
          { operation: "agent.interrupt", targetKind: "agent", targetId: sessionId },
          () => this.options.lifecycle!.interruptAgent!({ sessionId }),
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
        const result = await runLifecycle(
          { operation: "agent.rename", targetKind: "agent", targetId: body.sessionId },
          () => this.options.lifecycle!.renameAgent!(body),
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
        const result = await runLifecycle(
          { operation: "agent.migrate", targetKind: "agent", targetId: body.sessionId, targetPath: body.worktreePath },
          () => this.options.lifecycle!.migrateAgent!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.migrate",
            targetKind: "agent",
            targetId: body.sessionId,
            targetPath: body.worktreePath,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.agents.kill) {
        const body = (await readJson(req)) as { sessionId: string; session?: Record<string, unknown> };
        if (!this.options.lifecycle?.killAgent) {
          send(res, 501, { ok: false, error: "agent kill not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "agent.kill", targetKind: "agent", targetId: body.sessionId },
          () => this.options.lifecycle!.killAgent!({ sessionId: body.sessionId }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "agent.kill",
            targetKind: "agent",
            targetId: body.sessionId,
          }),
        );
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === PROJECT_API_ROUTES.agents.input || url.pathname === PROJECT_API_ROUTES.livePane.input)
      ) {
        const body = (await readJson(req)) as { sessionId?: string; text?: string; attachmentIds?: unknown };
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
        if (!text.trim() && attachmentIds.length === 0) {
          send(res, 400, { ok: false, error: "text is required" });
          return;
        }
        const attachments = attachmentIds.map((id) => getAttachmentRecord(id));
        const missingAttachmentId = attachmentIds.find((_, index) => attachments[index] === null);
        if (missingAttachmentId) {
          send(res, 400, { ok: false, error: `attachment not found: ${missingAttachmentId}` });
          return;
        }
        if (!this.options.lifecycle?.sendAgentInput) {
          send(res, 501, { ok: false, error: "agent input not supported by this service" });
          return;
        }
        const formattedText = formatAgentInputWithAttachments(
          text,
          attachments.filter((entry): entry is AttachmentRecord => !!entry),
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
        const body = (await readJson(req)) as { sessionId?: string; active?: boolean; goal?: string };
        const sessionId = body.sessionId?.trim() ?? "";
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
          const loop = { active: true, goal: goal || undefined, since: new Date().toISOString() };
          setSessionLoop(sessionId, loop);
          notifyCurrentRouteChange();
          send(res, 200, { ok: true, sessionId, loop });
        } else {
          clearSessionLoop(sessionId);
          notifyCurrentRouteChange();
          send(res, 200, { ok: true, sessionId, loop: null });
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
        setSessionOverseer(sessionId, Boolean(body.active));
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, sessionId, overseer: Boolean(body.active) });
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.attachments) {
        const body = (await readJson(req)) as { filename?: unknown; mimeType?: unknown; dataBase64?: unknown };
        if (
          typeof body.filename !== "string" ||
          typeof body.mimeType !== "string" ||
          typeof body.dataBase64 !== "string"
        ) {
          send(res, 400, { ok: false, error: "filename, mimeType, and dataBase64 are required" });
          return;
        }
        try {
          const attachment = createUploadedAttachment({
            filename: body.filename,
            mimeType: body.mimeType,
            dataBase64: body.dataBase64,
          });
          send(res, 200, { ok: true, attachment });
        } catch (error) {
          send(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid attachment" });
        }
        return;
      }

      const attachmentContentMatch = url.pathname.match(/^\/attachments\/([^/]+)\/content$/);
      if (req.method === "GET" && attachmentContentMatch) {
        const content = getAttachmentContent(decodeURIComponent(attachmentContentMatch[1] || ""));
        if (!content) {
          send(res, 404, { ok: false, error: "attachment not found" });
          return;
        }
        sendBytes(res, 200, content.buffer, content.attachment.mimeType);
        return;
      }

      const attachmentMatch = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (req.method === "GET" && attachmentMatch) {
        const attachment = getAttachment(decodeURIComponent(attachmentMatch[1] || ""));
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
        const startLine = parsedStartLine.value;
        const result = await this.options.lifecycle.readAgentOutput({ sessionId, startLine });
        send(res, 200, { ok: true, ...result });
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
        const startLine = parsedStartLine.value;

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

        const output = await this.options.lifecycle.readAgentOutput({ sessionId, startLine });
        send(res, 200, {
          ok: true,
          ...output,
          stream: {
            route: PROJECT_API_ROUTES.events,
            sessionId,
            startLine: output.startLine ?? startLine,
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
        const resultPromise = Promise.resolve().then(() => desktop.createWorktree!(body));
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
        void resultPromise.then(
          () => notifyCurrentRouteChange(),
          () => notifyCurrentRouteChange(),
        );
        const targetPath = getWorktreeCreatePath(body.name, this.projectRoot);
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
        const resultPromise = Promise.resolve().then(() => desktop.removeWorktree!(body));
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
        void resultPromise.then(
          () => notifyCurrentRouteChange(),
          () => notifyCurrentRouteChange(),
        );
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
        const result = await runLifecycle(
          { operation: "worktree.graveyard", targetKind: "worktree", targetPath: body.path },
          () => this.options.desktop!.graveyardWorktree!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "worktree.graveyard",
            targetKind: "worktree",
            targetPath: body.path,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.create) {
        const body = (await readJson(req)) as { command?: string; worktreePath?: string; serviceId?: string };
        if (!this.options.desktop?.createService) {
          send(res, 501, { ok: false, error: "service create not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "service.create", targetKind: "service", targetId: body.serviceId },
          () => this.options.desktop!.createService!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "service.create",
            targetKind: "service",
            targetId: result.serviceId ?? body.serviceId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.stop) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.stopService) {
          send(res, 501, { ok: false, error: "service stop not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "service.stop", targetKind: "service", targetId: body.serviceId },
          () => this.options.desktop!.stopService!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "service.stop",
            targetKind: "service",
            targetId: body.serviceId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.resume) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.resumeService) {
          send(res, 501, { ok: false, error: "service resume not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "service.resume", targetKind: "service", targetId: body.serviceId },
          () => this.options.desktop!.resumeService!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "service.resume",
            targetKind: "service",
            targetId: body.serviceId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.services.remove) {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.removeService) {
          send(res, 501, { ok: false, error: "service remove not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "service.remove", targetKind: "service", targetId: body.serviceId },
          () => this.options.desktop!.removeService!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "service.remove",
            targetKind: "service",
            targetId: body.serviceId,
          }),
        );
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
        const result = await runLifecycle(
          { operation: "graveyard.agent.resurrect", targetKind: "agent", targetId: sessionId },
          () => this.options.desktop!.resurrectGraveyard!({ sessionId }),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "graveyard.agent.resurrect",
            targetKind: "agent",
            targetId: sessionId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.resurrectWorktree) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.resurrectGraveyardWorktree) {
          send(res, 501, { ok: false, error: "worktree graveyard resurrection not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "graveyard.worktree.resurrect", targetKind: "worktree", targetPath: body.path },
          () => this.options.desktop!.resurrectGraveyardWorktree!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "graveyard.worktree.resurrect",
            targetKind: "worktree",
            targetPath: body.path,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.deleteWorktree) {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.deleteGraveyardWorktree) {
          send(res, 501, { ok: false, error: "worktree graveyard delete not supported by this service" });
          return;
        }
        const result = await runLifecycle(
          { operation: "graveyard.worktree.delete", targetKind: "worktree", targetPath: body.path },
          () => this.options.desktop!.deleteGraveyardWorktree!(body),
        );
        notifyCurrentRouteChange();
        send(
          res,
          200,
          lifecycleOk(result, {
            operation: "graveyard.worktree.delete",
            targetKind: "worktree",
            targetPath: body.path,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === PROJECT_API_ROUTES.graveyardActions.cleanup) {
        const body = (await readJson(req).catch(() => ({}))) as { dryRun?: boolean };
        if (!this.options.desktop?.cleanupGraveyard) {
          send(res, 501, { ok: false, error: "graveyard cleanup not supported by this service" });
          return;
        }
        const result = await this.options.desktop.cleanupGraveyard({ dryRun: body.dryRun === true });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
        notifyCurrentRouteChange();
        send(res, 200, { ok: true, ...result });
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
      if (activeLifecycleTransition) {
        send(res, 500, {
          ok: false,
          error: message,
          transition: buildLifecycleTransition({
            ...activeLifecycleTransition,
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
