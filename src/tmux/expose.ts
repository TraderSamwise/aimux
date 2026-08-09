import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { basename, resolve as pathResolve } from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../debug.js";
import { resolveScopedWorktreePath, type FastControlContext, type FastControlItem } from "../fast-control.js";
import { parseKeys } from "../key-parser.js";
import { formatRelativeRecency } from "../recency.js";
import { TerminalHost } from "../terminal-host.js";
import { truncateAnsi, wrapText } from "../tui/render/text.js";
import { agentStatusKind, renderAgentStatusPill } from "../tui/render/agent-status.js";
import { recede, style, visibleWidth, type StatusKind } from "../tui/render/theme.js";
import {
  focusExposeItem,
  initialExposeScope,
  loadExposeScopeItems,
  nextExposeScope,
  type ExposeConfig,
  type ExposeScope,
  type ExposeScopeItem,
  type ExposeScopeView,
  type ExposeSublabel,
} from "./expose-model.js";
import { readHotExposeScopeView, writeHotExposeScopeView, type HotExposeScopeKey } from "./expose-hot-snapshot.js";
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
  /** Legacy standalone CLI value; the sidecar path passes daemonEndpoint instead. */
  aimuxHome?: string;
  daemonEndpoint?: string;
  selectionFile?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream & { columns?: number; rows?: number };
  manageTerminal?: boolean;
  columns?: number;
  rows?: number;
  exposeConfig?: ExposeConfig;
  onTiming?: (event: TmuxExposeTimingEvent) => void;
}

export type TmuxExposeTimingEventName =
  | "start"
  | "terminal-ready"
  | "items-load-start"
  | "items-load-end"
  | "items-load-stale"
  | "items-load-error"
  | "first-render"
  | "first-items-render"
  | "first-live-capture-start"
  | "first-live-capture-end"
  | "focus-start"
  | "focus-end"
  | "exit";

export interface TmuxExposeTimingEvent {
  name: TmuxExposeTimingEventName;
  elapsedMs: number;
  scope?: ExposeScope;
  itemCount?: number;
  previewSnapshotCount?: number;
  captureChanged?: boolean;
  exitCode?: number;
}

const CAPTURE_LINES = 40;
const ITEM_RELOAD_EVERY_TICKS = 5;
const INPUT_QUIET_BEFORE_REFRESH_MS = 120;
const RESIZE_CHECK_DURING_INPUT_MS = 1000;
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

// tmux popups keep launch dimensions after terminal resize. Exposé exits with this
// code when the controlling client size changes so the launcher can relaunch it.
const RELAUNCH_ON_RESIZE_EXIT = 75;

/** Pick one client's `WxH` out of a `list-clients` listing, by tty. */
export function matchClientSize(listing: string, clientTty: string): string {
  const wanted = basename(clientTty);
  for (const line of listing.split("\n")) {
    const [tty, size] = line.trim().split(/\s+/);
    if (!tty || !size) continue;
    if (tty === clientTty || basename(tty) === wanted) return size;
  }
  return "";
}

/**
 * The controlling client's size, by tty.
 *
 * `display-message -c <tty>` looks like the direct way to ask and is not: run outside
 * a client (this is a socket server, so always), tmux ignores `-c` for format
 * resolution and answers for whatever client its own heuristic picks. With several
 * clients on one session it reports a sibling's size, which never changes when the
 * client actually being resized does — resize detection silently never fires.
 * `list-clients` evaluates the format once per client, so the tty match is real.
 */
function queryClientSize(clientTty?: string): string {
  if (!clientTty) return "";
  try {
    const result = spawnSync(
      "tmux",
      ["list-clients", "-F", "#{client_tty} #{client_width}x#{client_height}"],
      // Bounded so a hung tmux server fails open (no resize check) instead of freezing
      // the popup's single-threaded refresh loop.
      { encoding: "utf8", timeout: 500 },
    );
    if (result.status === 0) return matchClientSize(result.stdout ?? "", clientTty);
  } catch {}
  return "";
}

function writeSelectedWindow(options: TmuxExposeOptions, item: ExposeScopeItem): boolean {
  if (!options.selectionFile) return false;
  if (item.projectRoot && pathResolve(item.projectRoot) !== pathResolve(options.projectRoot)) return false;
  try {
    writeFileSync(options.selectionFile, `${item.target.windowId}\n`);
    return true;
  } catch {
    return false;
  }
}

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

// Exposé is full-bleed: the popup already covers 100% of the client, so an inset panel
// only bought margins. Screen rows 1 and `rows` are the title and help bars; everything
// between belongs to the grid.
const TITLE_ROW = 1;
/** Screen column the title, help, and first tile column all start at. */
const CONTENT_LEFT = 1;

interface GridLayout {
  tileCols: number;
  tileWidth: number;
  tileHeight: number;
  bodyLines: number;
  visibleCount: number;
  /** Rows below the title bar the grid starts at. */
  gridTopRow: number;
  /** Rows available to the grid, between the title and help bars. */
  gridHeight: number;
}

export function computeLayout(itemCount: number, cols: number, rows: number): GridLayout {
  const gridTopRow = 1;
  const footerRow = rows - 1;
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
    gridHeight,
  };
}

export interface ExposeSectionGroup {
  label: string;
  count: number;
}

export interface ExposeSectionBand {
  row: number;
  label: string;
  count: number;
  tone: number;
}

export interface ExposeSectionPlan {
  /** Tile slots in item order; `row` is a text-row offset from the grid top. */
  slots: Array<{ row: number; col: number }>;
  bands: ExposeSectionBand[];
  visibleCount: number;
}

/**
 * Tiles must sit in project order for bands to bound contiguous runs. Only reorders when
 * bands will actually be drawn, so single-project and narrower scopes keep server order.
 */
export function orderExposeItems(view: ExposeScopeView): ExposeScopeItem[] {
  if (view.sublabel !== "project-worktree") return view.items;
  const groups = groupItemsByProject(view.items);
  return groups.length < 2 ? view.items : groups.flatMap((group) => group.items);
}

/** Ordered project groups, preserving first-seen project order and item order within one. */
export function groupItemsByProject(items: ExposeScopeItem[]): Array<{ label: string; items: ExposeScopeItem[] }> {
  const order: string[] = [];
  const buckets = new Map<string, ExposeScopeItem[]>();
  for (const item of items) {
    const label = item.projectName?.trim() || "unknown project";
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = [];
      buckets.set(label, bucket);
      order.push(label);
    }
    bucket.push(item);
  }
  return order.map((label) => ({ label, items: buckets.get(label)! }));
}

/**
 * Lay sections out down the grid: one band row per project, then that project's tiles
 * packed `tileCols` wide. A section that cannot fit its band plus one row of tiles is
 * dropped whole rather than orphaning a header, and tiles that run past the grid are
 * left out — the caller reports them as "+N more".
 */
export function planExposeSections(
  groups: ExposeSectionGroup[],
  tileCols: number,
  tileHeight: number,
  gridHeight: number,
): ExposeSectionPlan {
  const slots: Array<{ row: number; col: number }> = [];
  const bands: ExposeSectionBand[] = [];
  let row = 0;
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g]!;
    if (row + 1 + tileHeight > gridHeight) break;
    bands.push({ row, label: group.label, count: group.count, tone: g });
    row += 1;
    let placed = 0;
    while (placed < group.count) {
      if (row + tileHeight > gridHeight) return { slots, bands, visibleCount: slots.length };
      const take = Math.min(tileCols, group.count - placed);
      for (let c = 0; c < take; c += 1) slots.push({ row, col: c });
      placed += take;
      row += tileHeight;
    }
  }
  return { slots, bands, visibleCount: slots.length };
}

/**
 * Vertical move across a section plan. Section rows are ragged — a project's last row
 * can be short and the next project restarts at column 0 — so stepping by `tileCols`
 * would land on the wrong tile. Hold the column where the neighbouring row is wide
 * enough, otherwise take that row's last tile.
 */
export function moveExposeIndexVertically(
  slots: Array<{ row: number; col: number }>,
  index: number,
  delta: 1 | -1,
  visibleCount: number,
): number {
  const current = slots[index];
  if (!current) return index;
  const rows: number[] = [];
  for (let i = 0; i < visibleCount; i += 1) {
    const row = slots[i]?.row;
    if (row !== undefined && !rows.includes(row)) rows.push(row);
  }
  rows.sort((a, b) => a - b);
  const targetRow = rows[rows.indexOf(current.row) + delta];
  if (targetRow === undefined) return index;
  let fallback = index;
  for (let i = 0; i < visibleCount; i += 1) {
    const slot = slots[i];
    if (!slot || slot.row !== targetRow) continue;
    if (slot.col === current.col) return i;
    if (slot.col < current.col) fallback = i;
  }
  return fallback;
}

// Bands cycle a small palette so neighbouring projects never share a tint, and tile
// titles tint their worktree from the same palette. These are deliberately distinct
// from STATE_BORDER's meaning — a tone groups, it does not report.
const BAND_TONES = ["38;5;38", "38;5;71", "38;5;179", "38;5;176", "38;5;75", "38;5;209"];

/** Bold text in a grouping tone; `undefined` falls back to the plain strong tone. */
function toned(text: string, tone: number | undefined): string {
  if (tone === undefined) return style(text, "strong");
  return `\x1b[1;${BAND_TONES[tone % BAND_TONES.length]}m${text}${RESET}`;
}

function worktreeToneKey(item: ExposeScopeItem, projectRoot: string): string {
  return pathResolve(item.metadata.worktreePath || projectRoot);
}

/**
 * A tint per worktree, assigned in render order.
 *
 * Order of first appearance rather than a hash of the path: it guarantees the first
 * six worktrees on screen are mutually distinct, which is the whole point. A hash is
 * stable across renders but lets two adjacent worktrees collide, and Exposé is a
 * popup — nothing survives long enough for cross-render stability to be worth that.
 *
 * Keyed by resolved path, not by the displayed name, because every project's main
 * checkout renders as "main" and the global scope puts several of them on one grid.
 */
export function assignWorktreeTones(items: ExposeScopeItem[], projectRoot: string): Map<string, number> {
  const tones = new Map<string, number>();
  for (const item of items) {
    const key = worktreeToneKey(item, item.projectRoot ?? projectRoot);
    if (!tones.has(key)) tones.set(key, tones.size % BAND_TONES.length);
  }
  return tones;
}

export function drawBand(band: ExposeSectionBand, top: number, left: number, width: number): string {
  const color = `\x1b[${BAND_TONES[band.tone % BAND_TONES.length]}m`;
  const right = `${band.count} ${band.count === 1 ? "agent" : "agents"}`;
  const fill = Math.max(0, width - 4 - visibleWidth(band.label) - right.length);
  const text =
    `${color}▌ ${RESET}${style(band.label, "strong")} ` +
    `${color}${"─".repeat(fill)}${RESET} ${style(right, "muted")}`;
  return `\x1b[${top};${left}H${truncateAnsi(text, width)}${RESET}`;
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
// The selected tile borrows the accent (the same gold as the `▸` marker and badge) so
// focus reads as one object. State stays legible on the pill, which is its primary carrier.
const SELECTED_BORDER = "1;33";

// Inline title in the top rule when the trailing context fits; otherwise drop the
// context onto its own wrapped row(s). The status pill always gets its own row, so
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
    const wide = `${titleLeft}  ${style(context, "muted")}`;
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

/**
 * The grouping half of a tile title: which worktree (and, in the global scope, which
 * project) this agent belongs to. `worktree` is empty in the worktree scope, where
 * every tile shares one and naming it says nothing.
 */
export interface TileContext {
  worktree: string;
  /** Only in the global scope, and only when no band already names the project. */
  project?: string;
  /** Index into BAND_TONES; absent when there is no worktree to tint. */
  tone?: number;
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
  context: TileContext,
  options: TmuxExposeOptions,
  dimInactive: boolean,
): string {
  const innerW = Math.max(1, width - 2);
  const textW = Math.max(0, innerW - 1);
  // Only non-selected tiles dim, and only when configured; the active tile is always full color.
  const dimmed = dimInactive && !selected;
  const kind = agentStatusKind(item.metadata);
  const palette = (kind && STATE_BORDER[kind]) || NEUTRAL_BORDER;
  const bd = `\x1b[${selected ? SELECTED_BORDER : dimmed ? palette.off : palette.on}m`;
  // Focus changes both the glyph set and the color. Line weight alone was too fine a
  // difference to spot at a glance, and it was the only channel left while the border
  // color carried state on every tile.
  const box = selected
    ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

  const badgeLabel = badge <= 9 ? String(badge) : "·";
  // Reserve the marker slot whether or not selected so the title (and thus the
  // wide/narrow header breakpoint) doesn't shift as selection moves between tiles.
  const marker = selected ? `${style("▸", "accent")} ` : "  ";
  const here = item.target.windowId === options.currentWindowId ? style(" (here)", "muted") : "";
  // The worktree leads the rule and carries the tint; the agent name trails muted.
  // Selection keeps the badge on the accent so focus never reads as a group tone.
  const badgeStr = selected ? style(badgeLabel, "accent") : toned(badgeLabel, context.tone);
  const projectStr = context.project ? style(`${context.project} / `, "muted") : "";
  const lead = context.worktree ? `${projectStr}${toned(context.worktree, context.tone)}` : style(item.label, "strong");
  const trailing = context.worktree ? item.label : "";
  const titleLeft = `${marker}${badgeStr} ${lead}${here}`;
  const pillStr = renderAgentStatusPill(item.metadata);
  const rel = formatRelativeRecency(item.metadata.recencyAt) ?? "";
  const recency = rel && item.metadata.recencyLabel ? `${item.metadata.recencyLabel} ${rel}` : rel;
  const statusText = (item.metadata.statusText ?? "").replace(/[\r\n]+/g, " ").trim();
  const detail = [recency, statusText].filter(Boolean).join(" · ");
  // Inset the header rows by the marker width so they line up under the title text.
  const inset = visibleWidth(marker);
  const { ruleTitle, headerRows } = buildTileHeader(textW, width, titleLeft, trailing, pillStr, detail, inset);

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

function defaultExposeScopeView(scope: ExposeScope): ExposeScopeView {
  if (scope === "global") {
    return { scope, items: [], scopeLabel: "all projects", sublabel: "project-worktree" };
  }
  return {
    scope,
    items: [],
    scopeLabel: scope === "worktree" ? "this worktree" : "all worktrees",
    sublabel: scope === "worktree" ? "none" : "worktree",
  };
}

export async function runTmuxExpose(options: TmuxExposeOptions): Promise<number> {
  const timingStartedAt = performance.now();
  const markTiming = (
    name: TmuxExposeTimingEventName,
    fields: Omit<TmuxExposeTimingEvent, "name" | "elapsedMs"> = {},
  ) => {
    const event: TmuxExposeTimingEvent = {
      name,
      elapsedMs: Math.round((performance.now() - timingStartedAt) * 100) / 100,
      ...fields,
    };
    try {
      options.onTiming?.(event);
    } catch {
      log.debug("expose timing sink failed", "tmux", {});
    }
    log.debug("expose timing", "tmux", { ...event });
  };
  markTiming("start");

  const tmux = new TmuxRuntimeManager();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const manageTerminal = options.manageTerminal !== false;
  const terminalSize = () => ({
    cols: output.columns ?? options.columns ?? 80,
    rows: output.rows ?? options.rows ?? 24,
  });

  // On the meta-dashboard window Exposé starts cross-project (global); otherwise it
  // starts scoped to the launch context. Pressing `g` zooms out along the ladder
  // worktree → project → global; the rung is ephemeral (never persisted).
  const crossProject = isMetaDashboardWindowName(options.currentWindow ?? "");
  const context: FastControlContext & { clientTty?: string } = {
    projectRoot: options.projectRoot,
    currentPath: options.currentPath,
    currentWindow: options.currentWindow,
    currentWindowId: options.currentWindowId,
    currentClientSession: options.currentClientSession,
    clientTty: options.clientTty,
  };
  const exposeDeps = { daemonEndpoint: options.daemonEndpoint };
  const exposeConfig = options.exposeConfig ?? loadConfig({ projectRoot: options.projectRoot }).expose;
  let scope = initialExposeScope(crossProject, context, exposeConfig);
  const hotSnapshotKeyForScope = (nextScope: ExposeScope): HotExposeScopeKey => ({
    projectRoot: options.projectRoot,
    scope: nextScope,
    worktreeKey:
      nextScope === "worktree"
        ? resolveScopedWorktreePath(options.projectRoot, options.currentPath || options.projectRoot)
        : undefined,
    launchWindowId: nextScope === "worktree" ? options.currentWindowId : undefined,
  });
  const initialHotView = readHotExposeScopeView(options.projectStateDir, hotSnapshotKeyForScope(scope));
  let view = initialHotView ?? defaultExposeScopeView(scope);
  let items = orderExposeItems(view);
  let scopeLabel = view.scopeLabel;
  let sublabel: ExposeSublabel = view.sublabel;
  let loading = !initialHotView;
  let viewStale = Boolean(initialHotView);

  // Bands only earn their row when more than one project is on screen; below that the
  // grid stays flat and every tile keeps naming its own project.
  const sectionGroups = (): ExposeSectionGroup[] | null => {
    if (sublabel !== "project-worktree") return null;
    const groups = groupItemsByProject(items);
    if (groups.length < 2) return null;
    return groups.map((group) => ({ label: group.label, count: group.items.length }));
  };

  // Keyed on the items array itself: `items` is replaced wholesale on every reload and
  // scope change, so identity is the reload signal without touching all three sites.
  let toneCache: { items: ExposeScopeItem[]; tones: Map<string, number> } | null = null;
  const worktreeTones = (): Map<string, number> => {
    if (toneCache?.items !== items) toneCache = { items, tones: assignWorktreeTones(items, options.projectRoot) };
    return toneCache.tones;
  };

  const tileContext = (item: ExposeScopeItem): TileContext => {
    if (sublabel === "none") return { worktree: "" };
    // `projectRoot` rides only on global-scope items, so this is the project root in
    // every other scope — the same value the old per-scope branches resolved to.
    const root = item.projectRoot ?? options.projectRoot;
    const tone = worktreeTones().get(worktreeToneKey(item, root));
    const worktree = shortWorktree(item, root);
    // A band already names the project, so the tile only needs its worktree.
    if (sublabel === "project-worktree" && !sectionGroups() && item.projectName) {
      return { worktree, project: item.projectName, tone };
    }
    return { worktree, tone };
  };

  const terminal = manageTerminal ? new TerminalHost() : null;
  if (terminal) {
    terminal.enterRawMode();
    terminal.enterAlternateScreen(true);
  } else {
    output.write("\x1b[2J\x1b[H");
  }
  output.write("\x1b[?25l");
  markTiming("terminal-ready", { scope });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const exit = (code: number): number => {
    markTiming("exit", { scope, itemCount: items.length, exitCode: code });
    if (timer) clearTimeout(timer);
    output.write("\x1b[?25h");
    if (terminal) {
      terminal.restoreTerminalState();
    } else {
      output.write(
        "\x1b[0m" +
          "\x1b[?25h" +
          "\x1b[?1l" +
          "\x1b>" +
          "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
          "\x1b[?2004l",
      );
    }
    return code;
  };

  const captures = new Map<string, string>();
  let previewSnapshotCount = 0;
  let firstRenderMarked = false;
  let firstItemsRenderMarked = false;
  let firstLiveCaptureMarked = false;
  const seedPreviewSnapshots = (): void => {
    previewSnapshotCount = 0;
    for (const item of items) {
      if (!item.previewSnapshot) continue;
      captures.set(item.target.windowId, item.previewSnapshot.output);
      previewSnapshotCount += 1;
    }
  };
  if (viewStale) seedPreviewSnapshots();

  // Returns whether any capture changed, so the refresh loop can skip a repaint when
  // idle — the dominant cause of the periodic flicker was repainting unchanged tiles.
  const refreshCaptures = (): boolean => {
    if (items.length === 0) return false;
    const markFirstLiveCapture = !firstLiveCaptureMarked;
    if (markFirstLiveCapture) {
      firstLiveCaptureMarked = true;
      markTiming("first-live-capture-start", { scope, itemCount: items.length });
    }
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
    if (markFirstLiveCapture) {
      markTiming("first-live-capture-end", { scope, itemCount: items.length, captureChanged: changed });
    }
    return changed;
  };

  const currentIdx = items.findIndex((item) => item.target.windowId === options.currentWindowId);
  let index = currentIdx >= 0 ? currentIdx : 0;
  // Baseline the controlling client size at launch; a later change means the terminal
  // was resized and the popup must be relaunched to re-fit it.
  const clientBaseline =
    options.columns && options.rows ? `${options.columns}x${options.rows}` : queryClientSize(options.clientTty);
  let tileCols = 1;
  let sectionSlots: ExposeSectionPlan["slots"] | null = null;
  let visibleCount = items.length;
  let staticSize = "";
  let staticVisibleCount = -1;
  let refreshTick = 0;
  let finished = false;
  let opening = false;
  let focusTimingOpen = false;
  let refreshStarted = false;
  let pendingKeys: Array<{ key: string; ctrl?: boolean }> = [];
  let lastInputAt = 0;
  let lastResizeCheckAt = 0;
  let selectionVersion = 0;
  let reloadGeneration = 0;

  const closeFocusTiming = () => {
    if (!focusTimingOpen) return;
    focusTimingOpen = false;
    markTiming("focus-end", { scope, itemCount: items.length });
  };

  const detachFatalSignals = () => {
    if (!manageTerminal) return;
    process.off("SIGINT", onFatalSignal);
    process.off("SIGTERM", onFatalSignal);
  };

  // Restore the terminal if tmux (or anything) kills the popup with a signal.
  const onFatalSignal = () => {
    if (!finished) {
      finished = true;
      closeFocusTiming();
    }
    detachFatalSignals();
    process.exit(exit(0));
  };
  if (manageTerminal) {
    process.once("SIGINT", onFatalSignal);
    process.once("SIGTERM", onFatalSignal);
  }

  // Section rows come from the plan; without one the grid is a plain uniform pack.
  const sectionPlanFor = (layout: GridLayout): ExposeSectionPlan | null => {
    const groups = sectionGroups();
    if (!groups) return null;
    return planExposeSections(groups, layout.tileCols, layout.tileHeight, layout.gridHeight);
  };

  const renderTileAt = (tileIndex: number, layout: GridLayout, plan: ExposeSectionPlan | null): string => {
    const slot = plan?.slots[tileIndex];
    const rowOffset = slot ? slot.row : Math.floor(tileIndex / layout.tileCols) * layout.tileHeight;
    const c = slot ? slot.col : tileIndex % layout.tileCols;
    const top = TITLE_ROW + layout.gridTopRow + rowOffset;
    const left = CONTENT_LEFT + c * (layout.tileWidth + GAP);
    const item = items[tileIndex]!;
    const preview = tilePreview(captures.get(item.target.windowId) ?? "", layout.bodyLines);
    return drawTile(
      item,
      preview,
      tileIndex + 1,
      tileIndex === index,
      top,
      left,
      layout.tileWidth,
      layout,
      tileContext(item),
      options,
      false,
    );
  };

  const renderTileIndexes = (tileIndexes: number[]): boolean => {
    if (loading || visibleCount === 0) return false;
    const { cols, rows } = terminalSize();
    const size = `${cols}x${rows}`;
    const layout = computeLayout(items.length, cols, rows);
    const plan = sectionPlanFor(layout);
    const nextVisibleCount = plan ? plan.visibleCount : layout.visibleCount;
    if (size !== staticSize || nextVisibleCount !== staticVisibleCount) return false;
    tileCols = layout.tileCols;
    sectionSlots = plan?.slots ?? null;
    visibleCount = nextVisibleCount;
    if (index >= visibleCount) index = Math.max(0, visibleCount - 1);

    const seen = new Set<number>();
    let out = "\x1b[?2026h";
    for (const tileIndex of tileIndexes) {
      if (tileIndex < 0 || tileIndex >= visibleCount || seen.has(tileIndex)) continue;
      seen.add(tileIndex);
      out += renderTileAt(tileIndex, layout, plan);
    }
    output.write(`${out}\x1b[?2026l`);
    return true;
  };

  const renderSelectionMove = (previousIndex: number) => {
    if (previousIndex === index) return;
    if (!renderTileIndexes([previousIndex, index])) render(false);
  };

  const render = (full = true) => {
    const { cols, rows } = terminalSize();
    const layout = computeLayout(items.length, cols, rows);
    const plan = sectionPlanFor(layout);
    tileCols = layout.tileCols;
    sectionSlots = plan?.slots ?? null;
    visibleCount = plan ? plan.visibleCount : layout.visibleCount;
    if (index >= visibleCount) index = Math.max(0, visibleCount - 1);

    const hidden = items.length - visibleCount;
    const more = hidden > 0 ? `   +${hidden} more (use ^A s)` : "";
    const zoom = scope === "global" ? "" : " · g zoom out";
    const title = truncateAnsi(`\x1b[1mExposé · ${scopeLabel} (${items.length})${RESET}`, cols - 2);
    const help = truncateAnsi(
      `\x1b[2m1-9 open · ↑↓←→/n/p move · Enter open${zoom} · q/Esc close${more}${RESET}`,
      cols - 2,
    );

    // Synchronized output makes the repaint atomic. Static chrome repaints only on full
    // render, resize, or tile-count changes; capture refreshes repaint tiles in place.
    const size = `${cols}x${rows}`;
    const needsStatic = full || size !== staticSize || visibleCount !== staticVisibleCount;
    let base = "\x1b[?2026h";
    if (needsStatic) {
      staticSize = size;
      staticVisibleCount = visibleCount;
      // The grid no longer repaints an opaque panel over the whole screen, so this clear
      // is what erases tiles that a shrinking count left behind. Atomic inside ?2026.
      base += "\x1b[2J";
    }
    const titleAt = `\x1b[${TITLE_ROW};${CONTENT_LEFT + 1}H${title}`;
    const helpAt = `\x1b[${rows};${CONTENT_LEFT + 1}H${help}`;

    if (loading || visibleCount === 0) {
      const msg = loading ? "Loading sessions..." : `No active agents in ${scopeLabel}.`;
      const msgCol = CONTENT_LEFT + Math.max(0, Math.floor((cols - msg.length) / 2));
      const msgRow = Math.max(1, Math.floor(rows / 2));
      output.write(`${base}${titleAt}\x1b[${msgRow};${msgCol}H\x1b[2m${msg}${RESET}${helpAt}\x1b[?2026l`);
      if (!firstRenderMarked) {
        firstRenderMarked = true;
        markTiming("first-render", { scope, itemCount: items.length });
      }
      return;
    }

    let out = `${base}${titleAt}`;
    for (const band of plan?.bands ?? []) {
      out += drawBand(band, TITLE_ROW + layout.gridTopRow + band.row, CONTENT_LEFT, cols);
    }
    for (let i = 0; i < visibleCount; i += 1) {
      out += renderTileAt(i, layout, plan);
    }
    out += `${helpAt}\x1b[?2026l`;
    output.write(out);
    if (!firstRenderMarked) {
      firstRenderMarked = true;
      markTiming("first-render", { scope, itemCount: items.length, previewSnapshotCount });
    }
    if (!firstItemsRenderMarked) {
      firstItemsRenderMarked = true;
      markTiming("first-items-render", { scope, itemCount: items.length, previewSnapshotCount });
    }
  };

  // Reload tiles for the current rung after a zoom: swap items/labels, drop stale
  // captures, keep the user's selected tile when possible, and re-capture.
  const reload = async (capture = true): Promise<"committed" | "stale"> => {
    if (finished) return "stale";
    const generation = (reloadGeneration += 1);
    const reloadScope = scope;
    const selectedWindowIdAtStart = items[index]?.target.windowId;
    const selectionVersionAtStart = selectionVersion;
    let nextView: ExposeScopeView;
    markTiming("items-load-start", { scope: reloadScope });
    try {
      nextView = await loadExposeScopeItems(reloadScope, context, options.projectStateDir, exposeDeps);
    } catch (error) {
      if (finished) return "stale";
      if (generation !== reloadGeneration || reloadScope !== scope) {
        markTiming("items-load-stale", { scope: reloadScope });
        return "stale";
      }
      markTiming("items-load-error", { scope: reloadScope });
      throw error;
    }
    if (finished) return "stale";
    if (generation !== reloadGeneration || reloadScope !== scope) {
      markTiming("items-load-stale", { scope: reloadScope });
      return "stale";
    }
    const selectedWindowId =
      selectionVersionAtStart === selectionVersion ? selectedWindowIdAtStart : items[index]?.target.windowId;
    view = nextView;
    items = orderExposeItems(view);
    scopeLabel = view.scopeLabel;
    sublabel = view.sublabel;
    loading = false;
    viewStale = false;
    captures.clear();
    seedPreviewSnapshots();
    writeHotExposeScopeView(options.projectStateDir, hotSnapshotKeyForScope(reloadScope), view);
    markTiming("items-load-end", {
      scope: reloadScope,
      itemCount: items.length,
      previewSnapshotCount,
    });
    const selectedIdx = selectedWindowId ? items.findIndex((item) => item.target.windowId === selectedWindowId) : -1;
    const currentIdx = items.findIndex((item) => item.target.windowId === options.currentWindowId);
    index = selectedIdx >= 0 ? selectedIdx : currentIdx >= 0 ? currentIdx : 0;
    if (capture && firstItemsRenderMarked) refreshCaptures();
    return "committed";
  };

  return await new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      closeFocusTiming();
      input.off("data", onData);
      input.off("end", onEnd);
      detachFatalSignals();
      resolve(exit(code));
    };

    const onEnd = () => finish(0);

    const startRefreshLoop = () => {
      if (finished || refreshStarted) return;
      refreshStarted = true;
      scheduleRefresh();
    };

    const applyPendingKeys = (): boolean => {
      if (finished || loading || opening || pendingKeys.length === 0) return false;
      let needsRender = false;
      while (!finished && !loading && !opening && pendingKeys.length > 0) {
        const event = pendingKeys.shift()!;
        needsRender = handleKey(event.key, event.ctrl, true) || needsRender;
      }
      if (needsRender && !finished && !loading && !opening) render(false);
      return loading || opening || finished;
    };

    const zoomOut = (): boolean => {
      if (loading) {
        pendingKeys.push({ key: "g" });
        return true;
      }
      const next = nextExposeScope(scope);
      if (next === scope) return false;
      const previousScope = scope;
      const previousView = view;
      const previousViewStale = viewStale;
      scope = next;
      const hotView = readHotExposeScopeView(options.projectStateDir, hotSnapshotKeyForScope(scope));
      view = hotView ?? defaultExposeScopeView(scope);
      items = orderExposeItems(view);
      scopeLabel = view.scopeLabel;
      sublabel = view.sublabel;
      loading = !hotView;
      viewStale = Boolean(hotView);
      captures.clear();
      seedPreviewSnapshots();
      render();
      void reload(false)
        .then((result) => {
          if (finished || result === "stale") return;
          render(false);
          if (applyPendingKeys()) return;
          if (refreshCaptures()) render(false);
          startRefreshLoop();
        })
        .catch(() => {
          if (finished) return;
          scope = previousScope;
          view = previousView;
          items = orderExposeItems(view);
          scopeLabel = view.scopeLabel;
          sublabel = view.sublabel;
          viewStale = previousViewStale;
          loading = false;
          pendingKeys = [];
          captures.clear();
          seedPreviewSnapshots();
          render(false);
          startRefreshLoop();
        });
      return true;
    };

    const loadInitialItems = () => {
      if (!viewStale || items.length === 0) loading = true;
      void reload(false)
        .then((result) => {
          if (finished || result === "stale") return;
          // Not a full render: the backdrop is a screenshot of the host taken once at
          // startup and never updated, so repainting it here rewrites the whole screen
          // to redraw identical pixels. A warm launch lands this ~800ms after the first
          // frame, which is exactly when it reads as a flash. `needsStatic` still
          // repaints the chrome whenever the size or tile count actually changed.
          render(false);
          if (applyPendingKeys()) return;
          if (refreshCaptures()) render(false);
          startRefreshLoop();
        })
        .catch(() => {
          if (finished) return;
          loading = false;
          render(false);
          startRefreshLoop();
        });
    };

    const selectTile = (i: number) => {
      if (opening) return;
      const item = items[i];
      if (!item) return;
      opening = true;
      markTiming("focus-start", { scope, itemCount: items.length });
      focusTimingOpen = true;
      if (!viewStale && writeSelectedWindow(options, item)) {
        closeFocusTiming();
        finish(0);
        return;
      }
      void focusExposeItem(item, context, options.projectStateDir, exposeDeps)
        .then((ok) => {
          if (finished) return;
          closeFocusTiming();
          if (ok) {
            finish(0);
            return;
          }
          opening = false;
          loadInitialItems();
        })
        .catch(() => {
          if (finished) return;
          closeFocusTiming();
          opening = false;
          loadInitialItems();
        });
    };

    function handleKey(key: string, ctrl = false, deferRender = false): boolean {
      if (key === "q" || key === "escape" || (ctrl && key === "c")) {
        finish(0);
        return false;
      }
      if (loading) {
        pendingKeys.push({ key, ctrl });
        return false;
      }
      if (key === "g") {
        zoomOut();
        return false;
      }
      if (key >= "1" && key <= "9") {
        const target = Number.parseInt(key, 10) - 1;
        if (target < visibleCount) {
          if (target !== index) selectionVersion += 1;
          index = target;
          selectTile(target);
        }
        return false;
      }
      if (key === "enter" || key === "return") {
        selectTile(index);
        return false;
      }
      if (visibleCount === 0) return false;
      if (key === "right" || key === "l" || key === "n" || key === "tab") {
        const previousIndex = index;
        index = (index + 1) % visibleCount;
        if (previousIndex !== index) selectionVersion += 1;
        if (deferRender) return true;
        renderSelectionMove(previousIndex);
        return false;
      }
      if (key === "left" || key === "h" || key === "p") {
        const previousIndex = index;
        index = (index - 1 + visibleCount) % visibleCount;
        if (previousIndex !== index) selectionVersion += 1;
        if (deferRender) return true;
        renderSelectionMove(previousIndex);
        return false;
      }
      if (key === "down" || key === "j") {
        const previousIndex = index;
        if (sectionSlots) index = moveExposeIndexVertically(sectionSlots, index, 1, visibleCount);
        else if (index + tileCols < visibleCount) index += tileCols;
        if (previousIndex !== index) selectionVersion += 1;
        if (deferRender) return true;
        renderSelectionMove(previousIndex);
        return false;
      }
      if (key === "up" || key === "k") {
        const previousIndex = index;
        if (sectionSlots) index = moveExposeIndexVertically(sectionSlots, index, -1, visibleCount);
        else if (index - tileCols >= 0) index -= tileCols;
        if (previousIndex !== index) selectionVersion += 1;
        if (deferRender) return true;
        renderSelectionMove(previousIndex);
      }
      return false;
    }

    function onData(data: Buffer) {
      try {
        if (opening) return;
        const events = parseKeys(data)
          .filter((entry) => entry.name !== "focusin" && entry.name !== "focusout" && entry.name !== "mouse")
          .flatMap((entry) =>
            !entry.name && entry.char.length > 1 ? [...entry.char].map((char) => ({ ...entry, char })) : [entry],
          );
        if (events.length > 0) {
          lastInputAt = Date.now();
        }
        let needsRender = false;
        const deferRender = events.length > 1;
        for (const event of events) {
          if (finished || opening) return;
          const key = event.name || event.char || "";
          needsRender = handleKey(key, event.ctrl, deferRender) || needsRender;
        }
        if (needsRender && !finished && !loading && !opening) render(false);
      } catch {
        finish(1);
      }
    }

    // Recursive timeout (not setInterval) so the cadence re-derives from the
    // current tile count after a zoom changes how many panes are captured.
    const scheduleRefresh = () => {
      if (finished) return;
      timer = setTimeout(async () => {
        try {
          if (finished) return;
          const now = Date.now();
          const inputQuiet = Boolean(lastInputAt && now - lastInputAt < INPUT_QUIET_BEFORE_REFRESH_MS);
          if (inputQuiet && lastResizeCheckAt === 0) lastResizeCheckAt = now;
          const shouldCheckResize =
            !inputQuiet || (lastResizeCheckAt > 0 && now - lastResizeCheckAt >= RESIZE_CHECK_DURING_INPUT_MS);
          // A fixed-size popup can't grow with the terminal, so exit and let the launcher
          // relaunch us at the new bounds when the controlling client size changes.
          if (clientBaseline && shouldCheckResize) {
            lastResizeCheckAt = now;
            const clientNow = queryClientSize(options.clientTty);
            if (clientNow && clientNow !== clientBaseline) {
              finish(RELAUNCH_ON_RESIZE_EXIT);
              return;
            }
          }
          if (inputQuiet) {
            scheduleRefresh();
            return;
          }
          // Repaint on changed captures or a terminal resize (no SIGWINCH handler), so an
          // idle exposé still reflows when the window size changes.
          refreshTick += 1;
          const reloadedItems = refreshTick >= ITEM_RELOAD_EVERY_TICKS;
          if (reloadedItems) {
            refreshTick = 0;
            // A background refresh that fails is not a reason to close the popup.
            // Letting it throw here reached the outer catch and exited 1, so a
            // project service briefly out of reach — restarting, endpoint mid-write —
            // looked exactly like the user pressing q. Keep the last good view and
            // try again on the next tick.
            const reloadResult = await reload().catch(() => "failed" as const);
            if (finished) return;
            if (reloadResult === "stale" || reloadResult === "failed") {
              scheduleRefresh();
              return;
            }
          }
          const captureChanged = reloadedItems || refreshCaptures();
          const { cols, rows } = terminalSize();
          const sizeNow = `${cols}x${rows}`;
          if (captureChanged || sizeNow !== staticSize) render(false);
          scheduleRefresh();
        } catch {
          finish(1);
        }
      }, refreshDelayMs(items.length));
    };
    input.on("data", onData);
    input.on("end", onEnd);
    render();
    loadInitialItems();
  });
}
