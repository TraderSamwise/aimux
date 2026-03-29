import { renderTerminalSnapshotLine, type SessionTerminalViewport } from "./session-terminal-state.js";
import { TerminalHost } from "./terminal-host.js";

export interface FocusedRenderableSession {
  getViewportFrameAsync(): Promise<SessionTerminalViewport>;
}

export class FocusedRenderer {
  constructor(
    private terminalHost: TerminalHost,
    private renderFooter: (cursor: { row: number; col: number }, force?: boolean) => void,
  ) {}

  async renderSession(session: FocusedRenderableSession | null | undefined, forceFooter = true): Promise<void> {
    if (!session) return;
    const viewport = await session.getViewportFrameAsync();
    let output = "\x1b[r";
    for (let row = 1; row <= viewport.rows; row++) {
      const line = viewport.visibleLines[row - 1];
      output += `\x1b[${row};1H\x1b[2K${line ? renderTerminalSnapshotLine(line) : ""}`;
    }
    process.stdout.write(output);
    this.renderFooter(viewport.cursor, forceFooter);
  }
}
