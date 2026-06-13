import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { type ToolConfig } from "./config.js";
import { getContextDir, getHistoryDir, getPlansDir, getStatusDir } from "./paths.js";
import { readHistory } from "./context/history.js";
import { debug, debugPreamble } from "./debug.js";
import { listWorktrees as listAllWorktrees } from "./worktree.js";
import { type TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";
import { type SessionTeamMetadata, buildOverseerPreamble } from "./team.js";

export interface ForkSourceSnapshot {
  historyText?: string;
  liveText?: string;
  planText?: string;
  statusText?: string;
}

export function buildAimuxAgentInstructions(
  opts: { sessionId?: string; includeTeammateCreationInstructions?: boolean } = {},
): string {
  const sessionLine = opts.sessionId ? `Your aimux session ID is ${opts.sessionId}.\n` : "";
  const sessionPath = opts.sessionId ?? "{session-id}";
  const includeTeammates = opts.includeTeammateCreationInstructions !== false;
  const teamCoordinationLine = includeTeammates
    ? "- Do not directly spawn or control other agents unless the user gives an explicit aimux CLI command.\n" +
      "- Do not call aimux metadata APIs from inside an agent unless the user gives an explicit CLI/API command.\n"
    : "- This session is already a teammate; do not create nested teammate teams.\n";
  const delegationProtocol = includeTeammates
    ? "When the user specifically asks for delegation, handoff, or teammate coordination, use explicit aimux CLI/API commands so the runtime exchange records the work. " +
      'For generic delegation or handoff records, create them with `aimux task assign` or the project service task endpoint with `status: "pending"`, `assignedBy`, `description`, `prompt`, and timestamps. '
    : 'For generic delegation or handoff records, create them with `aimux task assign` or the project service task endpoint with `status: "pending"`, `assignedBy`, `description`, `prompt`, and timestamps. ';

  return (
    "You are running inside aimux, an agent multiplexer for this repository. " +
    "Aimux keeps long-lived Claude, Codex, and shell sessions in the main checkout and git worktrees so the user can switch between them, stop/restart them, and coordinate work.\n" +
    sessionLine +
    "\n" +
    "## Aimux Model\n" +
    "- The user controls aimux from the dashboard and tmux status/footer UI.\n" +
    "- Agents are normal tool processes running inside aimux-managed tmux windows.\n" +
    "- Broad cross-agent coordination uses aimux task, handoff, and thread commands backed by the runtime exchange.\n" +
    teamCoordinationLine +
    "\n" +
    "## Shared Context Files\n" +
    `- .aimux/context/${sessionPath}/live.md — recent conversation for this session\n` +
    `- .aimux/context/${sessionPath}/summary.md — compacted history for this session\n` +
    `- .aimux/plans/${sessionPath}.md — optional shared plan for long-running or delegated work\n` +
    `- .aimux/status/${sessionPath}.md — optional brief status note for long-running or delegated work\n` +
    "- .aimux/context/{other-session-id}/ — other agents' context when needed\n" +
    "- .aimux/history/ — full raw conversation history (JSONL)\n" +
    "\n" +
    "Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only inspections, or one-shot tasks. " +
    "Only update those files when the user asks for coordination/delegation, when the task is explicitly long-running, or when state would materially help another agent continue the work.\n" +
    "\n" +
    "## Delegation Protocol\n" +
    delegationProtocol +
    "Optional fields are `assignedTo` for a specific session ID and `tool` for coordination metadata. Treat tasks as shared handoff records for explicit manual coordination flows.\n" +
    "When you accept a task, complete it and mark the task `done` with `result`, or `failed` with `error`."
  );
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
    includeAimuxPreamble?: boolean;
    team?: SessionTeamMetadata;
  }): string {
    const { sessionId, worktreePath, extraPreamble, includeAimuxPreamble = true, team } = opts;
    let preamble = "";

    if (includeAimuxPreamble) {
      preamble = buildAimuxAgentInstructions({
        sessionId,
        includeTeammateCreationInstructions: !team?.parentSessionId,
      });
    }

    if (includeAimuxPreamble) {
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
    }

    if (includeAimuxPreamble && worktreePath) {
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

    if (team?.role === "overseer") {
      preamble += (preamble ? "\n\n" : "") + buildOverseerPreamble();
    }

    if (extraPreamble) {
      preamble += (preamble ? "\n" : "") + extraPreamble;
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
    return Boolean(
      backendSessionId &&
      toolCfg?.resumeArgs?.some((arg) => arg.includes("{sessionId}")) &&
      toolCfg.resumeByBackendSessionId !== false,
    );
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

  buildCodexForkContinuityPreamble(
    sourceSessionId: string,
    targetSessionId: string,
    snapshot: ForkSourceSnapshot,
    instruction?: string,
  ): string {
    const activitySummary = this.summarizeForkSourceActivity(snapshot);
    const summaryPath = join(getContextDir(), targetSessionId, "summary.md");
    const livePath = join(getContextDir(), targetSessionId, "live.md");
    const planPath = join(getPlansDir(), `${targetSessionId}.md`);
    return [
      `This session is a fork of ${sourceSessionId}.`,
      `Read ${summaryPath}, ${livePath}, and ${planPath} first.`,
      "Treat them as real carried-over memory, not fresh-session scaffolding.",
      "Do not start with git archaeology.",
      activitySummary ? `Recent source activity: ${activitySummary}` : undefined,
      instruction?.trim() ? `Instruction: ${instruction.trim()}` : undefined,
      "After reading them, briefly summarize what we were doing and continue from that context.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  buildCodexMigrationContinuityPreamble(
    sessionId: string,
    sourceWorktreePath: string,
    targetWorktreePath: string,
    snapshot: ForkSourceSnapshot,
    instruction?: string,
  ): string {
    const activitySummary = this.summarizeForkSourceActivity(snapshot);
    const summaryPath = join(getContextDir(), sessionId, "summary.md");
    const livePath = join(getContextDir(), sessionId, "live.md");
    const planPath = join(getPlansDir(), `${sessionId}.md`);
    return [
      `This session was migrated from ${sourceWorktreePath} to ${targetWorktreePath}.`,
      `Read ${summaryPath}, ${livePath}, and ${planPath} first.`,
      "Treat them as real carried-over memory, not fresh-session scaffolding.",
      "Do not start with git archaeology.",
      "You are now working from the new worktree.",
      "Re-orient to this worktree before continuing.",
      activitySummary ? `Recent session activity: ${activitySummary}` : undefined,
      instruction?.trim(),
      "After reading them, briefly summarize what we were doing in the new worktree and continue from that context.",
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
}

export function getToolResumeArgs(
  toolCfg: ToolConfig | undefined,
  backendSessionId: string | undefined,
): string[] | undefined {
  if (
    !backendSessionId ||
    !toolCfg?.resumeArgs?.some((arg) => arg.includes("{sessionId}")) ||
    toolCfg.resumeByBackendSessionId === false
  ) {
    return undefined;
  }
  return toolCfg.resumeArgs.map((arg) => arg.replace("{sessionId}", backendSessionId));
}
