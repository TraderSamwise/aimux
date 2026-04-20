import { readFileSync } from "node:fs";
import { TerminalHost } from "../terminal-host.js";
import { parseKeys } from "../key-parser.js";
import { requestJson } from "../http-client.js";
import type { NotificationRecord } from "../notifications.js";

export interface TmuxInboxPopupOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
}

type InboxTargetState = "live" | "offline" | "missing" | "none";

interface InboxPopupEntry extends NotificationRecord {
  targetLabel?: string;
  targetState: InboxTargetState;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 8) return [text.slice(0, Math.max(0, width))];
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= width) {
      current = word;
      continue;
    }
    let remaining = word;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    current = remaining;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function formatRelative(createdAt: string): string {
  const deltaMs = Date.now() - Date.parse(createdAt);
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}

function stateLabel(state: InboxTargetState): string {
  switch (state) {
    case "live":
      return "live";
    case "offline":
      return "offline";
    case "missing":
      return "missing";
    default:
      return "info";
  }
}

function loadEndpoint(projectStateDir: string): string {
  const raw = readFileSync(`${projectStateDir}/metadata-api.txt`, "utf8").trim();
  if (!raw) throw new Error("no live project service metadata endpoint");
  return raw;
}

async function loadInboxEntries(endpoint: string): Promise<InboxPopupEntry[]> {
  const [{ status: notificationsStatus, json: notificationsBody }, { status: desktopStatus, json: desktopBody }] =
    await Promise.all([
      requestJson<{ notifications?: NotificationRecord[] }>(`${endpoint}/notifications`, { timeoutMs: 2000 }),
      requestJson<{ sessions?: any[]; services?: any[] }>(`${endpoint}/desktop-state`, { timeoutMs: 2000 }),
    ]);
  if (notificationsStatus < 200 || notificationsStatus >= 300) {
    throw new Error("failed to load inbox");
  }
  if (desktopStatus < 200 || desktopStatus >= 300) {
    throw new Error("failed to load desktop state");
  }

  const sessions = new Map<string, any>((desktopBody.sessions ?? []).map((entry) => [entry.id, entry]));
  const services = new Map<string, any>((desktopBody.services ?? []).map((entry) => [entry.id, entry]));

  return (notificationsBody.notifications ?? []).map((entry) => {
    const session = entry.sessionId ? sessions.get(entry.sessionId) : undefined;
    if (session) {
      return {
        ...entry,
        targetLabel: `${session.label ?? session.command}${session.worktreeName ? ` · ${session.worktreeName}` : ""}`,
        targetState: session.status === "offline" ? "offline" : "live",
      };
    }
    const service = entry.sessionId ? services.get(entry.sessionId) : undefined;
    if (service) {
      return {
        ...entry,
        targetLabel: `${service.label ?? service.command} [service]${service.worktreeName ? ` · ${service.worktreeName}` : ""}`,
        targetState: service.status === "running" ? "live" : "offline",
      };
    }
    return {
      ...entry,
      targetState: entry.sessionId ? "missing" : "none",
    };
  });
}

async function postJson(endpoint: string, path: string, body: unknown): Promise<any> {
  const { status, json } = await requestJson(`${endpoint}${path}`, { method: "POST", body, timeoutMs: 3000 });
  if (status < 200 || status >= 300) {
    const message = typeof (json as any)?.error === "string" ? (json as any).error : `request failed (${status})`;
    throw new Error(message);
  }
  return json;
}

function renderPopup(entries: InboxPopupEntry[], index: number, message: string | null): void {
  const cols = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 28;
  const leftWidth = Math.max(36, Math.min(72, Math.floor(cols * 0.46)));
  const rightWidth = Math.max(24, cols - leftWidth - 6);
  const contentHeight = Math.max(10, rows - 5);
  const listHeight = Math.max(1, contentHeight - 4);
  const startCol = 3;
  const rightCol = startCol + leftWidth + 3;
  const listStartRow = 3;
  const selected = index >= 0 ? entries[index] : undefined;
  const visible = entries.slice(0, listHeight);

  let output = "\x1b[2J\x1b[H";
  output += `\x1b[1;${startCol}H\x1b[1maimux\x1b[0m — inbox`;
  output += `\x1b[1;${rightCol}H${message ? `\x1b[33m${message}\x1b[0m` : `${entries.length} items`}`;

  for (let i = 0; i < visible.length; i += 1) {
    const entry = visible[i]!;
    const row = listStartRow + i;
    const isSelected = i === index;
    const bullet = entry.unread ? "●" : "○";
    const summary = `${bullet} ${entry.title} · ${stateLabel(entry.targetState)} · ${formatRelative(entry.createdAt)}`;
    output += `\x1b[${row};${startCol}H`;
    if (isSelected) output += "\x1b[30;43m";
    output += summary.slice(0, leftWidth).padEnd(leftWidth);
    if (isSelected) output += "\x1b[0m";
  }

  for (let row = 2; row < rows - 2; row += 1) {
    output += `\x1b[${row};${startCol + leftWidth + 1}H│`;
  }

  const details: string[] = [];
  if (selected) {
    details.push(`Target: ${selected.targetLabel ?? "n/a"}`);
    details.push(`State: ${stateLabel(selected.targetState)}`);
    details.push(`When: ${formatRelative(selected.createdAt)}`);
    if (selected.subtitle) details.push(`Subtitle: ${selected.subtitle}`);
    details.push("");
    details.push(...wrapText(selected.body, rightWidth));
  } else {
    details.push("No inbox items.");
  }

  for (let i = 0; i < Math.min(details.length, contentHeight - 1); i += 1) {
    output += `\x1b[${listStartRow + i};${rightCol}H${(details[i] ?? "").slice(0, rightWidth).padEnd(rightWidth)}`;
  }

  const help = "j/k move  Enter jump  r read  R read-all  c clear  C clear-all  q/Esc close";
  output += `\x1b[${rows - 1};${startCol}H${help.slice(0, cols - 4).padEnd(cols - 4)}`;
  process.stdout.write(output);
}

export async function runTmuxInboxPopup(options: TmuxInboxPopupOptions): Promise<number> {
  const endpoint = loadEndpoint(options.projectStateDir);
  let entries = await loadInboxEntries(endpoint);
  let index = entries.length > 0 ? 0 : -1;
  let message: string | null = null;

  const terminal = new TerminalHost();
  terminal.enterRawMode();
  terminal.enterAlternateScreen(true);
  process.stdout.write("\x1b[?25l");
  renderPopup(entries, index, message);

  const exit = (code: number) => {
    process.stdout.write("\x1b[?25h");
    terminal.restoreTerminalState();
    return code;
  };

  const refresh = async (nextMessage: string | null = null) => {
    entries = await loadInboxEntries(endpoint);
    if (index >= entries.length) index = Math.max(0, entries.length - 1);
    if (entries.length === 0) index = -1;
    message = nextMessage;
    renderPopup(entries, index, message);
  };

  return await new Promise<number>((resolve) => {
    const onData = async (data: Buffer) => {
      const events = parseKeys(data);
      const event = events[0];
      const key = event?.name || event?.char || "";

      if (key === "q" || key === "escape" || (event?.ctrl && key === "c")) {
        process.stdin.off("data", onData);
        resolve(exit(0));
        return;
      }
      if (key === "down" || key === "j" || key === "tab") {
        if (entries.length > 1) {
          index = (index + 1) % entries.length;
          renderPopup(entries, index, message);
        }
        return;
      }
      if (key === "up" || key === "k" || (key === "tab" && event?.shift)) {
        if (entries.length > 1) {
          index = (index - 1 + entries.length) % entries.length;
          renderPopup(entries, index, message);
        }
        return;
      }

      const selected = index >= 0 ? entries[index] : undefined;
      if (key === "r") {
        if (!selected) return;
        await postJson(endpoint, "/notifications/read", { id: selected.id });
        await refresh(null);
        return;
      }
      if (key === "R") {
        await postJson(endpoint, "/notifications/read", {});
        await refresh(null);
        return;
      }
      if (key === "c") {
        if (!selected) return;
        await postJson(endpoint, "/notifications/clear", { id: selected.id });
        await refresh(null);
        return;
      }
      if (key === "C") {
        await postJson(endpoint, "/notifications/clear", {});
        await refresh(null);
        return;
      }
      if (key === "enter" || key === "return") {
        if (!selected) {
          process.stdin.off("data", onData);
          resolve(exit(0));
          return;
        }
        if (!selected.sessionId || selected.targetState === "missing") {
          await refresh("target unavailable");
          return;
        }
        try {
          await postJson(endpoint, "/control/open-notification-target", {
            sessionId: selected.sessionId,
            currentClientSession: options.currentClientSession,
            clientTty: options.clientTty,
          });
          if (selected.unread) {
            await postJson(endpoint, "/notifications/read", { id: selected.id });
          }
          process.stdin.off("data", onData);
          resolve(exit(0));
        } catch (error) {
          await refresh(error instanceof Error ? error.message : String(error));
        }
      }
    };

    process.stdin.on("data", onData);
  });
}
