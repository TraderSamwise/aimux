import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createFakeEnvironment(state: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "aimux-tmux-control-test-"));
  const binDir = join(root, "bin");
  const projectStateDir = join(root, "project");
  mkdirSync(binDir);
  mkdirSync(projectStateDir);
  const statePath = join(root, "tmux-state.json");
  const logPath = join(root, "tmux-log.jsonl");
  const curlLogPath = join(root, "curl-log.jsonl");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(logPath, "");
  writeFileSync(curlLogPath, "");

  writeExecutable(
    join(binDir, "tmux"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.TMUX_FAKE_STATE;
const logPath = process.env.TMUX_FAKE_LOG;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
function fail() { process.exit(1); }
function out(value) { process.stdout.write(String(value)); }
function listClients() {
  const format = args[2] || "";
  const rows = (state.clients || []).map((client) =>
    format.replace("#{client_tty}", client.tty).replace("#{session_name}", client.sessionName).replace("#{window_id}", client.windowId),
  );
  out(rows.join("\\n"));
}
function listWindows() {
  const all = args.includes("-a");
  const formatIndex = args.indexOf("-F");
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "";
  const targetIndex = args.indexOf("-t");
  const sessionName = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const sessions = all ? Object.entries(state.windows || {}) : [[sessionName, state.windows?.[sessionName] || []]];
  const rows = [];
  for (const [session, windows] of sessions) {
    for (const window of windows || []) {
      rows.push(
        format
          .replace("#{session_name}", session)
          .replace("#{window_index}", String(window.index))
          .replace("#{window_name}", window.name)
          .replace("#{window_id}", window.id),
      );
    }
  }
  out(rows.join("\\n"));
}
function displayMessage() {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const format = args.at(-1) || "";
  const pane = (state.panes || {})[target];
  if (!pane) fail();
  out(
    format
      .replace("#{session_name}", pane.sessionName || "")
      .replace("#{window_id}", pane.windowId || "")
      .replace("#{window_name}", pane.windowName || "")
      .replace("#{client_tty}", pane.clientTty || "")
      .replace("#{pane_current_path}", pane.currentPath || ""),
  );
}
function showOptions() {
  const targetIndex = args.indexOf("-t");
  const session = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const key = args.at(-1);
  const value = state.sessionOptions?.[session]?.[key];
  if (value == null) fail();
  out(value);
}
function showWindowOptions() {
  const targetIndex = args.indexOf("-t");
  const windowId = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const key = args.at(-1);
  if (key !== "@aimux-meta") fail();
  const value = state.windowMetadata?.[windowId];
  if (value == null) fail();
  out(JSON.stringify(value));
}
function findWindow(sessionName, windowId) {
  return (state.windows?.[sessionName] || []).find((window) => window.id === windowId);
}
function linkWindow() {
  const source = args[args.indexOf("-s") + 1];
  const targetSession = args[args.indexOf("-t") + 1];
  let sourceWindow = null;
  for (const windows of Object.values(state.windows || {})) {
    const match = (windows || []).find((window) => window.id === source);
    if (match) {
      sourceWindow = { ...match };
      break;
    }
  }
  if (!sourceWindow) fail();
  state.windows[targetSession] ||= [];
  const windows = state.windows[targetSession];
  if (!windows.find((window) => window.id === sourceWindow.id)) {
    const nextIndex = windows.length ? Math.max(...windows.map((window) => window.index)) + 1 : 0;
    windows.push({ ...sourceWindow, index: nextIndex });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}
function switchClient() {
  const ttyIndex = args.indexOf("-c");
  const tty = ttyIndex >= 0 ? args[ttyIndex + 1] : "";
  const target = args[args.indexOf("-t") + 1];
  const [sessionName, indexText] = target.split(":");
  const window = (state.windows?.[sessionName] || []).find((entry) => String(entry.index) === indexText);
  if (!window) fail();
  const client = (state.clients || []).find((entry) => entry.tty === tty);
  if (!client) fail();
  client.sessionName = sessionName;
  client.windowId = window.id;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
switch (args[0]) {
  case "list-clients": listClients(); break;
  case "list-windows": listWindows(); break;
  case "display-message": displayMessage(); break;
  case "display-menu": break;
  case "display-popup": break;
  case "show-options": showOptions(); break;
  case "show-window-options": showWindowOptions(); break;
  case "link-window": linkWindow(); break;
  case "switch-client": switchClient(); break;
  case "refresh-client": break;
  case "send-keys": break;
  default: fail();
}
`,
  );

  writeExecutable(
    join(binDir, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_FAKE_CURL_LOG"
exit 28
`,
  );

  writeExecutable(
    join(binDir, "aimux"),
    `#!/bin/sh
exit 0
`,
  );

  return {
    root,
    binDir,
    statePath,
    logPath,
    curlLogPath,
    projectStateDir,
  };
}

function runControl(
  envRoot: ReturnType<typeof createFakeEnvironment>,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const scriptPath = join(process.cwd(), "scripts", "tmux-control.sh");
  return execFileSync("sh", [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: `${envRoot.binDir}:${process.env.PATH}`,
      TMUX_FAKE_STATE: envRoot.statePath,
      TMUX_FAKE_LOG: envRoot.logPath,
      TMUX_FAKE_CURL_LOG: envRoot.curlLogPath,
      TMPDIR: envRoot.root,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function readLog(envRoot: ReturnType<typeof createFakeEnvironment>): string[] {
  return readFileSync(envRoot.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
    .map((args) => args.join(" "));
}

function readCurlLog(envRoot: ReturnType<typeof createFakeEnvironment>): string[] {
  return readFileSync(envRoot.curlLogPath, "utf8").trim().split("\n").filter(Boolean);
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("tmux-control.sh", () => {
  it("recovers dashboard switching locally when the endpoint is stale", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-live", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-live": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj-client-live": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-stale",
      "--client-tty",
      "/dev/stale",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-live:0");
    expect(curlLog).toEqual([]);
  });

  it("falls back to host tmux metadata for next when statusline is empty", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-live", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-live": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-live": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "next",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-stale",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-live");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-live:2");
    expect(curlLog).toEqual([]);
  });

  it("hydrates current context from explicit pane id", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-live", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-live": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-live": { "@aimux-project-root": "/repo/project" },
      },
      panes: {
        "%42": {
          sessionName: "aimux-proj-client-live",
          windowId: "@claude",
          windowName: "claude",
          clientTty: "/dev/live",
          currentPath: "/repo/project/worktree",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));

    runControl(
      envRoot,
      [
        "next",
        "--project-state-dir",
        envRoot.projectStateDir,
        "--current-client-session",
        "aimux-proj-client-stale",
        "--client-tty",
        "/dev/stale",
        "--current-window",
        "wrong",
        "--current-window-id",
        "@wrong",
        "--current-path",
        "/wrong/path",
        "--pane-id",
        "%42",
      ],
      { TMUX_PANE: "" },
    );

    const log = readLog(envRoot);
    expect(log).toContain(
      "display-message -p -t %42 #{session_name}|#{window_id}|#{window_name}|#{client_tty}|#{pane_current_path}",
    );
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-live:2");
  });

  it("uses current window worktree when cwd is outside the worktree", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-live", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-live": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-live": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@claude", tmuxWindowIndex: 1, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@codex", tmuxWindowIndex: 6, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@shell", tmuxWindowIndex: 0, kind: "service", worktreePath: "/repo/project/worktree" },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "next",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-stale",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/private/tmp/project-pr5180",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-live");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-live:2");
    expect(curlLog).toEqual([]);
  });

  it("shows the switch menu locally when the endpoint is stale", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-live", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-live": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@shell": {
          sessionId: "service-1",
          kind: "service",
          command: "shell",
          worktreePath: "/repo/project/worktree",
        },
        "@claude": {
          sessionId: "claude-1",
          kind: "agent",
          command: "claude",
          role: "coder",
          worktreePath: "/repo/project/worktree",
        },
        "@codex": {
          sessionId: "codex-1",
          kind: "agent",
          command: "codex",
          role: "coder",
          worktreePath: "/repo/project/worktree",
        },
      },
      sessionOptions: {
        "aimux-proj-client-live": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "last-used.json"),
      JSON.stringify({
        version: 1,
        items: {
          "codex-1": { lastUsedAt: "2026-04-04T00:01:00.000Z" },
          "claude-1": { lastUsedAt: "2026-04-04T00:00:00.000Z" },
        },
        clients: {
          "aimux-proj-client-live": {
            recentIds: ["codex-1", "claude-1"],
            updatedAt: "2026-04-04T00:01:00.000Z",
          },
        },
        projectRecentIds: ["codex-1", "claude-1"],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "menu",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-stale",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-live");
    expect(
      log.some((entry) => entry.includes("display-popup -c /dev/live -T aimux -x P -y P -w 56 -h 10 -E exec")),
    ).toBe(true);
    expect(curlLog).toEqual([]);
  });
});
