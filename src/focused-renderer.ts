import { TerminalHost } from "./terminal-host.js";

export interface FocusedRenderableSession {
  getScreenState(): string;
}

export class FocusedRenderer {
  constructor(
    private terminalHost: TerminalHost,
    private getFooterHeight: () => number,
    private renderFooter: (force?: boolean) => void,
  ) {}

  renderSession(session: FocusedRenderableSession | null | undefined, forceFooter = true): void {
    this.terminalHost.setupScrollRegion(this.getFooterHeight());
    if (session) {
      process.stdout.write(session.getScreenState());
    }
    this.renderFooter(forceFooter);
  }
}
