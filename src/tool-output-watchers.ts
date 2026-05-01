import { createHash } from "node:crypto";
import type { AgentObservation, AgentWatcherContext } from "./agent-watcher.js";
import type { AimuxPluginInstance } from "./plugin-runtime.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { SessionServiceMetadata } from "./metadata-store.js";
import { OscNotificationParser } from "./osc-notifications.js";

interface PaneSnapshot {
  fingerprint: string;
  promptVisible: boolean;
  errorVisible: boolean;
  lastObservedAt: number;
  lastAppliedActivity?: import("./agent-events.js").AgentActivityState;
  lastAppliedAttention?: import("./agent-events.js").AgentAttentionState;
}

function fingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function tailLines(text: string, count = 12): string[] {
  return text.split("\n").slice(-count);
}

function lastMeaningfulLine(text: string): string {
  const lines = tailLines(text, 20)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function classifyActiveTailError(text: string): { errorVisible: boolean; interruptedVisible: boolean } {
  const recentLines = tailLines(text, 20)
    .map((line) => line.trim())
    .filter(Boolean);
  if (recentLines.length === 0) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const isInterruptedLine = (line: string) =>
    /conversation interrupted/i.test(line) || /\binterrupted\b.*\bwhat should\b.*\bdo instead\?/i.test(line);
  const isErrorLine = (line: string) =>
    isInterruptedLine(line) || /something went wrong/i.test(line) || /error:/i.test(line) || /failed:/i.test(line);

  let lastErrorIndex = -1;
  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    const line = recentLines[index];
    if (!isErrorLine(line)) continue;
    lastErrorIndex = index;
    break;
  }

  if (lastErrorIndex === -1) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const laterMeaningfulLines = recentLines.slice(lastErrorIndex + 1);
  if (laterMeaningfulLines.length > 0) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const interruptedVisible = recentLines.slice(0, lastErrorIndex + 1).some((line) => isInterruptedLine(line));
  return { errorVisible: true, interruptedVisible };
}

function tracksPromptReadiness(tool: string): boolean {
  const normalizedTool = tool.trim().toLowerCase();
  return normalizedTool === "claude" || normalizedTool === "codex";
}

function hasToolInputPrompt(tool: string, text: string, lastLine: string): boolean {
  const normalizedTool = tool.trim().toLowerCase();
  if (normalizedTool === "codex") {
    return /^\s*[›❯]\s?.*$/.test(lastLine) || /use \/skills to list available skills/i.test(text);
  }
  if (normalizedTool === "claude") {
    return (
      /^\s*[›>❯]\s?.*$/.test(lastLine) ||
      /use \/skills to list available skills/i.test(text) ||
      /find and fix a bug in @filename/i.test(text)
    );
  }
  return false;
}

function classifyToolUpdatePrompt(
  tool: string,
  text: string,
): {
  updatePromptVisible: boolean;
  blockedMessage?: string;
} {
  const normalizedTool = tool.trim().toLowerCase();
  if (normalizedTool === "codex") {
    const hasBanner = /update available!/i.test(text);
    const hasCommand = /npm install -g @openai\/codex/i.test(text);
    if (hasBanner && hasCommand) {
      return {
        updatePromptVisible: true,
        blockedMessage:
          "Codex update prompt detected. In-session update is not supported in aimux. Exit this agent, run `npm install -g @openai/codex`, then restart it.",
      };
    }
  }

  if (normalizedTool === "claude") {
    const hasClaudeHeader = /claude code/i.test(text);
    const hasCommand = /\bclaude (update|upgrade)\b/i.test(text);
    const hasUpdateLanguage = /\bupdate\b|\bupgrade\b/i.test(text);
    if (hasClaudeHeader && hasCommand && hasUpdateLanguage) {
      return {
        updatePromptVisible: true,
        blockedMessage:
          "Claude update prompt detected. In-session update is not supported in aimux. Exit this agent, run `claude update`, then restart it.",
      };
    }
  }

  return { updatePromptVisible: false };
}

export function classifyToolPane(
  tool: string,
  text: string,
): {
  promptVisible: boolean;
  errorVisible: boolean;
  interruptedVisible: boolean;
  updatePromptVisible: boolean;
  blockedMessage?: string;
} {
  const lastLine = lastMeaningfulLine(text);
  const { errorVisible, interruptedVisible } = classifyActiveTailError(text);
  const { updatePromptVisible, blockedMessage } = classifyToolUpdatePrompt(tool, text);
  const promptVisible = !updatePromptVisible && tracksPromptReadiness(tool) && hasToolInputPrompt(tool, text, lastLine);
  return { promptVisible, errorVisible, interruptedVisible, updatePromptVisible, blockedMessage };
}

export function deriveObservation(
  sessionId: string,
  tool: string,
  text: string,
  previous: PaneSnapshot | undefined,
): { snapshot: PaneSnapshot; observation?: AgentObservation } {
  const now = Date.now();
  const nextFingerprint = fingerprint(text);
  const { promptVisible, errorVisible, interruptedVisible, updatePromptVisible, blockedMessage } = classifyToolPane(
    tool,
    text,
  );
  const next: PaneSnapshot = {
    fingerprint: nextFingerprint,
    promptVisible,
    errorVisible,
    lastObservedAt: now,
    lastAppliedActivity: previous?.lastAppliedActivity,
    lastAppliedAttention: previous?.lastAppliedAttention,
  };

  if (!previous || previous.fingerprint !== nextFingerprint) {
    if (updatePromptVisible && previous?.lastAppliedAttention !== "blocked") {
      next.lastAppliedActivity = "waiting";
      next.lastAppliedAttention = "blocked";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "waiting",
          attention: "blocked",
          event: {
            kind: "blocked",
            message: blockedMessage ?? "Tool update required",
            source: tool,
            tone: "warn",
          },
        },
      };
    }
    if (errorVisible && previous?.errorVisible !== true) {
      next.lastAppliedActivity = "error";
      next.lastAppliedAttention = "error";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "error",
          attention: "error",
          event: {
            kind: interruptedVisible ? "interrupted" : "notify",
            message: interruptedVisible ? "Conversation interrupted" : "Tool error",
            source: tool,
            tone: "error",
          },
        },
      };
    }
    if (!errorVisible && previous?.lastAppliedAttention === "error") {
      if (tracksPromptReadiness(tool)) {
        if (promptVisible) {
          next.lastAppliedActivity = "waiting";
          next.lastAppliedAttention = "needs_input";
          return {
            snapshot: next,
            observation: {
              sessionId,
              tool,
              activity: "waiting",
              attention: "needs_input",
            },
          };
        }
        next.lastAppliedActivity = "running";
        next.lastAppliedAttention = "normal";
        return {
          snapshot: next,
          observation: {
            sessionId,
            tool,
            activity: "running",
            attention: "normal",
          },
        };
      }

      next.lastAppliedActivity = previous.lastAppliedActivity === "error" ? undefined : previous.lastAppliedActivity;
      next.lastAppliedAttention = "normal";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          attention: "normal",
        },
      };
    }
    if (!updatePromptVisible && previous?.lastAppliedAttention === "blocked") {
      if (promptVisible) {
        next.lastAppliedActivity = "waiting";
        next.lastAppliedAttention = "needs_input";
        return {
          snapshot: next,
          observation: {
            sessionId,
            tool,
            activity: "waiting",
            attention: "needs_input",
          },
        };
      }
      next.lastAppliedActivity = "running";
      next.lastAppliedAttention = "normal";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "running",
          attention: "normal",
        },
      };
    }
    if (!promptVisible && previous?.promptVisible && previous.lastAppliedAttention === "needs_input") {
      next.lastAppliedActivity = "running";
      next.lastAppliedAttention = "normal";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "running",
          attention: "normal",
        },
      };
    }
    if (promptVisible) {
      next.lastAppliedActivity = "waiting";
      next.lastAppliedAttention = "needs_input";
      if (!previous?.promptVisible) {
        return {
          snapshot: next,
          observation: {
            sessionId,
            tool,
            activity: "waiting",
            attention: "needs_input",
            event: {
              kind: "needs_input",
              message: "Ready for input",
              source: tool,
              tone: "warn",
            },
          },
        };
      }
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "waiting",
          attention: "needs_input",
        },
      };
    }
    if (tracksPromptReadiness(tool)) {
      next.lastAppliedActivity = "running";
      next.lastAppliedAttention = "normal";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "running",
          attention: "normal",
        },
      };
    }
    if (!previous) {
      next.lastAppliedActivity = "running";
      next.lastAppliedAttention = "normal";
      return {
        snapshot: next,
        observation: {
          sessionId,
          tool,
          activity: "running",
          attention: "normal",
        },
      };
    }
    next.lastAppliedActivity = previous?.lastAppliedActivity;
    next.lastAppliedAttention = previous?.lastAppliedAttention;
    return { snapshot: next };
  }

  if (promptVisible && previous?.lastAppliedActivity !== "waiting") {
    next.lastAppliedActivity = "waiting";
    next.lastAppliedAttention = "needs_input";
    return {
      snapshot: next,
      observation: {
        sessionId,
        tool,
        activity: "waiting",
        attention: "needs_input",
      },
    };
  }
  if (updatePromptVisible && previous?.lastAppliedAttention !== "blocked") {
    next.lastAppliedActivity = "waiting";
    next.lastAppliedAttention = "blocked";
    return {
      snapshot: next,
      observation: {
        sessionId,
        tool,
        activity: "waiting",
        attention: "blocked",
        event: {
          kind: "blocked",
          message: blockedMessage ?? "Tool update required",
          source: tool,
          tone: "warn",
        },
      },
    };
  }
  if (errorVisible && previous?.lastAppliedActivity !== "error") {
    next.lastAppliedActivity = "error";
    next.lastAppliedAttention = "error";
    return {
      snapshot: next,
      observation: {
        sessionId,
        tool,
        activity: "error",
        attention: "error",
      },
    };
  }

  next.lastAppliedActivity = previous?.lastAppliedActivity;
  next.lastAppliedAttention = previous?.lastAppliedAttention;
  return { snapshot: next };
}

export function extractLocalServices(text: string): SessionServiceMetadata[] {
  const services = new Map<string, SessionServiceMetadata>();
  const urlMatches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:[^\s)]*)?/g) ?? [];
  for (const url of urlMatches) {
    const portMatch = url.match(/:(\d+)(?:\/|$)/);
    const port = portMatch ? Number(portMatch[1]) : undefined;
    services.set(url, { url, port });
  }
  return Array.from(services.values()).slice(0, 3);
}

export function createToolOutputWatcher(context: AgentWatcherContext): AimuxPluginInstance {
  const snapshots = new Map<string, PaneSnapshot>();
  const oscParsers = new Map<string, OscNotificationParser>();
  const rawPaneTexts = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    const tmux = new TmuxRuntimeManager();
    const sessionName = tmux.getProjectSession(context.api.projectRoot).sessionName;
    let windows: ReturnType<TmuxRuntimeManager["listManagedWindows"]> = [];
    try {
      windows = tmux.listManagedWindows(sessionName);
    } catch {
      return;
    }

    for (const { target, metadata } of windows) {
      if (!metadata.sessionId || isDashboardWindowName(target.windowName)) continue;
      let rawText = "";
      try {
        rawText = tmux.captureTarget(target, { startLine: -80, includeEscapes: true });
      } catch {
        continue;
      }
      const parser = oscParsers.get(metadata.sessionId) ?? new OscNotificationParser();
      oscParsers.set(metadata.sessionId, parser);
      const previousRaw = rawPaneTexts.get(metadata.sessionId) ?? "";
      const delta = rawText.startsWith(previousRaw) ? rawText.slice(previousRaw.length) : rawText;
      rawPaneTexts.set(metadata.sessionId, rawText);
      const deltaParsed = parser.parseChunk(delta);
      for (const notification of deltaParsed.notifications) {
        context.api.metadata.emitEvent(metadata.sessionId, {
          kind: "notify",
          message: notification.body || notification.title || "Notification",
          source: metadata.command,
          tone: "info",
        });
      }
      const text = new OscNotificationParser().parseChunk(rawText).cleaned;
      context.api.metadata.setServices(metadata.sessionId, extractLocalServices(text));
      const previous = snapshots.get(metadata.sessionId);
      const { snapshot, observation } = deriveObservation(metadata.sessionId, metadata.command, text, previous);
      snapshots.set(metadata.sessionId, snapshot);
      if (!observation) continue;
      if (observation.activity) context.api.metadata.setActivity(observation.sessionId, observation.activity);
      if (observation.attention) context.api.metadata.setAttention(observation.sessionId, observation.attention);
      if (observation.event) context.api.metadata.emitEvent(observation.sessionId, observation.event);
    }
  };

  return {
    start() {
      poll();
      timer = setInterval(poll, 2000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      oscParsers.clear();
      rawPaneTexts.clear();
    },
  };
}
