#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/statusline-render.json", ROOT);
const { renderTmuxStatuslineFromData } = await import(new URL("dist/tmux/statusline.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const projectRoot = "/repo/aimux";
const freshUpdatedAt = "2099-01-01T00:00:00.000Z";
const staleUpdatedAt = "2000-01-01T00:00:00.000Z";
const baseData = {
  updatedAt: freshUpdatedAt,
  dashboardScreen: "library",
  sessions: [
    {
      id: "coder",
      kind: "agent",
      tool: "codex",
      label: "coder",
      windowName: "codex",
      tmuxWindowId: "@1",
      tmuxWindowIndex: 1,
      role: "coder",
      status: "running",
      active: true,
      headline: "Fix auth flow",
      worktreePath: projectRoot,
      semantic: {
        user: { label: "working", attention: "needs_input" },
        notifications: { unreadCount: 0 },
        presentation: { statusLabel: "needs input", compactHint: "on you" },
      },
    },
    {
      id: "worker",
      kind: "agent",
      tool: "claude",
      label: "worker",
      windowName: "claude",
      tmuxWindowId: "@2",
      tmuxWindowIndex: 2,
      status: "idle",
      worktreePath: projectRoot,
      semantic: {
        user: { label: "done", attention: "normal" },
        notifications: { unreadCount: 0 },
        presentation: { statusLabel: "done" },
      },
    },
    {
      id: "svc",
      kind: "service",
      tool: "shell",
      label: "web",
      launchCommandLine: "yarn dev",
      windowName: "web",
      tmuxWindowId: "@3",
      tmuxWindowIndex: 3,
      status: "running",
      worktreePath: projectRoot,
    },
    {
      id: "boss",
      kind: "agent",
      tool: "claude",
      label: "claude-overseer",
      windowName: "claude",
      tmuxWindowId: "@4",
      tmuxWindowIndex: 4,
      role: "coder",
      status: "idle",
      worktreePath: projectRoot,
      overseer: true,
    },
  ],
  teammates: [
    {
      id: "teammate-a",
      kind: "agent",
      tool: "codex",
      label: "reviewer",
      windowName: "codex",
      tmuxWindowId: "@5",
      tmuxWindowIndex: 5,
      status: "running",
      worktreePath: projectRoot,
      team: { parentSessionId: "coder", role: "reviewer", order: 1 },
      semantic: {
        user: { label: "idle", attention: "normal" },
        notifications: { unreadCount: 0 },
        presentation: { statusLabel: "idle" },
      },
    },
  ],
  metadata: {
    coder: {
      context: {
        worktreeName: "aimux",
        branch: "rust-translation-v1",
        pr: { number: 123, url: "https://github.com/example/aimux/pull/123" },
      },
      derived: {
        activity: "running",
        attention: "needs_input",
        unseenCount: 3,
        services: [{ port: 3000, url: "http://localhost:3000" }],
      },
      statusline: {
        top: [{ id: "transcript", text: "80kb", tone: "info" }],
        bottom: [{ id: "transcript", text: "80kb", tone: "success" }],
      },
    },
  },
  tasks: { pending: 2, assigned: 1 },
  controlPlane: { daemonAlive: true, projectServiceAlive: true },
};

const cases = [];
function record(name, line, options, data = baseData) {
  const input = { name, data, projectRoot, line, options };
  cases.push({
    id: `tmux-statusline-render-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/statusline.ts",
    api: "renderTmuxStatuslineFromData",
    input,
    output: {
      text: renderTmuxStatuslineFromData(data, projectRoot, line, options),
    },
    inputSha256: hash(input),
  });
}

record("renders full top statusline with active metadata and plugin segment", "top", {
  currentWindow: "codex",
  currentWindowId: "@1",
  currentPath: projectRoot,
  currentSession: "aimux-repo",
  width: 220,
});
record("trims top statusline to available width", "top", {
  currentWindow: "codex",
  currentWindowId: "@1",
  currentPath: projectRoot,
  currentSession: "aimux-repo",
  width: 60,
});
record("renders dashboard footer tabs with width-aware selection", "bottom", {
  currentWindow: "dashboard",
  currentPath: projectRoot,
  currentSession: "aimux-repo-client-live",
  width: 62,
});
record("renders scoped footer chips with headline teammate and plugin detail", "bottom", {
  currentWindow: "codex",
  currentWindowId: "@1",
  currentPath: projectRoot,
  currentSession: "aimux-repo",
  width: 220,
});
record("omits detail when scoped footer chips fill narrow width", "bottom", {
  currentWindow: "codex",
  currentWindowId: "@1",
  currentPath: projectRoot,
  currentSession: "aimux-repo",
  width: 58,
});
record("renders active overseer footer classification", "bottom", {
  currentWindow: "claude",
  currentWindowId: "@4",
  currentPath: projectRoot,
  currentSession: "aimux-repo",
  width: 220,
});
record(
  "renders stale control-plane status",
  "top",
  {
    currentWindow: "codex",
    currentWindowId: "@1",
    currentPath: projectRoot,
    width: 220,
  },
  { ...baseData, updatedAt: staleUpdatedAt },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-statusline-render-contract.mjs",
  source: "src/tmux/statusline.ts",
  subject: "src/tmux/statusline.ts",
  description: "tmux statusline rendering captured from TypeScript renderTmuxStatuslineFromData.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
