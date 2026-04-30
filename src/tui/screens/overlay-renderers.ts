import { renderOverlayBox } from "../render/box.js";

export function buildServiceInputOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const lines = [
    "Create service:",
    "",
    `  Command: ${ctx.serviceInputBuffer}_`,
    "",
    "  Empty command opens an interactive shell",
    "  [Enter] create  [Esc] cancel",
  ];
  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderServiceInputOverlay(ctx: any): void {
  process.stdout.write(buildServiceInputOverlayOutput(ctx));
}

export function buildLabelInputOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const lines = ["Name agent:", "", `  Name: ${ctx.labelInputBuffer}_`, "", "  [Enter] save  [Esc] cancel"];
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

  const lines = ["Worktree Management:", ""];
  if (worktrees.length === 0) {
    lines.push("  No worktrees found.");
  } else {
    for (let i = 0; i < worktrees.length; i++) {
      const wt = worktrees[i];
      const isMain = i === 0 ? " \x1b[2m(main)\x1b[0m" : "";
      lines.push(`  ${wt.name} (${wt.branch})${isMain}`);
    }
  }
  lines.push("");
  lines.push("  [Esc] back");
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
    `Remove worktree "${confirm.name}"?`,
    "",
    `  Path: ${confirm.path}`,
    "  This runs: git worktree remove --force",
    "",
    "  [Enter/y] yes  [n/Esc] cancel",
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
  const lines = [`${spinner} ${busy.title}`, "", ...busy.lines, "", `  Elapsed: ${elapsed}s`, "", "  Please wait"];
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
  const lines = [ctx.stripAnsi(error.title), "", ...messageLines, "", "[Esc/Enter] dismiss"];
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
  const title = "Notifications";
  const header = [`${title}`, "", "  [↑↓] select  [r] read  [c] clear  [C] clear all  [Esc] close", ""];
  const items =
    panel.entries.length === 0
      ? ["  No inbox items."]
      : panel.entries.map((entry: any, index: number) => {
          const marker = index === panel.index ? "▸" : " ";
          const state = entry.unread ? "unread" : "read";
          const session = entry.sessionId ? ` (${entry.sessionId})` : "";
          const time = entry.createdAt.replace("T", " ").slice(5, 16);
          return `  ${marker} ${entry.title}${session} · ${state} · ${time}`;
        });
  const selected = panel.entries[panel.index];
  const details = selected
    ? [
        "Details",
        "",
        ...ctx.wrapKeyValue("Title", selected.title, 56),
        ...(selected.subtitle ? ctx.wrapKeyValue("Subtitle", selected.subtitle, 56) : []),
        ...ctx.wrapKeyValue("Body", selected.body, 56),
        ...(selected.sessionId ? ctx.wrapKeyValue("Session", selected.sessionId, 56) : []),
        ...(selected.kind ? ctx.wrapKeyValue("Kind", selected.kind, 56) : []),
      ]
    : ["Details", "", "  No notification selected."];

  const lines = [...header, ...items];
  const height = Math.min(rows - 6, Math.max(10, Math.min(22, lines.length + 2)));
  const width = Math.min(cols - 8, 100);
  const leftWidth = Math.max(34, Math.floor(width * 0.5));
  const rightWidth = Math.max(24, width - leftWidth - 3);
  const startRow = Math.max(1, Math.floor((rows - height) / 2));
  const startCol = Math.max(2, Math.floor((cols - width) / 2));
  const listHeight = height - 2;
  const listVisible = lines.slice(0, listHeight);
  while (listVisible.length < listHeight) listVisible.push("");
  const detailVisible = details.slice(0, listHeight);
  while (detailVisible.length < listHeight) detailVisible.push("");

  let output = "\x1b7";
  for (let i = 0; i < height; i++) {
    output += `\x1b[${startRow + i};${startCol}H`;
    if (i === 0 || i === height - 1) {
      output += `\x1b[48;5;236;38;5;255m${" ".repeat(width)}\x1b[0m`;
      continue;
    }
    const left = ctx.truncatePlain(ctx.stripAnsi(listVisible[i - 1] ?? ""), leftWidth).padEnd(leftWidth);
    const right = ctx.truncatePlain(ctx.stripAnsi(detailVisible[i - 1] ?? ""), rightWidth).padEnd(rightWidth);
    output += `\x1b[48;5;236;38;5;255m ${left} │ ${right} \x1b[0m`;
  }
  output += "\x1b8";
  return output;
}

export function renderNotificationPanel(ctx: any): void {
  const output = buildNotificationPanelOverlayOutput(ctx);
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
    "  Ctrl+A x  stop agent",
    "  Ctrl+A w  create worktree",
    "  Ctrl+A W  worktree list",
    "  Ctrl+A v  request review",
    "  Ctrl+A 1-9  focus numbered agent",
    "  Ctrl+A d  return to dashboard window",
    "  arrows / j k  navigate",
    "  Enter  open, resume, or takeover",
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

  const visibleRows = rows;
  const maxContentRows = Math.max(6, visibleRows - 2);
  let lines = [...allLines];
  if (lines.length > maxContentRows) {
    const closeLine = lines[lines.length - 1];
    const available = Math.max(4, maxContentRows - 2);
    lines = [...lines.slice(0, available), "...", closeLine];
  }

  const ellipsizeEnd = (s: string, max: number) => {
    if (max <= 0) return "";
    if (s.length <= max) return s;
    if (max <= 1) return "…";
    return `${s.slice(0, max - 1)}…`;
  };

  const contentWidth = Math.max(36, Math.min(cols - 6, Math.max(...lines.map((line) => line.length))));
  const boxWidth = contentWidth + 4;
  const boxHeight = lines.length + 2;
  const startRow = Math.max(1, Math.floor((visibleRows - boxHeight) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));
  let output = "\x1b7";
  for (let i = 0; i < boxHeight; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === boxHeight - 1) {
      output += `\x1b[44;97m${" ".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = ellipsizeEnd(lines[i - 1] ?? "", contentWidth);
      output += `\x1b[44;97m  ${line.padEnd(contentWidth)}  \x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}

export function renderHelpOverlay(ctx: any): void {
  process.stdout.write(buildHelpOverlayOutput(ctx));
}

export function buildSwitcherOverlayOutput(ctx: any): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const list = ctx.getSwitcherList();

  const ellipsizeEnd = (s: string, max: number) => {
    if (max <= 0) return "";
    if (s.length <= max) return s;
    if (max <= 1) return "…";
    return `${s.slice(0, max - 1)}…`;
  };

  const lines: string[] = ["Switch Agent:"];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const wtPath = ctx.sessionWorktreePaths.get(s.id);
    const wtLabel = wtPath ? ` (${wtPath.split("/").pop()})` : "";
    const current = s.id === ctx.sessions[ctx.activeIndex]?.id ? " (current)" : "";
    const pointer = i === ctx.switcherIndex ? "▸ " : "  ";
    lines.push(`${pointer}${s.command}:${s.id}${wtLabel}${current}`);
  }
  lines.push("");
  lines.push("  [s] cycle  Enter confirm  [x] stop  Esc cancel");

  const contentWidth = Math.max(20, Math.min(cols - 6, Math.max(...lines.map((l) => l.length))));
  const boxWidth = contentWidth + 4;
  const startRow = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = ellipsizeEnd(lines[i - 1], contentWidth);
      output += `\x1b[44;97m  ${line.padEnd(contentWidth)}  \x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
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
  const lines = [`Migrate "${session.id}" to:`, ""];
  for (let i = 0; i < ctx.migratePickerWorktrees.length; i++) {
    const wt = ctx.migratePickerWorktrees[i];
    const isCurrent = wt.path === currentWt || (!currentWt && wt.name === "(main)");
    const marker = isCurrent ? " (current)" : "";
    lines.push(`  [${i + 1}] ${wt.name}${marker}`);
  }
  lines.push("");
  lines.push("  [Esc] cancel");

  return renderOverlayBox(lines, cols, rows, "blue");
}

export function renderMigratePickerOverlay(ctx: any): void {
  const output = buildMigratePickerOverlayOutput(ctx);
  if (output) process.stdout.write(output);
}
