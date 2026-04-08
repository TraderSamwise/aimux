import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TerminalHost } from "../terminal-host.js";
import { parseKeys } from "../key-parser.js";
import { listSwitchableAgentMenuItems } from "../fast-control.js";
import { formatRelativeRecency } from "../recency.js";
import { TmuxRuntimeManager } from "./runtime-manager.js";

export interface TmuxSwitcherOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
}

function renderSwitcher(
  items: ReturnType<typeof listSwitchableAgentMenuItems>,
  index: number,
  currentWindowId?: string,
): void {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const lines = items.map((item) => {
    const recency = formatRelativeRecency(item.lastUsedAt);
    const current = item.target.windowId === currentWindowId ? "  current" : "";
    return recency ? `${item.label}  ·  ${recency}${current}` : `${item.label}${current}`;
  });
  const help = "s/j/down next  k/up prev  Enter switch  q/Esc cancel";
  const contentWidth = Math.max(help.length, ...lines.map((line) => line.length));
  const contentAreaWidth = Math.min(Math.max(contentWidth, 28), cols - 8);
  const startCol = Math.max(3, Math.floor((cols - contentAreaWidth) / 2));
  const bodyHeight = lines.length + 2;
  const startRow = Math.max(2, Math.floor((rows - bodyHeight) / 2));

  let output = "\x1b[2J\x1b[H";
  for (let i = 0; i < lines.length; i += 1) {
    const selected = i === index;
    const line = lines[i]!.slice(0, contentAreaWidth);
    output += `\x1b[${startRow + i};${startCol}H`;
    if (selected) output += "\x1b[30;43m";
    output += line.padEnd(contentAreaWidth);
    if (selected) output += "\x1b[0m";
  }
  output += `\x1b[${startRow + 1 + lines.length};${startCol}H${help.slice(0, contentAreaWidth).padEnd(contentAreaWidth)}`;
  process.stdout.write(output);
}

function runWindowSwitch(options: TmuxSwitcherOptions, targetWindowId: string): number {
  const scriptPath = fileURLToPath(new URL("../../scripts/tmux-control.sh", import.meta.url));
  const args = [
    scriptPath,
    "window",
    "--project-root",
    options.projectRoot,
    "--project-state-dir",
    options.projectStateDir,
    "--window-id",
    targetWindowId,
    "--current-window-id",
    options.currentWindowId ?? "",
    "--current-window",
    options.currentWindow ?? "",
    "--current-client-session",
    options.currentClientSession ?? "",
    "--client-tty",
    options.clientTty ?? "",
    "--current-path",
    options.currentPath ?? "",
    "--pane-id",
    options.paneId ?? "",
  ];
  const result = spawnSync("sh", args, { stdio: "ignore" });
  return result.status ?? 1;
}

export async function runTmuxSwitcher(options: TmuxSwitcherOptions): Promise<number> {
  const tmux = new TmuxRuntimeManager();
  const items = listSwitchableAgentMenuItems(
    {
      projectRoot: options.projectRoot,
      currentPath: options.currentPath,
      currentWindow: options.currentWindow,
      currentWindowId: options.currentWindowId,
      currentClientSession: options.currentClientSession,
    },
    tmux,
  );
  if (items.length === 0) return 1;

  const terminal = new TerminalHost();
  terminal.enterRawMode();
  terminal.enterAlternateScreen(true);
  process.stdout.write("\x1b[?25l");

  let index = items.length > 1 ? 1 : 0;
  renderSwitcher(items, index, options.currentWindowId);

  const exit = (code: number) => {
    process.stdout.write("\x1b[?25h");
    terminal.restoreTerminalState();
    return code;
  };

  return await new Promise<number>((resolve) => {
    const onData = (data: Buffer) => {
      const events = parseKeys(data);
      const event = events[0];
      const key = event?.name || event?.char || "";

      if (key === "q" || key === "escape" || key === "c" || (event?.ctrl && key === "c")) {
        process.stdin.off("data", onData);
        resolve(exit(0));
        return;
      }

      if (key === "down" || key === "j" || key === "s" || key === "tab") {
        index = (index + 1) % items.length;
        renderSwitcher(items, index, options.currentWindowId);
        return;
      }

      if (key === "up" || key === "k" || (key === "tab" && event?.shift)) {
        index = (index - 1 + items.length) % items.length;
        renderSwitcher(items, index, options.currentWindowId);
        return;
      }

      if (key === "enter" || key === "return") {
        const code = runWindowSwitch(options, items[index]!.target.windowId);
        process.stdin.off("data", onData);
        resolve(exit(code));
        return;
      }
    };

    process.stdin.on("data", onData);
  });
}
