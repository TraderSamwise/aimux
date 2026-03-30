import { renderTerminalSnapshotLine, type SessionTerminalViewport } from "./session-terminal-state.js";
import { TerminalHost } from "./terminal-host.js";

export interface FocusedRenderableSession {
  id: string;
  getViewportFrame(): SessionTerminalViewport;
}

export class FocusedRenderer {
  private lastSessionId: string | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private lastRenderedLines: string[] = [];

  constructor(
    private terminalHost: TerminalHost,
    private renderFooter: (cursor: { row: number; col: number }, force?: boolean) => void,
    private writeOutput: (data: string) => void = (data) => process.stdout.write(data),
  ) {}

  invalidate(): void {
    this.lastSessionId = null;
    this.lastCols = 0;
    this.lastRows = 0;
    this.lastRenderedLines = [];
  }

  async renderSession(session: FocusedRenderableSession | null | undefined, forceFooter = true): Promise<void> {
    if (!session) return;
    const viewport = session.getViewportFrame();
    const renderedLines = Array.from({ length: viewport.rows }, (_, rowIndex) => {
      const line = viewport.visibleLines[rowIndex];
      return line ? renderTerminalSnapshotLine(line) : "";
    });
    const fullRedraw =
      session.id !== this.lastSessionId || viewport.cols !== this.lastCols || viewport.rows !== this.lastRows;

    const changedRows: number[] = [];
    if (fullRedraw) {
      for (let row = 1; row <= viewport.rows; row++) changedRows.push(row);
    } else {
      for (let row = 1; row <= viewport.rows; row++) {
        if (renderedLines[row - 1] !== this.lastRenderedLines[row - 1]) {
          changedRows.push(row);
        }
      }
    }

    let output = "";
    if (changedRows.length > 0) {
      output += "\x1b[?25l\x1b[r";
    }
    for (const row of changedRows) {
      output += `\x1b[${row};1H\x1b[2K${renderedLines[row - 1]}`;
    }
    if (output) {
      this.writeOutput(output);
    }
    this.lastSessionId = session.id;
    this.lastCols = viewport.cols;
    this.lastRows = viewport.rows;
    this.lastRenderedLines = renderedLines;
    this.renderFooter(viewport.cursor, forceFooter);
  }
}
