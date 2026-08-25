import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { readHistory } from "../context/history.js";
import { getAimuxDirFor, getProjectStateDir, getRepoRoot, getStatusDir } from "../paths.js";
import { loadTeamConfig } from "../team.js";
import { SessionRuntime } from "../session-runtime.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { withTmuxQueryMemo } from "../tmux/query-memo.js";
import { loadMetadataState } from "../metadata-store.js";
import { isAgentOutputEventKind } from "../agent-events.js";
import { loadLastUsedState } from "../last-used.js";
import { summarizeUnreadNotificationsBySession } from "../notifications.js";
import { sessionRecencyAnchor } from "../session-recency.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { activityTextFromParsedAgentOutput, parseAgentOutput } from "../agent-output-parser.js";
import { boundedAgentOutputEndLine, boundedAgentOutputStartLine } from "../agent-output-bounds.js";
import {
  mergePublishedAttachments,
  messagesFromParsedAgentOutput,
  type AgentTranscriptMessage,
} from "../agent-transcript.js";
import { classifyToolPane } from "../tool-output-watchers.js";
import {
  anchorSessionAttachment,
  forgetSessionAttachments,
  getAttachment,
  listSessionAttachments,
} from "../attachment-store.js";
import { parseSgrRichTextLines } from "../rich-text.js";
import type { AgentActivityState, AgentAttentionState } from "../agent-events.js";
import { normalizeSubmittedPrompt, waitForTmuxPromptSubmit } from "../agent-prompt-delivery.js";
import { captureGitContext, writeLivePaneSnapshot } from "../context/context-bridge.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { upsertTopologySession } from "../runtime-core/topology-sessions.js";
import type { SessionTeamMetadata } from "../team.js";
import { discoverCodexBackendSessionId } from "../backend-session-discovery.js";
import { shouldMarkFreshRelaunchAllowed } from "../session-fresh-relaunch.js";
import { captureDashboardLifecycle, isDashboardLifecycleCurrent } from "./dashboard-lifecycle.js";
import { mutateDashboardApi, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";

/** Recordings have no size bound, so only the tail is ever read back. */
const RECORDING_TAIL_BYTES = 64 * 1024;

function readRecordingTail(path: string): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= RECORDING_TAIL_BYTES) return readFileSync(path, "utf-8");
    const buffer = Buffer.alloc(RECORDING_TAIL_BYTES);
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, RECORDING_TAIL_BYTES, size - RECORDING_TAIL_BYTES);
    return buffer.subarray(0, read).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

type SessionRuntimeHost = any;
const RESTORE_EXIT_BLOCK_MS = 30_000;

function projectRootFor(host: SessionRuntimeHost): string {
  const projectRoot = typeof host.projectRoot === "string" ? host.projectRoot.trim() : "";
  return projectRoot || getRepoRoot();
}

export function getSessionLabel(host: SessionRuntimeHost, sessionId: string): string | undefined {
  return (
    host.sessionLabels.get(sessionId) ?? host.offlineSessions.find((session: any) => session.id === sessionId)?.label
  );
}

export function applySessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): void {
  const trimmed = label?.trim();
  if (trimmed) {
    host.sessionLabels.set(sessionId, trimmed);
  } else {
    host.sessionLabels.delete(sessionId);
  }

  const offline = host.offlineSessions.find((session: any) => session.id === sessionId);
  if (offline) {
    if (trimmed) offline.label = trimmed;
    else delete offline.label;
  }
}

export function applyDashboardSessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): void {
  const trimmed = label?.trim();
  host.dashboardSessionsCache = host.dashboardSessionsCache.map((session: any) =>
    session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
  );
  host.dashboardWorktreeGroupsCache = host.dashboardWorktreeGroupsCache.map((group: any) => ({
    ...group,
    sessions: group.sessions.map((session: any) =>
      session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
    ),
  }));
  host.dashboardState.worktreeSessions = host.dashboardState.worktreeSessions.map((session: any) =>
    session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
  );
}

export async function updateSessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): Promise<void> {
  if (host.mode === "dashboard") {
    const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
    const modelLifecycle = captureDashboardLifecycle(host);
    const token = host.setPendingDashboardSessionAction(sessionId, "renaming");
    host.writeStatuslineFile();
    host.renderCurrentDashboardView();
    const clearPending = () => {
      if (typeof token === "number") {
        const clearIfToken = host.dashboardPendingActions?.clearSessionActionIfToken;
        if (typeof clearIfToken === "function") {
          if (clearIfToken.call(host.dashboardPendingActions, sessionId, token)) {
            host.reapplyDashboardPendingActions?.();
          }
          return;
        }
        host.setPendingDashboardSessionAction(sessionId, null);
        return;
      }
      host.setPendingDashboardSessionAction(sessionId, null);
    };
    try {
      await mutateDashboardApi(host, PROJECT_API_ROUTES.agents.rename, { sessionId, label });
      host.invalidateDesktopStateSnapshot();
      await refreshDashboardModelThroughApi(host, { force: true, lifecycle: modelLifecycle });
    } catch (err: unknown) {
      await refreshDashboardModelThroughApi(host, { force: true, lifecycle: modelLifecycle });
      if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
      host.footerFlash = `Rename failed: ${err instanceof Error ? err.message : String(err)}`;
      host.footerFlashTicks = 4;
    } finally {
      clearPending();
      host.writeStatuslineFile();
      if (isDashboardLifecycleCurrent(host, lifecycle)) {
        host.renderCurrentDashboardView();
      }
    }
    return;
  }

  applySessionLabel(host, sessionId, label);
  host.invalidateDesktopStateSnapshot();

  const localSession = host.sessions.find((session: any) => session.id === sessionId)?.transport;
  if (localSession instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, localSession.tmuxTarget);
    if (target) {
      localSession.retarget(target);
      localSession.renameWindow(localSession.command);
      host.sessionTmuxTargets.set(sessionId, localSession.tmuxTarget);
      host.syncTmuxWindowMetadata(sessionId);
    }
  }

  host.saveState();
  host.writeStatuslineFile();
  host.renderDashboard();
}

export function readStatusHeadline(_host: SessionRuntimeHost, sessionId: string): string | undefined {
  try {
    const statusPath = join(getStatusDir(), `${sessionId}.md`);
    if (!existsSync(statusPath)) return undefined;
    const content = readFileSync(statusPath, "utf-8").trim();
    if (!content) return undefined;
    return content.split("\n")[0].slice(0, 80);
  } catch {
    return undefined;
  }
}

export function deriveHeadline(host: SessionRuntimeHost, sessionId: string): string | undefined {
  const statusHeadline = readStatusHeadline(host, sessionId);
  if (statusHeadline) return statusHeadline;

  try {
    const turns = readHistory(sessionId, { lastN: 3 });
    const lastPrompt = turns.filter((turn: any) => turn.type === "prompt").pop();
    if (lastPrompt) return lastPrompt.content.slice(0, 80);
  } catch {}

  return undefined;
}

export function resolveRunningSession(host: SessionRuntimeHost, sessionId: string): any {
  const session = host.sessions.find((candidate: any) => candidate.id === sessionId);
  if (!session || session.exited) {
    throw new Error(`Session "${sessionId}" is not running`);
  }
  return session;
}

const TARGET_METADATA_STARTUP_GRACE_MS = 5_000;

function canAcceptMetadatalessTarget(host: SessionRuntimeHost, sessionId: string): boolean {
  const runtime = host.sessions?.find?.((candidate: any) => candidate.id === sessionId);
  const startTime = typeof runtime?.startTime === "number" ? runtime.startTime : undefined;
  return startTime !== undefined && Date.now() - startTime <= TARGET_METADATA_STARTUP_GRACE_MS;
}

export function resolveLiveSessionTmuxTarget(host: SessionRuntimeHost, sessionId: string, fallback?: any): any {
  const candidate = host.sessionTmuxTargets.get(sessionId) ?? fallback;
  if (candidate) {
    try {
      if (!host.tmuxRuntimeManager.getTargetByWindowId || !host.tmuxRuntimeManager.getWindowMetadata) {
        return candidate;
      }
      const resolved = host.tmuxRuntimeManager.getTargetByWindowId(candidate.sessionName, candidate.windowId);
      const metadata = resolved ? host.tmuxRuntimeManager.getWindowMetadata(resolved) : null;
      if (!resolved) {
        host.sessionTmuxTargets.delete(sessionId);
      } else if (metadata?.kind === "agent" && metadata.sessionId === sessionId) {
        host.sessionTmuxTargets.set(sessionId, resolved);
        return resolved;
      } else if (!metadata && canAcceptMetadatalessTarget(host, sessionId)) {
        host.sessionTmuxTargets.set(sessionId, resolved);
        return resolved;
      } else {
        host.sessionTmuxTargets.delete(sessionId);
      }
    } catch {
      host.sessionTmuxTargets.delete(sessionId);
    }
  }

  try {
    const projectRoot =
      typeof host.projectRoot === "string" && host.projectRoot.trim() ? host.projectRoot : process.cwd();
    for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(projectRoot)) {
      if (metadata.kind !== "agent" || metadata.sessionId !== sessionId) continue;
      if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) continue;
      host.sessionTmuxTargets.set(sessionId, target);
      return target;
    }
  } catch {}

  return undefined;
}

export async function interruptAgent(host: SessionRuntimeHost, sessionId: string): Promise<{ sessionId: string }> {
  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, session.transport.tmuxTarget);
    if (!target) throw new Error(`Session "${sessionId}" does not have a live tmux target`);
    session.transport.retarget(target);
    host.tmuxRuntimeManager.sendEscape(target);
  } else {
    session.write("\x1b");
  }
  return { sessionId };
}

export async function resizeAgentPane(
  host: SessionRuntimeHost,
  sessionId: string,
  cols: number,
  rows: number,
): Promise<{ sessionId: string; cols: number; rows: number }> {
  if (!Number.isInteger(cols) || cols <= 0) throw new Error("cols must be a positive integer");
  if (!Number.isInteger(rows) || rows <= 0) throw new Error("rows must be a positive integer");

  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, session.transport.tmuxTarget);
    if (!target) throw new Error(`Session "${sessionId}" does not have a live tmux target`);
    session.transport.retarget(target);
  }
  session.resize(cols, rows);
  return { sessionId, cols, rows };
}

export async function sendAgentInput(
  host: SessionRuntimeHost,
  sessionId: string,
  text: string,
  opts?: { waitForSubmit?: boolean },
): Promise<{ sessionId: string; accepted: true }> {
  // Default true preserves the blocking behavior the TUI and loop-watcher rely
  // on. The HTTP `input` route passes false: it returns once the input is
  // accepted and lets the submit-confirmation finish in the background, because
  // agent output is delivered over the SSE event stream, not this response.
  // Blocking the response on the (up to ~10s) tmux confirmation is what made the
  // app's send time out on prompts that flood the pane immediately.
  const waitForSubmit = opts?.waitForSubmit ?? true;
  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, session.transport.tmuxTarget);
    if (!target) throw new Error(`Session "${sessionId}" does not have a live tmux target`);
    session.transport.retarget(target);
    const prompt = normalizeSubmittedPrompt(host.sessionToolKeys.get(sessionId), text, true);
    session.transport.write(prompt);
    const confirmSubmit = waitForTmuxPromptSubmit({
      tmuxRuntimeManager: host.tmuxRuntimeManager,
      target,
      draft: prompt,
      isTargetCurrent: () => resolveLiveSessionTmuxTarget(host, sessionId, target)?.windowId === target.windowId,
    });
    // waitForTmuxPromptSubmit always resolves (never rejects), so backgrounding
    // it cannot produce an unhandled rejection.
    if (waitForSubmit) await confirmSubmit;
    else void confirmSubmit;
  } else {
    session.write(text);
    session.write("\r");
  }
  return { sessionId, accepted: true };
}

/**
 * One entry per session, keyed on the pane text that produced it.
 *
 * Every attached client polls, and each poll parsed and projected the same
 * unchanged pane again. A still pane is the common case, so the whole cost
 * collapses to a string comparison.
 *
 * Keyed by startLine as well as session: two clients watching the same pane
 * through different windows produce different text, and one key between them
 * would mean each eviscerating the other\'s entry on every poll.
 */
const transcriptCache = new Map<
  string,
  {
    output: string;
    outputAnsi: string;
    parsed: any;
    messages: AgentTranscriptMessage[];
    activityText: string;
    publishedKey: string;
  }
>();

/** How many recent publishes may be carried into a transcript on their own. */
const PUBLISHED_ATTACHMENT_LIMIT = 5;
/**
 * How long after publishing an attachment may re-attach to a different turn.
 * Long enough to survive a reply still being written — the message id hashes
 * its text, so it moves while the agent streams — and short enough that an
 * older image stays where it was shown.
 */
const PUBLISHED_ATTACHMENT_REANCHOR_MS = 2 * 60 * 1000;

/**
 * SGR only — the colours tmux tracked, none of the cursor motion around them.
 *
 * Dropping these from a `-e` capture reproduces the plain capture byte for byte,
 * which is what lets one capture serve both readers: the parser keeps taking the
 * exact text it always took, and the terminal view gets the same bytes with the
 * attributes still attached.
 */
const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;

export function stripSgr(text: string): string {
  return text.replace(SGR_SEQUENCE, "");
}

function containsSgr(text: string): boolean {
  return /\x1b\[[0-9;:]*m/.test(text);
}

function stripParsedSourceLines(parsed: any): any {
  if (!Array.isArray(parsed?.blocks)) return parsed;
  return {
    ...parsed,
    blocks: parsed.blocks.map(({ sourceLines: _sourceLines, ...block }: any) => block),
  };
}

/**
 * What the session is really doing, from the event enum and the pane together.
 *
 * The enum only moves when the tool emits an event, so an agent that keeps
 * working after its response sits at "idle" while its pane spins — measured on
 * two live sessions, wrong in both directions. A progress line is first-hand
 * evidence of a turn in flight (the extractor takes only the in-progress form,
 * never the past-tense "Verbed for 20s" a finished turn leaves behind), so it
 * wins. waiting/error/interrupted come from explicit events and keep priority:
 * those are the states where the operator, not the agent, is the blocker.
 */
export function reconcileAgentActivity(
  reported: AgentActivityState | undefined,
  activityText: string | undefined,
  paneState?: { interruptedVisible?: boolean },
): AgentActivityState | undefined {
  if (paneState?.interruptedVisible) return "interrupted";
  if (!activityText) return reported;
  if (reported === "waiting" || reported === "error" || reported === "interrupted") return reported;
  return "running";
}

/**
 * Chat output must fail closed rather than briefly show another pane's bytes.
 * Revalidate ownership before every capture; lifecycle churn and tmux restarts
 * can otherwise make a cached target look like discontinuous old chat history.
 */
function captureSessionPane(
  host: SessionRuntimeHost,
  sessionId: string,
  options: { startLine: number; endLine?: number; includeEscapes: boolean },
): string {
  const target = resolveLiveSessionTmuxTarget(host, sessionId);
  if (!target) {
    throw new Error(`Session "${sessionId}" does not have a live tmux target`);
  }
  return host.tmuxRuntimeManager.captureTarget(target, options);
}

export async function readAgentOutput(
  host: SessionRuntimeHost,
  sessionId: string,
  startLine?: number,
): Promise<{
  sessionId: string;
  output: string;
  /** `output` with tmux's colours still on it, for the terminal view. */
  outputAnsi: string;
  startLine?: number;
  parsed: any;
  messages: AgentTranscriptMessage[];
  /** The tool's own progress line, empty when the pane is not showing one. */
  activityText?: string;
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
}> {
  const runtime = resolveRunningSession(host, sessionId);
  const boundedStartLine = boundedAgentOutputStartLine(startLine);
  const outputAnsi = captureSessionPane(host, sessionId, {
    startLine: boundedStartLine,
    endLine: boundedAgentOutputEndLine(boundedStartLine),
    includeEscapes: true,
  });
  const output = stripSgr(outputAnsi);
  const toolKey = host.sessionToolKeys.get(sessionId) ?? runtime.command;
  const paneState = classifyToolPane(toolKey, output);
  writeLivePaneSnapshot({ id: sessionId, command: toolKey }, output);

  // Read every time rather than cached with the transcript below: activity
  // moves independently of the pane — an agent finishing leaves the last frame
  // on screen — so a value cached behind a text comparison would stick.
  const derived = loadMetadataState(projectRootFor(host)).sessions[sessionId]?.derived;

  const livenessFor = (activityText?: string) => ({
    activity: reconcileAgentActivity(derived?.activity, activityText, paneState),
    attention: derived?.attention,
  });

  // Published attachments are part of the transcript but not part of the pane
  // text the cache is keyed on, so a fresh publish has to invalidate it too.
  const published = listSessionAttachments(sessionId, { limit: PUBLISHED_ATTACHMENT_LIMIT });
  const publishedKey = published.map((entry) => `${entry.record.id}@${entry.anchorMessageId ?? ""}`).join(",");
  const cacheKey = `${sessionId}:${boundedStartLine}`;
  const cached = transcriptCache.get(cacheKey);
  if (cached && cached.output === output && cached.outputAnsi === outputAnsi && cached.publishedKey === publishedKey) {
    const activityText = paneState.interruptedVisible ? "" : cached.activityText;
    return {
      sessionId,
      output,
      outputAnsi,
      startLine: boundedStartLine,
      parsed: cached.parsed,
      messages: cached.messages,
      activityText,
      ...livenessFor(activityText),
    };
  }

  const richLines = containsSgr(outputAnsi) ? parseSgrRichTextLines(outputAnsi) : undefined;
  const parsedForMessages = parseAgentOutput(output, {
    includeSource: Boolean(richLines),
    tool: toolKey,
  });
  const parsed = stripParsedSourceLines(parsedForMessages);
  // Projected here rather than in each client. Two of them had grown their own
  // copy of this mapping and the copies had already drifted.
  const parsedMessages = messagesFromParsedAgentOutput(parsedForMessages, {
    richLines,
    attachmentContentForId: (attachmentId) => {
      const attachment = getAttachment(attachmentId, sessionId);
      if (!attachment?.hostedContentUrl) return undefined;
      return {
        contentUrl: attachment.hostedContentUrl,
        hostedExpiresAt: attachment.hostedExpiresAt,
      };
    },
  });
  // Cached beside the transcript, not recomputed on the hit path: the verb lives
  // in the pane text this cache is keyed on, so identical output means an
  // identical verb — and recomputing only on a miss would blank it on every
  // unchanged poll.
  const merged = mergePublishedAttachments(
    parsedMessages,
    published.map((entry) => ({
      attachmentId: entry.record.id,
      anchorMessageId: entry.anchorMessageId,
      canReanchor: Date.now() - Date.parse(entry.record.createdAt) < PUBLISHED_ATTACHMENT_REANCHOR_MS,
      filename: entry.record.filename,
      mimeType: entry.record.mimeType,
      contentUrl: entry.record.contentUrl,
      hostedContentUrl: entry.record.hostedContentUrl,
      hostedExpiresAt: entry.record.hostedExpiresAt,
    })),
  );
  const messages = merged.messages;
  // Written back so the next read puts it in the same place rather than under
  // whatever the newest reply happens to be by then.
  for (const anchor of merged.anchors) {
    anchorSessionAttachment(sessionId, anchor.attachmentId, anchor.messageId);
  }
  const activityText = paneState.interruptedVisible ? "" : activityTextFromParsedAgentOutput(parsed);
  transcriptCache.set(cacheKey, { output, outputAnsi, parsed, messages, activityText, publishedKey });

  return {
    sessionId,
    output,
    outputAnsi,
    startLine: boundedStartLine,
    parsed,
    messages,
    activityText,
    ...livenessFor(activityText),
  };
}

/** Called from session teardown; the cache is keyed per startLine window. */
export function forgetAgentTranscript(sessionId: string): void {
  for (const key of transcriptCache.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) transcriptCache.delete(key);
  }
  // The publish index is transcript state too — a session that is gone has no
  // transcript left for its attachments to belong to.
  forgetSessionAttachments(sessionId);
}

export function registerManagedSession(
  host: SessionRuntimeHost,
  session: any,
  args: string[],
  toolConfigKey?: string,
  worktreePath?: string,
  role?: string,
  startTime?: number,
  team?: SessionTeamMetadata,
): any {
  const existing = host.sessions.find((runtime: any) => runtime.transport === session);
  if (existing) return existing;

  const runtime = new SessionRuntime(session, startTime, {
    onEvent: (event: any) => host.handleSessionRuntimeEvent(runtime, event),
  });
  runtime.team = team;

  if (toolConfigKey) {
    host.sessionToolKeys.set(runtime.id, toolConfigKey);
  }
  host.sessionOriginalArgs.set(runtime.id, args);
  if (worktreePath) {
    host.sessionWorktreePaths.set(runtime.id, worktreePath);
  }
  if (team) {
    host.sessionRoles.delete(runtime.id);
  } else if (role) {
    host.sessionRoles.set(runtime.id, role);
  } else if (!host.sessionRoles.has(runtime.id)) {
    try {
      const teamConfig = loadTeamConfig();
      host.sessionRoles.set(runtime.id, teamConfig.defaultRole);
    } catch {}
  }
  const label = host.offlineSessions.find((offline: any) => offline.id === runtime.id)?.label;
  if (label) {
    host.sessionLabels.set(runtime.id, label);
  }

  host.sessions.push(runtime);
  host.updateContextWatcherSessions();
  if (host.sessions.length === 1) host.contextWatcher.start();
  return runtime;
}

export function handleSessionRuntimeEvent(host: SessionRuntimeHost, runtime: any, event: any): void {
  if (event.type === "output") {
    host.writeStatuslineFile();
    return;
  }

  if (event.type !== "exit") return;
  const code = event.code;

  host.debug?.(`session exited: ${runtime.id} (code=${code})`, "session");

  const uptime = runtime.startTime ? Date.now() - runtime.startTime : Infinity;
  let errorHint = "";
  if (code !== 0 && uptime < 10_000) {
    const sessionCwd = host.sessionWorktreePaths.get(runtime.id);
    const searchDirs = [getProjectStateDir(), sessionCwd ? getAimuxDirFor(sessionCwd) : null].filter(
      Boolean,
    ) as string[];
    for (const dir of searchDirs) {
      if (errorHint) break;
      try {
        const logPath = join(dir, "recordings", `${runtime.id}.log`);
        if (existsSync(logPath)) {
          // Recordings are unbounded, and a crash hint only needs the tail.
          const raw = readRecordingTail(logPath);
          const lines = raw
            .split("\n")
            .map((l) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim())
            .filter(Boolean);
          const errorLine = lines.find(
            (l) => l.includes("Error") || l.includes("error") || l.includes("unmatched") || l.includes("not found"),
          );
          if (errorLine) errorHint = `: ${errorLine.slice(0, 60)}`;
        }
      } catch {}
    }
    host.footerFlash = `✗ ${runtime.id} crashed (code ${code})${errorHint}`;
    host.footerFlashTicks = 8;
    host.debug?.(`quick crash: ${runtime.id} (code=${code}, uptime=${uptime}ms)${errorHint}`, "session");
  }

  if (code !== 0) {
    host.publishAlert({
      kind: "task_failed",
      sessionId: runtime.id,
      title: `${runtime.id} failed`,
      message: errorHint ? `Agent exited with code ${code}${errorHint}` : `Agent exited with code ${code}.`,
      dedupeKey: `exit-failed:${runtime.id}`,
      cooldownMs: 15_000,
    });
  }
  captureGitContext(runtime.id, runtime.command).catch(() => {});

  const idx = host.sessions.indexOf(runtime);
  if (idx === -1) return;

  const explicitStop = host.stoppingSessionIds.has(runtime.id);
  const graveyardAfterStop = host.graveyardAfterStopSessionIds?.has?.(runtime.id) ?? false;
  let backendSessionId = runtime.backendSessionId;
  const toolConfigKey = host.sessionToolKeys.get(runtime.id) ?? runtime.command;
  let projectRoot: string | undefined;
  const resolveProjectRoot = () => (projectRoot ??= projectRootFor(host));
  if (!graveyardAfterStop && !backendSessionId && toolConfigKey === "codex") {
    try {
      backendSessionId = discoverCodexBackendSessionId(
        host.sessionWorktreePaths.get(runtime.id) ?? resolveProjectRoot(),
        undefined,
        { sinceMs: Math.max(0, (runtime.startTime ?? Date.now()) - 1000) },
      );
      if (backendSessionId) runtime.backendSessionId = backendSessionId;
    } catch (error) {
      host.debug?.(
        `codex backend session id exit capture failed for ${runtime.id}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
    }
  }
  const restoreStartedAt = typeof runtime.restoreStartedAt === "number" ? runtime.restoreStartedAt : undefined;
  const restoreUptime = restoreStartedAt === undefined ? Infinity : Date.now() - restoreStartedAt;
  const restoreExitedDuringProbe = !explicitStop && !graveyardAfterStop && restoreUptime < RESTORE_EXIT_BLOCK_MS;
  const quickUnexpectedExit = !explicitStop && !graveyardAfterStop && uptime < 10_000;
  const restoreBlockedReason = restoreExitedDuringProbe
    ? errorHint
      ? `agent exited after restore${errorHint}`
      : "agent exited after restore"
    : quickUnexpectedExit
      ? errorHint
        ? `agent exited during startup${errorHint}`
        : "agent exited during startup"
      : undefined;
  const shouldPreserveOffline =
    !graveyardAfterStop && (explicitStop || Boolean(backendSessionId) || uptime >= 10_000 || restoreExitedDuringProbe);
  if (shouldPreserveOffline) {
    upsertTopologySession(
      {
        id: runtime.id,
        tool: runtime.command,
        toolConfigKey,
        command: runtime.command,
        args: host.sessionOriginalArgs.get(runtime.id) ?? [],
        lifecycle: "offline",
        createdAt: runtime.startTime ? new Date(runtime.startTime).toISOString() : undefined,
        backendSessionId,
        freshRelaunchAllowed: shouldMarkFreshRelaunchAllowed(
          { id: runtime.id, backendSessionId },
          resolveProjectRoot(),
        ),
        team: runtime.team,
        worktreePath: host.sessionWorktreePaths.get(runtime.id),
        label: host.getSessionLabel(runtime.id),
        headline: host.deriveHeadline(runtime.id),
        restoreBlockedReason,
      },
      "offline",
      { projectRoot: resolveProjectRoot() },
    );
  } else if (!shouldPreserveOffline) {
    host.unpreservedExitedSessionIds ??= new Set<string>();
    host.unpreservedExitedSessionIds.add(runtime.id);
  }

  host.sessions.splice(idx, 1);
  host.stoppingSessionIds.delete(runtime.id);
  host.graveyardAfterStopSessionIds?.delete?.(runtime.id);
  if (shouldPreserveOffline) {
    host.loadOfflineTopologySessions?.();
  } else {
    host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== runtime.id);
  }
  host.updateContextWatcherSessions();
  const mappedTarget = host.sessionTmuxTargets.get(runtime.id);
  const runtimeTarget = runtime.transport instanceof TmuxSessionTransport ? runtime.transport.tmuxTarget : undefined;
  if (!mappedTarget || !runtimeTarget || mappedTarget.windowId === runtimeTarget.windowId) {
    host.sessionTmuxTargets.delete(runtime.id);
  }
  host.saveState();

  if (host.sessions.length === 0) {
    if (host.startedInDashboard) {
      host.renderDashboard();
      return;
    }
    // A project service outlives its sessions. Its lifetime belongs to whoever
    // supervises the process, not to the last agent someone stopped — resolving
    // the run here would exit with that session's code, which a supervisor reads
    // as a crash. The daemon-hosted actor never noticed because it never assigns
    // resolveRun; the standalone entrypoint does.
    if (host.mode === "project-service") return;
    host.resolveRun?.(code);
    return;
  }

  if (host.activeIndex >= host.sessions.length) {
    host.activeIndex = host.sessions.length - 1;
  }

  host.renderDashboard();
}

export function buildTmuxWindowMetadata(
  host: SessionRuntimeHost,
  sessionId: string,
  command: string,
  existing?: { team?: SessionTeamMetadata } | null,
): any {
  const sessionMetadata = loadMetadataState().sessions[sessionId];
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  // Compute the same semantic user label the dashboard shows, from the single source
  // of truth, so Exposé and the dashboard never disagree on an agent's state.
  const semantic = deriveSessionSemantics({
    status: runtime?.status ?? "running",
    activity: sessionMetadata?.derived?.activity,
    attention: sessionMetadata?.derived?.attention,
    unseenCount: sessionMetadata?.derived?.unseenCount,
  });
  const derived = sessionMetadata?.derived;
  const lastOutputAt =
    derived?.lastOutputAt ??
    (derived?.lastEvent && isAgentOutputEventKind(derived.lastEvent.kind) ? derived.lastEvent.ts : undefined);
  const label = semantic.user.label;
  // latestUnread only feeds the prompted/blocked/failed anchors — skip the notification
  // scan for the common working/ready/idle states.
  const wantsUnread = label === "needs_input" || label === "needs_response" || label === "blocked" || label === "error";
  const anchor = sessionRecencyAnchor({
    label,
    lastOutputAt,
    becameIdleAt: derived?.becameIdleAt,
    lastUsedAt: loadLastUsedState(process.cwd()).items[sessionId]?.lastUsedAt,
    latestUnreadAt: wantsUnread
      ? summarizeUnreadNotificationsBySession().get(sessionId)?.latestUnread?.createdAt
      : undefined,
  });
  return {
    kind: "agent",
    sessionId,
    command,
    args: host.sessionOriginalArgs.get(sessionId) ?? [],
    toolConfigKey: host.sessionToolKeys.get(sessionId) ?? command,
    backendSessionId: runtime?.backendSessionId,
    team: runtime?.team ?? existing?.team,
    overseer: sessionMetadata?.overseer === true,
    worktreePath: host.sessionWorktreePaths.get(sessionId),
    label: getSessionLabel(host, sessionId),
    role: host.sessionRoles.get(sessionId),
    activity: sessionMetadata?.derived?.activity,
    attention: sessionMetadata?.derived?.attention,
    unseenCount: sessionMetadata?.derived?.unseenCount,
    statusText: sessionMetadata?.status?.text,
    userLabel: semantic.user.label,
    recencyAt: anchor?.value,
    recencyLabel: anchor?.label,
  };
}

/**
 * Key-order-independent, so a rebuilt object that happens to serialize its keys
 * in a different order is not mistaken for a change.
 */
function canonicalMetadata(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/**
 * Window policy is three constants derived from the tool key, so it only has to
 * be stamped once per window rather than on every metadata sync.
 */
const policyAppliedWindows = new Set<string>();

export function syncTmuxWindowMetadata(host: SessionRuntimeHost, sessionId: string): void {
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  if (!runtime || !(runtime.transport instanceof TmuxSessionTransport)) return;
  const target = resolveLiveSessionTmuxTarget(host, sessionId, runtime.transport.tmuxTarget);
  if (!target) return;
  const existing = host.tmuxRuntimeManager.getWindowMetadata(target);
  const metadata = buildTmuxWindowMetadata(host, sessionId, runtime.command, existing);
  metadata.createdAt =
    existing?.createdAt ??
    (runtime.startTime ? new Date(runtime.startTime).toISOString() : undefined) ??
    new Date().toISOString();
  runtime.transport.retarget(target);

  // The agent hook calls this on every tool call. Comparing first keeps Exposé
  // exactly as fresh — a status change alters the payload and writes on the very
  // next sync — while dropping the write, and the memo flush it caused, whenever
  // nothing moved. A busy agent still writes; a quiet one stops paying.
  const windowId = typeof target === "string" ? target : target.windowId;
  const changed = canonicalMetadata(existing) !== canonicalMetadata(metadata);
  if (changed) host.tmuxRuntimeManager.setWindowMetadata(target, metadata);
  if (changed || !policyAppliedWindows.has(windowId)) {
    policyAppliedWindows.add(windowId);
    host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, metadata.toolConfigKey);
  }
}

export function updateContextWatcherSessions(host: SessionRuntimeHost): void {
  // Every session resolves against the same host tmux session, so without a
  // scope this asks tmux to list the identical window set once per session.
  // Synchronous throughout, which is what makes the scope safe.
  withTmuxQueryMemo(() => {
    host.contextWatcher.updateSessions(
      host.sessions.map((s: any) => {
        const key = host.sessionToolKeys.get(s.id);
        const tc = key ? loadConfig().tools[key] : undefined;
        return {
          id: s.id,
          command: s.command,
          turnPatterns: tc?.turnPatterns?.map((p: string) => new RegExp(p)),
          tmuxTarget: resolveLiveSessionTmuxTarget(host, s.id),
        };
      }),
    );
    host.contextWatcher.start?.();
  });
}
