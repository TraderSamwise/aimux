import { spawnSync } from "node:child_process";
import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import type { FastControlContext, FastControlItem } from "../fast-control.js";
import { parseKeys } from "../key-parser.js";
import { TerminalHost } from "../terminal-host.js";
import { stripAnsi, truncateAnsi, truncatePlain } from "../tui/render/text.js";
import {
  initialExposeScope,
  loadExposeScopeItems,
  nextExposeScope,
  type ExposeScopeItem,
  type ExposeSublabel,
} from "./expose-model.js";
import { isMetaDashboardWindowName, TmuxRuntimeManager } from "./runtime-manager.js";

export interface TmuxExposeOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
  /** Baked AIMUX_HOME so cross-project Exposé reads the right project registry. */
  aimuxHome?: string;
}

const CAPTURE_LINES = 40;
// Preview refresh cadence scales with tile count: snappy for a few tiles, easier
// on CPU when many panes are captured per tick (each tile is one capture-pane).
function refreshDelayMs(count: number): number {
  if (count > 8) return 1000;
  if (count > 4) return 500;
  return 250;
}
const GAP = 1;
const MIN_TILE_WIDTH = 30;
const MIN_TILE_HEIGHT = 5;

// Balanced grid: keep a single row up to 3 tiles, then grow toward a near-square
// (4→2x2, 5-6→2x3, 7-9→3x3, 10-12→3x4, …). Width/height limits narrow it further.
export function balancedCols(count: number): number {
  if (count <= 3) return Math.max(1, count);
  return Math.ceil(Math.sqrt(count));
}

const RESET = "\x1b[0m";

function shortWorktree(item: FastControlItem, projectRoot: string): string {
  const wt = item.metadata.worktreePath;
  if (!wt || pathResolve(wt) === pathResolve(projectRoot)) return "main";
  return basename(wt);
}

// Keep SGR color/style sequences from captured agent output so previews render in
// their real colors, but strip everything else dangerous (cursor moves, OSC, other
// control bytes) so a rogue pane can't hijack the host terminal or misalign borders.
function sanitizeLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, (m) => (/^\x1b\[[0-9;:]*m$/.test(m) ? m : ""))
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;:?]*[ -/]*$/g, "")
    .replace(/\x1b[^[]/g, "")
    .replace(/\x1b$/, "")
    .replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, " ");
}

function tilePreview(raw: string, count: number): string[] {
  const lines = raw.replace(/\r/g, "").split("\n").map(sanitizeLine);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  const tail = lines.slice(-count);
  while (tail.length < count) tail.push("");
  return tail;
}

function runWindowSwitch(options: TmuxExposeOptions, targetWindowId: string): number {
  const scriptPath = fileURLToPath(new URL("../../scripts/tmux-control.sh", import.meta.url));
  const args = [
    scriptPath,
    "window",
    "--project-root",
    options.projectRoot,
    "--project-state-dir",
    options.projectStateDir,
    "--window-id",
    targetWindowId,
    "--current-window-id",
    options.currentWindowId ?? "",
    "--current-window",
    options.currentWindow ?? "",
    "--current-client-session",
    options.currentClientSession ?? "",
    "--client-tty",
    options.clientTty ?? "",
    "--current-path",
    options.currentPath ?? "",
    "--pane-id",
    options.paneId ?? "",
  ];
  const result = spawnSync("sh", args, { stdio: "ignore" });
  return result.status ?? 1;
}

interface GridLayout {
  tileCols: number;
  tileWidth: number;
  tileHeight: number;
  bodyLines: number;
  visibleCount: number;
  gridTopRow: number;
}

export function computeLayout(itemCount: number, cols: number, rows: number): GridLayout {
  const gridTopRow = 3;
  const footerRow = rows;
  const gridHeight = Math.max(1, footerRow - gridTopRow);
  const fitCols = Math.max(1, Math.floor((cols + GAP) / (MIN_TILE_WIDTH + GAP)));
  const tileCols = Math.max(1, Math.min(balancedCols(itemCount), fitCols));
  const neededRows = Math.ceil(itemCount / tileCols);
  const maxTileRows = Math.max(1, Math.floor(gridHeight / MIN_TILE_HEIGHT));
  const tileRows = Math.max(1, Math.min(neededRows, maxTileRows));
  const tileWidth = Math.max(4, Math.floor((cols - (tileCols - 1) * GAP) / tileCols));
  const tileHeight = Math.floor(gridHeight / tileRows);
  return {
    tileCols,
    tileWidth,
    tileHeight,
    bodyLines: Math.max(1, tileHeight - 3),
    visibleCount: Math.min(itemCount, tileCols * tileRows),
    gridTopRow,
  };
}

function drawTile(
  item: ExposeScopeItem,
  preview: string[],
  badge: number,
  selected: boolean,
  top: number,
  left: number,
  width: number,
  layout: GridLayout,
  sublabel: string,
  options: TmuxExposeOptions,
): string {
  const innerW = Math.max(1, width - 2);
  const textW = Math.max(0, innerW - 1);
  const border = selected ? "\x1b[38;5;39m" : "\x1b[38;5;240m";
  const headerStyle = selected ? "\x1b[1;38;5;39m" : "\x1b[1m";
  const sub = sublabel ? `  ${sublabel}` : "";
  const here = item.target.windowId === options.currentWindowId ? " (here)" : "";
  const badgeLabel = badge <= 9 ? String(badge) : "·";
  const header = truncatePlain(`${badgeLabel} ${item.label}${sub}${here}`, textW);

  const rows: string[] = [];
  rows.push(`${border}┌${"─".repeat(innerW)}┐${RESET}`);
  rows.push(`${border}│${RESET}${headerStyle} ${header.padEnd(textW)}${RESET}${border}│${RESET}`);
  for (let b = 0; b < layout.bodyLines; b += 1) {
    const text = truncateAnsi(preview[b] ?? "", textW);
    const pad = Math.max(0, textW - stripAnsi(text).length);
    rows.push(`${border}│${RESET} ${text}${" ".repeat(pad)}${RESET}${border}│${RESET}`);
  }
  rows.push(`${border}└${"─".repeat(innerW)}┘${RESET}`);

  let out = "";
  for (let k = 0; k < rows.length; k += 1) {
    out += `\x1b[${top + k};${left}H${rows[k]}`;
  }
  return out;
}

export async function runTmuxExpose(options: TmuxExposeOptions): Promise<number> {
  if (options.aimuxHome) process.env.AIMUX_HOME = options.aimuxHome;
  const tmux = new TmuxRuntimeManager();

  // On the meta-dashboard window Exposé starts cross-project (global); otherwise it
  // starts scoped to the launch context. Pressing `g` zooms out along the ladder
  // worktree → project → global; the rung is ephemeral (never persisted).
  const crossProject = isMetaDashboardWindowName(options.currentWindow ?? "");
  const context: FastControlContext = {
    projectRoot: options.projectRoot,
    currentPath: options.currentPath,
    currentWindow: options.currentWindow,
    currentWindowId: options.currentWindowId,
    currentClientSession: options.currentClientSession,
  };
  // Resolve config for the explicit project root without write side effects — a
  // popup must never register the project or rewrite state, which would refresh
  // the dashboard and move its selection cursor.
  const config = loadConfig({ projectRoot: options.projectRoot });

  let scope = initialExposeScope(crossProject, context, config);
  let view = loadExposeScopeItems(scope, context, { tmux });
  let items = view.items;
  let scopeLabel = view.scopeLabel;
  let sublabel: ExposeSublabel = view.sublabel;

  const tileSublabel = (item: ExposeScopeItem): string =>
    sublabel === "project"
      ? (item.projectName ?? "")
      : sublabel === "worktree"
        ? shortWorktree(item, options.projectRoot)
        : "";

  const terminal = new TerminalHost();
  terminal.enterRawMode();
  terminal.enterAlternateScreen(true);
  process.stdout.write("\x1b[?25l");

  let timer: ReturnType<typeof setTimeout> | null = null;
  const exit = (code: number): number => {
    if (timer) clearTimeout(timer);
    process.stdout.write("\x1b[?25h");
    terminal.restoreTerminalState();
    return code;
  };

  // Restore the terminal if tmux (or anything) kills the popup with a signal.
  const onFatalSignal = () => process.exit(exit(0));
  process.once("SIGINT", onFatalSignal);
  process.once("SIGTERM", onFatalSignal);

  const captures = new Map<string, string>();
  const refreshCaptures = () => {
    for (const item of items) {
      try {
        captures.set(
          item.target.windowId,
          tmux.captureTarget(item.target, { startLine: -CAPTURE_LINES, includeEscapes: true }),
        );
      } catch {
        captures.set(item.target.windowId, captures.get(item.target.windowId) ?? "");
      }
    }
  };

  const currentIdx = items.findIndex((item) => item.target.windowId === options.currentWindowId);
  let index = currentIdx >= 0 ? currentIdx : 0;
  let tileCols = 1;
  let visibleCount = items.length;

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const layout = computeLayout(items.length, cols, rows);
    tileCols = layout.tileCols;
    visibleCount = layout.visibleCount;
    if (index >= visibleCount) index = Math.max(0, visibleCount - 1);

    const title = `\x1b[1mExposé · ${scopeLabel} (${items.length})${RESET}`;
    const hidden = items.length - visibleCount;
    const more = hidden > 0 ? `   +${hidden} more (use ^A s)` : "";
    const zoom = scope === "global" ? "" : " · g zoom out";
    const help = `\x1b[2m1-9 jump · ↑↓←→/n/p move · Enter open${zoom} · q/Esc close${more}${RESET}`;

    if (visibleCount === 0) {
      const msg = `No active agents in ${scopeLabel}.`;
      const col = Math.max(1, Math.floor((cols - msg.length) / 2));
      const out = `\x1b[2J\x1b[H\x1b[1;2H${title}\x1b[${Math.floor(rows / 2)};${col}H\x1b[2m${msg}${RESET}\x1b[${rows};2H${help}`;
      process.stdout.write(out);
      return;
    }

    let out = `\x1b[2J\x1b[H\x1b[1;2H${title}`;
    for (let i = 0; i < visibleCount; i += 1) {
      const r = Math.floor(i / layout.tileCols);
      const c = i % layout.tileCols;
      const top = layout.gridTopRow + r * layout.tileHeight;
      const left = 1 + c * (layout.tileWidth + GAP);
      const preview = tilePreview(captures.get(items[i]!.target.windowId) ?? "", layout.bodyLines);
      out += drawTile(
        items[i]!,
        preview,
        i + 1,
        i === index,
        top,
        left,
        layout.tileWidth,
        layout,
        tileSublabel(items[i]!),
        options,
      );
    }
    out += `\x1b[${rows};2H${help}`;
    process.stdout.write(out);
  };

  // Reload tiles for the current rung after a zoom: swap items/labels, drop stale
  // captures, re-seek the selection to the current window, and re-capture.
  const reload = () => {
    view = loadExposeScopeItems(scope, context, { tmux });
    items = view.items;
    scopeLabel = view.scopeLabel;
    sublabel = view.sublabel;
    captures.clear();
    const idx = items.findIndex((item) => item.target.windowId === options.currentWindowId);
    index = idx >= 0 ? idx : 0;
    refreshCaptures();
  };

  refreshCaptures();
  render();

  return await new Promise<number>((resolve) => {
    const finish = (code: number) => {
      process.stdin.off("data", onData);
      resolve(exit(code));
    };

    const selectTile = (i: number) => {
      const item = items[i];
      if (!item) return;
      if (item.projectRoot) {
        // Cross-project tile: the popup client is ephemeral, so switch the real
        // client (by tty) into the target project's per-client session via
        // openTarget's explicit-client path.
        const suffix = options.currentClientSession?.match(/-client-([a-f0-9]{8})$/)?.[1];
        try {
          tmux.openTarget(
            { ...item.target, sessionName: tmux.getProjectSession(item.projectRoot).sessionName },
            {
              insideTmux: true,
              clientTty: options.clientTty,
              clientSuffix: suffix,
              returnSessionName: options.currentClientSession,
            },
          );
        } catch {
          /* target vanished mid-jump; close Exposé regardless */
        }
        finish(0);
        return;
      }
      finish(runWindowSwitch(options, item.target.windowId));
    };

    function onData(data: Buffer) {
      try {
        const event = parseKeys(data)[0];
        if (!event) return;
        const key = event.name || event.char || "";

        if (key === "q" || key === "escape" || (event.ctrl && key === "c")) {
          finish(0);
          return;
        }
        if (key === "g") {
          const next = nextExposeScope(scope);
          if (next !== scope) {
            scope = next;
            reload();
            render();
          }
          return;
        }
        if (key >= "1" && key <= "9") {
          const target = Number.parseInt(key, 10) - 1;
          if (target < visibleCount) selectTile(target);
          return;
        }
        if (key === "enter" || key === "return") {
          selectTile(index);
          return;
        }
        if (visibleCount === 0) return;
        if (key === "right" || key === "l" || key === "n" || key === "tab") {
          index = (index + 1) % visibleCount;
          render();
          return;
        }
        if (key === "left" || key === "h" || key === "p") {
          index = (index - 1 + visibleCount) % visibleCount;
          render();
          return;
        }
        if (key === "down" || key === "j") {
          if (index + tileCols < visibleCount) index += tileCols;
          render();
          return;
        }
        if (key === "up" || key === "k") {
          if (index - tileCols >= 0) index -= tileCols;
          render();
          return;
        }
      } catch {
        finish(1);
      }
    }

    // Recursive timeout (not setInterval) so the cadence re-derives from the
    // current tile count after a zoom changes how many panes are captured.
    const scheduleRefresh = () => {
      timer = setTimeout(() => {
        try {
          refreshCaptures();
          render();
          scheduleRefresh();
        } catch {
          finish(1);
        }
      }, refreshDelayMs(items.length));
    };
    scheduleRefresh();

    process.stdin.on("data", onData);
  });
}
