import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { spawnSync } from "node:child_process";
import { debug } from "./debug.js";
import {
  listSwitchableAgentItems,
  resolveAttentionAgent,
  resolveCurrentAgentIndex,
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

function fallbackToMainCli(action: string, opts: Options, reason: string): never {
  debug(`action=${action} mode=main-fallback reason=${reason}`, "fast-control");
  const currentFile = fileURLToPath(import.meta.url);
  const mainScript = join(dirname(currentFile), "main.js");
  const args = [mainScript, "tmux-switch", action, "--project-root", opts.projectRoot];
  if (opts.currentClientSession) args.push("--current-client-session", opts.currentClientSession);
  if (opts.currentWindow) args.push("--current-window", opts.currentWindow);
  if (opts.currentWindowId) args.push("--current-window-id", opts.currentWindowId);
  if (opts.currentPath) args.push("--current-path", opts.currentPath);
  spawnSync(process.execPath, args, { stdio: "ignore", cwd: opts.currentPath || opts.projectRoot });
  process.exit(0);
}

function openManagedTarget(tmux: TmuxRuntimeManager, target: TmuxTarget, currentClientSession?: string): void {
  if (currentClientSession) {
    const linkedTarget = tmux.getTargetByWindowId(currentClientSession, target.windowId);
    if (linkedTarget) {
      tmux.selectWindow(linkedTarget);
      return;
    }
  }
  tmux.openTarget(target, { insideTmux: Boolean(currentClientSession) });
}

function handleDashboard(tmux: TmuxRuntimeManager, opts: Options): void {
  const currentClientSession = opts.currentClientSession?.trim() || tmux.currentClientSession() || undefined;
  if (!currentClientSession) {
    fallbackToMainCli("dashboard", opts, "missing-client-session");
  }
  const dashboardTarget = tmux.listWindows(currentClientSession).find((window) => isDashboardWindowName(window.name));
  if (!dashboardTarget) {
    fallbackToMainCli("dashboard", opts, "missing-dashboard-window");
  }
  const target = {
    sessionName: currentClientSession,
    windowId: dashboardTarget.id,
    windowIndex: dashboardTarget.index,
    windowName: dashboardTarget.name,
  };
  tmux.selectWindow(target);
  tmux.sendFocusIn(target);
}

function displayMenu(
  tmux: TmuxRuntimeManager,
  items: ReturnType<typeof listSwitchableAgentItems>,
  currentWindowId?: string,
): void {
  tmux.displayWindowMenu(
    "aimux",
    items.map((item, index) => ({
      label: item.target.windowId === currentWindowId ? `${item.label}*` : item.label,
      target: item.target,
    })),
  );
}

function main() {
  const { action, opts } = parseArgs(process.argv.slice(2));
  if (!action || !opts.projectRoot) process.exit(1);
  opts.projectRoot = pathResolve(opts.projectRoot);
  const tmux = new TmuxRuntimeManager();
  const currentClientSession = opts.currentClientSession?.trim() || tmux.currentClientSession() || undefined;

  if (action === "dashboard") {
    handleDashboard(tmux, { ...opts, currentClientSession });
    process.exit(0);
  }

  const context: FastControlContext = {
    projectRoot: opts.projectRoot,
    currentClientSession,
    currentWindow: opts.currentWindow,
    currentWindowId: opts.currentWindowId,
    currentPath: opts.currentPath,
  };

  if (action === "attention") {
    const item = resolveAttentionAgent(context, tmux);
    if (!item) process.exit(0);
    openManagedTarget(tmux, item.target, currentClientSession);
    process.exit(0);
  }

  const items = listSwitchableAgentItems(context, tmux);
  if (items.length === 0) process.exit(0);
  if (action === "menu") {
    displayMenu(tmux, items, opts.currentWindowId);
    process.exit(0);
  }
  if (action === "next") {
    const item = resolveNextAgent(context, tmux);
    if (!item) process.exit(0);
    openManagedTarget(tmux, item.target, currentClientSession);
    process.exit(0);
  }
  if (action === "prev") {
    const item = resolvePrevAgent(context, tmux);
    if (!item) process.exit(0);
    openManagedTarget(tmux, item.target, currentClientSession);
    process.exit(0);
  }

  const currentIndex = resolveCurrentAgentIndex(items, context);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;
  const target = items[resolvedIndex]?.target;
  if (!target) process.exit(0);
  openManagedTarget(tmux, target, currentClientSession);
  process.exit(0);
}

main();
