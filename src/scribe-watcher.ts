import { createHash } from "node:crypto";
import { log } from "./debug.js";
import { findScribeSessionId, type MetadataState } from "./metadata-store.js";
import { isProjectControlSession, type SessionTeamMetadata } from "./team.js";

export const SCRIBE_WATCHER_SCAN_INTERVAL_MS = 60_000;
export const SCRIBE_WATCHER_COOLDOWN_MS = 60_000;
export const SCRIBE_WATCHER_MAX_CANDIDATES = 8;
export const SCRIBE_WATCHER_MAX_SCAN_CANDIDATES = 50;
export const SCRIBE_WATCHER_OUTPUT_START_LINE = -160;
export const SCRIBE_WATCHER_MAX_OUTPUT_CHARS = 12_000;
export const SCRIBE_WATCHER_MAX_SEEN_FINGERPRINTS_PER_SESSION = 5;

export interface ScribeWatcherSession {
  id: string;
  status?: string;
  worktreePath?: string;
  tool?: string;
  team?: unknown;
  overseer?: boolean;
  scribe?: boolean;
}

export interface ScribeCandidate {
  id: string;
  status?: string;
  activity?: string;
  attention?: string;
  worktreePath?: string;
  tool?: string;
}

export interface ScribeBriefingCandidate extends ScribeCandidate {
  output: string;
  outputChars: number;
  fingerprint: string;
}

export interface ScribeWatcherDeps {
  loadSessions: () => ScribeWatcherSession[];
  loadMetadata: () => MetadataState;
  readAgentOutput: (sessionId: string, startLine: number) => Promise<{ output?: string } | string | null | undefined>;
  sendAgentInput: (sessionId: string, text: string) => Promise<unknown>;
  now?: () => number;
  scanIntervalMs?: number;
  cooldownMs?: number;
  maxCandidates?: number;
  maxScanCandidates?: number;
  outputStartLine?: number;
  maxOutputChars?: number;
}

function normalizeOutput(value: { output?: string } | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof value.output === "string") return value.output;
  return "";
}

function boundedOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return output.slice(output.length - maxChars);
}

function fingerprintFor(sessionId: string, output: string): string {
  return createHash("sha1").update(sessionId).update("\0").update(output).digest("hex");
}

function readyScribeExists(
  sessions: ScribeWatcherSession[],
  metadata: MetadataState,
  scribeId: string | undefined,
): scribeId is string {
  if (!scribeId) return false;
  return sessions.some((session) => {
    if (session.id !== scribeId) return false;
    if (session.status === "offline" || session.status === "graveyard" || session.status === "starting") return false;
    const meta = metadata.sessions[scribeId];
    const activity = meta?.derived?.activity;
    if (activity !== "idle" && activity !== "done") return false;
    const attention = meta?.derived?.attention ?? "normal";
    return attention === "normal";
  });
}

export function findScribeCandidates(
  sessions: ScribeWatcherSession[],
  metadata: MetadataState,
  scribeId: string | undefined,
  maxScanCandidates = SCRIBE_WATCHER_MAX_SCAN_CANDIDATES,
): ScribeCandidate[] {
  const candidates: ScribeCandidate[] = [];
  for (const session of sessions) {
    if (session.id === scribeId) continue;
    const meta = metadata.sessions[session.id];
    const controlProbe = {
      ...session,
      overseer: meta?.overseer ?? session.overseer,
      scribe: meta?.scribe ?? session.scribe,
    } as { team?: SessionTeamMetadata; overseer?: boolean; scribe?: boolean };
    if (isProjectControlSession(controlProbe)) {
      continue;
    }
    const status = session.status ?? "running";
    if (status !== "running" && status !== "idle") continue;
    const activity = meta?.derived?.activity;
    if (activity !== "idle" && activity !== "done") continue;
    const attention = meta?.derived?.attention ?? "normal";
    if (attention !== "normal") continue;
    candidates.push({
      id: session.id,
      status,
      activity,
      attention,
      worktreePath: session.worktreePath ?? meta?.context?.worktreePath,
      tool: session.tool,
    });
    if (candidates.length >= maxScanCandidates) break;
  }
  return candidates;
}

function describeCandidate(candidate: ScribeBriefingCandidate): string {
  const parts = [
    `id=${candidate.id}`,
    candidate.tool ? `tool=${candidate.tool}` : undefined,
    candidate.status ? `status=${candidate.status}` : undefined,
    candidate.activity ? `activity=${candidate.activity}` : undefined,
    candidate.attention ? `attention=${candidate.attention}` : undefined,
    candidate.worktreePath ? `worktree=${candidate.worktreePath}` : undefined,
    `chars=${candidate.outputChars}`,
  ].filter(Boolean);
  return [`## ${parts.join(" ")}`, "", "```text", candidate.output.trimEnd(), "```"].join("\n");
}

export function buildScribeBriefing(candidates: ScribeBriefingCandidate[]): string {
  return [
    "[aimux scribe check] Review these changed bounded agent tails and update the work outline only for meaningful distinct work.",
    "Use `aimux outline list --json` first when needed. Use stable topic keys and update existing entries instead of duplicating them.",
    "Ignore heartbeats, prompts, progress chatter, repeated status, and anything that is not real work.",
    "",
    ...candidates.map(describeCandidate),
  ].join("\n");
}

export class ScribeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;
  private lastBriefingAt = 0;
  private readonly seenFingerprints = new Map<string, string[]>();

  constructor(private readonly deps: ScribeWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.scan(), this.deps.scanIntervalMs ?? SCRIBE_WATCHER_SCAN_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.scanning = false;
    this.lastBriefingAt = 0;
    this.seenFingerprints.clear();
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const startedAt = (this.deps.now ?? Date.now)();
    try {
      const metadata = this.deps.loadMetadata();
      const scribeId = findScribeSessionId(metadata);
      const sessions = this.deps.loadSessions();
      if (!readyScribeExists(sessions, metadata, scribeId)) return;

      const now = (this.deps.now ?? Date.now)();
      const cooldownMs = this.deps.cooldownMs ?? SCRIBE_WATCHER_COOLDOWN_MS;
      if (this.lastBriefingAt > 0 && now - this.lastBriefingAt < cooldownMs) return;

      const candidates = findScribeCandidates(
        sessions,
        metadata,
        scribeId,
        this.deps.maxScanCandidates ?? SCRIBE_WATCHER_MAX_SCAN_CANDIDATES,
      );
      if (candidates.length === 0) return;

      const briefingCandidates: ScribeBriefingCandidate[] = [];
      let readCount = 0;
      let skippedUnchanged = 0;
      let failedReads = 0;
      let totalOutputChars = 0;
      for (const candidate of candidates) {
        try {
          readCount += 1;
          const rawOutput = normalizeOutput(
            await this.deps.readAgentOutput(
              candidate.id,
              this.deps.outputStartLine ?? SCRIBE_WATCHER_OUTPUT_START_LINE,
            ),
          );
          const output = boundedOutput(rawOutput, this.deps.maxOutputChars ?? SCRIBE_WATCHER_MAX_OUTPUT_CHARS);
          if (!output.trim()) continue;
          const fingerprint = fingerprintFor(candidate.id, output);
          const seen = this.seenFingerprints.get(candidate.id) ?? [];
          if (seen.includes(fingerprint)) {
            skippedUnchanged += 1;
            continue;
          }
          totalOutputChars += output.length;
          briefingCandidates.push({
            ...candidate,
            output,
            outputChars: output.length,
            fingerprint,
          });
          if (briefingCandidates.length >= (this.deps.maxCandidates ?? SCRIBE_WATCHER_MAX_CANDIDATES)) break;
        } catch (error) {
          failedReads += 1;
          log.warn("scribe watcher agent read failed", "scribe", {
            sessionId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (briefingCandidates.length === 0) {
        log.debug("scribe watcher scan skipped", "scribe", {
          reason: "unchanged-or-empty",
          scribeId,
          candidateCount: candidates.length,
          readCount,
          skippedUnchanged,
          failedReads,
        });
        return;
      }

      if (this.stopped) return;
      await this.deps.sendAgentInput(scribeId, buildScribeBriefing(briefingCandidates));
      if (this.stopped) return;
      this.lastBriefingAt = now;
      for (const candidate of briefingCandidates) {
        const existing = this.seenFingerprints.get(candidate.id) ?? [];
        this.seenFingerprints.set(
          candidate.id,
          [candidate.fingerprint, ...existing.filter((fingerprint) => fingerprint !== candidate.fingerprint)].slice(
            0,
            SCRIBE_WATCHER_MAX_SEEN_FINGERPRINTS_PER_SESSION,
          ),
        );
      }
      log.info("scribe watcher delivered briefing", "scribe", {
        scribeId,
        candidateCount: briefingCandidates.length,
        sessionIds: briefingCandidates.map((candidate) => candidate.id),
        readCount,
        skippedUnchanged,
        failedReads,
        totalOutputChars,
        durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAt),
      });
    } catch (error) {
      log.warn("scribe watcher scan failed", "scribe", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.scanning = false;
    }
  }
}
