import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { statSync } from "node:fs";
import { debug } from "./debug.js";
import { loadMetadataEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import {
  listSwitchableAgentMenuItems,
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
  clientTty?: string;
  windowId?: string;
}

interface FastControlResponse {
  ok: boolean;
  target?: TmuxTarget;
  item?: { target: TmuxTarget; label?: string };
  items?: Array<{ target: TmuxTarget; label: string }>;
}

function resolveCurrentClientSession(tmux: TmuxRuntimeManager, opts: Options): string | undefined {
  const normalizedSession = opts.currentClientSession?.trim();
  if (normalizedSession && tmux.hasSession(normalizedSession)) {
    return normalizedSession;
  }
  const liveFromTty = opts.clientTty ? tmux.findClientByTty(opts.clientTty)?.sessionName : null;
  if (liveFromTty) return liveFromTty;
  const liveCurrent = tmux.currentClientSession();
  if (liveCurrent && tmux.hasSession(liveCurrent)) {
    return liveCurrent;
  }
  return undefined;
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
  if (action === "window") return null;
  const endpoint = loadMetadataEndpoint(opts.projectRoot);
  if (!endpoint) {
    logFastControl(`action=${action} mode=service-miss reason=no-endpoint project=${opts.projectRoot}`);
    return null;
  }
  const startedAt = Date.now();
  try {
    if (action === "menu") {
      const url = new URL(`http://${endpoint.host}:${endpoint.port}/control/switchable-agents`);
      if (opts.currentClientSession) url.searchParams.set("currentClientSession", opts.currentClientSession);
      if (opts.currentWindow) url.searchParams.set("currentWindow", opts.currentWindow);
      if (opts.currentWindowId) url.searchParams.set("currentWindowId", opts.currentWindowId);
      if (opts.currentPath) url.searchParams.set("currentPath", opts.currentPath);
      const { status, json } = await requestJson(url.toString(), { timeoutMs: 400 });
      if (status < 200 || status >= 300) {
        logFastControl(`action=${action} mode=service-miss reason=http-${status} durationMs=${Date.now() - startedAt}`);
        return null;
      }
      const body = json as FastControlResponse;
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
    const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${endpointPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts,
      timeoutMs: 400,
    });
    if (status < 200 || status >= 300) {
      logFastControl(`action=${action} mode=service-miss reason=http-${status} durationMs=${Date.now() - startedAt}`);
      return null;
    }
    const body = json as FastControlResponse;
    logFastControl(`action=${action} mode=service-ok durationMs=${Date.now() - startedAt}`);
    return body;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logFastControl(
      `action=${action} mode=service-miss reason=${JSON.stringify(reason)} durationMs=${Date.now() - startedAt}`,
    );
    return null;
  }
}

function openTarget(
  tmux: TmuxRuntimeManager,
  target: TmuxTarget,
  currentClientSession?: string,
  clientTty?: string,
): void {
  const liveClientTty = resolveLiveClientTty(tmux, currentClientSession, clientTty);
  if (liveClientTty) {
    tmux.switchClientToTarget(liveClientTty, target);
    if (target.windowName.startsWith("dashboard")) {
      tmux.sendFocusIn(target);
    }
    return;
  }
  if (currentClientSession) {
    const linkedTarget = tmux.getTargetByWindowId(currentClientSession, target.windowId);
    if (linkedTarget) {
      tmux.switchClient(currentClientSession, linkedTarget.windowIndex);
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
  currentClientSession?: string,
  clientTty?: string,
): void {
  const menuItems = items.map((item) => ({
    label: item.target.windowId === currentWindowId ? `${item.label}*` : item.label,
    target: item.target,
  }));
  const liveClientTty = resolveLiveClientTty(tmux, currentClientSession, clientTty);
  if (liveClientTty) {
    tmux.displayWindowMenuForClient(liveClientTty, "aimux", menuItems);
    return;
  }
  tmux.displayWindowMenu("aimux", menuItems);
}

function resolveLiveClientTty(
  tmux: TmuxRuntimeManager,
  currentClientSession?: string,
  preferredClientTty?: string,
): string | undefined {
  const normalizedTty = preferredClientTty?.trim();
  if (normalizedTty && tmux.findClientByTty(normalizedTty)) {
    return normalizedTty;
  }
  const normalizedSession = currentClientSession?.trim();
  if (!normalizedSession) return undefined;
  const liveClient = tmux.listClients().find((client) => client.sessionName === normalizedSession);
  return liveClient?.tty || undefined;
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
  const currentClientSession = resolveCurrentClientSession(tmux, opts);

  if (action === "window") {
    const windowId = opts.windowId?.trim();
    if (!windowId) {
      throw new Error("window action requires --window-id");
    }
    const sessionName = currentClientSession ?? tmux.getProjectSession(opts.projectRoot).sessionName;
    const target = tmux.getTargetByWindowId(sessionName, windowId);
    if (target) return { ok: true, target };
    const projectSession = tmux.getProjectSession(opts.projectRoot);
    const projectTarget = tmux.getTargetByWindowId(projectSession.sessionName, windowId);
    if (!projectTarget) {
      throw new Error(`tmux window ${windowId} not found for ${opts.projectRoot}`);
    }
    return { ok: true, target: projectTarget };
  }

  if (action === "dashboard") {
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
    currentClientSession,
    currentWindow: opts.currentWindow,
    currentWindowId: opts.currentWindowId,
    currentPath: opts.currentPath,
  };

  if (action === "menu") {
    return { ok: true, items: listSwitchableAgentMenuItems(context, tmux) };
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
      displayMenu(tmux, result.items, opts.currentWindowId, opts.currentClientSession, opts.clientTty);
      process.exit(0);
    }
    const target = result?.target ?? result?.item?.target;
    if (!target) process.exit(0);
    const currentClientSession = resolveCurrentClientSession(tmux, opts);
    openTarget(tmux, target, currentClientSession, opts.clientTty);
    process.exit(0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logFastControl(`action=${action} mode=local-error reason=${JSON.stringify(reason)}`);
    process.exit(1);
  }
}

void main();
