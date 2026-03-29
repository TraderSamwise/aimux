import type { FooterPluginItem } from "./footer-plugins.js";

export interface FooterSessionChip {
  index: number;
  name: string;
  status: string;
  active: boolean;
}

export interface FooterRenderInput {
  enabledPluginCount: number;
  cursor: { row: number; col: number };
  sessionChips: FooterSessionChip[];
  headline?: string;
  taskCounts?: { pending: number; assigned: number };
  flash?: string | null;
  pluginItems: FooterPluginItem[];
}

const STATUS_ICONS: Record<string, string> = {
  running: "●",
  idle: "●",
  waiting: "◉",
  exited: "○",
};

export class FooterController {
  private lastSignature: string | null = null;

  getFooterHeight(enabledPluginCount: number): number {
    return enabledPluginCount > 0 ? 2 : 1;
  }

  render(input: FooterRenderInput, force = true): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const footerHeight = this.getFooterHeight(input.enabledPluginCount);

    const stripTerminalCodes = (s: string) =>
      s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b]8;;.*?(?:\x07|\x1b\\)/g, "");
    const ellipsizeEnd = (s: string, max: number) => {
      if (max <= 0) return "";
      if (s.length <= max) return s;
      if (max <= 1) return "…";
      return `${s.slice(0, max - 1)}…`;
    };
    const formatHyperlink = (text: string, href?: string) => (href ? `\x1b]8;;${href}\x07${text}\x1b]8;;\x07` : text);
    const fitPlainText = (text: string) => ellipsizeEnd(text, cols);
    const drawRow = (row: number, content: string) => `\x1b[${row};1H\x1b[2K${content}`;

    const parts: string[] = input.sessionChips.map((chip) => {
      const icon = STATUS_ICONS[chip.status] ?? "?";
      const activePrefix = chip.active ? "*" : "";
      return `${activePrefix}${icon} ${chip.index}:${chip.name}`;
    });

    if (input.headline) parts.push(input.headline);
    if (input.taskCounts && (input.taskCounts.pending > 0 || input.taskCounts.assigned > 0)) {
      parts.push(`[T:${input.taskCounts.pending}p/${input.taskCounts.assigned}a]`);
    }
    if (input.flash) parts.push(stripTerminalCodes(input.flash));

    const tabsRow = fitPlainText(` ${parts.join("  ")}`.replace(/\s+/g, " ").trimStart());

    const renderedPluginParts: string[] = [];
    let usedPluginWidth = 0;
    for (const plugin of input.pluginItems) {
      const separatorWidth = renderedPluginParts.length > 0 ? 2 : 0;
      const remaining = cols - usedPluginWidth - separatorWidth;
      if (remaining <= 1) break;
      const fitted = ellipsizeEnd(plugin.text, remaining);
      if (!fitted) break;
      renderedPluginParts.push(formatHyperlink(fitted, plugin.href));
      usedPluginWidth += separatorWidth + fitted.length;
    }
    const pluginRow = renderedPluginParts.join("  ");

    const signature = JSON.stringify({
      cols,
      rows,
      footerHeight,
      tabsRow,
      pluginParts: renderedPluginParts.map((part) => stripTerminalCodes(part)),
      cursor: input.cursor,
    });
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;

    if (footerHeight === 1) {
      process.stdout.write(`${drawRow(rows, tabsRow)}\x1b[${input.cursor.row};${input.cursor.col}H\x1b[?25h`);
      return;
    }
    process.stdout.write(
      `${drawRow(rows - 1, tabsRow)}${drawRow(rows, pluginRow)}\x1b[${input.cursor.row};${input.cursor.col}H\x1b[?25h`,
    );
  }
}
