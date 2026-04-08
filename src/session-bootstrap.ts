import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { type ToolConfig } from "./config.js";
import { getContextDir, getHistoryDir, getPlansDir, getStatusDir } from "./paths.js";
import { readHistory } from "./context/history.js";
import { debug, debugPreamble } from "./debug.js";
import { listWorktrees as listAllWorktrees } from "./worktree.js";
import { type TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";

export interface ForkSourceSnapshot {
  historyText?: string;
  liveText?: string;
  planText?: string;
  statusText?: string;
}

interface SessionBootstrapDependencies {
  tmuxRuntimeManager: TmuxRuntimeManager;
  getSessionLabel(sessionId: string): string | undefined;
  getSessionRole(sessionId: string): string | undefined;
  getSessionWorktreePath(sessionId: string): string | undefined;
  getSessionTmuxTarget(sessionId: string): TmuxTarget | undefined;
}

export class SessionBootstrapService {
  constructor(private readonly deps: SessionBootstrapDependencies) {}

  buildSessionPreamble(opts: {
    sessionId: string;
    command: string;
    worktreePath?: string;
    extraPreamble?: string;
  }): string {
    const { sessionId, worktreePath, extraPreamble } = opts;
    let preamble =
      "You are running inside aimux, an agent multiplexer. " +
      "Other agents may be working on this codebase simultaneously.\n" +
      `Your session ID is ${sessionId}.\n` +
      `- .aimux/context/${sessionId}/live.md — your recent conversation history\n` +
      `- .aimux/context/${sessionId}/summary.md — your compacted history\n` +
      `- .aimux/plans/${sessionId}.md — your shared working plan\n` +
      "- .aimux/sessions.json — all running agents\n" +
      "- Other agent contexts are in .aimux/context/{their-session-id}/. Check sessions.json for the list.\n" +
      "- Other agent plans are in .aimux/plans/{their-session-id}.md.\n" +
      "- .aimux/history/ — full raw conversation history (JSONL)";

    const globalAimuxMd = join(homedir(), "AIMUX.md");
    const projectAimuxMd = join(process.cwd(), "AIMUX.md");
    for (const mdPath of [globalAimuxMd, projectAimuxMd]) {
      if (!existsSync(mdPath)) continue;
      try {
        const userPreamble = readFileSync(mdPath, "utf-8").trim();
        if (!userPreamble) continue;
        preamble += "\n\n" + userPreamble;
        debug(`loaded ${mdPath} (${userPreamble.length} chars)`, "preamble");
      } catch {
        // Ignore unreadable user preamble files.
      }
    }

    if (worktreePath) {
      try {
        const allWt = listAllWorktrees(worktreePath);
        const thisWt = allWt.find((w) => w.path === worktreePath);
        const mainWt = allWt[0];
        const siblings = allWt
          .filter((w) => w.path !== worktreePath)
          .map((w) => `${w.name} (${w.branch})`)
          .join(", ");
        preamble +=
          `\n\nYou are working in git worktree "${thisWt?.name ?? basename(worktreePath)}" at ${worktreePath} on branch "${thisWt?.branch ?? "unknown"}".` +
          `\nMain repository: ${mainWt?.path ?? "unknown"}.` +
          (siblings ? `\nSibling worktrees: ${siblings}` : "") +
          "\nStay in your worktree directory.";
      } catch {
        preamble += `\n\nYou are working in a git worktree at ${worktreePath}. Stay in this directory.`;
      }
    }

    preamble +=
      "\n\n## Planning\n" +
      "Maintain a plan file at .aimux/plans/" +
      sessionId +
      ".md.\n" +
      "Keep it current enough that other agents can audit, annotate, or continue your work.\n" +
      "Use this structure:\n" +
      "- Goal\n" +
      "- Current Status\n" +
      "- Steps\n" +
      "- Notes\n" +
      "Update it when your plan materially changes or when you complete a step.";

    preamble +=
      "\n\n## Status\n" +
      "Maintain a status file at .aimux/status/" +
      sessionId +
      ".md (3-5 lines max).\n" +
      "Update it whenever your focus changes. Include:\n" +
      "- What you're currently working on\n" +
      "- Key files involved\n" +
      "- Current state (investigating, implementing, testing, blocked, etc.)";

    preamble +=
      "\n\n## Aimux Cross-Agent Delegation\n" +
      "IMPORTANT: This is the aimux delegation system for coordinating work across agents in this multiplexer. " +
      "It is separate from any built-in task/todo features in your own tool.\n\n" +
      "### Delegating work to another agent\n" +
      "When asked to delegate, hand off, or assign work to another agent, create a JSON file:\n" +
      "```\n" +
      ".aimux/tasks/{short-descriptive-name}.json\n" +
      "```\n" +
      "Contents:\n" +
      "```json\n" +
      '{\n  "id": "{same as filename without .json}",\n  "status": "pending",\n' +
      '  "assignedBy": "' +
      sessionId +
      '",\n' +
      '  "description": "Brief summary of the task",\n' +
      '  "prompt": "Detailed instructions for the other agent",\n' +
      '  "createdAt": "{ISO timestamp}",\n  "updatedAt": "{ISO timestamp}"\n}\n' +
      "```\n" +
      "Optional fields: `assignedTo` (target session ID), `tool` (preferred tool type).\n" +
      "Aimux will automatically dispatch pending tasks to idle agents and inject the prompt.\n" +
      "Check .aimux/sessions.json for available agents and their session IDs.\n\n" +
      "### Receiving a delegated task\n" +
      "When you see `[AIMUX TASK ...]` in your input, another agent delegated work to you.\n" +
      "Complete the work, then update the task file:\n" +
      '- Success: set `status` to `"done"` and add a `result` field with a summary\n' +
      '- Failure: set `status` to `"failed"` and add an `error` field\n' +
      "The delegating agent will be notified automatically.";

    if (extraPreamble) {
      preamble += "\n" + extraPreamble;
    }

    return preamble;
  }

  ensurePlanFile(sessionId: string, command: string, worktreePath?: string): void {
    try {
      const plansDir = getPlansDir();
      mkdirSync(plansDir, { recursive: true });
      const planPath = join(plansDir, `${sessionId}.md`);
      if (existsSync(planPath)) return;

      const worktreeLabel = worktreePath ? worktreePath : "main";
      const content =
        `---\n` +
        `sessionId: ${sessionId}\n` +
        `tool: ${command}\n` +
        `worktree: ${worktreeLabel}\n` +
        `updatedAt: ${new Date().toISOString()}\n` +
        `---\n\n` +
        `# Goal\n\n` +
        `TBD\n\n` +
        `# Current Status\n\n` +
        `TBD\n\n` +
        `# Steps\n\n` +
        `- [ ] TBD\n\n` +
        `# Notes\n\n` +
        `- None yet.\n`;
      writeFileSync(planPath, content);
    } catch {
      // Keep session creation resilient even if plan file creation fails.
    }
  }

  composeToolArgs(toolCfg: { args: string[] }, actionArgs: string[], savedArgs: string[] = []): string[] {
    const baseArgs = [...(toolCfg.args ?? [])];
    const trailingArgs =
      baseArgs.length > 0 && savedArgs.length >= baseArgs.length && baseArgs.every((arg, idx) => savedArgs[idx] === arg)
        ? savedArgs.slice(baseArgs.length)
        : [...savedArgs];
    return [...baseArgs, ...actionArgs, ...trailingArgs];
  }

  canResumeWithBackendSessionId(
    toolCfg: { resumeArgs?: string[]; resumeByBackendSessionId?: boolean } | undefined,
    backendSessionId: string | undefined,
  ): boolean {
    return Boolean(backendSessionId && toolCfg?.resumeArgs && toolCfg.resumeByBackendSessionId !== false);
  }

  readForkSourceSnapshot(sourceSessionId: string): ForkSourceSnapshot {
    const historyTurns = readHistory(sourceSessionId, { lastN: 20 });
    const historyText =
      historyTurns.length > 0
        ? historyTurns
            .map((turn) => {
              const prefix =
                turn.type === "prompt"
                  ? "User"
                  : turn.type === "response"
                    ? "Agent"
                    : turn.type === "git"
                      ? "Git"
                      : "Note";
              return `- ${prefix}: ${turn.content}`;
            })
            .join("\n")
        : undefined;

    let liveText = "";
    const sourceTarget = this.deps.getSessionTmuxTarget(sourceSessionId);
    if (sourceTarget) {
      try {
        liveText = this.deps.tmuxRuntimeManager.captureTarget(sourceTarget, { startLine: -160 }).trim();
      } catch {
        // Fall back to live.md.
      }
    }
    if (!liveText) {
      const sourceLivePath = join(getContextDir(), sourceSessionId, "live.md");
      try {
        if (existsSync(sourceLivePath)) {
          liveText = readFileSync(sourceLivePath, "utf-8").trim();
        }
      } catch {
        // Ignore unreadable live context.
      }
    }

    const sourcePlanPath = join(getPlansDir(), `${sourceSessionId}.md`);
    let planText = "";
    try {
      if (existsSync(sourcePlanPath)) {
        const raw = readFileSync(sourcePlanPath, "utf-8")
          .replace(/^---\n[\s\S]*?\n---\n?/, "")
          .trim();
        if (raw && !this.isDefaultPlanContent(raw)) {
          planText = raw;
        }
      }
    } catch {
      // Ignore unreadable plan files.
    }

    const sourceStatusPath = join(getStatusDir(), `${sourceSessionId}.md`);
    let statusText = "";
    try {
      if (existsSync(sourceStatusPath)) {
        statusText = readFileSync(sourceStatusPath, "utf-8").trim();
      }
    } catch {
      // Ignore unreadable status files.
    }

    return {
      historyText: historyText || undefined,
      liveText: liveText || undefined,
      planText: planText || undefined,
      statusText: statusText || undefined,
    };
  }

  summarizeForkSourceActivity(snapshot: ForkSourceSnapshot): string | undefined {
    if (snapshot.statusText?.trim()) {
      return snapshot.statusText.trim();
    }

    const source = snapshot.historyText || snapshot.liveText;
    if (!source) return undefined;

    const lines = source
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !line.startsWith("# ") &&
          !line.startsWith("Updated:") &&
          !line.startsWith("Recent terminal output:") &&
          !line.includes("gpt-5.4 medium") &&
          !line.includes("Opus 4.6") &&
          !line.startsWith("sam@") &&
          !line.startsWith("▐") &&
          !line.startsWith("▝") &&
          !line.startsWith("⏵⏵"),
      );

    const tail = lines.slice(-8);
    if (tail.length === 0) return undefined;
    return tail.join(" ").slice(0, 500);
  }

  buildForkPreamble(sourceSessionId: string, targetSessionId: string): string {
    const sourceLabel = this.deps.getSessionLabel(sourceSessionId) ?? sourceSessionId;
    const sourceRole = this.deps.getSessionRole(sourceSessionId);
    const sourceWorktree = this.deps.getSessionWorktreePath(sourceSessionId);
    const snapshot = this.readForkSourceSnapshot(sourceSessionId);
    const activitySummary = this.summarizeForkSourceActivity(snapshot);

    return [
      "## Aimux Handoff",
      `You are a fork of ${sourceLabel}${sourceRole ? ` (${sourceRole})` : ""}.`,
      `Your new session ID is ${targetSessionId}.`,
      sourceWorktree ? `Source worktree: ${sourceWorktree}` : undefined,
      "",
      "Continue the same line of work using the source agent's carried-over context below.",
      "You are independent now, but should preserve continuity and build on the source agent's progress.",
      "Treat the provided summary, history, and live snapshot as prior context you already know.",
      "Do not describe yourself as a fresh session if any carried-over context is present.",
      "A blank source plan does not mean there was no prior work or interaction.",
      activitySummary ? `\n### Recent Activity Summary\n${activitySummary}` : undefined,
      snapshot.planText ? `\n### Source Plan\n${snapshot.planText}` : undefined,
      snapshot.historyText ? `\n### Recent History\n${snapshot.historyText}` : undefined,
      snapshot.liveText ? `\n### Live Terminal Snapshot\n${snapshot.liveText}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  buildForkKickoffPrompt(
    sourceSessionId: string,
    targetSessionId: string,
    snapshot: ForkSourceSnapshot,
    instruction?: string,
  ): string {
    const activitySummary = this.summarizeForkSourceActivity(snapshot);
    return [
      `This session is a fork of ${sourceSessionId}.`,
      `Read .aimux/context/${targetSessionId}/summary.md, .aimux/context/${targetSessionId}/live.md, and .aimux/plans/${targetSessionId}.md first.`,
      "Treat them as real carried-over memory, not fresh-session scaffolding.",
      "Do not start with git archaeology.",
      activitySummary ? `Recent source activity: ${activitySummary}` : undefined,
      instruction?.trim() ? `Instruction: ${instruction.trim()}` : undefined,
      "After reading them, briefly summarize what we were doing and continue from that context.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  seedForkArtifacts(sourceSessionId: string, targetSessionId: string, targetToolConfigKey: string): void {
    const snapshot = this.readForkSourceSnapshot(sourceSessionId);
    const activitySummary = this.summarizeForkSourceActivity(snapshot);
    const sourceHistoryPath = join(getHistoryDir(), `${sourceSessionId}.jsonl`);
    const targetHistoryPath = join(getHistoryDir(), `${targetSessionId}.jsonl`);
    if (existsSync(sourceHistoryPath) && !existsSync(targetHistoryPath)) {
      copyFileSync(sourceHistoryPath, targetHistoryPath);
    }

    const targetContextDir = join(getContextDir(), targetSessionId);
    mkdirSync(targetContextDir, { recursive: true });

    const sourceStatusPath = join(getStatusDir(), `${sourceSessionId}.md`);
    const targetStatusPath = join(getStatusDir(), `${targetSessionId}.md`);
    if (existsSync(sourceStatusPath) && !existsSync(targetStatusPath)) {
      copyFileSync(sourceStatusPath, targetStatusPath);
    } else if (!existsSync(targetStatusPath) && snapshot.statusText) {
      writeFileSync(targetStatusPath, snapshot.statusText + "\n");
    }

    const targetPlanPath = join(getPlansDir(), `${targetSessionId}.md`);
    const targetWorktree = this.deps.getSessionWorktreePath(sourceSessionId) ?? "main";
    const handoffPlan =
      `---\n` +
      `sessionId: ${targetSessionId}\n` +
      `tool: ${targetToolConfigKey}\n` +
      `worktree: ${targetWorktree}\n` +
      `updatedAt: ${new Date().toISOString()}\n` +
      `---\n\n` +
      `# Goal\n\n` +
      `${snapshot.planText ? "Continue the forked work described below." : `Continue work forked from ${sourceSessionId}.`}\n\n` +
      `# Current Status\n\n` +
      `${snapshot.statusText || activitySummary || "Forked from an existing agent with carried-over context."}\n\n` +
      `# Steps\n\n` +
      `- [ ] Review .aimux/context/${targetSessionId}/summary.md and live.md\n` +
      `- [ ] Continue the forked line of work\n\n` +
      `# Notes\n\n` +
      `- Forked from ${sourceSessionId}\n` +
      (activitySummary ? `- Recent carried-over activity: ${activitySummary}\n` : "") +
      (snapshot.planText ? `- Source plan carried below\n\n## Source Plan\n\n${snapshot.planText}\n` : "");
    writeFileSync(targetPlanPath, handoffPlan);

    const targetLivePath = join(targetContextDir, "live.md");
    if (snapshot.liveText) {
      writeFileSync(targetLivePath, snapshot.liveText + "\n");
    }

    const targetSummaryPath = join(targetContextDir, "summary.md");
    writeFileSync(
      targetSummaryPath,
      [
        `# Forked from ${sourceSessionId}`,
        "",
        `Target session: ${targetSessionId}`,
        "",
        "Treat this file as carried-over prior context from the source session.",
        "Do not describe yourself as a fresh session if this file contains prior interaction.",
        "A blank source plan does not mean there was no prior context.",
        "",
        snapshot.statusText ? `## Source Status\n\n${snapshot.statusText}\n` : "",
        activitySummary ? `## Recent Activity Summary\n\n${activitySummary}\n` : "",
        snapshot.planText ? `## Source Plan\n\n${snapshot.planText}\n` : "",
        snapshot.historyText ? `## Recent History\n\n${snapshot.historyText}\n` : "",
        snapshot.liveText ? `## Live Terminal Snapshot\n\n${snapshot.liveText}\n` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  waitForCodexKickoffSubmit(targetSessionId: string, target: TmuxTarget, kickoff: string): Promise<boolean> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const step = (attempt = 1, lastFingerprint = "") => {
        if (Date.now() - startedAt > 12000 || attempt > 12) {
          debug(`fork kickoff submit: target=${targetSessionId} timeout`, "fork");
          resolve(false);
          return;
        }
        setTimeout(
          () => {
            try {
              const currentTarget = this.deps.getSessionTmuxTarget(targetSessionId);
              if (!currentTarget || currentTarget.windowId !== target.windowId) {
                debug(`fork kickoff submit: target=${targetSessionId} no longer active`, "fork");
                resolve(false);
                return;
              }
              const stillDraft = this.paneStillContainsDraft(target, kickoff);
              const fingerprint = this.capturePaneFingerprint(target);
              const settled = stillDraft && fingerprint.length > 0 && fingerprint === lastFingerprint;
              debug(
                `fork kickoff submit: target=${targetSessionId} attempt=${attempt} stillDraft=${stillDraft ? "yes" : "no"} settled=${settled ? "yes" : "no"} mode=Enter`,
                "fork",
              );
              if (!stillDraft && attempt > 1) {
                resolve(true);
                return;
              }
              if (!settled) {
                step(attempt, fingerprint);
                return;
              }
              const client = this.deps.tmuxRuntimeManager.getAttachedClientForTarget(target);
              if (client) {
                this.deps.tmuxRuntimeManager.switchClientToTarget(client.tty, target);
                this.deps.tmuxRuntimeManager.sendClientCarriageReturn(client.tty, target);
              } else {
                this.deps.tmuxRuntimeManager.sendEnter(target);
              }
              step(attempt + 1, "");
            } catch {
              resolve(false);
            }
          },
          attempt === 1 ? 1200 : 700,
        );
      };
      step();
    });
  }

  finalizePreamble(command: string, preamble: string): void {
    debugPreamble(command, Buffer.byteLength(preamble));
  }

  private isDefaultPlanContent(content: string): boolean {
    const normalized = content.replace(/\r/g, "").trim();
    return (
      normalized.includes("# Goal\n\nTBD") &&
      normalized.includes("# Current Status\n\nTBD") &&
      normalized.includes("# Steps\n\n- [ ] TBD")
    );
  }

  private paneStillContainsDraft(target: TmuxTarget, draft: string): boolean {
    try {
      const pane = this.deps.tmuxRuntimeManager.captureTarget(target, { startLine: -60 });
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizedPane = normalize(pane);
      const expectedFragments = [
        "this session is a fork of",
        "treat them as real carried-over memory",
        "after reading them, briefly summarize",
      ].filter((fragment) => normalize(draft).includes(fragment));
      if (expectedFragments.length === 0) return false;
      return expectedFragments.every((fragment) => normalizedPane.includes(fragment));
    } catch {
      return false;
    }
  }

  private capturePaneFingerprint(target: TmuxTarget): string {
    try {
      const pane = this.deps.tmuxRuntimeManager.captureTarget(target, { startLine: -80 });
      return pane.replace(/\s+/g, " ").trim().slice(-800);
    } catch {
      return "";
    }
  }
}

export function getToolResumeArgs(
  toolCfg: ToolConfig | undefined,
  backendSessionId: string | undefined,
): string[] | undefined {
  if (!backendSessionId || !toolCfg?.resumeArgs || toolCfg.resumeByBackendSessionId === false) {
    return undefined;
  }
  return toolCfg.resumeArgs.map((arg) => arg.replace("{sessionId}", backendSessionId));
}
