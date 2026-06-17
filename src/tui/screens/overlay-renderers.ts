import { renderOverlayBox } from "../render/box.js";
import { keycap, keycapHint, modalBand, padVisible, statusDot, style } from "../render/theme.js";

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
  let worktrees: Array<{ name: string; branch: string; path: string }> = [];
  try {
    worktrees = ctx.listAllWorktrees().filter((wt: any) => !wt.isBare);
  } catch {}

  const body: string[] = [];
  if (worktrees.length === 0) {
    body.push(`  ${style("No worktrees found.", "muted")}`);
  } else {
    for (let i = 0; i < worktrees.length; i++) {
      const wt = worktrees[i];
      const isMain = i === 0 ? ` ${style("(main)", "muted")}` : "";
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

export function buildNotificationPanelOverlayOutput(ctx: any, cols: number, rows: number): string | null {
  const panel = ctx.notificationPanelState;
  if (!panel) return null;

  const header = [
    hints([
      ["↑↓", "select"],
      ["r", "read"],
      ["c", "clear"],
      ["C", "clear all"],
      ["Esc", "close"],
    ]),
    "",
  ];
  const items =
    panel.entries.length === 0
      ? [`  ${style("No inbox items.", "muted")}`]
      : panel.entries.map((entry: any, index: number) => {
          const marker = index === panel.index ? style("▸", "accent") : " ";
          const dot = entry.unread ? statusDot("needs") : statusDot("offline");
          const session = entry.sessionId ? style(` (${entry.sessionId})`, "muted") : "";
          const time = entry.createdAt.replace("T", " ").slice(5, 16);
          const titleTone = entry.unread ? "strong" : "muted";
          return `  ${marker} ${dot} ${style(entry.title, titleTone)}${session} ${style(`· ${time}`, "muted")}`;
        });
  const selected = panel.entries[panel.index];
  const details = selected
    ? [
        style("Details", "strong"),
        "",
        ...ctx.wrapKeyValue("Title", selected.title, 56),
        ...(selected.subtitle ? ctx.wrapKeyValue("Subtitle", selected.subtitle, 56) : []),
        ...ctx.wrapKeyValue("Body", selected.body, 56),
        ...(selected.sessionId ? ctx.wrapKeyValue("Session", selected.sessionId, 56) : []),
        ...(selected.kind ? ctx.wrapKeyValue("Kind", selected.kind, 56) : []),
      ]
    : [style("Details", "strong"), "", `  ${style("No notification selected.", "muted")}`];

  if (rows < 10) return null;
  const lines = [...header, ...items];
  const height = Math.max(8, Math.min(rows - 6, Math.max(12, Math.min(24, lines.length + 4))));
  const width = Math.min(cols - 8, 100);
  const leftWidth = Math.max(28, Math.floor((width - 7) * 0.5));
  const rightWidth = Math.max(20, width - 7 - leftWidth);
  const boxWidth = leftWidth + rightWidth + 7;
  const startRow = Math.max(1, Math.floor((rows - height) / 2));
  const startCol = Math.max(2, Math.floor((cols - boxWidth) / 2));
  // Chrome rows: top border, band, separator, bottom border.
  const listHeight = height - 4;
  const listVisible = lines.slice(0, listHeight);
  while (listVisible.length < listHeight) listVisible.push("");
  const detailVisible = details.slice(0, listHeight);
  while (detailVisible.length < listHeight) detailVisible.push("");
  const border = (segment: string): string => style(segment, "info");
  const divider = style("│", "muted");

  let output = "\x1b7";
  for (let i = 0; i < height; i++) {
    output += `\x1b[${startRow + i};${startCol}H`;
    if (i === 0) {
      output += border(`╭${"─".repeat(boxWidth - 2)}╮`);
      continue;
    }
    if (i === 1) {
      output += border("│") + modalBand("NOTIFICATIONS", "info", boxWidth - 2) + border("│");
      continue;
    }
    if (i === 2) {
      output += border(`├${"─".repeat(boxWidth - 2)}┤`);
      continue;
    }
    if (i === height - 1) {
      output += border(`╰${"─".repeat(boxWidth - 2)}╯`);
      continue;
    }
    const left = padVisible(listVisible[i - 3] ?? "", leftWidth);
    const right = padVisible(detailVisible[i - 3] ?? "", rightWidth);
    output += `${border("│")} ${left} ${divider} ${right} ${border("│")}`;
  }
  output += "\x1b8";
  return output;
}

export function renderNotificationPanel(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const output = buildNotificationPanelOverlayOutput(ctx, cols, rows);
  if (output) process.stdout.write(output);
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

export function buildHelpOverlayOutput(_ctx: any, cols: number, rows: number): string {
  const allLines = [
    "Tmux mode",
    "  Dashboard lives in a managed tmux dashboard window",
    "  Each agent runs in its own tmux window",
    "  Use normal tmux window navigation inside agents",
    "  Run aimux with no args to return to the dashboard window",
    "",
    "Dashboard mode",
    "  Ctrl+A ?  show help",
    "  Ctrl+A c  new agent",
    "  Ctrl+A o  create / open overseer",
    "  Ctrl+A x  stop agent",
    "  Ctrl+A w  create worktree",
    "  Ctrl+A W  worktree list",
    "  Ctrl+A v  request review",
    "  Ctrl+A 1-9  focus numbered agent",
    "  Ctrl+A d  return to dashboard window",
    "  arrows / j k  navigate",
    "  Enter  open, resume, or focus",
    "  a  activity",
    "  i  coordination",
    "  y  project",
    "  p  library",
    "  t  topology",
    "  r  name agent",
    "  m  migrate agent",
    "  g  graveyard",
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
