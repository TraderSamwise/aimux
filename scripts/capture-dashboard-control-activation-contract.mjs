#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-activation.json", ROOT);

const { waitAndOpenLiveTmuxWindowForEntry, waitAndOpenLiveTmuxWindowForService } = await import(
  new URL("dist/multiplexer/dashboard-control.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value).replaceAll("/tmp/repo", "<REPO>").replace(ISO_RE, "<NOW>"));
}

async function runCase(input) {
  const calls = [];
  const timers = [];
  const pendingTimers = [];
  let now = 1_000;
  const previousNow = Date.now;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousTmuxPane = process.env.TMUX_PANE;
  Date.now = () => now;
  global.setTimeout = (fn, ms, ...args) => {
    const timer = {
      ms,
      args,
      cancelled: false,
      unref() {},
    };
    timers.push({ ms });
    pendingTimers.push({ timer, fn });
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cancelled = true;
  };
  if (input.tmuxPane === null) delete process.env.TMUX_PANE;
  else if (typeof input.tmuxPane === "string") process.env.TMUX_PANE = input.tmuxPane;

  const postSteps = [...(input.postSteps ?? [])];
  const fn =
    (method, impl) =>
    (...args) => {
      calls.push({ method, args: normalize(args) });
      return impl?.(...args);
    };
  const tmux = input.tmux ?? {};
  const host = {
    projectRoot: "/tmp/repo",
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    dashboardActivationToken: input.dashboardActivationToken,
    postToProjectService: async (...args) => {
      calls.push({ method: "postToProjectService", args: normalize(args) });
      const body = args[1] ?? {};
      if (input.invalidateAfterResolve === true && body.focus === false) host.dashboardInputEpoch += 1;
      const step = postSteps.shift() ?? { value: { ok: true } };
      if (step.throw) throw new Error(step.throw);
      return step.value;
    },
    invalidateDesktopStateSnapshot: fn("invalidateDesktopStateSnapshot"),
    showDashboardError: fn("showDashboardError"),
    tmuxRuntimeManager: {
      currentClientSession: fn("tmuxRuntimeManager.currentClientSession", () => tmux.currentClientSession),
      displayMessage: fn("tmuxRuntimeManager.displayMessage", (format, target) => {
        const key = target ? `${format}|${target}` : format;
        return tmux.display?.[key];
      }),
      listClients: fn("tmuxRuntimeManager.listClients", () => tmux.clients ?? []),
      findClientByTty: fn(
        "tmuxRuntimeManager.findClientByTty",
        (tty) => (tmux.clients ?? []).find((client) => client.tty === tty) ?? null,
      ),
      listProjectManagedWindows: fn("tmuxRuntimeManager.listProjectManagedWindows", () => tmux.windows ?? []),
      isWindowAlive: fn("tmuxRuntimeManager.isWindowAlive", (target) => target.alive !== false),
      getAttachedClientForTarget: fn(
        "tmuxRuntimeManager.getAttachedClientForTarget",
        () => tmux.attachedClient ?? null,
      ),
      switchClientToTarget: fn("tmuxRuntimeManager.switchClientToTarget"),
      switchClient: fn("tmuxRuntimeManager.switchClient"),
      openTarget: fn("tmuxRuntimeManager.openTarget"),
      selectWindow: fn("tmuxRuntimeManager.selectWindow"),
      refreshStatus: fn("tmuxRuntimeManager.refreshStatus"),
      sendFocusIn: fn("tmuxRuntimeManager.sendFocusIn"),
    },
  };

  try {
    let settled = false;
    const operation =
      input.api === "entry"
        ? waitAndOpenLiveTmuxWindowForEntry(host, input.entry, input.timeoutMs)
        : waitAndOpenLiveTmuxWindowForService(host, input.service, input.timeoutMs);
    const tracked = Promise.resolve(operation).finally(() => {
      settled = true;
    });
    for (let guard = 0; guard < 20 && (pendingTimers.length > 0 || !settled); guard += 1) {
      await Promise.resolve();
      const next = pendingTimers.shift();
      if (!next) continue;
      if (next.timer.cancelled) continue;
      now += next.timer.ms ?? 0;
      next.fn(...next.timer.args);
    }
    const result = await tracked;
    await Promise.resolve();
    return {
      result,
      calls,
      timers,
      dashboardInputEpoch: host.dashboardInputEpoch,
    };
  } finally {
    Date.now = previousNow;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousTmuxPane;
  }
}

const agentTarget = {
  sessionName: "aimux-repo",
  windowId: "@agent",
  windowIndex: 2,
  windowName: "codex(coder)",
};
const serviceTarget = {
  sessionName: "aimux-repo",
  windowId: "@service",
  windowIndex: 4,
  windowName: "svc(dev)",
};

const inputs = [
  {
    name: "focuses a live dashboard agent locally and marks usage",
    input: {
      api: "entry",
      timeoutMs: 1200,
      tmuxPane: "%dashboard",
      entry: { id: "codex-1", status: "running" },
      tmux: {
        currentClientSession: "stale-client",
        display: { "#{window_id}|%dashboard": "@dashboard", "#{client_tty}": "/dev/stale" },
        clients: [{ tty: "/dev/live", sessionName: "aimux-repo-client-live", windowId: "@dashboard" }],
        windows: [{ metadata: { kind: "agent", sessionId: "codex-1" }, target: agentTarget }],
      },
    },
  },
  {
    name: "opens agents through project-service control API when local tmux cannot focus",
    input: {
      api: "entry",
      timeoutMs: 1200,
      tmuxPane: null,
      entry: { id: "codex-1" },
      tmux: {
        currentClientSession: "aimux-repo-client-live",
        display: { "#{client_tty}": "/dev/live", "#{window_id}": "@9" },
      },
    },
  },
  {
    name: "returns missing without surfacing an error when no dashboard client tty exists",
    input: {
      api: "entry",
      timeoutMs: 120,
      tmuxPane: null,
      entry: { id: "codex-1", status: "running" },
      tmux: {
        currentClientSession: "aimux-repo-client-live",
        display: {},
        clients: [],
      },
    },
  },
  {
    name: "does not focus after activation is invalidated by dashboard input",
    input: {
      api: "entry",
      timeoutMs: 1000,
      tmuxPane: null,
      dashboardInputEpoch: 0,
      dashboardActivationToken: { targetKind: "session", targetId: "codex-1", inputEpoch: 0 },
      invalidateAfterResolve: true,
      entry: { id: "codex-1" },
      tmux: {
        currentClientSession: "aimux-repo-client-live",
        display: { "#{client_tty}": "/dev/live" },
      },
    },
  },
  {
    name: "focuses a live service locally by service target id",
    input: {
      api: "service",
      timeoutMs: 1200,
      tmuxPane: "%dashboard",
      service: { id: "service-1", tmuxWindowId: "@service" },
      tmux: {
        currentClientSession: "aimux-repo-client-live",
        display: { "#{window_id}|%dashboard": "@dashboard", "#{client_tty}": "/dev/live" },
        clients: [{ tty: "/dev/live", sessionName: "aimux-repo-client-live", windowId: "@dashboard" }],
        windows: [{ metadata: { kind: "service", sessionId: "service-1" }, target: serviceTarget }],
      },
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  cases.push({
    id: `dashboard-control-activation-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-control.ts",
    api: "dashboardControlActivation",
    input: entry.input,
    output: await runCase(entry.input),
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-activation-contract.mjs",
  description: "Dashboard control local focus and project-service activation behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
