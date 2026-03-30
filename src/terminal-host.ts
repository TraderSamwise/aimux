export class TerminalHost {
  private rawModeWas: boolean | undefined;
  private terminalRestored = false;
  private inAlternateScreen = false;
  private responseWaiters: Array<{
    matcher: (data: string) => boolean;
    resolve: (data: string | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  getToolRows(mode: "focused" | "dashboard", footerHeight: number): number {
    const rows = process.stdout.rows ?? 24;
    return mode === "focused" ? rows - footerHeight : rows;
  }

  setupScrollRegion(footerHeight: number): void {
    const rows = process.stdout.rows ?? 24;
    const toolRows = rows - footerHeight;
    process.stdout.write(`\x1b[1;${toolRows}r`);
    process.stdout.write(`\x1b[${toolRows};1H`);
  }

  resetScrollRegion(): void {
    process.stdout.write("\x1b[r");
  }

  enterRawMode(): void {
    if (process.stdin.isTTY) {
      this.rawModeWas = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    process.stdout.write("\x1b[?1004h");
  }

  enterAlternateScreen(clear = false): void {
    if (!this.inAlternateScreen) {
      process.stdout.write("\x1b[?1049h");
      this.inAlternateScreen = true;
    }
    if (clear) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }

  exitAlternateScreen(): void {
    if (!this.inAlternateScreen) return;
    process.stdout.write("\x1b[?1049l");
    this.inAlternateScreen = false;
  }

  writeQuery(data: string): void {
    process.stdout.write(data);
  }

  waitForResponse(matcher: (data: string) => boolean, timeoutMs = 150): Promise<string | null> {
    return new Promise((resolve) => {
      const waiter = {
        matcher,
        resolve: (data: string | null) => {
          clearTimeout(waiter.timeout);
          resolve(data);
        },
        timeout: setTimeout(() => {
          this.responseWaiters = this.responseWaiters.filter((entry) => entry !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.responseWaiters.push(waiter);
    });
  }

  consumeResponse(data: Buffer | string): boolean {
    if (this.responseWaiters.length === 0) return false;
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    for (const waiter of [...this.responseWaiters]) {
      if (!waiter.matcher(raw)) continue;
      this.responseWaiters = this.responseWaiters.filter((entry) => entry !== waiter);
      waiter.resolve(raw);
      return true;
    }
    return false;
  }

  exitRawMode(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.rawModeWas ?? false);
      process.stdin.pause();
    }
  }

  restoreTerminalState(): void {
    if (this.terminalRestored) return;
    this.terminalRestored = true;
    for (const waiter of this.responseWaiters) {
      waiter.resolve(null);
    }
    this.responseWaiters = [];

    try {
      this.resetScrollRegion();
      this.exitRawMode();
      process.stdout.write(
        "\x1b[0m" +
          "\x1b[?25h" +
          "\x1b[?1l" +
          "\x1b>" +
          "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
          "\x1b[?2004l" +
          "\x1b[?1049l",
      );
      this.inAlternateScreen = false;
    } catch {}
  }
}
