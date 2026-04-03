import { renderTmuxStatusline, type TmuxStatusLine } from "./tmux-statusline.js";
import { initPaths } from "./paths.js";

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
  process.stdout.write(
    renderTmuxStatusline(projectRoot, (opts.line as TmuxStatusLine | undefined) ?? "bottom", {
      currentWindow: opts.currentWindow,
      currentWindowId: opts.currentWindowId,
      currentPath: opts.currentPath,
      currentSession: opts.currentSession,
      width: opts.width ? Number(opts.width) : undefined,
    }),
  );
}

void main();
