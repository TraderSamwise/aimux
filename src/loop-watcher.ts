import type { LoopConfig } from "./config.js";
import { findOverseerSessionId, type MetadataState } from "./metadata-store.js";
import { debug } from "./debug.js";

/** Minimal session shape the watcher needs from the topology. */
export interface LoopWatcherSession {
  id: string;
  status?: string;
  worktreePath?: string;
  tool?: string;
}

export interface LoopCandidate {
  id: string;
  goal?: string;
  worktreePath?: string;
  tool?: string;
}

/**
 * An in-loop agent is a nudge candidate when it has stopped (activity idle/done)
 * without waiting on a human (attention normal, no pending interaction) and is not
 * the overseer itself. waiting/error/interrupted states are deliberately excluded —
 * those are genuine pauses we must not steamroll.
 */
export function findLoopCandidates(
  sessions: LoopWatcherSession[],
  metadata: MetadataState,
  opts: { overseerId?: string; hasPendingInteraction: (sessionId: string) => boolean },
): LoopCandidate[] {
  const candidates: LoopCandidate[] = [];
  for (const session of sessions) {
    if (session.id === opts.overseerId) continue;
    const meta = metadata.sessions[session.id];
    if (!meta?.loop?.active) continue;
    const activity = meta.derived?.activity;
    if (activity !== "idle" && activity !== "done") continue;
    const attention = meta.derived?.attention ?? "normal";
    if (attention !== "normal") continue;
    if (opts.hasPendingInteraction(session.id)) continue;
    candidates.push({
      id: session.id,
      goal: meta.loop.goal,
      worktreePath: session.worktreePath,
      tool: session.tool,
    });
  }
  return candidates;
}

function describeCandidate(candidate: LoopCandidate): string {
  const tool = candidate.tool ? ` (${candidate.tool})` : "";
  const where = candidate.worktreePath ? ` @ ${candidate.worktreePath}` : "";
  const goal = candidate.goal ? ` — goal: ${candidate.goal}` : "";
  return `- ${candidate.id}${tool}${where}${goal}`;
}

export function buildOverseerBriefing(candidates: LoopCandidate[]): string {
  return [
    "[aimux loop check] These agents are in a managed loop but appear to have stopped:",
    ...candidates.map(describeCandidate),
    "",
    "For each: read its recent output with `aimux host agent-read <id>`, then decide whether it stopped prematurely.",
    'If it should keep going, send a specific next instruction with `aimux input <id> "…"`.',
    "If it genuinely finished its goal or is blocked beyond repair, run `aimux loop remove <id>` and report back.",
    "Never push an agent that is waiting on a human decision.",
  ].join("\n");
}

export function buildCannedNudge(candidate: LoopCandidate): string {
  const goal = candidate.goal ? ` with this goal: ${candidate.goal}` : "";
  return [
    `[aimux loop] You stopped, but you're in a managed loop${goal}.`,
    "Keep working toward it now. Only stop when you have genuinely finished or are blocked beyond repair:",
    '- finished  → run `aimux loop done --reason "…"`',
    '- hard-blocked → run `aimux loop block --reason "…"`',
    "Otherwise, continue.",
  ].join("\n");
}

export interface LoopWatcherDeps {
  config: LoopConfig;
  loadSessions: () => LoopWatcherSession[];
  loadMetadata: () => MetadataState;
  hasPendingInteraction: (sessionId: string) => boolean;
  sendAgentInput: (sessionId: string, text: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * Daemon-side heartbeat. Deterministic and cheap: it only contacts an LLM (the
 * overseer) when there is an actual candidate. With no overseer present it stays
 * observe-only unless autoNudgeWithoutOverseer is enabled.
 */
export class LoopWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private readonly lastNudgeAt = new Map<string, number>();
  private lastOverseerWakeAt = 0;

  constructor(private readonly deps: LoopWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), this.deps.config.scanIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastNudgeAt.clear();
    this.lastOverseerWakeAt = 0;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const metadata = this.deps.loadMetadata();
      const overseerId = findOverseerSessionId(metadata);
      const sessions = this.deps.loadSessions();
      const candidates = findLoopCandidates(sessions, metadata, {
        overseerId,
        hasPendingInteraction: this.deps.hasPendingInteraction,
      });
      if (candidates.length === 0) return;

      const now = (this.deps.now ?? Date.now)();
      const cooldown = this.deps.config.nudgeCooldownMs;
      const overseerRunning = Boolean(overseerId) && sessions.some((session) => session.id === overseerId);

      if (overseerId && overseerRunning) {
        if (now - this.lastOverseerWakeAt < cooldown) return;
        // Only start the cooldown once the briefing actually lands; a failed
        // send must not silence the overseer for a whole cooldown window.
        if (await this.deliver(overseerId, buildOverseerBriefing(candidates))) {
          this.lastOverseerWakeAt = now;
        }
        return;
      }

      if (!this.deps.config.autoNudgeWithoutOverseer) return;
      for (const candidate of candidates) {
        if (now - (this.lastNudgeAt.get(candidate.id) ?? 0) < cooldown) continue;
        if (await this.deliver(candidate.id, buildCannedNudge(candidate))) {
          this.lastNudgeAt.set(candidate.id, now);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async deliver(sessionId: string, text: string): Promise<boolean> {
    try {
      await this.deps.sendAgentInput(sessionId, text);
      return true;
    } catch (error) {
      debug(`loop nudge failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`, "loop");
      return false;
    }
  }
}
