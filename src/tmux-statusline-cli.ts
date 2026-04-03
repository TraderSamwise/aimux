import { renderTmuxStatusline, renderTmuxStatuslineFromData, type TmuxStatusLine } from "./tmux-statusline.js";
import { initPaths } from "./paths.js";
import { resolveProjectServiceEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";

interface Options {
  line?: string;
  projectRoot?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  currentSession?: string;
  width?: string;
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
  const endpoint = resolveProjectServiceEndpoint(projectRoot);
  if (endpoint) {
    try {
      const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/desktop-state`, {
        timeoutMs: 1000,
      });
      if (status >= 200 && status < 300 && json) {
        const state = json as { statusline?: any; sessions?: any[] };
        const mergedStatusline =
          state.statusline && typeof state.statusline === "object"
            ? { ...state.statusline, sessions: state.sessions ?? state.statusline.sessions ?? [] }
            : null;
        if (mergedStatusline) {
          process.stdout.write(renderTmuxStatuslineFromData(mergedStatusline, projectRoot, line, renderOptions));
          return;
        }
      }
    } catch {}
  }
  process.stdout.write(renderTmuxStatusline(projectRoot, line, renderOptions));
}

void main();
