import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

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
  const aimuxLogPath = join(root, "aimux-log.txt");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(logPath, "");
  writeFileSync(curlLogPath, "");
  writeFileSync(aimuxLogPath, "");

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
          .replace("#{window_id}", window.id)
          .replace("#{pane_dead}", state.deadWindows?.includes(window.id) ? "1" : "0"),
      );
    }
  }
  out(rows.join("\\n"));
}
function displayMessage() {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const format = args.at(-1) || "";
  if (format === "#{pane_dead}") {
    const exists = Object.values(state.windows || {}).some((windows) =>
      (windows || []).some((window) => window.id === target),
    );
    if (!exists) fail();
    out(state.deadWindows?.includes(target) ? "1" : "0");
    return;
  }
  const pane = (state.panes || {})[target];
  if (!pane) fail();
  out(
    format
      .replace("#{pane_in_mode}", pane.inMode ? "1" : "0")
      .replace("#{pane_current_command}", pane.currentCommand || "")
      .replace("#{session_name}", pane.sessionName || "")
      .replace("#{window_id}", pane.windowId || "")
      .replace("#{window_name}", pane.windowName || "")
      .replace("#{client_tty}", pane.clientTty || "")
      .replace("#{pane_current_path}", pane.currentPath || ""),
  );
}
function capturePane() {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : "";
  const content = (state.capturedPanes || {})[target];
  if (content == null) {
    out("");
    return;
  }
  out(content);
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
  const value =
    key === "@aimux-meta" ? state.windowMetadata?.[windowId] && JSON.stringify(state.windowMetadata[windowId]) : state.windowOptions?.[windowId]?.[key];
  if (value == null) fail();
  out(value);
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
  case "capture-pane": capturePane(); break;
  case "display-menu": break;
  case "display-popup": break;
  case "new-window": break;
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
printf '%s|%s\\n' "$PWD" "$*" >> "$TMUX_FAKE_AIMUX_LOG"
exit 0
`,
  );

  return {
    root,
    binDir,
    statePath,
    logPath,
    curlLogPath,
    aimuxLogPath,
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
      TMUX_FAKE_AIMUX_LOG: envRoot.aimuxLogPath,
      AIMUX_BIN: join(envRoot.binDir, "aimux"),
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

function readCurlLogEventually(envRoot: ReturnType<typeof createFakeEnvironment>): string[] {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = readCurlLog(envRoot);
    if (lines.length) return lines;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return [];
}

function readAimuxLog(envRoot: ReturnType<typeof createFakeEnvironment>): string[] {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = readFileSync(envRoot.aimuxLogPath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) return lines;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return [];
}

function expectDashboardReloadRequest(envRoot: ReturnType<typeof createFakeEnvironment>): void {
  const curlLog = readCurlLogEventually(envRoot);
  expect(curlLog).toHaveLength(1);
  expect(curlLog[0]).toContain("--data-binary");
  expect(curlLog[0]).toContain('"forceReload": true');
  expect(curlLog[0]).toContain('"focus": true');
  expect(curlLog[0]).toContain("http://127.0.0.1:43444/control/open-dashboard");
  expect(readAimuxLog(envRoot)).toEqual([]);
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("tmux-control.sh", () => {
  it("rejects a dashboard pane that already contains the failed-start screen", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
      },
      capturedPanes: {
        "@dash": "aimux dashboard failed to start.\nPress q, Enter, or Ctrl+C to close this pane.\n",
      },
    });
    tempRoots.push(envRoot.root);
    const projectRoot = join(envRoot.root, "repo-project");
    mkdirSync(projectRoot);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
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
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(false);
    expectDashboardReloadRequest(envRoot);
  });

  it("does not use the current-session fast dashboard path for a failed-start pane", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
      },
      capturedPanes: {
        "@dash": "aimux dashboard failed to start.\nPress q, Enter, or Ctrl+C to close this pane.\n",
      },
    });
    tempRoots.push(envRoot.root);
    const projectRoot = join(envRoot.root, "repo-project");
    mkdirSync(projectRoot);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(false);
    expectDashboardReloadRequest(envRoot);
  });

  it("does not strip project session names that merely contain client", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-client-api-1234567890", windowId: "@shell" }],
      windows: {
        "aimux-client-api-1234567890": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      panes: {
        "@dash": {
          sessionName: "aimux-client-api-1234567890",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
        "@shell": {
          sessionName: "aimux-client-api-1234567890",
          windowId: "@shell",
          windowName: "shell",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
        },
      },
      sessionOptions: {
        "aimux-client-api-1234567890": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-project-state-dir": "/state/project",
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-client-api-1234567890",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("show-options -v -t aimux-client-api-1234567890 @aimux-project-root");
    expect(log).not.toContain("show-options -v -t aimux @aimux-project-root");
    expect(log).toContain("switch-client -c /dev/live -t aimux-client-api-1234567890:0");
  });

  it("keeps metadata navigation on project sessions that merely contain client", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-client-api-1234567890", windowId: "@shell" }],
      windows: {
        "aimux-client-api-1234567890": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@codex", index: 1, name: "codex" },
        ],
      },
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project" },
      },
      sessionOptions: {
        "aimux-client-api-1234567890": {
          "@aimux-project-root": "/repo/project",
          "@aimux-project-state-dir": "/state/project",
        },
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
      "aimux-client-api-1234567890",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain(
      "list-windows -t aimux-client-api-1234567890 -F #{window_id}|#{window_index}|#{window_name}|#{pane_dead}",
    );
    expect(log).not.toContain("list-windows -t aimux -F #{window_id}|#{window_index}|#{window_name}|#{pane_dead}");
    expect(log).toContain("switch-client -c /dev/live -t aimux-client-api-1234567890:1");
  });

  it("switches dashboard locally before trying the control API", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      "/repo/project",
      "--current-client-session",
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(curlLog).toEqual([]);
  });

  it("validates client dashboard project root from the host session", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("show-options -v -t aimux-proj @aimux-project-root");
    expect(log).not.toContain("show-options -v -t aimux-proj-client-1234abcd @aimux-project-root");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(readAimuxLog(envRoot)).toEqual([]);
  });

  it("reloads instead of switching to a stale-build dashboard", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-control-project-"));
    tempRoots.push(projectRoot);
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": projectRoot,
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-old",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: projectRoot,
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      projectRoot,
    ]);

    const log = readLog(envRoot);
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expectDashboardReloadRequest(envRoot);
  });

  it("reloads instead of switching to a dashboard without a current readiness stamp", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-control-project-"));
    tempRoots.push(projectRoot);
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": projectRoot,
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-owner": "owner-current",
          "@aimux-dashboard-ready": "build-old",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: projectRoot,
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      projectRoot,
    ]);

    const log = readLog(envRoot);
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expectDashboardReloadRequest(envRoot);
  });

  it("reloads instead of switching to a dashboard with missing build metadata", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-control-project-"));
    tempRoots.push(projectRoot);
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": projectRoot,
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: projectRoot,
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      projectRoot,
    ]);

    const log = readLog(envRoot);
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expectDashboardReloadRequest(envRoot);
  });

  it("opens coordination by switching to the dashboard instead of showing a popup", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-control-project-"));
    tempRoots.push(projectRoot);
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": projectRoot,
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": projectRoot,
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: projectRoot,
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), `${projectRoot}\n`);

    runControl(envRoot, [
      "coordination",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      projectRoot,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      projectRoot,
    ]);

    const log = readLog(envRoot);
    const clientState = JSON.parse(
      readFileSync(join(envRoot.projectStateDir, "dashboard-ui-client-aimux-proj-client-1234abcd.json"), "utf8"),
    ) as { screen?: string };
    expect(clientState.screen).toBe("coordination");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(log.some((entry) => entry.startsWith("display-popup"))).toBe(false);
  });

  it("does not reload dashboard for ordinary validation misses", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-stale",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-stale",
        },
      },
      panes: {
        "@dash": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@dash",
          windowName: "dashboard-live",
          clientTty: "/dev/live",
          currentPath: "/repo/project",
          currentCommand: "bash",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--project-root",
      "/repo/project",
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    expect(readLog(envRoot)).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(readAimuxLog(envRoot)).toEqual([]);
  }, 30_000);

  it("hydrates project context from the host session for global prefix bindings", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-project-state-dir": "/repo/project/.aimux-state",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);

    runControl(envRoot, [
      "dashboard",
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("show-options -v -t aimux-proj @aimux-project-root");
    expect(log).toContain("show-options -v -t aimux-proj @aimux-project-state-dir");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(curlLog).toEqual([]);
  });

  it("keeps dashboard switching local when no endpoint is available", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@shell", index: 3, name: "shell" },
        ],
      },
      sessionOptions: {
        "aimux-proj": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
        "aimux-proj-client-1234abcd": {
          "@aimux-project-root": "/repo/project",
          "@aimux-runtime-owner": "owner-current",
        },
      },
      windowOptions: {
        "@dash": {
          "@aimux-dashboard-build": "build-current",
          "@aimux-dashboard-ready": "build-current",
          "@aimux-dashboard-owner": "owner-current",
        },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "dashboard",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:0");
    expect(curlLog).toEqual([]);
  });

  it("fails fast locally instead of falling through to the control API", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {},
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");

    runControl(envRoot, [
      "next",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/stale",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(curlLog).toEqual([]);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("falls back to host tmux metadata for next when statusline is empty", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
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
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(curlLog).toEqual([]);
  });

  it("does not match sibling worktree path prefixes in host tmux metadata fallback", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@current" }],
      windows: {
        "aimux-proj": [{ id: "@wrong", index: 2, name: "wrong" }],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@current", index: 1, name: "current" },
        ],
      },
      windowMetadata: {
        "@wrong": { sessionId: "wrong-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "current",
      "--current-window-id",
      "@current",
      "--current-path",
      "/repo/project/worktree2",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(curlLog).toEqual([]);
    expect(log).not.toContain("link-window -d -s @wrong -t aimux-proj-client-1234abcd");
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("skips dead host tmux metadata candidates for next", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      deadWindows: ["@codex"],
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(existsSync(join(envRoot.projectStateDir, "last-used.json"))).toBe(false);
  });

  it("uses a dead current host window only for next ordering", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@codex" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@codex", index: 6, name: "codex" },
        ],
      },
      deadWindows: ["@codex"],
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "codex",
      "--current-window-id",
      "@codex",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const state = JSON.parse(readFileSync(envRoot.statePath, "utf8")) as {
      clients: Array<{ windowId: string }>;
    };
    expect(log).toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
    expect(state.clients[0]?.windowId).toBe("@shell");
    expect(log).not.toContain("link-window -d -s @claude -t aimux-proj-client-1234abcd");
  });

  it("does not use stale statusline windows for next/prev ordering", () => {
    const buildEnv = () => {
      const envRoot = createFakeEnvironment({
        clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@codex" }],
        windows: {
          "aimux-proj-client-1234abcd": [
            { id: "@dash", index: 0, name: "dashboard-live" },
            { id: "@codex", index: 6, name: "codex" },
          ],
          "aimux-proj": [
            { id: "@shell", index: 0, name: "shell" },
            { id: "@claude", index: 1, name: "claude" },
            { id: "@codex", index: 6, name: "codex" },
          ],
        },
        deadWindows: ["@codex"],
        sessionOptions: {
          "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
        },
        panes: {},
      });
      tempRoots.push(envRoot.root);
      writeFileSync(
        join(envRoot.projectStateDir, "statusline.json"),
        JSON.stringify({
          sessions: [
            { tmuxWindowId: "@shell", tmuxWindowIndex: 0, kind: "service", worktreePath: "/repo/project/worktree" },
            { tmuxWindowId: "@claude", tmuxWindowIndex: 1, kind: "agent", worktreePath: "/repo/project/worktree" },
            { tmuxWindowId: "@codex", tmuxWindowIndex: 6, kind: "agent", worktreePath: "/repo/project/worktree" },
          ],
        }),
      );
      writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
      writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");
      return envRoot;
    };

    const nextEnv = buildEnv();
    runControl(nextEnv, [
      "next",
      "--project-state-dir",
      nextEnv.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "codex",
      "--current-window-id",
      "@codex",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const nextLog = readLog(nextEnv);
    const nextState = JSON.parse(readFileSync(nextEnv.statePath, "utf8")) as {
      clients: Array<{ windowId: string }>;
    };
    expect(nextLog.some((line) => line.includes("no local tmux target available"))).toBe(true);
    expect(nextState.clients[0]?.windowId).toBe("@codex");
    expect(nextLog).not.toContain("link-window -d -s @claude -t aimux-proj-client-1234abcd");

    const prevEnv = buildEnv();
    runControl(prevEnv, [
      "prev",
      "--project-state-dir",
      prevEnv.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "codex",
      "--current-window-id",
      "@codex",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const prevLog = readLog(prevEnv);
    const prevState = JSON.parse(readFileSync(prevEnv.statePath, "utf8")) as {
      clients: Array<{ windowId: string }>;
    };
    expect(prevLog.some((line) => line.includes("no local tmux target available"))).toBe(true);
    expect(prevState.clients[0]?.windowId).toBe("@codex");
    expect(prevLog).not.toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
  });

  it("does not use stale statusline attention candidates", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [{ id: "@shell", index: 0, name: "shell" }],
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
      },
      deadWindows: ["@codex"],
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          {
            tmuxWindowId: "@codex",
            tmuxWindowIndex: 6,
            kind: "agent",
            worktreePath: "/repo/project/worktree",
            semantic: { waitingOnMeCount: 3, unreadCount: 9, blockedCount: 2, pendingDeliveryCount: 1 },
          },
          {
            tmuxWindowId: "@claude",
            tmuxWindowIndex: 1,
            kind: "agent",
            worktreePath: "/repo/project/worktree",
            semantic: { waitingOnMeCount: 1, unreadCount: 1 },
          },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "attention",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @claude -t aimux-proj-client-1234abcd");
    expect(readCurlLog(envRoot)).toEqual([]);
  });

  it("does not jump to statusline-only window candidates", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj-client-1234abcd": [{ id: "@shell", index: 0, name: "shell" }],
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
      },
      deadWindows: ["@codex"],
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@codex", tmuxWindowIndex: 0, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@claude", tmuxWindowIndex: 1, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@shell", tmuxWindowIndex: 2, kind: "service", worktreePath: "/repo/project/worktree" },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "window",
      "--index",
      "1",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @claude -t aimux-proj-client-1234abcd");
    expect(readCurlLog(envRoot)).toEqual([]);
  });

  it("falls through to the control API for dead explicit local targets", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      deadWindows: ["@codex"],
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "window",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--window-id",
      "@codex",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(curlLog).toEqual([]);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("hydrates current context from explicit pane id", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {
        "%42": {
          sessionName: "aimux-proj-client-1234abcd",
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
        "aimux-proj-client-deadbeef",
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
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
  });

  it("prefers the pane-owned live client when multiple clients share the same window", () => {
    const envRoot = createFakeEnvironment({
      clients: [
        { tty: "/dev/right", sessionName: "aimux-proj-client-11111111", windowId: "@claude" },
        { tty: "/dev/wrong", sessionName: "aimux-proj-client-22222222", windowId: "@claude" },
      ],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-11111111": [
          { id: "@dash-right", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
        "aimux-proj-client-22222222": [
          { id: "@dash-wrong", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-11111111": { "@aimux-project-root": "/repo/project" },
        "aimux-proj-client-22222222": { "@aimux-project-root": "/repo/project" },
      },
      panes: {
        "%42": {
          sessionName: "aimux-proj-client-11111111",
          windowId: "@claude",
          windowName: "claude",
          clientTty: "/dev/right",
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
        "aimux-proj-client-deadbeef",
        "--client-tty",
        "/dev/wrong",
        "--current-window",
        "wrong",
        "--current-window-id",
        "@claude",
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
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-11111111");
    expect(log).toContain("switch-client -c /dev/right -t aimux-proj-client-11111111:2");
    expect(log).not.toContain("switch-client -c /dev/wrong -t aimux-proj-client-22222222:2");
  });

  it("uses current window worktree when cwd is outside the worktree", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
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
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(curlLog).toEqual([]);
  });

  it("prefers live tmux metadata order over stale statusline order for next/prev", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
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
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@codex", tmuxWindowIndex: 1, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@claude", tmuxWindowIndex: 6, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@shell", tmuxWindowIndex: 99, kind: "service", worktreePath: "/repo/project/worktree" },
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
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
  });

  it("jumps to the rendered chip index using live tmux metadata order", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
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
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@shell", tmuxWindowIndex: 0, kind: "service", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@codex", tmuxWindowIndex: 1, kind: "agent", worktreePath: "/repo/project/worktree" },
          { tmuxWindowId: "@claude", tmuxWindowIndex: 6, kind: "agent", worktreePath: "/repo/project/worktree" },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "window",
      "--index",
      "2",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
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
    expect(log).toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
  });

  it("ranks underscore attention metadata for prefix attention jumps", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@shell" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 2, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@shell", index: 0, name: "shell" }],
      },
      windowMetadata: {
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
        "@claude": {
          sessionId: "claude-1",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          attention: "needs_input",
        },
        "@codex": {
          sessionId: "codex-1",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          unseenCount: 9,
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));

    runControl(envRoot, [
      "attention",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "shell",
      "--current-window-id",
      "@shell",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @claude -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
  });

  it("rejects out-of-range window index jumps with a friendly message, not a raw error", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@claude", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    // The bad jump is rejected without surfacing tmux's raw "returned N" error (exit 0),
    // and no window switch is performed.
    expect(() =>
      runControl(envRoot, [
        "window",
        "--index",
        "9",
        "--project-state-dir",
        envRoot.projectStateDir,
        "--current-client-session",
        "aimux-proj-client-deadbeef",
        "--client-tty",
        "/dev/live",
        "--current-window",
        "claude",
        "--current-window-id",
        "@claude",
        "--current-path",
        "/repo/project/worktree",
      ]),
    ).not.toThrow();

    const log = readLog(envRoot);
    expect(log.some((line) => line.startsWith("switch-client"))).toBe(false);
    expect(log.some((line) => line.includes("couldn't switch window"))).toBe(true);
  });

  it("reports a friendly message when prev cannot reach the runtime", () => {
    const envRoot = createFakeEnvironment({
      clients: [],
      windows: {},
      windowMetadata: {},
      sessionOptions: {},
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    let output = "";
    expect(() => {
      output = runControl(envRoot, [
        "prev",
        "--project-state-dir",
        envRoot.projectStateDir,
        "--current-client-session",
        "aimux-proj-client-1234abcd",
        "--client-tty",
        "/dev/live",
        "--current-window",
        "dashboard",
        "--current-window-id",
        "@dash",
        "--current-path",
        "/repo/project",
      ]);
    }).not.toThrow();

    // No raw "returned N" leak: clean exit, plus a styled aimux message.
    expect(output).toBe("");
    const log = readLog(envRoot);
    expect(log.some((line) => line.includes("aimux") && line.includes("couldn't switch window"))).toBe(true);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("reports the runtime as unavailable when no endpoint file exists", () => {
    const envRoot = createFakeEnvironment({
      clients: [],
      windows: {},
      windowMetadata: {},
      sessionOptions: {},
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));
    // No metadata-api.txt: the runtime endpoint is unknown, not merely unresponsive.

    let output = "";
    expect(() => {
      output = runControl(envRoot, [
        "prev",
        "--project-state-dir",
        envRoot.projectStateDir,
        "--current-client-session",
        "aimux-proj-client-1234abcd",
        "--client-tty",
        "/dev/live",
        "--current-window",
        "dashboard",
        "--current-window-id",
        "@dash",
        "--current-path",
        "/repo/project",
      ]);
    }).not.toThrow();

    expect(output).toBe("");
    const log = readLog(envRoot);
    expect(log.some((line) => line.includes("couldn't switch window"))).toBe(true);
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("keeps next scoped to main checkout items when current window has no explicit worktree path", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@main-agent" }],
      windows: {
        "aimux-proj": [
          { id: "@dash", index: 0, name: "dashboard" },
          { id: "@main-agent", index: 1, name: "codex" },
          { id: "@main-shell", index: 2, name: "shell" },
          { id: "@other-agent", index: 3, name: "claude" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@main-agent", index: 1, name: "codex" },
        ],
      },
      windowMetadata: {
        "@main-agent": { sessionId: "codex-main", kind: "agent" },
        "@main-shell": { sessionId: "service-main", kind: "service" },
        "@other-agent": {
          sessionId: "claude-other",
          kind: "agent",
          worktreePath: "/repo/project/.claude/worktrees/other",
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@main-agent", tmuxWindowIndex: 1, kind: "agent" },
          { tmuxWindowId: "@main-shell", tmuxWindowIndex: 2, kind: "service" },
          {
            tmuxWindowId: "@other-agent",
            tmuxWindowIndex: 3,
            kind: "agent",
            worktreePath: "/repo/project/.claude/worktrees/other",
          },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "next",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "codex",
      "--current-window-id",
      "@main-agent",
      "--current-path",
      "/repo/project",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @main-shell -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @other-agent -t aimux-proj-client-1234abcd");
  });

  it("does not match sibling worktree path prefixes from stale statusline data", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@current" }],
      windows: {
        "aimux-proj": [{ id: "@wrong", index: 2, name: "wrong" }],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@current", index: 1, name: "current" },
        ],
      },
      windowMetadata: {},
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [
          { tmuxWindowId: "@wrong", tmuxWindowIndex: 2, kind: "agent", worktreePath: "/repo/project/worktree" },
        ],
      }),
    );
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "next",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "current",
      "--current-window-id",
      "@current",
      "--current-path",
      "/repo/project/worktree2",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(curlLog).toEqual([]);
    expect(log).not.toContain("link-window -d -s @wrong -t aimux-proj-client-1234abcd");
    expect(log.some((line) => line.includes("no local tmux target available"))).toBe(true);
  });

  it("switches from a focused parent agent to its first teammate in statusline order", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@reviewer", index: 7, name: "codex" },
          { id: "@coder", index: 8, name: "claude" },
          { id: "@other", index: 9, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@reviewer": {
          sessionId: "reviewer",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
        },
        "@coder": {
          sessionId: "coder",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
        },
        "@other": {
          sessionId: "other",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-2", parentSessionId: "other-parent", role: "coder", order: 0 },
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [{ id: "parent", tmuxWindowId: "@parent", kind: "agent", worktreePath: "/repo/project/worktree" }],
        teammates: [
          {
            id: "coder",
            tmuxWindowId: "@coder",
            kind: "agent",
            createdAt: "2026-04-04T00:00:00.000Z",
            team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
          },
          {
            id: "reviewer",
            tmuxWindowId: "@reviewer",
            kind: "agent",
            createdAt: "2026-04-04T00:01:00.000Z",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
          },
          {
            id: "other",
            tmuxWindowId: "@other",
            kind: "agent",
            team: { teamId: "team-2", parentSessionId: "other-parent", role: "coder", order: 0 },
          },
        ],
      }),
    );

    runControl(envRoot, [
      "team",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@parent",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("link-window -d -s @reviewer -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(log).not.toContain("link-window -d -s @other -t aimux-proj-client-1234abcd");
    expect(curlLog).toEqual([]);
  });

  it("skips dead statusline teammates in team order", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@reviewer", index: 7, name: "codex" },
          { id: "@coder", index: 8, name: "claude" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      deadWindows: ["@reviewer"],
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@reviewer": {
          sessionId: "reviewer",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
        },
        "@coder": {
          sessionId: "coder",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [{ id: "parent", tmuxWindowId: "@parent", kind: "agent", worktreePath: "/repo/project/worktree" }],
        teammates: [
          {
            id: "reviewer",
            tmuxWindowId: "@reviewer",
            kind: "agent",
            createdAt: "2026-04-04T00:01:00.000Z",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
          },
          {
            id: "coder",
            tmuxWindowId: "@coder",
            kind: "agent",
            createdAt: "2026-04-04T00:00:00.000Z",
            team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
          },
        ],
      }),
    );

    runControl(envRoot, [
      "team",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@parent",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @coder -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(log).not.toContain("link-window -d -s @reviewer -t aimux-proj-client-1234abcd");
  });

  it("switches from a focused parent agent to its first live teammate from tmux metadata", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@reviewer", index: 7, name: "codex" },
          { id: "@coder", index: 8, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@reviewer": {
          sessionId: "reviewer",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
        },
        "@coder": {
          sessionId: "coder",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [{ id: "parent", tmuxWindowId: "@parent", kind: "agent", worktreePath: "/repo/project/worktree" }],
        teammates: [
          {
            id: "coder",
            kind: "agent",
            team: { teamId: "team-1", parentSessionId: "parent", role: "coder", order: 2 },
          },
          {
            id: "reviewer",
            kind: "agent",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
          },
        ],
      }),
    );

    runControl(envRoot, [
      "team",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@parent",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @reviewer -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
  });

  it("switches to live teammates across worktree paths", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@reviewer", index: 7, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree-a" },
        "@reviewer": {
          sessionId: "reviewer",
          kind: "agent",
          worktreePath: "/repo/project/worktree-b",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 1 },
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));

    runControl(envRoot, [
      "team",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@parent",
      "--current-path",
      "/repo/project/worktree-a",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @reviewer -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
  });

  it("keeps next/prev in the parent plane instead of entering live teammates", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@teammate", index: 2, name: "codex" },
          { id: "@shell", index: 3, name: "shell" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@teammate": {
          sessionId: "teammate",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", order: 0 },
        },
        "@shell": { sessionId: "service-1", kind: "service", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "statusline.json"), JSON.stringify({ sessions: [] }));

    runControl(envRoot, [
      "next",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@parent",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    expect(log).toContain("link-window -d -s @shell -t aimux-proj-client-1234abcd");
    expect(log).not.toContain("link-window -d -s @teammate -t aimux-proj-client-1234abcd");
  });

  it("switches from a focused teammate back to its recorded parent", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@teammate" }],
      windows: {
        "aimux-proj": [
          { id: "@parent", index: 1, name: "claude" },
          { id: "@teammate", index: 7, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [{ id: "@teammate", index: 1, name: "codex" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
        "@teammate": {
          sessionId: "reviewer",
          kind: "agent",
          worktreePath: "/repo/project/worktree",
          team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer" },
        },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [{ id: "parent", tmuxWindowId: "@parent", kind: "agent", worktreePath: "/repo/project/worktree" }],
        teammates: [
          {
            id: "reviewer",
            tmuxWindowId: "@teammate",
            kind: "agent",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer" },
          },
        ],
      }),
    );

    runControl(envRoot, [
      "team",
      "--project-root",
      "/repo/project",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-1234abcd",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "codex",
      "--current-window-id",
      "@teammate",
      "--current-path",
      "/repo/project/worktree",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).toContain("link-window -d -s @parent -t aimux-proj-client-1234abcd");
    expect(log).toContain("switch-client -c /dev/live -t aimux-proj-client-1234abcd:2");
    expect(curlLog).toEqual([]);
  });

  it("does not fail when the resolved teammate has no tmux window", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@parent" }],
      windows: {
        "aimux-proj": [{ id: "@parent", index: 1, name: "claude" }],
        "aimux-proj-client-1234abcd": [{ id: "@parent", index: 1, name: "claude" }],
      },
      windowMetadata: {
        "@parent": { sessionId: "parent", kind: "agent", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {
        "%42": {
          sessionName: "aimux-proj-client-1234abcd",
          windowId: "@parent",
          windowName: "claude",
          clientTty: "/dev/live",
          currentPath: "/repo/project/worktree",
        },
      },
    });
    tempRoots.push(envRoot.root);
    writeFileSync(
      join(envRoot.projectStateDir, "statusline.json"),
      JSON.stringify({
        sessions: [{ id: "parent", tmuxWindowId: "@parent", kind: "agent", worktreePath: "/repo/project/worktree" }],
        teammates: [
          {
            id: "reviewer",
            kind: "agent",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer" },
          },
        ],
      }),
    );

    expect(() => {
      runControl(envRoot, [
        "team",
        "--project-root",
        "/repo/project",
        "--project-state-dir",
        envRoot.projectStateDir,
        "--current-client-session",
        "aimux-proj-client-1234abcd",
        "--client-tty",
        "/dev/live",
        "--current-window",
        "claude",
        "--current-window-id",
        "@parent",
        "--current-path",
        "/repo/project/worktree",
        "--pane-id",
        "%42",
      ]);
    }).not.toThrow();

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log).not.toContain("link-window -d -s @reviewer -t aimux-proj-client-1234abcd");
    expect(log).toContain("display-message -t %42 aimux: no live teammate target");
    expect(curlLog).toEqual([]);
  });

  it("shows the switch menu locally when the endpoint is stale", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@shell", index: 0, name: "shell" },
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
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
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
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
          "aimux-proj-client-1234abcd": {
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
      "aimux-proj-client-deadbeef",
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
    expect(log).not.toContain("link-window -d -s @codex -t aimux-proj-client-1234abcd");
    expect(log.some((entry) => entry.includes("display-menu -c /dev/live -T aimux"))).toBe(true);
    expect(log.some((entry) => entry.includes("scripts/tmux-control.sh window"))).toBe(true);
    expect(log.some((entry) => entry.includes("--window-id @codex"))).toBe(true);
    expect(log.some((entry) => entry.includes("display-popup"))).toBe(false);
    expect(curlLog).toEqual([]);
  });

  it("opens exposé as a tmux-native global menu", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj": [
          { id: "@claude", index: 1, name: "claude" },
          { id: "@codex", index: 6, name: "codex" },
        ],
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", command: "claude", worktreePath: "/repo/project/worktree" },
        "@codex": { sessionId: "codex-1", kind: "agent", command: "codex", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "expose",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/repo/project/worktree",
      "--aimux-home",
      "/home/user/.aimux-custom",
    ]);

    const log = readLog(envRoot);
    const curlLog = readCurlLog(envRoot);
    expect(log.some((entry) => entry.includes("display-menu -c /dev/live -T aimux expose"))).toBe(true);
    expect(log.some((entry) => entry.includes("--window-id @codex"))).toBe(true);
    expect(log.some((entry) => entry.includes("display-popup"))).toBe(false);
    expect(log.some((entry) => entry.includes("expose --project-root"))).toBe(false);
    expect(curlLog).toEqual([]);
  });

  it("opens the cross-project meta surface as a tmux-native menu", () => {
    const envRoot = createFakeEnvironment({
      clients: [{ tty: "/dev/live", sessionName: "aimux-proj-client-1234abcd", windowId: "@claude" }],
      windows: {
        "aimux-proj-client-1234abcd": [
          { id: "@dash", index: 0, name: "dashboard-live" },
          { id: "@claude", index: 1, name: "claude" },
        ],
      },
      windowMetadata: {
        "@claude": { sessionId: "claude-1", kind: "agent", command: "claude", worktreePath: "/repo/project/worktree" },
      },
      sessionOptions: {
        "aimux-proj-client-1234abcd": { "@aimux-project-root": "/repo/project" },
      },
      panes: {},
    });
    tempRoots.push(envRoot.root);
    writeFileSync(join(envRoot.projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43444");
    writeFileSync(join(envRoot.projectStateDir, "project-root.txt"), "/repo/project\n");

    runControl(envRoot, [
      "meta",
      "--project-state-dir",
      envRoot.projectStateDir,
      "--current-client-session",
      "aimux-proj-client-deadbeef",
      "--client-tty",
      "/dev/live",
      "--current-window",
      "claude",
      "--current-window-id",
      "@claude",
      "--current-path",
      "/repo/project/worktree",
      "--aimux-home",
      "/home/user/.aimux-custom",
    ]);

    const log = readLog(envRoot);
    expect(log.some((entry) => entry.includes("display-menu -c /dev/live -T aimux projects"))).toBe(true);
    expect(log.some((entry) => entry.includes("new-window"))).toBe(false);
    expect(log.some((entry) => entry.includes("meta-dashboard --project-root"))).toBe(false);
  });
});
