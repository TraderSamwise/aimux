import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadMetadataEndpoint } from "./metadata-store.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./tmux-runtime-manager.js";

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
  if (!endpoint) return null;
  if (action === "menu") {
    const url = new URL(`http://${endpoint.host}:${endpoint.port}/control/switchable-agents`);
    if (opts.currentClientSession) url.searchParams.set("currentClientSession", opts.currentClientSession);
    if (opts.currentWindow) url.searchParams.set("currentWindow", opts.currentWindow);
    if (opts.currentWindowId) url.searchParams.set("currentWindowId", opts.currentWindowId);
    if (opts.currentPath) url.searchParams.set("currentPath", opts.currentPath);
    const res = await fetch(url, { signal: AbortSignal.timeout(400) });
    if (!res.ok) return null;
    return (await res.json()) as FastControlResponse;
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
  if (!res.ok) return null;
  return (await res.json()) as FastControlResponse;
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

function fallbackToCli(action: string, opts: Options): never {
  const currentFile = fileURLToPath(import.meta.url);
  const mainScript = join(dirname(currentFile), "main.js");
  const args = [mainScript, "tmux-switch", action, "--project-root", opts.projectRoot];
  if (opts.currentWindow) args.push("--current-window", opts.currentWindow);
  if (opts.currentWindowId) args.push("--current-window-id", opts.currentWindowId);
  if (opts.currentPath) args.push("--current-path", opts.currentPath);
  spawnSync(process.execPath, args, { stdio: "ignore", cwd: opts.currentPath || opts.projectRoot });
  process.exit(0);
}

async function main() {
  const { action, opts } = parseArgs(process.argv.slice(2));
  if (!action || !opts.projectRoot) process.exit(1);
  opts.projectRoot = pathResolve(opts.projectRoot);
  const tmux = new TmuxRuntimeManager();
  try {
    const result = await requestFastControl(action, opts);
    if (!result) fallbackToCli(action, opts);
    if (action === "menu") {
      if (!result?.items?.length) process.exit(0);
      displayMenu(tmux, result.items, opts.currentWindowId);
      process.exit(0);
    }
    const target = result?.target ?? result?.item?.target;
    if (!target) process.exit(0);
    openTarget(tmux, target, opts.currentClientSession);
    process.exit(0);
  } catch {
    fallbackToCli(action, opts);
  }
}

void main();
