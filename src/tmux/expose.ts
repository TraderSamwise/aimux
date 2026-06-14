import { spawnSync } from "node:child_process";
import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import type { FastControlItem } from "../fast-control.js";
import { parseKeys } from "../key-parser.js";
import { TerminalHost } from "../terminal-host.js";
import { truncatePlain } from "../tui/render/text.js";
import { listExposeAgentItems } from "./expose-model.js";
import { TmuxRuntimeManager } from "./runtime-manager.js";

export interface TmuxExposeOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
}

const CAPTURE_LINES = 40;
const REFRESH_MS = 1000;
const GAP = 1;
const MAX_TILE_COLS = 5;
const MIN_TILE_WIDTH = 30;
const MIN_TILE_HEIGHT = 5;

const RESET = "\x1b[0m";
const BODY_STYLE = "\x1b[38;5;245m";

function shortWorktree(item: FastControlItem, projectRoot: string): string {
  const wt = item.metadata.worktreePath;
  if (!wt || pathResolve(wt) === pathResolve(projectRoot)) return "main";
  return basename(wt);
}

// Strip escape sequences and stray control bytes from captured agent output so a
// rogue pane can't inject escapes into the host terminal or misalign tile borders.
function sanitizeLine(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ");
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

function computeLayout(itemCount: number, cols: number, rows: number): GridLayout {
  const gridTopRow = 3;
  const footerRow = rows;
  const gridHeight = Math.max(1, footerRow - gridTopRow);
  const tileCols = Math.max(1, Math.min(MAX_TILE_COLS, itemCount, Math.floor((cols + GAP) / (MIN_TILE_WIDTH + GAP))));
  const neededRows = Math.ceil(itemCount / tileCols);
  const maxTileRows = Math.max(1, Math.floor(gridHeight / MIN_TILE_HEIGHT));
  const tileRows = Math.min(neededRows, maxTileRows);
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
  item: FastControlItem,
  preview: string[],
  badge: number,
  selected: boolean,
  top: number,
  left: number,
  width: number,
  layout: GridLayout,
  scope: string,
  options: TmuxExposeOptions,
): string {
  const innerW = Math.max(1, width - 2);
  const textW = Math.max(0, innerW - 1);
  const border = selected ? "\x1b[38;5;39m" : "\x1b[38;5;240m";
  const headerStyle = selected ? "\x1b[1;38;5;39m" : "\x1b[1m";
  const wt = scope === "all" ? `  ${shortWorktree(item, options.projectRoot)}` : "";
  const here = item.target.windowId === options.currentWindowId ? " (here)" : "";
  const badgeLabel = badge <= 9 ? String(badge) : "·";
  const header = truncatePlain(`${badgeLabel} ${item.label}${wt}${here}`, textW);

  const rows: string[] = [];
  rows.push(`${border}┌${"─".repeat(innerW)}┐${RESET}`);
  rows.push(`${border}│${RESET}${headerStyle} ${header.padEnd(textW)}${RESET}${border}│${RESET}`);
  for (let b = 0; b < layout.bodyLines; b += 1) {
    const text = truncatePlain(preview[b] ?? "", textW);
    rows.push(`${border}│${RESET}${BODY_STYLE} ${text.padEnd(textW)}${RESET}${border}│${RESET}`);
  }
  rows.push(`${border}└${"─".repeat(innerW)}┘${RESET}`);

  let out = "";
  for (let k = 0; k < rows.length; k += 1) {
    out += `\x1b[${top + k};${left}H${rows[k]}`;
  }
  return out;
}

export async function runTmuxExpose(options: TmuxExposeOptions): Promise<number> {
  // Resolve config for the explicit project root without write side effects — a
  // popup must never register the project or rewrite state, which would refresh
  // the dashboard and move its selection cursor.
  const config = loadConfig({ projectRoot: options.projectRoot });
  const tmux = new TmuxRuntimeManager();
  const { scope, items } = listExposeAgentItems(
    {
      projectRoot: options.projectRoot,
      currentPath: options.currentPath,
      currentWindow: options.currentWindow,
      currentWindowId: options.currentWindowId,
      currentClientSession: options.currentClientSession,
    },
    config,
    tmux,
  );

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

  // Restore the terminal if tmux (or anything) kills the popup with a signal.
  const onFatalSignal = () => process.exit(exit(0));
  process.once("SIGINT", onFatalSignal);
  process.once("SIGTERM", onFatalSignal);

  const scopeLabel = scope === "all" ? "all worktrees" : "this worktree";

  if (items.length === 0) {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const msg = `No active agents in ${scopeLabel}.  q/Esc to close`;
    process.stdout.write(
      `\x1b[2J\x1b[H\x1b[${Math.floor(rows / 2)};${Math.max(1, Math.floor((cols - msg.length) / 2))}H${msg}`,
    );
    return await new Promise<number>((resolve) => {
      const onData = (data: Buffer) => {
        try {
          const event = parseKeys(data)[0];
          const key = event?.name || event?.char || "";
          if (key === "q" || key === "escape" || (event?.ctrl && key === "c")) {
            process.stdin.off("data", onData);
            resolve(exit(0));
          }
        } catch {
          process.stdin.off("data", onData);
          resolve(exit(1));
        }
      };
      process.stdin.on("data", onData);
    });
  }

  const captures = new Map<string, string>();
  const refreshCaptures = () => {
    for (const item of items) {
      try {
        captures.set(item.target.windowId, tmux.captureTarget(item.target, { startLine: -CAPTURE_LINES }));
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
    if (index >= visibleCount) index = visibleCount - 1;

    const title = `\x1b[1mExposé · ${scopeLabel} (${items.length})${RESET}`;
    const hidden = items.length - visibleCount;
    const more = hidden > 0 ? `   +${hidden} more (use ^A s)` : "";
    const help = `\x1b[2m1-9 jump · ↑↓←→/n/p move · Enter open · q/Esc close${more}${RESET}`;

    let out = `\x1b[2J\x1b[H\x1b[1;2H${title}`;
    for (let i = 0; i < visibleCount; i += 1) {
      const r = Math.floor(i / layout.tileCols);
      const c = i % layout.tileCols;
      const top = layout.gridTopRow + r * layout.tileHeight;
      const left = 1 + c * (layout.tileWidth + GAP);
      const preview = tilePreview(captures.get(items[i]!.target.windowId) ?? "", layout.bodyLines);
      out += drawTile(items[i]!, preview, i + 1, i === index, top, left, layout.tileWidth, layout, scope, options);
    }
    out += `\x1b[${rows};2H${help}`;
    process.stdout.write(out);
  };

  refreshCaptures();
  render();

  return await new Promise<number>((resolve) => {
    const finish = (code: number) => {
      process.stdin.off("data", onData);
      resolve(exit(code));
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
        if (key >= "1" && key <= "9") {
          const target = Number.parseInt(key, 10) - 1;
          if (target < visibleCount) finish(runWindowSwitch(options, items[target]!.target.windowId));
          return;
        }
        if (key === "enter" || key === "return") {
          finish(runWindowSwitch(options, items[index]!.target.windowId));
          return;
        }
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

    interval = setInterval(() => {
      try {
        refreshCaptures();
        render();
      } catch {
        finish(1);
      }
    }, REFRESH_MS);

    process.stdin.on("data", onData);
  });
}
