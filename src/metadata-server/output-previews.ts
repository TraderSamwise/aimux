import type { IncomingMessage } from "node:http";
import { Buffer } from "node:buffer";
import type { Worker } from "node:worker_threads";
import type { AgentActivityState, AgentAttentionState } from "../agent-events.js";
import type { ParsedAgentOutput } from "../agent-output-parser.js";
import { recordAgentOutputReadMetric, type AgentOutputReadSource } from "../agent-output-read-metrics.js";
import type { AgentTranscriptMessage } from "../agent-transcript.js";
import { log } from "../debug.js";
import { ExposePaneOutputTap, type ExposePaneOutputTapLike } from "../expose-pane-output-tap.js";
import { ExposePreviewCache, type ExposePreviewCacheLike } from "../expose-preview-cache.js";
import type { FastControlItem } from "../fast-control.js";
import { getProjectStateDir, getProjectStateDirFor } from "../paths.js";
import type { ExposePreviewSnapshot } from "../project-api-contract.js";
import { pruneExpiredHotExposeSnapshots } from "../tmux/expose-hot-snapshot.js";
import { parseVisualClientKind, VisualClientLeaseRegistry } from "../visual-client-leases.js";
import { startExposeHotSnapshotWorker } from "../expose-hot-snapshot-worker.js";

export type MetadataReadAgentOutputResult = {
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

export type MetadataReadAgentOutput = (input: {
  sessionId: string;
  startLine?: number;
}) => Promise<MetadataReadAgentOutputResult> | MetadataReadAgentOutputResult;

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
const DESKTOP_STATE_PREVIEW_MAX_CHARS = 8_192;
const DESKTOP_STATE_CHAT_PREVIEW_START_LINE = -80;
const DESKTOP_STATE_CHAT_PREVIEW_MAX_MESSAGES = 3;
const DESKTOP_STATE_CHAT_PREVIEW_CACHE_MS = 1500;
export const EXPOSE_HOT_SNAPSHOT_INITIAL_MS = 1500;
export const EXPOSE_HOT_SNAPSHOT_INITIAL_JITTER_MS = 1500;
export const EXPOSE_HOT_SNAPSHOT_REFRESH_MS = 3000;

export function mergeExposePreviewSnapshots(
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

export interface ProjectOutputPreviewCoordinatorOptions {
  currentProjectRoot: () => string;
  isServerRunning: () => boolean;
  readAgentOutput?: MetadataReadAgentOutput;
  exposePreviewCache?: ExposePreviewCacheLike | false;
  exposePaneOutputTap?: ExposePaneOutputTapLike | false;
  exposeHotSnapshots?: boolean;
  runInProjectContext: <T>(fn: () => T) => T;
}

export class ProjectOutputPreviewCoordinator {
  private readonly exposePreviewCache: ExposePreviewCacheLike | null;
  private readonly exposePaneOutputTap: ExposePaneOutputTapLike | null;
  private readonly visualClientLeases = new VisualClientLeaseRegistry();
  private readonly exposeHotSnapshotsEnabled: boolean;
  private readonly agentOutputReadCoalescer = new Map<string, AgentOutputReadCoalescerEntry>();
  private readonly agentChatPreviewCache = new Map<string, AgentChatPreviewCacheEntry>();
  private exposeHotSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private exposeHotSnapshotRefreshing = false;
  private exposeHotSnapshotWorker: Worker | null = null;

  constructor(private readonly options: ProjectOutputPreviewCoordinatorOptions) {
    const defaultExposePreviewCache = options.readAgentOutput
      ? new ExposePreviewCache({
          projectRoot: this.options.currentProjectRoot(),
        })
      : null;
    const defaultExposePaneOutputTap = options.readAgentOutput
      ? new ExposePaneOutputTap({
          projectStateDir: getProjectStateDirFor(this.options.currentProjectRoot()),
        })
      : null;
    this.exposePreviewCache =
      options.exposePreviewCache === false ? null : (options.exposePreviewCache ?? defaultExposePreviewCache);
    this.exposePaneOutputTap =
      options.exposePaneOutputTap === false ? null : (options.exposePaneOutputTap ?? defaultExposePaneOutputTap);
    this.exposeHotSnapshotsEnabled = options.exposeHotSnapshots ?? Boolean(options.readAgentOutput);
  }

  start(): void {
    this.exposePreviewCache?.start();
    this.exposePaneOutputTap?.start();
  }

  stop(): void {
    this.exposePreviewCache?.stop();
    this.exposePaneOutputTap?.stop();
    if (this.exposeHotSnapshotTimer) clearTimeout(this.exposeHotSnapshotTimer);
    this.exposeHotSnapshotTimer = null;
    this.exposeHotSnapshotRefreshing = false;
    this.exposeHotSnapshotWorker?.terminate().catch(() => {});
    this.exposeHotSnapshotWorker = null;
  }

  diagnostics(): Record<string, unknown> {
    return {
      clients: this.visualClientLeases.snapshot(),
      cache: this.exposePreviewCache?.stats?.() ?? null,
      taps: this.exposePaneOutputTap?.stats?.() ?? null,
    };
  }

  async measureAgentOutputRead(
    source: AgentOutputReadSource,
    input: { sessionId: string; startLine?: number },
  ): Promise<MetadataReadAgentOutputMeasurement> {
    if (!this.options.readAgentOutput) {
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

    const promise = Promise.resolve(this.options.readAgentOutput(input));
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

  recordAgentOutputRead(
    source: AgentOutputReadSource,
    input: { sessionId: string; startLine?: number },
    result: MetadataReadAgentOutputResult,
    durationMs: number,
    changed?: boolean,
    coalesced = false,
    responseBytes?: number,
  ): void {
    recordAgentOutputReadMetric({
      source,
      sessionId: input.sessionId,
      requestedStartLine: input.startLine,
      startLine: result.startLine,
      endLine: result.endLine,
      captureLineLimit: result.captureLineLimit,
      outputBytes: Buffer.byteLength(result.output ?? "", "utf8"),
      responseBytes,
      durationMs,
      coalesced,
      changed,
    });
  }

  touchVisualClientLease(
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

  attachExposePreviewSnapshots(
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

  async readAgentChatPreviews(
    sessionIds: readonly string[],
  ): Promise<Map<string, NonNullable<FastControlItem["chatPreview"]>>> {
    const previewsBySessionId = new Map<string, NonNullable<FastControlItem["chatPreview"]>>();
    if (!this.options.readAgentOutput) return previewsBySessionId;
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

  async attachExposeChatPreviews(rawItems: FastControlItem[]): Promise<FastControlItem[]> {
    const sessionIds = rawItems.map((item) => item.metadata.sessionId).filter((id): id is string => Boolean(id));
    const chatPreviewsBySessionId = await this.readAgentChatPreviews(sessionIds);
    if (chatPreviewsBySessionId.size === 0) return rawItems;
    return rawItems.map((item) => {
      const chatPreview = item.metadata.sessionId ? chatPreviewsBySessionId.get(item.metadata.sessionId) : undefined;
      return chatPreview ? { ...item, chatPreview } : item;
    });
  }

  async attachDesktopStatePreviews(
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

  scheduleExposeHotSnapshotRefresh(delayMs = EXPOSE_HOT_SNAPSHOT_REFRESH_MS): void {
    if (!this.exposeHotSnapshotsEnabled || this.exposeHotSnapshotTimer || !this.options.isServerRunning()) return;
    this.exposeHotSnapshotTimer = setTimeout(() => {
      this.exposeHotSnapshotTimer = null;
      this.options.runInProjectContext(() => this.refreshExposeHotSnapshots());
    }, delayMs);
    this.exposeHotSnapshotTimer.unref?.();
  }

  refreshExposeHotSnapshots(): void {
    if (!this.exposeHotSnapshotsEnabled || !this.options.isServerRunning()) return;
    pruneExpiredHotExposeSnapshots(getProjectStateDir());
    if (this.exposeHotSnapshotRefreshing) {
      this.scheduleExposeHotSnapshotRefresh();
      return;
    }
    this.exposeHotSnapshotRefreshing = true;
    const timeoutMs = 10_000;
    try {
      const worker = startExposeHotSnapshotWorker(
        { kind: "project", projectRoot: this.options.currentProjectRoot() },
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
        if (this.options.isServerRunning()) this.scheduleExposeHotSnapshotRefresh();
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
        projectRoot: this.options.currentProjectRoot(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleExposeHotSnapshotRefresh();
    }
  }
}
