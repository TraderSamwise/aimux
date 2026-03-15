export type SessionStatus = "running" | "idle" | "waiting" | "exited" | "offline";

// Generic patterns that look like prompts
const GENERIC_PROMPT = /[>$#%] $/m;

export class StatusDetector {
  private lastOutputTime = 0;
  private lastStrippedLine = "";
  private patterns: RegExp[];
  private _status: SessionStatus = "running";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(promptPatterns: RegExp[] = []) {
    this.patterns = promptPatterns;
  }

  get status(): SessionStatus {
    return this._status;
  }

  /**
   * Feed stripped (no ANSI) output for analysis.
   */
  feed(strippedText: string): void {
    this.lastOutputTime = Date.now();
    this._status = "running";

    // Track the last non-empty line
    const lines = strippedText.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) {
        this.lastStrippedLine = lines[i];
        break;
      }
    }

    // Reset idle timer
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.checkIdle(), 2000);
  }

  private checkIdle(): void {
    const elapsed = Date.now() - this.lastOutputTime;
    if (elapsed < 2000) return;

    // Check tool-specific prompts from config
    for (const pattern of this.patterns) {
      if (pattern.test(this.lastStrippedLine)) {
        this._status = "idle";
        return;
      }
    }

    // Check generic prompt pattern
    if (GENERIC_PROMPT.test(this.lastStrippedLine)) {
      this._status = "idle";
      return;
    }

    // No prompt detected but output stopped — "waiting" (thinking/processing)
    this._status = "waiting";
  }

  markExited(): void {
    this._status = "exited";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
