export class TerminalHost {
  private rawModeWas: boolean | undefined;
  private terminalRestored = false;
  private inAlternateScreen = false;

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
