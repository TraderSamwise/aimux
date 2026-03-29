export class TerminalHost {
  private rawModeWas: boolean | undefined;
  private terminalRestored = false;

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

  exitRawMode(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.rawModeWas ?? false);
      process.stdin.pause();
    }
  }

  restoreTerminalState(): void {
    if (this.terminalRestored) return;
    this.terminalRestored = true;

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
    } catch {}
  }
}
