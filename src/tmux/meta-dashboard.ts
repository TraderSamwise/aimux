import { buildMetaDashboardModel, type MetaDashboardModel, type MetaRow } from "../meta-dashboard-model.js";
import { parseKeys } from "../key-parser.js";
import { TerminalHost } from "../terminal-host.js";
import { truncatePlain } from "../tui/render/text.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./runtime-manager.js";

export interface TmuxMetaDashboardOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
  /** Baked AIMUX_HOME so listProjects() reads the right (stable vs dev) registry. */
  aimuxHome?: string;
}

const REFRESH_MS = 2000;
const RESET = "\x1b[0m";

export interface SelectableRow {
  projectName: string;
  projectRoot: string;
  row: MetaRow;
}

export function flattenSelectableRows(model: MetaDashboardModel): SelectableRow[] {
  const out: SelectableRow[] = [];
  for (const project of model.projects) {
    if (!project.running) continue;
    for (const group of project.worktreeGroups) {
      for (const row of group.rows) {
        out.push({ projectName: project.name, projectRoot: project.repoRoot, row });
      }
    }
  }
  return out;
}

/**
 * Resolve the jump target for the Nth selectable row. The session is overridden
 * to the target project's HOST session so openTarget resolves THIS client's
 * session for that project (not some other terminal's client session).
 */
export function resolveJumpTarget(
  model: MetaDashboardModel,
  index: number,
  hostSessionFor: (projectRoot: string) => string,
): { target: TmuxTarget; projectRoot: string } | null {
  const sel = flattenSelectableRows(model)[index];
  if (!sel) return null;
  return {
    projectRoot: sel.projectRoot,
    target: { ...sel.row.target, sessionName: hostSessionFor(sel.projectRoot) },
  };
}

function rowGlyph(row: MetaRow): string {
  if (row.attention === "error") return "\x1b[31m●\x1b[0m";
  if (row.attention === "needs_input" || row.activity === "waiting") return "\x1b[33m◍\x1b[0m";
  if (row.activity === "running") return "\x1b[32m▶\x1b[0m";
  return "\x1b[38;5;244m○\x1b[0m";
}

// Strip escape sequences + control bytes from metadata-sourced strings so a
// rogue agent label/worktree name can't inject escapes into the frame.
function sanitizeMeta(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Pure renderer: returns the full ANSI frame for the meta dashboard. */
export function renderMetaDashboard(
  model: MetaDashboardModel,
  selectedIndex: number,
  cols: number,
  rows: number,
): string {
  const width = Math.max(20, cols);
  const title = `\x1b[1maimux · all projects${RESET}`;
  const help = `\x1b[2m↑↓/jk move · Enter/1-9 open · q/Esc close${RESET}`;

  // Build content lines, tracking which terminal line holds each selectable row.
  const lines: string[] = [];
  const selectableLineByIndex: number[] = [];
  let selectable = 0;

  if (model.projects.length === 0) {
    lines.push("\x1b[2mNo projects registered.\x1b[0m");
  }

  for (const project of model.projects) {
    const state = project.running ? "" : " \x1b[2m(stopped)\x1b[0m";
    lines.push("");
    lines.push(`\x1b[1;36m▌ ${truncatePlain(sanitizeMeta(project.name), width - 4)}\x1b[0m${state}`);
    if (!project.running) continue;
    if (project.worktreeGroups.length === 0) {
      lines.push("  \x1b[2m(no active agents)\x1b[0m");
      continue;
    }
    for (const group of project.worktreeGroups) {
      const branch = group.branch ? ` \x1b[2m${sanitizeMeta(group.branch)}\x1b[0m` : "";
      lines.push(`  \x1b[38;5;180m${truncatePlain(sanitizeMeta(group.name), width - 6)}\x1b[0m${branch}`);
      for (const row of group.rows) {
        const idx = selectable;
        selectable += 1;
        const selected = idx === selectedIndex;
        const label = truncatePlain(`${sanitizeMeta(row.label)}  \x1b[2m${sanitizeMeta(row.tool)}\x1b[0m`, width - 8);
        const text = `    ${rowGlyph(row)} ${label}`;
        selectableLineByIndex[idx] = lines.length;
        lines.push(selected ? `\x1b[7m${text}${RESET}` : text);
      }
    }
  }

  if (selectable === 0 && model.projects.length > 0) {
    lines.push("");
    lines.push("\x1b[2mNo running projects.\x1b[0m");
  }

  // Scroll so the selected row stays visible (reserve 2 rows: title + help).
  const viewport = Math.max(1, rows - 2);
  let scroll = 0;
  const selLine = selectableLineByIndex[selectedIndex];
  if (selLine !== undefined && selLine >= viewport) scroll = selLine - viewport + 1;
  const visible = lines.slice(scroll, scroll + viewport);

  let out = `\x1b[2J\x1b[H\x1b[1;2H${title}`;
  for (let i = 0; i < visible.length; i += 1) {
    out += `\x1b[${i + 2};1H${visible[i]}`;
  }
  out += `\x1b[${rows};2H${help}`;
  return out;
}

export async function runTmuxMetaDashboard(options: TmuxMetaDashboardOptions): Promise<number> {
  if (options.aimuxHome) process.env.AIMUX_HOME = options.aimuxHome;

  // Build the first model BEFORE touching the terminal, so a startup failure
  // can't leave it stuck in raw/alternate-screen mode.
  const tmux = new TmuxRuntimeManager();
  let model: MetaDashboardModel;
  try {
    model = buildMetaDashboardModel({ tmux });
  } catch {
    return 1;
  }

  const terminal = new TerminalHost();
  terminal.enterRawMode();
  terminal.enterAlternateScreen(true);
  process.stdout.write("\x1b[?25l");

  let interval: ReturnType<typeof setInterval> | null = null;
  const exit = (code: number): number => {
    if (interval) clearInterval(interval);
    process.stdout.write("\x1b[?25h");
    terminal.restoreTerminalState();
    return code;
  };
  const onFatalSignal = () => process.exit(exit(0));
  process.once("SIGINT", onFatalSignal);
  process.once("SIGTERM", onFatalSignal);

  let selectedIndex = 0;

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const count = flattenSelectableRows(model).length;
    if (selectedIndex >= count) selectedIndex = Math.max(0, count - 1);
    process.stdout.write(renderMetaDashboard(model, selectedIndex, cols, rows));
  };

  render();

  return await new Promise<number>((resolve) => {
    const finish = (code: number) => {
      process.stdin.off("data", onData);
      resolve(exit(code));
    };

    const performJump = (i: number) => {
      const jump = resolveJumpTarget(model, i, (root) => tmux.getProjectSession(root).sessionName);
      if (!jump) return;
      // Switch the real client explicitly (robust with multiple attached clients).
      const suffix = options.currentClientSession?.match(/-client-([a-f0-9]{8})$/)?.[1];
      try {
        tmux.openTarget(jump.target, {
          insideTmux: true,
          clientTty: options.clientTty,
          clientSuffix: suffix,
          returnSessionName: options.currentClientSession,
        });
      } catch {
        /* target vanished mid-jump; close the meta dashboard regardless */
      }
      finish(0);
    };

    function onData(data: Buffer) {
      try {
        const event = parseKeys(data)[0];
        if (!event) return;
        const key = event.name || event.char || "";
        const count = flattenSelectableRows(model).length;

        if (key === "q" || key === "escape" || (event.ctrl && key === "c")) {
          finish(0);
          return;
        }
        if (key === "enter" || key === "return") {
          performJump(selectedIndex);
          return;
        }
        if (key >= "1" && key <= "9") {
          performJump(Number.parseInt(key, 10) - 1);
          return;
        }
        if (count === 0) return;
        if (key === "down" || key === "j") {
          selectedIndex = (selectedIndex + 1) % count;
          render();
          return;
        }
        if (key === "up" || key === "k") {
          selectedIndex = (selectedIndex - 1 + count) % count;
          render();
          return;
        }
      } catch {
        finish(1);
      }
    }

    interval = setInterval(() => {
      try {
        model = buildMetaDashboardModel({ tmux });
        render();
      } catch {
        finish(1);
      }
    }, REFRESH_MS);

    process.stdin.on("data", onData);
  });
}
