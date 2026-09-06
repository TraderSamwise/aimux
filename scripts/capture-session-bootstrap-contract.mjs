#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/session-bootstrap/preamble.json", ROOT);
const {
  LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
  SessionBootstrapService,
  buildAimuxAgentInstructions,
  capLaunchPreambleForArgv,
  getToolResumeArgs,
} = await import(new URL("dist/session-bootstrap.js", ROOT));
const { withProjectPaths } = await import(new URL("dist/paths.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const deps = {
  tmuxRuntimeManager: {},
  getSessionLabel: (sessionId) => (sessionId === "codex-source" ? "Source Agent" : undefined),
  getSessionRole: (sessionId) => (sessionId === "codex-source" ? "coder" : undefined),
  getSessionWorktreePath: (sessionId) => (sessionId === "codex-source" ? "/repo/.aimux/worktrees/feature" : undefined),
  getSessionTmuxTarget: () => undefined,
};
const service = new SessionBootstrapService(deps);

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

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `session-bootstrap-preamble-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/session-bootstrap.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function normalizeProjectRoot(value, root) {
  if (typeof value === "string") return value.split(root).join("<projectRoot>");
  if (Array.isArray(value)) return value.map((entry) => normalizeProjectRoot(entry, root));
  if (value && typeof value === "object") {
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeProjectRoot(entry, root)]),
    );
    if (typeof normalized.capped === "string") {
      normalized.cappedByteLength = Buffer.byteLength(normalized.capped, "utf-8");
    }
    return normalized;
  }
  return value;
}
function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `aimux-session-bootstrap-${label}-`));
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

record(
  "builds full aimux agent instructions for ordinary sessions",
  "buildAimuxAgentInstructions",
  { sessionId: "codex-123", includeTeammateCreationInstructions: true },
  buildAimuxAgentInstructions({ sessionId: "codex-123", includeTeammateCreationInstructions: true }),
);
record(
  "builds reduced aimux agent instructions for teammate sessions",
  "buildAimuxAgentInstructions",
  { sessionId: "codex-child", includeTeammateCreationInstructions: false },
  buildAimuxAgentInstructions({ sessionId: "codex-child", includeTeammateCreationInstructions: false }),
);
record(
  "requires an explicit session placeholder for backend-id resume",
  "canResumeWithBackendSessionIdBatch",
  {
    items: [
      { toolCfg: { resumeArgs: ["--resume", "{sessionId}"] }, backendSessionId: "backend-1" },
      { toolCfg: { resumeArgs: ["--continue"] }, backendSessionId: "backend-1" },
      { toolCfg: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: false }, backendSessionId: "backend-1" },
      { toolCfg: { resumeArgs: ["--resume", "{sessionId}"] }, backendSessionId: undefined },
    ],
  },
  [
    service.canResumeWithBackendSessionId({ resumeArgs: ["--resume", "{sessionId}"] }, "backend-1"),
    service.canResumeWithBackendSessionId({ resumeArgs: ["--continue"] }, "backend-1"),
    service.canResumeWithBackendSessionId({ resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: false }, "backend-1"),
    service.canResumeWithBackendSessionId({ resumeArgs: ["--resume", "{sessionId}"] }, undefined),
  ],
);
record(
  "builds only targeted backend resume args",
  "getToolResumeArgsBatch",
  {
    items: [
      { toolCfg: { resumeArgs: ["--resume", "{sessionId}"] }, backendSessionId: "backend-1" },
      { toolCfg: { resumeArgs: ["--continue"] }, backendSessionId: "backend-1" },
      { toolCfg: { resumeArgs: ["resume", "{sessionId}", "--fast"] }, backendSessionId: "codex-backend" },
    ],
  },
  [
    getToolResumeArgs({ resumeArgs: ["--resume", "{sessionId}"] }, "backend-1"),
    getToolResumeArgs({ resumeArgs: ["--continue"] }, "backend-1"),
    getToolResumeArgs({ resumeArgs: ["resume", "{sessionId}", "--fast"] }, "codex-backend"),
  ],
);
record(
  "leaves a preamble that already fits the tmux command budget alone",
  "capLaunchPreambleForArgv",
  { sessionId: "claude-fits", preamble: "## Aimux Handoff\nContinue the forked work.", mode: "fits" },
  {
    capped: capLaunchPreambleForArgv("claude-fits", "## Aimux Handoff\nContinue the forked work."),
    cappedByteLength: Buffer.byteLength(capLaunchPreambleForArgv("claude-fits", "## Aimux Handoff\nContinue the forked work."), "utf-8"),
  },
);
{
  const root = tempRoot("overflow");
  try {
    const preamble = Array.from({ length: 2000 }, (_, index) => `line ${index} of carried-over context`).join("\n");
    const output = withProjectPaths(root, () => {
      const capped = capLaunchPreambleForArgv("claude-fork", preamble);
      const overflowPath = join(root, ".aimux", "context", "claude-fork", "launch-preamble.md");
      return {
        capped,
        cappedByteLength: Buffer.byteLength(capped, "utf-8"),
        overflowPath,
        overflowTextIncludesTail: readFileSync(overflowPath, "utf-8").includes("line 1999 of carried-over context"),
        budget: LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
      };
    });
    record(
      "spills an oversized preamble to a file the agent is told to read",
      "capLaunchPreambleForArgv",
      { sessionId: "claude-fork", preambleLines: 2000, mode: "overflow" },
      normalizeProjectRoot(output, root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = tempRoot("blocked");
  const notADirectory = join(root, "file-where-a-repo-should-be");
  writeFileSync(notADirectory, "");
  try {
    const output = withProjectPaths(notADirectory, () => {
      const capped = capLaunchPreambleForArgv("claude-fork", "x".repeat(40000));
      return {
        capped,
        cappedByteLength: Buffer.byteLength(capped, "utf-8"),
        wroteOverflow: existsSync(join(notADirectory, ".aimux", "context", "claude-fork", "launch-preamble.md")),
        budget: LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
      };
    });
    record(
      "truncates even when the overflow file cannot be written",
      "capLaunchPreambleForArgv",
      { sessionId: "claude-fork", repeat: ["x", 40000], mode: "blocked" },
      normalizeProjectRoot(output, root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
record(
  "summarizes status text before live text",
  "summarizeForkSourceActivity",
  { snapshot: { statusText: "S".repeat(20000), liveText: "ignored" } },
  service.summarizeForkSourceActivity({ statusText: "S".repeat(20000), liveText: "ignored" }),
);
record(
  "drops codex composer placeholder and status line below the last rule",
  "summarizeForkSourceActivity",
  { snapshot: { liveText: codexPane } },
  service.summarizeForkSourceActivity({ liveText: codexPane }),
);
record(
  "keeps prompts that sit above the footer",
  "summarizeForkSourceActivity",
  { snapshot: { liveText: codexPane } },
  service.summarizeForkSourceActivity({ liveText: codexPane }),
);
record(
  "drops claude banner hint and status chrome",
  "summarizeForkSourceActivity",
  { snapshot: { liveText: claudePane } },
  service.summarizeForkSourceActivity({ liveText: claudePane }),
);
{
  const root = tempRoot("fork-preamble");
  try {
    const snapshot = {
      planText: "PLAN ".repeat(4000),
      historyText: "HISTORY ".repeat(4000),
      liveText: "LIVE ".repeat(4000),
      statusText: "Carried status: mid-refactor of the fills read path.",
    };
    const output = withProjectPaths(root, () => service.buildForkPreamble("codex-source", "claude-fork", snapshot));
    record(
      "names the seeded context files instead of inlining them",
      "buildForkPreamble",
      { sourceSessionId: "codex-source", targetSessionId: "claude-fork", snapshot },
      normalizeProjectRoot(output, root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = tempRoot("tool-switch");
  try {
    const snapshot = { statusText: "Ready to switch tools." };
    const output = withProjectPaths(root, () =>
      service.buildToolSwitchContinuityPreamble({
        sessionId: "codex-123",
        sourceTool: "claude",
        targetTool: "codex",
        snapshot,
        instruction: "Use the fixture corpus.",
      }),
    );
    record(
      "builds tool switch continuity preamble",
      "buildToolSwitchContinuityPreamble",
      {
        sessionId: "codex-123",
        sourceTool: "claude",
        targetTool: "codex",
        snapshot,
        instruction: "Use the fixture corpus.",
      },
      normalizeProjectRoot(output, root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = tempRoot("migration");
  try {
    const snapshot = { liveText: "implementation is halfway done" };
    const output = withProjectPaths(root, () =>
      service.buildCodexMigrationContinuityPreamble(
        "codex-123",
        "/repo/old",
        "/repo/new",
        snapshot,
        "Continue from the migration note.",
      ),
    );
    record(
      "builds codex migration continuity preamble",
      "buildCodexMigrationContinuityPreamble",
      {
        sessionId: "codex-123",
        sourceWorktreePath: "/repo/old",
        targetWorktreePath: "/repo/new",
        snapshot,
        instruction: "Continue from the migration note.",
      },
      normalizeProjectRoot(output, root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/session-bootstrap.test.ts",
  generatedBy: "scripts/capture-session-bootstrap-contract.mjs",
  description: "Session bootstrap preamble, resume argument, preamble truncation, and carried context text behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
