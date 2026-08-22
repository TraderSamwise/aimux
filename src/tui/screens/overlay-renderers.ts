import { runtimeGuardOverlayCopy } from "../../multiplexer/runtime-guard.js";
import { renderOverlayBox } from "../render/box.js";
import { keycap, keycapHint, style } from "../render/theme.js";

/** Render footer-style key hints as keycaps: hints([["Enter","create"],["Esc","cancel"]]). */
export function hints(pairs: [string, string][]): string {
  return `  ${pairs.map(([key, label]) => keycapHint(key, label)).join("  ")}`;
}

export function buildServiceInputOverlayOutput(ctx: any, cols: number, rows: number): string {
  const body = [
    `  ${style("Command:", "muted")} ${ctx.serviceInputBuffer}_`,
    "",
    `  ${style("Empty command opens an interactive shell", "muted")}`,
    "",
    hints([
      ["Enter", "create"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: "Create service", body, cols, rows });
}

export function renderServiceInputOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  process.stdout.write(buildServiceInputOverlayOutput(ctx, cols, rows));
}

export function buildLabelInputOverlayOutput(ctx: any, cols: number, rows: number): string {
  const body = [
    `  ${style("Name:", "muted")} ${ctx.labelInputBuffer}_`,
    "",
    hints([
      ["Enter", "save"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: "Name agent", body, cols, rows });
}

export function renderLabelInputOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  process.stdout.write(buildLabelInputOverlayOutput(ctx, cols, rows));
}

export function buildWorktreeListOverlayOutput(ctx: any, cols: number, rows: number): string {
  let worktrees: Array<{ name: string; branch: string; path?: string }> = [];
  if (ctx.mode === "dashboard" && Array.isArray(ctx.dashboardWorktreeGroupsCache)) {
    worktrees = ctx.dashboardWorktreeGroupsCache.map((group: any) => ({
      name: group.name,
      branch: group.branch,
      path: group.path,
    }));
  } else {
    try {
      worktrees = ctx.listAllWorktrees().filter((wt: any) => !wt.isBare);
    } catch {}
  }

  const body: string[] = [];
  if (worktrees.length === 0) {
    body.push(`  ${style("No worktrees found.", "muted")}`);
  } else {
    for (let i = 0; i < worktrees.length; i++) {
      const wt = worktrees[i];
      const isMain =
        wt.path === undefined || (ctx.mode !== "dashboard" && i === 0) ? ` ${style("(main)", "muted")}` : "";
      body.push(`  ${style(wt.name, "strong")} ${style(`(${wt.branch})`, "muted")}${isMain}`);
    }
  }
  body.push("");
  body.push(hints([["Esc", "back"]]));
  return renderOverlayBox({ title: "Worktree Management", body, cols, rows });
}

export function renderWorktreeListOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  process.stdout.write(buildWorktreeListOverlayOutput(ctx, cols, rows));
}

export function buildWorktreeRemoveConfirmOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const confirm = ctx.worktreeRemoveConfirm;
  if (!confirm) return null;
  const body = [
    `  ${style(`"${confirm.name}"`, "strong")}`,
    `  ${style("Path:", "muted")} ${confirm.path}`,
    `  ${style("Offlines attached agents and moves the checkout to the graveyard.", "muted")}`,
    "",
    hints([
      ["Enter/y", "yes"],
      ["n/Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: "Graveyard worktree", body, cols, rows, variant: "red" });
}

export function renderWorktreeRemoveConfirmOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildWorktreeRemoveConfirmOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
}

function restoreConfirmAction(ctx: any): "restore" | "cancel" {
  return ctx.agentRestoreConfirmSelection === "cancel" ? "cancel" : "restore";
}

function restoreConfirmButton(label: string, active: boolean): string {
  return active ? `\x1b[7m ${label} \x1b[0m` : style(` ${label} `, "muted");
}

export function buildAgentRestoreConfirmOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const offer = ctx.dashboardAgentRestoreOfferCache;
  if (!offer || !Array.isArray(offer.sessions) || !Array.isArray(offer.sessionIds)) return null;
  const selected = restoreConfirmAction(ctx);
  const labels = offer.sessions
    .slice(0, 5)
    .map((session: any) => session.label ?? session.command ?? session.tool ?? session.id)
    .join(", ");
  const extra = offer.sessions.length > 5 ? `, +${offer.sessions.length - 5} more` : "";
  const count = offer.sessionIds.length;
  const body = [
    `  Restore ${count} previously running agent${count === 1 ? "" : "s"} for this project?`,
    labels ? `  ${style(`${labels}${extra}`, "muted")}` : "",
    "",
    `  ${restoreConfirmButton("Restore", selected === "restore")}  ${restoreConfirmButton("Cancel", selected === "cancel")}`,
    "",
    hints([
      ["←/→", "choose"],
      ["Enter", "confirm"],
      ["Esc", "cancel"],
    ]),
  ].filter(Boolean);
  return renderOverlayBox({ title: "Restore agents", body, cols, rows });
}

export function buildDashboardBusyOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const busy = ctx.dashboardBusyState;
  if (!busy) return null;
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][busy.spinnerFrame % 10];
  const elapsed = ((Date.now() - busy.startedAt) / 1000).toFixed(1);
  const body = [
    ...busy.lines,
    "",
    `  ${style(`Elapsed: ${elapsed}s`, "muted")}`,
    "",
    `  ${style("Please wait", "muted")}`,
  ];
  return renderOverlayBox({ title: busy.title, body, cols, rows, icon: spinner });
}

export function renderDashboardBusyOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildDashboardBusyOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
}

export function buildDashboardErrorOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const error = ctx.dashboardErrorState;
  if (!error) return null;
  const bodyWidth = Math.max(24, Math.min(cols - 12, 84));
  const wrap = (label: string, value: string): string[] => {
    const wrapped = ctx.wrapText(ctx.stripAnsi(String(value ?? "")), Math.max(12, bodyWidth - label.length - 2));
    return wrapped.map((line: string, index: number) =>
      index === 0 ? `${label} ${line}` : `${" ".repeat(label.length + 1)}${line}`,
    );
  };
  const messageLines = error.lines.flatMap((line: string) => wrap(" ", line)).slice(0, Math.max(4, rows - 10));
  const body = [...messageLines, "", hints([["Esc/Enter", "dismiss"]])];
  return renderOverlayBox({ title: ctx.stripAnsi(error.title), body, cols, rows, variant: "red" });
}

export function renderDashboardErrorOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildDashboardErrorOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
}

export function buildDashboardRuntimeGuardOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const guard = ctx.runtimeGuardState;
  if (!guard || guard.kind === "ok") return null;
  const activeMs = typeof ctx.runtimeGuardActiveMs === "number" ? ctx.runtimeGuardActiveMs : undefined;
  const repairFailed = typeof ctx.runtimeGuardRepairFailedKey === "string";
  const copy = runtimeGuardOverlayCopy(guard, { activeMs, repairFailed });
  const body = [...copy.lines.map((line: string) => `  ${style(line, "muted")}`)];
  if (copy.waiting) body.push("", `  ${style("Please wait", "muted")}`);
  return renderOverlayBox({ title: copy.title, body, cols, rows, variant: "red" });
}

export function buildTeammatePickerOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const teammates = ctx.getTeammatePickerEntries?.() ?? [];
  if (teammates.length === 0) return null;

  const visible = teammates.slice(0, Math.max(3, rows - 10));
  const selectedIndex = Math.max(0, Math.min(ctx.teammatePickerState?.index ?? 0, visible.length - 1));
  const statusLabel =
    typeof ctx.derivedStatusLabel === "function"
      ? (entry: any) => ctx.derivedStatusLabel(entry)
      : (entry: any) => entry.status;
  const labelFor = (entry: any): string => {
    const label = entry.team?.label ?? entry.label ?? entry.command ?? entry.id;
    const role = entry.team?.role ?? entry.role;
    return role ? `${label} (${role})` : label;
  };
  const formatLine = (entry: any, index: number): string => {
    const marker = index === selectedIndex ? style("▸", "accent") : " ";
    const number = index < 9 ? keycap(String(index + 1)) : "   ";
    const status = statusLabel(entry);
    const summary = entry.headline ?? entry.previewLine ?? entry.lastEvent?.message;
    const suffix = summary ? style(` - ${summary}`, "muted") : "";
    return `  ${marker} ${number} ${style(labelFor(entry), "strong")} ${style(`- ${status}`, "muted")}${suffix}`;
  };

  const body = [...visible.map(formatLine)];
  if (teammates.length > visible.length) {
    body.push(`  ${style(`${teammates.length - visible.length} more`, "muted")}`);
  }
  body.push(
    "",
    hints([
      ["↑↓", "select"],
      ["1-9/Enter", "open"],
      ["Esc", "back"],
    ]),
  );
  return renderOverlayBox({ title: "Team", body, cols, rows });
}

export function renderTeammatePickerOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildTeammatePickerOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
}

function sessionLabel(entry: any): string {
  return entry?.team?.label ?? entry?.label ?? entry?.command ?? entry?.id ?? "agent";
}

function isLiveSession(entry: any): boolean {
  return Boolean(entry && entry.status !== "offline" && entry.status !== "exited");
}

function dashboardOverseerSessions(ctx: any): any[] {
  return ctx.dashboardOverseerSessionsCache ?? ctx.dashboard?.viewModel?.overseerSessions ?? [];
}

function watchedDashboardSessions(ctx: any): any[] {
  const normal = ctx.dashboardSessionsCache ?? ctx.dashboard?.viewModel?.sessions ?? [];
  const teammates = ctx.dashboardTeammatesCache ?? [];
  const byId = new Map<string, any>();
  for (const entry of [...normal, ...teammates]) {
    if (entry?.id && entry.loop?.active) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function buildOverseerOverlayOutput(ctx: any, cols: number, rows: number): string {
  const overseers = dashboardOverseerSessions(ctx);
  const liveOverseer = overseers.find(isLiveSession);
  const selected = ctx.getSelectedDashboardSessionForActions?.();
  const watched = watchedDashboardSessions(ctx);
  const maxWatchedRows = Math.max(2, rows - 15);
  const watchedRows = watched.slice(0, maxWatchedRows).map((entry) => {
    const goal = entry.loop?.goal ? style(` - ${entry.loop.goal}`, "muted") : "";
    return `  ${style("•", "accent")} ${style(sessionLabel(entry), "strong")} ${style(entry.status ?? "", "muted")}${goal}`;
  });

  if (watched.length > watchedRows.length) {
    watchedRows.push(`  ${style(`${watched.length - watchedRows.length} more watched agents`, "muted")}`);
  }

  const selectedLine = selected
    ? `${style(sessionLabel(selected), "strong")} ${selected.loop?.active ? style("watched", "done") : style("not watched", "muted")}`
    : style("none", "muted");
  const overseerLine = liveOverseer
    ? `${style(sessionLabel(liveOverseer), "strong")} ${style(liveOverseer.status ?? "active", "done")}`
    : style("none running", "muted");
  const body = [
    `  ${style("Status:", "muted")} ${liveOverseer ? style("Active", "done") : style("Off", "muted")}`,
    `  ${style("Overseer:", "muted")} ${overseerLine}`,
    `  ${style("Watching:", "muted")} ${watched.length} ${watched.length === 1 ? "agent" : "agents"}`,
    `  ${style("Selected:", "muted")} ${selectedLine}`,
    "",
    ...(watchedRows.length > 0 ? watchedRows : [`  ${style("No watched agents yet.", "muted")}`]),
    "",
    hints([
      ["Enter", liveOverseer ? "focus" : "start"],
      ["w", "watch selected"],
      ["u", "unwatch selected"],
      ...(liveOverseer ? ([["x", "stop overseer"]] as [string, string][]) : []),
      ["Esc", "back"],
    ]),
  ];
  return renderOverlayBox({ title: "Overseer", body, cols, rows });
}

export function buildHelpOverlayOutput(_ctx: any, cols: number, rows: number): string {
  const allLines = [
    "Tmux mode",
    "  Dashboard lives in a managed tmux dashboard window",
    "  Each agent runs in its own tmux window",
    "  Use normal tmux window navigation inside agents",
    "  Run aimux with no args to return to the dashboard window",
    "  Ctrl+A d  return to the dashboard window",
    "",
    "Dashboard mode",
    "  ?  show help",
    "  1-9  jump to visible item",
    "  arrows / h j k l  navigate",
    "  Enter / → / l  step in, open, resume, or focus",
    "  Tab  toggle details",
    "  c  coordination",
    "  p  project",
    "  L  library",
    "  t  topology",
    "  g  graveyard",
    "  n  new agent",
    "  v  new service",
    "  f  fork agent",
    "  S  switch selected agent tool",
    "  s  send message",
    "  H  handoff",
    "  T  task",
    "  o  open thread",
    "  R  reply",
    "  r  name agent",
    "  m  migrate agent",
    "  x  stop or remove selected item",
    "  q  quit",
    "",
    "Esc, Enter, or ? to close",
  ];

  const maxContentRows = Math.max(6, rows - 6);
  let lines = [...allLines];
  if (lines.length > maxContentRows) {
    const closeLine = lines[lines.length - 1];
    const available = Math.max(4, maxContentRows - 2);
    lines = [...lines.slice(0, available), "...", closeLine];
  }
  return renderOverlayBox({ title: "Help", body: lines.map(styleHelpLine), cols, rows });
}

// Style a help line: section headers bold, "key  description" rows as keycap + muted.
function styleHelpLine(line: string): string {
  if (line === "") return line;
  const indented = line.startsWith("  ");
  const text = line.trim();
  if (!indented) return style(text, "strong");
  const match = text.match(/^(\S+(?:\s\S+)*)\s{2,}(.*)$/);
  if (match) return `  ${keycapHint(match[1], match[2])}`;
  return `  ${style(text, "muted")}`;
}

export function renderHelpOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  process.stdout.write(buildHelpOverlayOutput(ctx, cols, rows));
}

export function buildSwitcherOverlayOutput(ctx: any, cols: number, rows: number): string {
  const list = ctx.getSwitcherList();

  const body: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const wtPath = ctx.sessionWorktreePaths.get(s.id);
    const wtLabel = wtPath ? style(` (${wtPath.split("/").pop()})`, "muted") : "";
    const current = s.id === ctx.sessions[ctx.activeIndex]?.id ? style(" (current)", "muted") : "";
    const pointer = i === ctx.switcherIndex ? style("▸", "accent") : " ";
    body.push(`  ${pointer} ${style(`${s.command}:${s.id}`, "strong")}${wtLabel}${current}`);
  }
  body.push("");
  body.push(
    hints([
      ["s", "cycle"],
      ["Enter", "confirm"],
      ["x", "stop"],
      ["Esc", "cancel"],
    ]),
  );
  return renderOverlayBox({ title: "Switch Agent", body, cols, rows });
}

export function renderSwitcherOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  process.stdout.write(buildSwitcherOverlayOutput(ctx, cols, rows));
}

export function buildMigratePickerOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const session = ctx.sessions[ctx.activeIndex];
  if (!session) return null;

  const currentWt = ctx.sessionWorktreePaths.get(session.id);
  const body: string[] = [];
  for (let i = 0; i < ctx.migratePickerWorktrees.length; i++) {
    const wt = ctx.migratePickerWorktrees[i];
    const isCurrent = wt.path === currentWt || (!currentWt && wt.name === "(main)");
    const marker = isCurrent ? style(" (current)", "muted") : "";
    body.push(`  ${keycap(String(i + 1))} ${style(wt.name, "strong")}${marker}`);
  }
  body.push("");
  body.push(hints([["Esc", "cancel"]]));

  return renderOverlayBox({ title: `Migrate "${session.id}" to`, body, cols, rows });
}

export function renderMigratePickerOverlay(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildMigratePickerOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
}
