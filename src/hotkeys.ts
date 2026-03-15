import { parseKeys, matchKey, type KeyEvent } from "./key-parser.js";
import { debug } from "./debug.js";

const TIMEOUT_MS = 1000;

export type HotkeyAction =
  | { type: "dashboard" }
  | { type: "focus"; index: number }
  | { type: "next" }
  | { type: "prev" }
  | { type: "create" }
  | { type: "kill" }
  | { type: "passthrough"; data: string };

export type ActionCallback = (action: HotkeyAction) => void;

export class HotkeyHandler {
  private waitingForAction = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private onAction: ActionCallback;

  constructor(onAction: ActionCallback) {
    this.onAction = onAction;
  }

  /**
   * Process raw stdin data. Returns any bytes that should be
   * forwarded to the active PTY (non-hotkey data).
   */
  feed(data: Buffer): string | null {
    const events = parseKeys(data);
    debug(`hotkey feed: ${events.length} events, waiting=${this.waitingForAction}, bytes=${data.length}`, "hotkey");
    if (events.length === 0) return data.toString();

    // If we're waiting for the action key after leader
    if (this.waitingForAction) {
      this.clearTimeout();
      this.waitingForAction = false;
      this.hideLeaderIndicator();
      return this.handleActionEvent(events[0], data);
    }

    // Check if this is the leader key (Ctrl+A)
    if (events.length === 1 && matchKey(events[0], "ctrl+a")) {
      this.waitingForAction = true;
      this.showLeaderIndicator();
      this.timeout = setTimeout(() => {
        this.waitingForAction = false;
        this.hideLeaderIndicator();
        // Timeout: forward the original data
        this.onAction({ type: "passthrough", data: data.toString() });
      }, TIMEOUT_MS);
      return null;
    }

    // Regular data — pass through
    return data.toString();
  }

  private handleActionEvent(event: KeyEvent, rawData: Buffer): string | null {
    // Double Ctrl+A: send literal through
    if (matchKey(event, "ctrl+a")) {
      this.onAction({ type: "passthrough", data: rawData.toString() });
      return null;
    }

    const key = event.name || event.char;

    switch (key) {
      case "d":
        this.onAction({ type: "dashboard" });
        return null;
      case "n":
        this.onAction({ type: "next" });
        return null;
      case "p":
        this.onAction({ type: "prev" });
        return null;
      case "c":
        this.onAction({ type: "create" });
        return null;
      case "x":
        this.onAction({ type: "kill" });
        return null;
      default:
        // Check for digits 1-9
        if (key >= "1" && key <= "9") {
          this.onAction({ type: "focus", index: parseInt(key) - 1 });
          return null;
        }
        // Unknown action key — forward raw data
        this.onAction({ type: "passthrough", data: rawData.toString() });
        return null;
    }
  }

  private showLeaderIndicator(): void {
    // Save cursor, move to top-right, show indicator, restore cursor
    const cols = process.stdout.columns ?? 80;
    const label = " ^A → ? ";
    const col = cols - label.length;
    process.stdout.write(
      `\x1b7` +                              // save cursor
      `\x1b[1;${col}H` +                     // move to top-right
      `\x1b[7;33m${label}\x1b[0m` +          // inverse yellow
      `\x1b8`                                 // restore cursor
    );
  }

  private hideLeaderIndicator(): void {
    // Save cursor, clear the indicator area, restore cursor
    const cols = process.stdout.columns ?? 80;
    const label = " ^A → ? ";
    const col = cols - label.length;
    process.stdout.write(
      `\x1b7` +
      `\x1b[1;${col}H` +
      `${" ".repeat(label.length)}` +
      `\x1b8`
    );
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  destroy(): void {
    this.clearTimeout();
  }
}
