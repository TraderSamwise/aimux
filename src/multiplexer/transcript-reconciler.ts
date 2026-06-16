import { claudeTranscriptPath } from "../backend-session-discovery.js";
import type { MetadataState } from "../metadata-store.js";
import type { RuntimeTopologySessionState } from "../runtime-core/topology-sessions.js";
import { findCodexTranscriptPath, probeTranscript, type TranscriptProbe } from "../transcript-turn-state.js";

// Ticks to skip re-scanning the Codex session tree after a path lookup miss, so a
// not-yet-written transcript doesn't trigger a recursive walk every tick.
const CODEX_MISS_BACKOFF_TICKS = 8;

export interface TranscriptReconcilerDeps {
  intervalMs?: number;
  loadMetadata: () => MetadataState;
  loadSessions: () => RuntimeTopologySessionState[];
  hasPendingInteraction: (sessionId: string) => boolean;
  /** Settle a stuck working agent to idle (label becomes "ready"). */
  settleActivity: (sessionId: string) => void;
  /** Clear a stranded needs_response attention back to normal. */
  clearStaleResponse: (sessionId: string) => void;
  probe?: (toolConfigKey: string, path: string) => TranscriptProbe | null;
  findCodexPath?: (backendSessionId: string) => string | null;
}

/**
 * Periodic reconciler that keeps an agent's derived `activity` in sync with the
 * deterministic turn-state recorded in its transcript. The event-driven state
 * machine (Claude/Codex hooks) can strand `activity:"running"` whenever the
 * clearing `stop` event is dropped (compact, interrupt, daemon down, resume).
 * When the transcript shows the turn is genuinely complete AND the file has gone
 * quiescent (unchanged since the prior tick — a working agent is still
 * appending), we settle the session so it reads "ready" instead of "working".
 */
export class TranscriptReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private readonly intervalMs: number;
  // Sessions seen "complete" once, with the transcript stat at that moment, so we
  // only settle after confirming the file stayed quiescent across a full tick.
  private readonly pending = new Map<string, { size: number; mtimeMs: number }>();
  private readonly codexPathCache = new Map<string, string>();
  // Sessions whose Codex transcript lookup missed, with the tick to retry at.
  private readonly codexMissUntil = new Map<string, number>();
  // Sessions seen needing a needs_response clear once, awaiting a second tick so a
  // fast daemon restart can't clear a still-re-registering interaction.
  private readonly pendingClear = new Set<string>();
  private tick = 0;

  constructor(private readonly deps: TranscriptReconcilerDeps) {
    this.intervalMs = deps.intervalMs ?? 4000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.codexPathCache.clear();
    this.codexMissUntil.clear();
    this.pendingClear.clear();
  }

  private resolveTranscriptPath(session: RuntimeTopologySessionState, metadata: MetadataState): string | null {
    const stored = metadata.sessions[session.id]?.context?.transcriptPath;
    if (stored) return stored;
    const cwd = session.worktreePath ?? metadata.sessions[session.id]?.context?.worktreePath;
    if (!session.backendSessionId) return null;
    if (session.toolConfigKey === "codex") {
      const cached = this.codexPathCache.get(session.id);
      if (cached) return cached;
      const retryAt = this.codexMissUntil.get(session.id);
      if (retryAt !== undefined && this.tick < retryAt) return null;
      const found = (this.deps.findCodexPath ?? findCodexTranscriptPath)(session.backendSessionId);
      if (found) {
        this.codexPathCache.set(session.id, found);
        this.codexMissUntil.delete(session.id);
      } else {
        this.codexMissUntil.set(session.id, this.tick + CODEX_MISS_BACKOFF_TICKS);
      }
      return found;
    }
    if (!cwd) return null;
    return claudeTranscriptPath(cwd, session.backendSessionId);
  }

  /** Exposed for tests; runs one reconciliation pass. */
  scan(): void {
    if (this.scanning) return;
    this.scanning = true;
    this.tick++;
    try {
      const metadata = this.deps.loadMetadata();
      const live = new Set<string>();
      const probe = this.deps.probe ?? probeTranscript;

      for (const session of this.deps.loadSessions()) {
        live.add(session.id);
        const derived = metadata.sessions[session.id]?.derived;
        if (!derived) continue;

        // Part B — clear a needs_response stranded by a lost in-memory interaction
        // registry (e.g. after a daemon restart) once it's still unbacked on a
        // second tick (so a fast restart mid-re-registration can't clear a live one).
        if (derived.attention === "needs_response" && !this.deps.hasPendingInteraction(session.id)) {
          if (this.pendingClear.has(session.id)) {
            this.deps.clearStaleResponse(session.id);
            this.pendingClear.delete(session.id);
          } else {
            this.pendingClear.add(session.id);
          }
        } else {
          this.pendingClear.delete(session.id);
        }

        // Part A — settle a stuck "working" agent against transcript ground truth.
        const stuckWorking =
          (derived.activity === "running" || derived.activity === "waiting") && derived.attention === "normal";
        if (!stuckWorking) {
          this.pending.delete(session.id);
          continue;
        }

        const path = this.resolveTranscriptPath(session, metadata);
        if (!path) {
          this.pending.delete(session.id);
          continue;
        }
        const result = probe(session.toolConfigKey, path);
        if (!result || result.turn !== "complete") {
          this.pending.delete(session.id);
          continue;
        }

        const prior = this.pending.get(session.id);
        if (prior && prior.size === result.size && prior.mtimeMs === result.mtimeMs) {
          // Complete and quiescent across a full tick — the turn is genuinely over.
          this.deps.settleActivity(session.id);
          this.pending.delete(session.id);
        } else {
          this.pending.set(session.id, { size: result.size, mtimeMs: result.mtimeMs });
        }
      }

      for (const id of [...this.pending.keys()]) {
        if (!live.has(id)) this.pending.delete(id);
      }
      for (const id of [...this.codexPathCache.keys()]) {
        if (!live.has(id)) this.codexPathCache.delete(id);
      }
      for (const id of [...this.codexMissUntil.keys()]) {
        if (!live.has(id)) this.codexMissUntil.delete(id);
      }
      for (const id of [...this.pendingClear]) {
        if (!live.has(id)) this.pendingClear.delete(id);
      }
    } finally {
      this.scanning = false;
    }
  }
}
