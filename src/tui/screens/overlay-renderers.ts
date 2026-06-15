import { renderOverlayBox } from "../render/box.js";
import { keycap, padVisible, statusDot, style } from "../render/theme.js";

/** Render footer-style key hints as keycaps: hints([["Enter","create"],["Esc","cancel"]]). */
function hints(pairs: [string, string][]): string {
  return `  ${pairs.map(([key, label]) => `${keycap(key)} ${style(label, "muted")}`).join("  ")}`;
}

export function buildServiceInputOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const lines = [
    style("Create service", "strong"),
    "",
    `  ${style("Command:", "muted")} ${ctx.serviceInputBuffer}_`,
    "",
    `  ${style("Empty command opens an interactive shell", "muted")}`,
    hints([
      ["Enter", "create"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderServiceInputOverlay(ctx: any): void {
  process.stdout.write(buildServiceInputOverlayOutput(ctx));
}

export function buildLabelInputOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const lines = [
    style("Name agent", "strong"),
    "",
    `  ${style("Name:", "muted")} ${ctx.labelInputBuffer}_`,
    "",
    hints([
      ["Enter", "save"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderLabelInputOverlay(ctx: any): void {
  process.stdout.write(buildLabelInputOverlayOutput(ctx));
}

export function buildWorktreeListOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  let worktrees: Array<{ name: string; branch: string; path: string }> = [];
  try {
    worktrees = ctx.listAllWorktrees().filter((wt: any) => !wt.isBare);
  } catch {}

  const lines = [style("Worktree Management", "strong"), ""];
  if (worktrees.length === 0) {
    lines.push(`  ${style("No worktrees found.", "muted")}`);
  } else {
    for (let i = 0; i < worktrees.length; i++) {
      const wt = worktrees[i];
      const isMain = i === 0 ? ` ${style("(main)", "muted")}` : "";
      lines.push(`  ${style(wt.name, "strong")} ${style(`(${wt.branch})`, "muted")}${isMain}`);
    }
  }
  lines.push("");
  lines.push(hints([["Esc", "back"]]));
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderWorktreeListOverlay(ctx: any): void {
  process.stdout.write(buildWorktreeListOverlayOutput(ctx));
}

export function buildWorktreeRemoveConfirmOverlayOutput(ctx: any): string | null {
  const confirm = ctx.worktreeRemoveConfirm;
  if (!confirm) return null;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const lines = [
    style(`Graveyard worktree "${confirm.name}"?`, "strong"),
    "",
    `  ${style("Path:", "muted")} ${confirm.path}`,
    `  ${style("This offlines attached agents and moves the checkout to the graveyard", "muted")}`,
    "",
    hints([
      ["Enter/y", "yes"],
      ["n/Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox(lines, cols, rows, "red");
}

export function renderWorktreeRemoveConfirmOverlay(ctx: any): void {
  const output = buildWorktreeRemoveConfirmOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}

export function buildDashboardBusyOverlayOutput(ctx: any): string | null {
  const busy = ctx.dashboardBusyState;
  if (!busy) return null;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][busy.spinnerFrame % 10];
  const elapsed = ((Date.now() - busy.startedAt) / 1000).toFixed(1);
  const lines = [
    `${style(spinner, "accent")} ${style(busy.title, "strong")}`,
    "",
    ...busy.lines,
    "",
    `  ${style(`Elapsed: ${elapsed}s`, "muted")}`,
    "",
    `  ${style("Please wait", "muted")}`,
  ];
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderDashboardBusyOverlay(ctx: any): void {
  const output = buildDashboardBusyOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}

export function buildDashboardErrorOverlayOutput(ctx: any): string | null {
  const error = ctx.dashboardErrorState;
  if (!error) return null;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const bodyWidth = Math.max(24, Math.min(cols - 12, 84));
  const wrap = (label: string, value: string): string[] => {
    const wrapped = ctx.wrapText(ctx.stripAnsi(String(value ?? "")), Math.max(12, bodyWidth - label.length - 2));
    return wrapped.map((line: string, index: number) =>
      index === 0 ? `${label} ${line}` : `${" ".repeat(label.length + 1)}${line}`,
    );
  };
  const messageLines = error.lines.flatMap((line: string) => wrap(" ", line)).slice(0, Math.max(4, rows - 10));
  const lines = [
    style(ctx.stripAnsi(error.title), "danger"),
    "",
    ...messageLines,
    "",
    hints([["Esc/Enter", "dismiss"]]),
  ];
  return renderOverlayBox(lines, cols, rows, "red");
}

export function renderDashboardErrorOverlay(ctx: any): void {
  const output = buildDashboardErrorOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}

export function buildNotificationPanelOverlayOutput(ctx: any): string | null {
  const panel = ctx.notificationPanelState;
  if (!panel) return null;

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const header = [
    style("Notifications", "strong"),
    "",
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

  const lines = [...header, ...items];
  const height = Math.min(rows - 6, Math.max(10, Math.min(22, lines.length + 2)));
  const width = Math.min(cols - 8, 100);
  const leftWidth = Math.max(28, Math.floor((width - 7) * 0.5));
  const rightWidth = Math.max(20, width - 7 - leftWidth);
  const boxWidth = leftWidth + rightWidth + 7;
  const startRow = Math.max(1, Math.floor((rows - height) / 2));
  const startCol = Math.max(2, Math.floor((cols - boxWidth) / 2));
  const listHeight = height - 2;
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
    if (i === height - 1) {
      output += border(`╰${"─".repeat(boxWidth - 2)}╯`);
      continue;
    }
    const left = padVisible(listVisible[i - 1] ?? "", leftWidth);
    const right = padVisible(detailVisible[i - 1] ?? "", rightWidth);
    output += `${border("│")} ${left} ${divider} ${right} ${border("│")}`;
  }
  output += "\x1b8";
  return output;
}

export function renderNotificationPanel(ctx: any): void {
  const output = buildNotificationPanelOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}

export function buildTeammatePickerOverlayOutput(ctx: any): string | null {
  const teammates = ctx.getTeammatePickerEntries?.() ?? [];
  if (teammates.length === 0) return null;

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
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

  const lines = [style("Team", "strong"), "", ...visible.map(formatLine)];
  if (teammates.length > visible.length) {
    lines.push(`  ${style(`${teammates.length - visible.length} more`, "muted")}`);
  }
  lines.push(
    "",
    hints([
      ["↑↓", "select"],
      ["1-9/Enter", "open"],
      ["Esc", "back"],
    ]),
  );
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderTeammatePickerOverlay(ctx: any): void {
  const output = buildTeammatePickerOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}

export function buildHelpOverlayOutput(_ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const allLines = [
    "Help",
    "",
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
    "  i  inbox",
    "  y  workflow",
    "  p  plans",
    "  r  name agent",
    "  m  migrate agent",
    "  g  graveyard",
    "  q  quit",
    "",
    "Esc, Enter, or ? to close",
  ];

  const maxContentRows = Math.max(6, rows - 2);
  let lines = [...allLines];
  if (lines.length > maxContentRows) {
    const closeLine = lines[lines.length - 1];
    const available = Math.max(4, maxContentRows - 2);
    lines = [...lines.slice(0, available), "...", closeLine];
  }
  return renderOverlayBox(lines.map(styleHelpLine), cols, rows, "blue");
}

// Style a help line: section headers bold, "key  description" rows as keycap + muted.
function styleHelpLine(line: string): string {
  if (line === "") return line;
  const indented = line.startsWith("  ");
  const text = line.trim();
  if (!indented) return style(text, "strong");
  const match = text.match(/^(\S+(?:\s\S+)*)\s{2,}(.*)$/);
  if (match) return `  ${keycap(match[1])} ${style(match[2], "muted")}`;
  return `  ${style(text, "muted")}`;
}

export function renderHelpOverlay(ctx: any): void {
  process.stdout.write(buildHelpOverlayOutput(ctx));
}

export function buildSwitcherOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const list = ctx.getSwitcherList();

  const lines: string[] = [style("Switch Agent", "strong"), ""];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const wtPath = ctx.sessionWorktreePaths.get(s.id);
    const wtLabel = wtPath ? style(` (${wtPath.split("/").pop()})`, "muted") : "";
    const current = s.id === ctx.sessions[ctx.activeIndex]?.id ? style(" (current)", "muted") : "";
    const pointer = i === ctx.switcherIndex ? style("▸", "accent") : " ";
    lines.push(`  ${pointer} ${style(`${s.command}:${s.id}`, "strong")}${wtLabel}${current}`);
  }
  lines.push("");
  lines.push(
    hints([
      ["s", "cycle"],
      ["Enter", "confirm"],
      ["x", "stop"],
      ["Esc", "cancel"],
    ]),
  );
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderSwitcherOverlay(ctx: any): void {
  process.stdout.write(buildSwitcherOverlayOutput(ctx));
}

export function buildMigratePickerOverlayOutput(ctx: any): string | null {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const session = ctx.sessions[ctx.activeIndex];
  if (!session) return null;

  const currentWt = ctx.sessionWorktreePaths.get(session.id);
  const lines = [style(`Migrate "${session.id}" to:`, "strong"), ""];
  for (let i = 0; i < ctx.migratePickerWorktrees.length; i++) {
    const wt = ctx.migratePickerWorktrees[i];
    const isCurrent = wt.path === currentWt || (!currentWt && wt.name === "(main)");
    const marker = isCurrent ? style(" (current)", "muted") : "";
    lines.push(`  ${keycap(String(i + 1))} ${style(wt.name, "strong")}${marker}`);
  }
  lines.push("");
  lines.push(hints([["Esc", "cancel"]]));

  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderMigratePickerOverlay(ctx: any): void {
  const output = buildMigratePickerOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}
