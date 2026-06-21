import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import type { FastControlContext, FastControlItem } from "../fast-control.js";
import { parseKeys } from "../key-parser.js";
import { formatRelativeRecency } from "../recency.js";
import { TerminalHost } from "../terminal-host.js";
import { truncateAnsi, wrapText } from "../tui/render/text.js";
import { agentStatusKind, renderAgentStatusPill } from "../tui/render/agent-status.js";
import { recede, style, visibleWidth, type StatusKind } from "../tui/render/theme.js";
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
  /** Host snapshot captured by the launcher before the popup opened (read once, then deleted). */
  backdropFile?: string;
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

// Paint a captured host screen as a dimmed full-screen backdrop, so the floating tile
// grid reads above the user's real (receded) content. Each line is sanitized (control
// bytes stripped, SGR kept), clamped to the viewport, then dimmed via recede "faint".
export function buildBackdrop(capture: string, cols: number, rows: number): string {
  if (!capture) return "";
  const lines = capture.replace(/\r/g, "").split("\n");
  const count = Math.min(lines.length, rows);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += `\x1b[${i + 1};1H${recede(truncateAnsi(sanitizeLine(lines[i]!), cols), "faint")}`;
  }
  return out;
}

// Exposé floats as an inset panel (centred, ~90%) over the dimmed backdrop, like a dialog.
const PANEL_RATIO = 0.9;
const PANEL_BORDER = "\x1b[38;5;248m";

export interface PanelGeometry {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function panelGeometry(cols: number, rows: number): PanelGeometry {
  // Clamp to the viewport last so the floor never makes the panel larger than the screen.
  const width = Math.min(cols, Math.max(MIN_TILE_WIDTH + 2, Math.round(cols * PANEL_RATIO)));
  const height = Math.min(rows, Math.max(MIN_TILE_HEIGHT + 4, Math.round(rows * PANEL_RATIO)));
  const left = Math.max(1, Math.floor((cols - width) / 2) + 1);
  const top = Math.max(1, Math.floor((rows - height) / 2) + 1);
  return { top, left, width, height };
}

// An opaque bordered box that covers the dimmed backdrop so the panel body reads as solid;
// tiles/title/help are drawn on top of it. Border rows position absolutely.
export function buildPanelFrame(geo: PanelGeometry): string {
  const innerW = Math.max(0, geo.width - 2);
  const fill = " ".repeat(innerW);
  let out = `\x1b[${geo.top};${geo.left}H${PANEL_BORDER}╭${"─".repeat(innerW)}╮${RESET}`;
  for (let r = 1; r < geo.height - 1; r += 1) {
    out += `\x1b[${geo.top + r};${geo.left}H${PANEL_BORDER}│${RESET}${fill}${PANEL_BORDER}│${RESET}`;
  }
  out += `\x1b[${geo.top + geo.height - 1};${geo.left}H${PANEL_BORDER}╰${"─".repeat(innerW)}╯${RESET}`;
  return out;
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

// 256-color tile borders tinted to the agent's state, with a bright (selected) and
// dimmed (unselected) variant. This is Exposé's selection model — distinct from the
// chip/pill tone, which carries the label color via the shared status vocabulary.
const STATE_BORDER: Partial<Record<StatusKind, { on: string; off: string }>> = {
  working: { on: "38;5;38", off: "38;5;24" },
  ready: { on: "38;5;75", off: "38;5;67" },
  idle: { on: "38;5;108", off: "38;5;65" },
  offline: { on: "38;5;244", off: "38;5;238" },
  needs: { on: "38;5;179", off: "38;5;94" },
  error: { on: "38;5;174", off: "38;5;88" },
  done: { on: "38;5;71", off: "38;5;28" },
  blocked: { on: "38;5;176", off: "38;5;97" },
};
const NEUTRAL_BORDER = { on: "38;5;39", off: "38;5;240" };

// Inline title in the top rule when the worktree/project context fits; otherwise drop
// the context onto its own wrapped row(s). The status pill always gets its own row, so
// the state signal stays legible no matter how narrow the tile is.
export function buildTileHeader(
  textW: number,
  width: number,
  titleLeft: string,
  context: string,
  pillStr: string,
  detail: string,
  inset: number,
): { ruleTitle: string; headerRows: string[] } {
  const pad = " ".repeat(Math.max(0, inset));
  const contentW = Math.max(1, textW - inset);
  const titleMax = Math.max(0, width - 6);
  const headerRows: string[] = [];
  let ruleTitle = titleLeft;
  if (context) {
    const wide = `${titleLeft} ${style(`· ${context}`, "muted")}`;
    if (visibleWidth(wide) <= titleMax) {
      ruleTitle = wide;
    } else {
      for (const line of wrapText(context, contentW)) headerRows.push(`${pad}${style(line, "muted")}`);
    }
  }
  ruleTitle = truncateAnsi(ruleTitle, titleMax);
  // The status row carries the pill plus the agent's status text (the dashboard's
  // "last message" semantics), inset to line up under the title text in the rule.
  const statusRow = [pillStr, detail ? style(detail, "muted") : ""].filter(Boolean).join("  ");
  if (statusRow) headerRows.push(`${pad}${statusRow}`);
  return { ruleTitle, headerRows };
}

// Clamp header rows to the tile's body capacity so a wrapped header can never push
// the tile past its height (which would overwrite the tile below). Context rows are
// dropped first; the status pill (the last row) is preserved.
export function fitHeaderRows(headerRows: string[], capacity: number, hasPill: boolean): string[] {
  if (headerRows.length <= capacity) return headerRows;
  if (!hasPill) return headerRows.slice(0, capacity);
  const pillRow = headerRows[headerRows.length - 1]!;
  const contextRows = headerRows.slice(0, headerRows.length - 1);
  return [...contextRows.slice(0, Math.max(0, capacity - 1)), pillRow];
}

export function drawTile(
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
  dimInactive: boolean,
): string {
  const innerW = Math.max(1, width - 2);
  const textW = Math.max(0, innerW - 1);
  // Only non-selected tiles dim, and only when configured; the active tile is always full color.
  const dimmed = dimInactive && !selected;
  const kind = agentStatusKind(item.metadata);
  const palette = (kind && STATE_BORDER[kind]) || NEUTRAL_BORDER;
  const bd = `\x1b[${dimmed ? palette.off : palette.on}m`;
  // Focus is shown by a bolder (heavy-line) outline, not a distinct color, so the
  // border always reflects the agent's state.
  const box = selected
    ? { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

  const badgeLabel = badge <= 9 ? String(badge) : "·";
  // Reserve the marker slot whether or not selected so the title (and thus the
  // wide/narrow header breakpoint) doesn't shift as selection moves between tiles.
  const marker = selected ? `${style("▸", "accent")} ` : "  ";
  const here = item.target.windowId === options.currentWindowId ? style(" (here)", "muted") : "";
  const titleLeft = `${marker}${style(badgeLabel, selected ? "accent" : "strong")} ${style(item.label, "strong")}${here}`;
  const pillStr = renderAgentStatusPill(item.metadata);
  const rel = formatRelativeRecency(item.metadata.recencyAt) ?? "";
  const recency = rel && item.metadata.recencyLabel ? `${item.metadata.recencyLabel} ${rel}` : rel;
  const statusText = (item.metadata.statusText ?? "").replace(/[\r\n]+/g, " ").trim();
  const detail = [recency, statusText].filter(Boolean).join(" · ");
  // Inset the header rows by the marker width so they line up under the title text.
  const inset = visibleWidth(marker);
  const { ruleTitle, headerRows } = buildTileHeader(textW, width, titleLeft, sublabel, pillStr, detail, inset);

  const bodyCapacity = Math.max(1, layout.tileHeight - 2);
  // The status row is the last header row; preserve it under capacity pressure when
  // it carries either the pill or the recency/status detail.
  const header = fitHeaderRows(headerRows, bodyCapacity, pillStr !== "" || detail !== "");
  // Dimmed (non-selected, when enabled) tiles flatten their preview to gray so the chrome
  // reads above it; otherwise previews keep the captured pane's real colors.
  const previewRows = preview
    .slice(0, Math.max(0, bodyCapacity - header.length))
    .map((line) => (dimmed ? recede(line, "deep") : line));
  const bodyRows = [...header, ...previewRows];
  while (bodyRows.length < bodyCapacity) bodyRows.push("");

  const titleSep = visibleWidth(ruleTitle) > 0 ? " " : "";
  const dashCount = Math.max(0, width - 3 - visibleWidth(ruleTitle) - titleSep.length);
  const rows: string[] = [];
  rows.push(`${bd}${box.tl} ${RESET}${ruleTitle}${titleSep}${bd}${box.h.repeat(dashCount)}${box.tr}${RESET}`);
  for (const content of bodyRows) {
    const text = truncateAnsi(content, textW);
    const pad = Math.max(0, textW - visibleWidth(text));
    rows.push(`${bd}${box.v}${RESET} ${text}${" ".repeat(pad)}${bd}${box.v}${RESET}`);
  }
  rows.push(`${bd}${box.bl}${box.h.repeat(innerW)}${box.br}${RESET}`);

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

  const tileSublabel = (item: ExposeScopeItem): string => {
    if (sublabel === "worktree") return shortWorktree(item, options.projectRoot);
    if (sublabel === "project-worktree") {
      const worktree = shortWorktree(item, item.projectRoot ?? options.projectRoot);
      return item.projectName ? `${item.projectName} / ${worktree}` : worktree;
    }
    return "";
  };

  // Read and delete the launcher's backdrop snapshot up front, before any terminal
  // state or signal handlers exist, so a fatal signal during startup can't leak the
  // temp file. Opening the popup transiently reflows the host pane, so capturing
  // in-popup would catch a mis-sized (off-centre) frame — hence the launcher capture.
  let hostCapture = "";
  if (options.backdropFile) {
    try {
      hostCapture = readFileSync(options.backdropFile, "utf8");
    } catch {
      hostCapture = "";
    }
    try {
      unlinkSync(options.backdropFile);
    } catch {}
  }

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
  // Returns whether any capture changed, so the refresh loop can skip a repaint when
  // idle — the dominant cause of the periodic flicker was repainting unchanged tiles.
  const refreshCaptures = (): boolean => {
    let changed = false;
    for (const item of items) {
      let next: string;
      try {
        next = tmux.captureTarget(item.target, { startLine: -CAPTURE_LINES, includeEscapes: true });
      } catch {
        next = captures.get(item.target.windowId) ?? "";
      }
      if (next !== captures.get(item.target.windowId)) changed = true;
      captures.set(item.target.windowId, next);
    }
    return changed;
  };

  // Fall back to capturing the host pane now only when the launcher passed no snapshot.
  if (!hostCapture) {
    // Prefer the exact host window; fall back to the client session's active pane.
    const hostTarget = options.currentWindowId || options.currentClientSession;
    if (hostTarget) {
      try {
        hostCapture = tmux.captureTarget(
          { sessionName: "", windowId: hostTarget, windowIndex: 0, windowName: "" },
          { startLine: 0, includeEscapes: true },
        );
      } catch {
        hostCapture = "";
      }
    }
  }

  const currentIdx = items.findIndex((item) => item.target.windowId === options.currentWindowId);
  let index = currentIdx >= 0 ? currentIdx : 0;
  let tileCols = 1;
  let visibleCount = items.length;
  let lastRenderSize = "";
  let staticSize = "";
  let staticVisibleCount = -1;

  const render = (full = true) => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const geo = panelGeometry(cols, rows);
    const innerW = geo.width - 2;
    const innerH = geo.height - 2;
    const layout = computeLayout(items.length, innerW, innerH);
    tileCols = layout.tileCols;
    visibleCount = layout.visibleCount;
    if (index >= visibleCount) index = Math.max(0, visibleCount - 1);

    const hidden = items.length - visibleCount;
    const more = hidden > 0 ? `   +${hidden} more (use ^A s)` : "";
    const zoom = scope === "global" ? "" : " · g zoom out";
    const title = truncateAnsi(`\x1b[1mExposé · ${scopeLabel} (${items.length})${RESET}`, innerW - 2);
    const help = truncateAnsi(
      `\x1b[2m1-9 jump · ↑↓←→/n/p move · Enter open${zoom} · q/Esc close${more}${RESET}`,
      innerW - 2,
    );

    // Wrap each frame in synchronized output so the repaint lands atomically. The dimmed
    // backdrop and panel frame are static (they depend only on size), so only repaint them
    // on a full render, a resize, or a tile-count change; the periodic capture refresh and
    // navigation repaint just the opaque tiles in place. This avoids the full-screen
    // blank-and-repaint that flickers on terminals which ignore synchronized output.
    const size = `${cols}x${rows}`;
    const needsStatic = full || size !== staticSize || visibleCount !== staticVisibleCount;
    let base = "\x1b[?2026h";
    if (needsStatic) {
      const clear = size === lastRenderSize ? "" : "\x1b[2J";
      lastRenderSize = size;
      staticSize = size;
      staticVisibleCount = visibleCount;
      // Dimmed real backdrop fills the screen; the opaque panel floats inset over it.
      base += `${clear}${buildBackdrop(hostCapture, cols, rows)}${buildPanelFrame(geo)}`;
    }
    const titleAt = `\x1b[${geo.top + 1};${geo.left + 2}H${title}`;
    const helpAt = `\x1b[${geo.top + innerH};${geo.left + 2}H${help}`;

    if (visibleCount === 0) {
      const msg = `No active agents in ${scopeLabel}.`;
      const msgCol = geo.left + 1 + Math.max(0, Math.floor((innerW - msg.length) / 2));
      const msgRow = geo.top + Math.floor(innerH / 2);
      process.stdout.write(`${base}${titleAt}\x1b[${msgRow};${msgCol}H\x1b[2m${msg}${RESET}${helpAt}\x1b[?2026l`);
      return;
    }

    let out = `${base}${titleAt}`;
    for (let i = 0; i < visibleCount; i += 1) {
      const r = Math.floor(i / layout.tileCols);
      const c = i % layout.tileCols;
      const top = geo.top + layout.gridTopRow + r * layout.tileHeight;
      const left = geo.left + 1 + c * (layout.tileWidth + GAP);
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
        config.expose.dimInactive,
      );
    }
    out += `${helpAt}\x1b[?2026l`;
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

  // Paint the backdrop, panel, and tile chrome immediately (previews blank), then capture
  // previews and repaint just the tiles — so entry shows the framed exposé at once instead
  // of a blank wait, without re-blanking the backdrop.
  render();
  if (refreshCaptures()) render(false);

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
          tmux.openTarget(item.target, {
            insideTmux: true,
            clientTty: options.clientTty,
            clientSuffix: suffix,
            returnSessionName: options.currentClientSession,
          });
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
          render(false);
          return;
        }
        if (key === "left" || key === "h" || key === "p") {
          index = (index - 1 + visibleCount) % visibleCount;
          render(false);
          return;
        }
        if (key === "down" || key === "j") {
          if (index + tileCols < visibleCount) index += tileCols;
          render(false);
          return;
        }
        if (key === "up" || key === "k") {
          if (index - tileCols >= 0) index -= tileCols;
          render(false);
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
          // Repaint on changed captures or a terminal resize (no SIGWINCH handler), so an
          // idle exposé still reflows when the window size changes.
          const captureChanged = refreshCaptures();
          const sizeNow = `${process.stdout.columns ?? 80}x${process.stdout.rows ?? 24}`;
          if (captureChanged || sizeNow !== staticSize) render(false);
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
