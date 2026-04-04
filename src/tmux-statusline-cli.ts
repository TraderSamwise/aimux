import {
  loadStatusline,
  renderTmuxStatusline,
  renderTmuxStatuslineFromData,
  type TmuxStatusLine,
} from "./tmux-statusline.js";
import { initPaths } from "./paths.js";
import { resolveProjectServiceEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import { loadMetadataState } from "./metadata-store.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";
import { basename } from "node:path";

interface Options {
  line?: string;
  projectRoot?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  currentSession?: string;
  width?: string;
}

function buildTmuxStatuslineFallback(
  projectRoot: string,
  currentWindowId?: string,
): {
  project: string;
  sessions: Array<{
    id: string;
    kind?: "agent" | "service";
    tool: string;
    label?: string;
    tmuxWindowId?: string;
    windowName: string;
    headline?: string;
    status?: string;
    role?: string;
    active: boolean;
    worktreePath?: string;
  }>;
  metadata: ReturnType<typeof loadMetadataState>["sessions"];
} | null {
  const tmux = new TmuxRuntimeManager();
  if (!tmux.isAvailable()) return null;
  const projectSession = tmux.getProjectSession(projectRoot);
  if (!tmux.hasSession(projectSession.sessionName)) return null;
  const metadata = loadMetadataState(projectRoot).sessions;
  const sessions = tmux.listManagedWindows(projectSession.sessionName).map(({ target, metadata: windowMeta }) => ({
    id: windowMeta.sessionId,
    kind: windowMeta.kind === "service" ? ("service" as const) : ("agent" as const),
    tool: windowMeta.command || target.windowName,
    label: windowMeta.label,
    tmuxWindowId: target.windowId,
    windowName: target.windowName,
    headline: windowMeta.statusText,
    status: windowMeta.activity,
    role: windowMeta.role,
    active: target.windowId === currentWindowId,
    worktreePath: windowMeta.worktreePath,
  }));
  return {
    project: basename(projectRoot),
    sessions,
    metadata,
  };
}

function parseArgs(argv: string[]): Options {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--")) continue;
    const normalized = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (value !== undefined && !value.startsWith("--")) {
      opts[normalized] = value;
      i += 1;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectRoot = opts.projectRoot || process.cwd();
  await initPaths(projectRoot);
  const line = (opts.line as TmuxStatusLine | undefined) ?? "bottom";
  const renderOptions = {
    currentWindow: opts.currentWindow,
    currentWindowId: opts.currentWindowId,
    currentPath: opts.currentPath,
    currentSession: opts.currentSession,
    width: opts.width ? Number(opts.width) : undefined,
  };
  const tmuxFallback = buildTmuxStatuslineFallback(projectRoot, opts.currentWindowId);
  const localData = loadStatusline(projectRoot);
  const agentWindow = opts.currentWindow && !opts.currentWindow.startsWith("dashboard");
  if (agentWindow && tmuxFallback) {
    const merged = {
      ...(localData ?? {}),
      ...tmuxFallback,
      sessions: tmuxFallback.sessions,
      metadata: tmuxFallback.metadata,
    };
    process.stdout.write(renderTmuxStatuslineFromData(merged, projectRoot, line, renderOptions));
    return;
  }

  const localRendered = renderTmuxStatusline(projectRoot, line, renderOptions);
  if (localRendered) {
    process.stdout.write(localRendered);
    return;
  }

  if (tmuxFallback) {
    const rendered = renderTmuxStatuslineFromData(tmuxFallback, projectRoot, line, renderOptions);
    if (rendered) {
      process.stdout.write(rendered);
      return;
    }
  }

  const endpoint = resolveProjectServiceEndpoint(projectRoot);
  if (endpoint) {
    try {
      const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/desktop-state`, {
        timeoutMs: 250,
      });
      if (status >= 200 && status < 300 && json) {
        const state = json as { statusline?: any; sessions?: any[]; services?: any[] };
        const fallbackSessions = [
          ...(state.sessions ?? []).map((session) => ({ ...session, kind: session.kind ?? "agent" })),
          ...(state.services ?? []).map((service) => ({ ...service, kind: service.kind ?? "service" })),
        ];
        const mergedStatusline =
          state.statusline && typeof state.statusline === "object"
            ? {
                ...state.statusline,
                sessions:
                  Array.isArray(state.statusline.sessions) && state.statusline.sessions.length > 0
                    ? state.statusline.sessions
                    : fallbackSessions,
              }
            : null;
        if (mergedStatusline) {
          process.stdout.write(renderTmuxStatuslineFromData(mergedStatusline, projectRoot, line, renderOptions));
          return;
        }
      }
    } catch {}
  }

  process.stdout.write(localRendered);
}

void main();
