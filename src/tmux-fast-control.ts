import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { statSync } from "node:fs";
import { debug } from "./debug.js";
import { loadMetadataEndpoint } from "./metadata-store.js";
import {
  listSwitchableAgentItems,
  resolveAttentionAgent,
  resolveNextAgent,
  resolvePrevAgent,
  type FastControlContext,
} from "./fast-control.js";
import { isDashboardWindowName, TmuxRuntimeManager, type TmuxTarget } from "./tmux-runtime-manager.js";

interface Options {
  projectRoot: string;
  currentClientSession?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
}

interface FastControlResponse {
  ok: boolean;
  target?: TmuxTarget;
  item?: { target: TmuxTarget; label?: string };
  items?: Array<{ target: TmuxTarget; label: string }>;
}

function logFastControl(message: string): void {
  debug(message, "fast-control");
}

function parseArgs(argv: string[]): { action: string; opts: Options } {
  const [action = "", ...rest] = argv;
  const opts: Partial<Options> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--")) continue;
    const normalized = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) as keyof Options;
    if (value !== undefined && !value.startsWith("--")) {
      opts[normalized] = value as never;
      i += 1;
    }
  }
  return { action, opts: opts as Options };
}

async function requestFastControl(action: string, opts: Options): Promise<FastControlResponse | null> {
  const endpoint = loadMetadataEndpoint(opts.projectRoot);
  if (!endpoint) {
    logFastControl(`action=${action} mode=service-miss reason=no-endpoint project=${opts.projectRoot}`);
    return null;
  }
  const startedAt = Date.now();
  if (action === "menu") {
    const url = new URL(`http://${endpoint.host}:${endpoint.port}/control/switchable-agents`);
    if (opts.currentClientSession) url.searchParams.set("currentClientSession", opts.currentClientSession);
    if (opts.currentWindow) url.searchParams.set("currentWindow", opts.currentWindow);
    if (opts.currentWindowId) url.searchParams.set("currentWindowId", opts.currentWindowId);
    if (opts.currentPath) url.searchParams.set("currentPath", opts.currentPath);
    const res = await fetch(url, { signal: AbortSignal.timeout(400) });
    if (!res.ok) {
      logFastControl(
        `action=${action} mode=service-miss reason=http-${res.status} durationMs=${Date.now() - startedAt}`,
      );
      return null;
    }
    const body = (await res.json()) as FastControlResponse;
    logFastControl(
      `action=${action} mode=service-ok durationMs=${Date.now() - startedAt} items=${body.items?.length ?? 0}`,
    );
    return body;
  }
  const endpointPath =
    action === "dashboard"
      ? "/control/open-dashboard"
      : action === "attention"
        ? "/control/switch-attention"
        : action === "prev"
          ? "/control/switch-prev"
          : "/control/switch-next";
  const res = await fetch(`http://${endpoint.host}:${endpoint.port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(400),
  });
  if (!res.ok) {
    logFastControl(`action=${action} mode=service-miss reason=http-${res.status} durationMs=${Date.now() - startedAt}`);
    return null;
  }
  const body = (await res.json()) as FastControlResponse;
  logFastControl(`action=${action} mode=service-ok durationMs=${Date.now() - startedAt}`);
  return body;
}

function openTarget(tmux: TmuxRuntimeManager, target: TmuxTarget, currentClientSession?: string): void {
  if (currentClientSession) {
    const linkedTarget = tmux.getTargetByWindowId(currentClientSession, target.windowId);
    if (linkedTarget) {
      tmux.selectWindow(linkedTarget);
      if (linkedTarget.windowName.startsWith("dashboard")) {
        tmux.sendFocusIn(linkedTarget);
      }
      return;
    }
  }
  tmux.openTarget(target, { insideTmux: Boolean(currentClientSession) });
}

function displayMenu(
  tmux: TmuxRuntimeManager,
  items: Array<{ target: TmuxTarget; label: string }>,
  currentWindowId?: string,
): void {
  tmux.displayWindowMenu(
    "aimux",
    items.map((item) => ({
      label: item.target.windowId === currentWindowId ? `${item.label}*` : item.label,
      target: item.target,
    })),
  );
}

function getDashboardCommandSpec(projectRoot: string) {
  const currentFile = fileURLToPath(import.meta.url);
  const mainScript = join(dirname(currentFile), "main.js");
  return {
    dashboardCommand: {
      cwd: projectRoot,
      command: process.execPath,
      args: [mainScript, "--tmux-dashboard-internal"],
    },
    dashboardBuildStamp: String(statSync(mainScript).mtimeMs),
  };
}

function resolveLocalResult(action: string, opts: Options, tmux: TmuxRuntimeManager): FastControlResponse {
  if (action === "dashboard") {
    const currentClientSession = opts.currentClientSession?.trim() || tmux.currentClientSession() || undefined;
    const dashboardTarget = currentClientSession
      ? tmux.listWindows(currentClientSession).find((window) => isDashboardWindowName(window.name))
      : undefined;
    if (dashboardTarget && currentClientSession) {
      return {
        ok: true,
        target: {
          sessionName: currentClientSession,
          windowId: dashboardTarget.id,
          windowIndex: dashboardTarget.index,
          windowName: dashboardTarget.name,
        },
      };
    }
    const { dashboardCommand, dashboardBuildStamp } = getDashboardCommandSpec(opts.projectRoot);
    const dashboardSession = tmux.ensureProjectSession(opts.projectRoot, dashboardCommand);
    const openSessionName = tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
    const target = tmux.ensureDashboardWindow(openSessionName, opts.projectRoot, dashboardCommand);
    const currentBuildStamp = tmux.getWindowOption(target, "@aimux-dashboard-build");
    if (!tmux.isWindowAlive(target) || currentBuildStamp !== dashboardBuildStamp) {
      tmux.respawnWindow(target, dashboardCommand);
      tmux.setWindowOption(target, "@aimux-dashboard-build", dashboardBuildStamp);
    }
    return { ok: true, target };
  }

  const context: FastControlContext = {
    projectRoot: opts.projectRoot,
    currentClientSession: opts.currentClientSession?.trim() || tmux.currentClientSession() || undefined,
    currentWindow: opts.currentWindow,
    currentWindowId: opts.currentWindowId,
    currentPath: opts.currentPath,
  };

  if (action === "menu") {
    return { ok: true, items: listSwitchableAgentItems(context, tmux) };
  }
  if (action === "attention") {
    const item = resolveAttentionAgent(context, tmux);
    return { ok: true, item: item ?? undefined };
  }
  if (action === "prev") {
    const item = resolvePrevAgent(context, tmux);
    return { ok: true, item: item ?? undefined };
  }
  const item = resolveNextAgent(context, tmux);
  return { ok: true, item: item ?? undefined };
}

async function main() {
  const { action, opts } = parseArgs(process.argv.slice(2));
  if (!action || !opts.projectRoot) process.exit(1);
  opts.projectRoot = pathResolve(opts.projectRoot);
  const tmux = new TmuxRuntimeManager();
  try {
    const result = (await requestFastControl(action, opts)) ?? resolveLocalResult(action, opts, tmux);
    if (action === "menu") {
      if (!result?.items?.length) process.exit(0);
      displayMenu(tmux, result.items, opts.currentWindowId);
      process.exit(0);
    }
    const target = result?.target ?? result?.item?.target;
    if (!target) process.exit(0);
    openTarget(tmux, target, opts.currentClientSession);
    process.exit(0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logFastControl(`action=${action} mode=local-error reason=${JSON.stringify(reason)}`);
    process.exit(1);
  }
}

void main();
