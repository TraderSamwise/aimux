import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAimuxAgentInstructions,
  capLaunchPreambleForArgv,
  getToolResumeArgs,
  LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
  SessionBootstrapService,
} from "./session-bootstrap.js";
import { withProjectPaths } from "./paths.js";

const tempRoots: string[] = [];

function tempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aimux-preamble-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

const deps: ConstructorParameters<typeof SessionBootstrapService>[0] = {
  tmuxRuntimeManager: {} as any,
  getSessionLabel: () => undefined,
  getSessionRole: () => undefined,
  getSessionWorktreePath: () => undefined,
  getSessionTmuxTarget: () => undefined,
};

describe("buildAimuxAgentInstructions", () => {
  it("explains aimux without requiring eager bookkeeping writes", () => {
    const instructions = buildAimuxAgentInstructions({ sessionId: "codex-123" });

    expect(instructions).toContain("agent multiplexer");
    expect(instructions).toContain("Claude, Codex, and shell sessions");
    expect(instructions).toContain("Your aimux session ID is codex-123");
    expect(instructions).toContain("runtime exchange");
    expect(instructions).toContain("messages prefixed like `[name]`");
    expect(instructions).toContain("Do not directly spawn or control other agents");
    expect(instructions).toContain("Do not call aimux metadata APIs from inside an agent");
    expect(instructions).toContain("For generic delegation or handoff records");
    expect(instructions).toContain("Treat tasks as shared handoff records");
    expect(instructions).not.toContain("dispatches pending tasks");
    expect(instructions).not.toContain("[AIMUX TASK");
    expect(instructions).not.toContain("aimux metadata endpoint");
    expect(instructions).not.toContain("/agents/teammates");
    expect(instructions).not.toContain("Teammates API");
    expect(instructions).not.toContain("Team lifecycle uses the local metadata teammate API");
    expect(instructions).not.toContain("initialPrompt");
    expect(instructions).not.toContain("sessions.json");
    expect(instructions).toContain("Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*`");
    expect(instructions).not.toContain("Maintain a plan file");
    expect(instructions).not.toContain("Maintain a status file");
  });
});

describe("SessionBootstrapService", () => {
  it("uses the shared aimux instructions in session preambles", () => {
    const service = new SessionBootstrapService(deps);
    const preamble = service.buildSessionPreamble({
      sessionId: "claude-123",
      command: "claude",
      includeAimuxPreamble: true,
    });

    expect(preamble).toContain("Your aimux session ID is claude-123");
    expect(preamble).toContain("Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*`");
    expect(preamble).not.toContain("Maintain a plan file");
  });

  it("does not tell teammate sessions to create nested teammates", () => {
    const service = new SessionBootstrapService(deps);
    const preamble = service.buildSessionPreamble({
      sessionId: "codex-child",
      command: "codex",
      includeAimuxPreamble: true,
      extraPreamble: 'You are a teammate for aimux parent agent "codex-parent".',
      team: {
        teamId: "team-codex-parent",
        parentSessionId: "codex-parent",
        role: "coder",
      },
    });

    expect(preamble).toContain('You are a teammate for aimux parent agent "codex-parent".');
    expect(preamble).toContain("This session is already a teammate; do not create nested teammate teams.");
    expect(preamble).not.toContain("/agents/teammates/create");
    expect(preamble).not.toContain("Reuse existing teammates first");
    expect(preamble).not.toContain("Team lifecycle uses the local metadata teammate API");
  });

  it("injects the overseer preamble for overseer-role sessions only", () => {
    const service = new SessionBootstrapService(deps);
    const overseer = service.buildSessionPreamble({
      sessionId: "claude-boss",
      command: "claude",
      includeAimuxPreamble: true,
      team: { teamId: "overseer", parentSessionId: "", role: "overseer" },
    });
    expect(overseer).toContain("You are the OVERSEER for this aimux project");
    expect(overseer).toContain("[aimux loop check]");
    expect(overseer).toContain('aimux loop add <id> --goal "…"');
    expect(overseer).toContain("Do not keep");
    expect(overseer).toContain("only in your chat context");

    const plain = service.buildSessionPreamble({
      sessionId: "claude-123",
      command: "claude",
      includeAimuxPreamble: true,
    });
    expect(plain).not.toContain("You are the OVERSEER");
  });

  it("requires an explicit session placeholder for backend-id resume", () => {
    const bootstrap = new SessionBootstrapService(deps);

    expect(bootstrap.canResumeWithBackendSessionId({ resumeArgs: ["--resume", "{sessionId}"] }, "backend-1")).toBe(
      true,
    );
    expect(bootstrap.canResumeWithBackendSessionId({ resumeArgs: ["--continue"] }, "backend-1")).toBe(false);
  });
});

describe("getToolResumeArgs", () => {
  it("does not build non-specific resume args for targeted restore", () => {
    expect(getToolResumeArgs({ resumeArgs: ["--resume", "{sessionId}"] } as any, "backend-1")).toEqual([
      "--resume",
      "backend-1",
    ]);
    expect(getToolResumeArgs({ resumeArgs: ["--continue"] } as any, "backend-1")).toBeUndefined();
  });
});

describe("capLaunchPreambleForArgv", () => {
  it("leaves a preamble that already fits the tmux command budget alone", () => {
    const preamble = "## Aimux Handoff\nContinue the forked work.";

    expect(capLaunchPreambleForArgv("claude-fits", preamble)).toBe(preamble);
  });

  it("spills an oversized preamble to a file the agent is told to read", () => {
    const root = tempProjectRoot();
    const preamble = Array.from({ length: 2000 }, (_, index) => `line ${index} of carried-over context`).join("\n");

    const capped = withProjectPaths(root, () => capLaunchPreambleForArgv("claude-fork", preamble));

    const overflowPath = join(root, ".aimux", "context", "claude-fork", "launch-preamble.md");
    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES);
    expect(capped).toContain(overflowPath);
    expect(capped.startsWith("line 0 of carried-over context")).toBe(true);
    expect(readFileSync(overflowPath, "utf-8")).toContain("line 1999 of carried-over context");
  });

  it("truncates even when the overflow file cannot be written", () => {
    const root = tempProjectRoot();
    const notADirectory = join(root, "file-where-a-repo-should-be");
    writeFileSync(notADirectory, "");

    const capped = withProjectPaths(notADirectory, () => capLaunchPreambleForArgv("claude-fork", "x".repeat(40000)));

    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES);
    expect(capped).toContain("[Preamble truncated to fit the terminal launch limit.]");
  });
});

describe("buildForkPreamble", () => {
  it("names the seeded context files instead of inlining them", () => {
    const root = tempProjectRoot();
    const service = new SessionBootstrapService(deps);
    const snapshot = {
      planText: "PLAN ".repeat(4000),
      historyText: "HISTORY ".repeat(4000),
      liveText: "LIVE ".repeat(4000),
      statusText: "Carried status: mid-refactor of the fills read path.",
    };

    const preamble = withProjectPaths(root, () => service.buildForkPreamble("codex-source", "claude-fork", snapshot));

    expect(Buffer.byteLength(preamble, "utf-8")).toBeLessThan(LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES);
    expect(preamble).not.toContain("PLAN PLAN");
    expect(preamble).not.toContain("HISTORY HISTORY");
    expect(preamble).not.toContain("LIVE LIVE");
    expect(preamble).toContain(join(root, ".aimux", "context", "claude-fork", "summary.md"));
    expect(preamble).toContain(join(root, ".aimux", "context", "claude-fork", "live.md"));
    expect(preamble).toContain("Carried status: mid-refactor of the fills read path.");
  });

  it("omits the live snapshot file when the source had no live text", () => {
    const root = tempProjectRoot();
    const service = new SessionBootstrapService(deps);

    const preamble = withProjectPaths(root, () =>
      service.buildForkPreamble("codex-source", "claude-fork", { planText: "small plan" }),
    );

    expect(preamble).toContain(join(root, ".aimux", "context", "claude-fork", "summary.md"));
    expect(preamble).not.toContain(join(root, ".aimux", "context", "claude-fork", "live.md"));
  });
});

describe("summarizeForkSourceActivity", () => {
  it("keeps a carried-over status blurb small enough to ride in the launch argv", () => {
    const service = new SessionBootstrapService(deps);

    const summary = service.summarizeForkSourceActivity({ statusText: "S".repeat(20000) });

    expect(summary).toHaveLength(500);
  });
});

describe("summarizeForkSourceActivity chrome filtering", () => {
  const codexPane = [
    "› commit and push and yolo into master and then master into preview",
    "",
    "• Ran git push origin master",
    "  Pushed:",
    "  - master -> origin/master at bb56e53a83",
    "  Flow was full branch -> master -> preview, no cherry-picks. Both worktrees are clean.",
    "─ Worked for 1m 33s ──────────────────────────────────────────────",
    "",
    "› Summarize recent commits",
    "",
    "  gpt-5.5 high · ~/cs/tealstreet-next/.aimux/worktrees/context-mcp · Main [default]",
  ].join("\n");

  it("drops the composer placeholder and status line below the last rule", () => {
    const service = new SessionBootstrapService(deps);

    const summary = service.summarizeForkSourceActivity({ liveText: codexPane });

    expect(summary).toContain("no cherry-picks");
    expect(summary).not.toContain("Summarize recent commits");
    expect(summary).not.toContain("gpt-5.5 high");
    expect(summary).not.toContain("Worked for 1m 33s");
  });

  it("keeps prompts that sit above the footer", () => {
    const service = new SessionBootstrapService(deps);

    const summary = service.summarizeForkSourceActivity({ liveText: codexPane });

    expect(summary).toContain("commit and push and yolo into master");
  });

  it("drops claude's banner, hint and status chrome without matching on model names", () => {
    const service = new SessionBootstrapService(deps);
    const claudePane = [
      "╭─── Claude Code v2.1.232 ───────────────────────────────╮",
      "│                  Welcome back Sam!                     │",
      "╰────────────────────────────────────────────────────────╯",
      "⏺ Bumped the constant in src/index.ts from 41 to 42.",
      "✻ Brewed for 13s",
      "──────────────────────────────────────────────────────────",
      "❯ ",
      "  sam@MacBook-Pro-4 /Users/sam/cs/aimux master Opus 5 (1M context)",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const summary = service.summarizeForkSourceActivity({ liveText: claudePane });

    expect(summary).toBe("⏺ Bumped the constant in src/index.ts from 41 to 42.");
  });
});
