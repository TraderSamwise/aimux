import { modalBand, padVisible, style, visibleWidth, type BandTone, type Tone } from "./theme.js";

const VARIANT: Record<"blue" | "red", { tone: Tone; band: BandTone; icon?: string }> = {
  blue: { tone: "info", band: "info" },
  red: { tone: "danger", band: "danger", icon: "⚠" },
};

export interface OverlayBoxSpec {
  /** Plain title text; rendered upper-cased in the tinted band. */
  title: string;
  /** Pre-styled body rows (content + footer hints). */
  body: string[];
  cols: number;
  rows: number;
  variant?: "blue" | "red";
  /** Override the band glyph (defaults: none for blue, ⚠ for red). */
  icon?: string;
}

/**
 * Draw a centered modal dialog over the current screen: a rounded, intent-tinted
 * border with a filled title band ("window chrome") above a separator rule and the
 * padded body. Each row is positioned absolutely so it paints over the backdrop.
 * The single primitive every overlay routes through, so dialogs share one look.
 */
export function renderOverlayBox({ title, body, cols, rows, variant = "blue", icon }: OverlayBoxSpec): string {
  const v = VARIANT[variant];
  const bandIcon = icon ?? v.icon;
  const border = (segment: string): string => style(segment, v.tone);
  const bandLabel = `${bandIcon ? `${bandIcon}  ` : ""}${title.toUpperCase()}`;

  const maxContentWidth = Math.max(10, cols - 8);
  const measuredContentWidth = Math.max(visibleWidth(bandLabel) + 1, 0, ...body.map((line) => visibleWidth(line)));
  const contentWidth = Math.max(20, Math.min(maxContentWidth, measuredContentWidth));
  const boxWidth = Math.max(24, Math.min(cols - 2, contentWidth + 4));
  const innerWidth = boxWidth - 4;
  const bandWidth = boxWidth - 2;

  // Chrome rows: top border, band, separator, bottom border.
  const maxBodyRows = Math.max(0, rows - 2 - 4);
  const visibleBody = body.slice(0, maxBodyRows);
  const boxHeight = 4 + visibleBody.length;
  const startRow = Math.max(1, Math.floor((rows - boxHeight) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));

  let row = 0;
  const at = (): string => `\x1b[${startRow + row++};${startCol}H`;
  let output = "\x1b7";
  output += at() + border(`╭${"─".repeat(boxWidth - 2)}╮`);
  output += at() + border("│") + modalBand(bandLabel, v.band, bandWidth) + border("│");
  output += at() + border(`├${"─".repeat(boxWidth - 2)}┤`);
  for (const line of visibleBody) {
    output += at() + `${border("│")} ${padVisible(line, innerWidth)} ${border("│")}`;
  }
  output += at() + border(`╰${"─".repeat(boxWidth - 2)}╯`);
  output += "\x1b8";
  return output;
}
