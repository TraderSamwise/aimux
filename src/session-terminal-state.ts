import pkg from "@xterm/headless";
const { Terminal } = pkg;

const DEFAULT_SCROLLBACK = 5_000;
const DEFAULT_SNAPSHOT_MAX_LINES = 1_000;

export interface SessionTerminalSnapshotCell {
  chars: string;
  width: number;
  fg: number;
  bg: number;
  fgMode: "default" | "palette" | "rgb";
  bgMode: "default" | "palette" | "rgb";
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface SessionTerminalSnapshotLine {
  wrapped: boolean;
  cells: SessionTerminalSnapshotCell[];
}

export interface SessionTerminalSnapshot {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  viewportY: number;
  baseY: number;
  startLine: number;
  lines: SessionTerminalSnapshotLine[];
}

export interface SessionTerminalDebugState {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  viewportY: number;
  baseY: number;
  visibleLines: string[];
}

export interface SessionTerminalViewport {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  visibleLines: SessionTerminalSnapshotLine[];
}

export class SessionTerminalState {
  private vt: InstanceType<typeof Terminal>;
  private pendingWrites = 0;
  private flushResolvers: Array<() => void> = [];

  constructor(cols: number, rows: number) {
    this.vt = this.createTerminal(cols, rows);
  }

  write(data: string): void {
    this.pendingWrites++;
    this.vt.write(data, () => {
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      if (this.pendingWrites === 0) {
        const resolvers = this.flushResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
    });
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

    const lines: SessionTerminalSnapshotLine[] = [];
    for (let y = startLine; y < endLine; y++) {
      lines.push(this.snapshotBufferLine(y));
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

  async exportSnapshotAsync(maxLines = DEFAULT_SNAPSHOT_MAX_LINES): Promise<SessionTerminalSnapshot> {
    await this.flush();
    return this.exportSnapshot(maxLines);
  }

  hydrateSnapshot(snapshot: SessionTerminalSnapshot): Promise<void> {
    this.vt.dispose();
    this.vt = this.createTerminal(snapshot.cols, snapshot.rows);
    const body = this.renderSnapshotBody(snapshot.lines);
    const cursor = `\x1b[${snapshot.cursor.row};${snapshot.cursor.col}H`;
    return new Promise((resolve) => {
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
        resolve();
      });
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

  async getScreenStateAsync(): Promise<string> {
    await this.flush();
    return this.getScreenState();
  }

  getCursorPosition(): { row: number; col: number } {
    const buffer = this.vt.buffer.active;
    return {
      row: buffer.cursorY + 1,
      col: buffer.cursorX + 1,
    };
  }

  async getCursorPositionAsync(): Promise<{ row: number; col: number }> {
    await this.flush();
    return this.getCursorPosition();
  }

  getViewport(): SessionTerminalViewport {
    const buffer = this.vt.buffer.active;
    const visibleLines: SessionTerminalSnapshotLine[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + this.vt.rows; y++) {
      visibleLines.push(this.snapshotBufferLine(y));
    }
    return {
      cols: this.vt.cols,
      rows: this.vt.rows,
      cursor: this.getCursorPosition(),
      visibleLines,
    };
  }

  async getViewportAsync(): Promise<SessionTerminalViewport> {
    await this.flush();
    return this.getViewport();
  }

  dispose(): void {
    this.vt.dispose();
  }

  getDebugState(): SessionTerminalDebugState {
    const buffer = this.vt.buffer.active;
    const visibleLines: string[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + this.vt.rows; y++) {
      visibleLines.push(
        this.snapshotBufferLine(y)
          .cells.map((cell) => cell.chars || " ")
          .join(""),
      );
    }
    return {
      cols: this.vt.cols,
      rows: this.vt.rows,
      cursor: this.getCursorPosition(),
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      visibleLines,
    };
  }

  async getDebugStateAsync(): Promise<SessionTerminalDebugState> {
    await this.flush();
    return this.getDebugState();
  }

  async flush(): Promise<void> {
    if (this.pendingWrites === 0) return;
    await new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
    });
  }

  private createTerminal(cols: number, rows: number): InstanceType<typeof Terminal> {
    return new Terminal({ cols, rows, allowProposedApi: true, scrollback: DEFAULT_SCROLLBACK });
  }

  private snapshotBufferLine(y: number): SessionTerminalSnapshotLine {
    const line = this.vt.buffer.active.getLine(y);
    if (!line) {
      return {
        wrapped: false,
        cells: [],
      };
    }

    const cells: SessionTerminalSnapshotCell[] = [];
    for (let x = 0; x < this.vt.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      cells.push({
        chars: cell.getChars() || "",
        width: cell.getWidth(),
        fg: cell.getFgColor(),
        bg: cell.getBgColor(),
        fgMode: cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default",
        bgMode: cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default",
        bold: cell.isBold() !== 0,
        dim: cell.isDim() !== 0,
        italic: cell.isItalic() !== 0,
        underline: cell.isUnderline() !== 0,
        inverse: cell.isInverse() !== 0,
      });
    }

    return {
      wrapped: line.isWrapped,
      cells,
    };
  }

  private renderBufferLine(y: number): string {
    return this.renderSnapshotLine(this.snapshotBufferLine(y));
  }

  private renderSnapshotBody(lines: SessionTerminalSnapshotLine[]): string {
    let output = "";
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !lines[i].wrapped) {
        output += "\r\n";
      }
      output += this.renderSnapshotLine(lines[i]);
    }
    return output;
  }

  private renderSnapshotLine(line: SessionTerminalSnapshotLine): string {
    let output = "";
    let prevFg = -1;
    let prevBg = -1;
    let prevBold = false;
    let prevDim = false;
    let prevItalic = false;
    let prevUnderline = false;
    let prevInverse = false;

    for (const cell of line.cells) {
      const { fg, bg, bold, dim, italic, underline, inverse, fgMode, bgMode } = cell;

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

      if (cell.width === 0) continue;
      output += cell.chars || " ";
    }

    return `${output}\x1b[0m`;
  }
}

export function renderTerminalSnapshotLine(line: SessionTerminalSnapshotLine): string {
  let output = "";
  let prevFg = -1;
  let prevBg = -1;
  let prevBold = false;
  let prevDim = false;
  let prevItalic = false;
  let prevUnderline = false;
  let prevInverse = false;

  for (const cell of line.cells) {
    const { fg, bg, bold, dim, italic, underline, inverse, fgMode, bgMode } = cell;

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

    if (cell.width === 0) continue;
    output += cell.chars || " ";
  }

  return `${output}\x1b[0m`;
}
