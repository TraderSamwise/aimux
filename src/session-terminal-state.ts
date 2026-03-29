import pkg from "@xterm/headless";
const { Terminal } = pkg;

const DEFAULT_SCROLLBACK = 5_000;
const DEFAULT_SNAPSHOT_MAX_LINES = 1_000;

export interface SessionTerminalSnapshot {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  viewportY: number;
  baseY: number;
  startLine: number;
  lines: string[];
}

export class SessionTerminalState {
  private vt: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number) {
    this.vt = this.createTerminal(cols, rows);
  }

  write(data: string): void {
    this.vt.write(data);
  }

  resize(cols: number, rows: number): void {
    this.vt.resize(cols, rows);
  }

  scrollLines(amount: number): void {
    this.vt.scrollLines(amount);
  }

  exportSnapshot(maxLines = DEFAULT_SNAPSHOT_MAX_LINES): SessionTerminalSnapshot {
    const buffer = this.vt.buffer.active;
    const totalLines = buffer.length;
    const viewportStart = buffer.viewportY;
    let startLine = viewportStart < buffer.baseY ? viewportStart : Math.max(0, totalLines - maxLines);
    const endLine = Math.min(totalLines, Math.max(startLine + maxLines, viewportStart + this.vt.rows));
    if (endLine - startLine > maxLines) {
      startLine = Math.max(0, endLine - maxLines);
    }

    const lines: string[] = [];
    for (let y = startLine; y < endLine; y++) {
      lines.push(this.renderBufferLine(y));
    }

    return {
      cols: this.vt.cols,
      rows: this.vt.rows,
      cursor: this.getCursorPosition(),
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      startLine,
      lines,
    };
  }

  hydrateSnapshot(snapshot: SessionTerminalSnapshot): void {
    this.vt.dispose();
    this.vt = this.createTerminal(snapshot.cols, snapshot.rows);
    const body = snapshot.lines.join("\r\n");
    const cursor = `\x1b[${snapshot.cursor.row};${snapshot.cursor.col}H`;
    this.vt.write(`\x1b[2J\x1b[H\x1b[0m${body}${cursor}`, () => {
      const currentViewport = this.vt.buffer.active.viewportY;
      const targetViewport = Math.max(
        0,
        Math.min(this.vt.buffer.active.baseY, snapshot.viewportY - snapshot.startLine),
      );
      const delta = targetViewport - currentViewport;
      if (delta !== 0) {
        this.vt.scrollLines(delta);
      }
    });
  }

  getScreenState(): string {
    let output = "\x1b[2J\x1b[H\x1b[0m";
    const buffer = this.vt.buffer.active;
    const startLine = buffer.viewportY;
    const endLine = startLine + this.vt.rows;

    for (let y = startLine; y < endLine; y++) {
      output += this.renderBufferLine(y);
      if (y < endLine - 1) output += "\r\n";
    }

    const cursor = this.getCursorPosition();
    output += `\x1b[${cursor.row};${cursor.col}H`;
    return output;
  }

  getCursorPosition(): { row: number; col: number } {
    const buffer = this.vt.buffer.active;
    return {
      row: buffer.cursorY + 1,
      col: buffer.cursorX + 1,
    };
  }

  dispose(): void {
    this.vt.dispose();
  }

  private createTerminal(cols: number, rows: number): InstanceType<typeof Terminal> {
    return new Terminal({ cols, rows, allowProposedApi: true, scrollback: DEFAULT_SCROLLBACK });
  }

  private renderBufferLine(y: number): string {
    const line = this.vt.buffer.active.getLine(y);
    if (!line) return "";

    let output = "";
    let prevFg = -1;
    let prevBg = -1;
    let prevBold = false;
    let prevDim = false;
    let prevItalic = false;
    let prevUnderline = false;
    let prevInverse = false;

    for (let x = 0; x < this.vt.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;

      const fg = cell.getFgColor();
      const bg = cell.getBgColor();
      const bold = cell.isBold() !== 0;
      const dim = cell.isDim() !== 0;
      const italic = cell.isItalic() !== 0;
      const underline = cell.isUnderline() !== 0;
      const inverse = cell.isInverse() !== 0;
      const fgMode = cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default";
      const bgMode = cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default";

      if (
        fg !== prevFg ||
        bg !== prevBg ||
        bold !== prevBold ||
        dim !== prevDim ||
        italic !== prevItalic ||
        underline !== prevUnderline ||
        inverse !== prevInverse
      ) {
        const sgr: number[] = [0];
        if (bold) sgr.push(1);
        if (dim) sgr.push(2);
        if (italic) sgr.push(3);
        if (underline) sgr.push(4);
        if (inverse) sgr.push(7);
        if (fgMode === "palette") {
          if (fg < 8) sgr.push(30 + fg);
          else if (fg < 16) sgr.push(90 + fg - 8);
          else sgr.push(38, 5, fg);
        } else if (fgMode === "rgb") {
          sgr.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
        }
        if (bgMode === "palette") {
          if (bg < 8) sgr.push(40 + bg);
          else if (bg < 16) sgr.push(100 + bg - 8);
          else sgr.push(48, 5, bg);
        } else if (bgMode === "rgb") {
          sgr.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
        }
        output += `\x1b[${sgr.join(";")}m`;
        prevFg = fg;
        prevBg = bg;
        prevBold = bold;
        prevDim = dim;
        prevItalic = italic;
        prevUnderline = underline;
        prevInverse = inverse;
      }

      output += cell.getChars() || " ";
    }

    return `${output}\x1b[0m`;
  }
}
