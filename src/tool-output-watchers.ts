import { createHash } from "node:crypto";
import type { AgentObservation, AgentWatcherContext } from "./agent-watcher.js";
import type { AimuxPluginInstance } from "./plugin-runtime.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";

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

export function classifyToolPane(
  tool: string,
  text: string,
): {
  promptVisible: boolean;
  errorVisible: boolean;
  interruptedVisible: boolean;
} {
  const lower = text.toLowerCase();
  const lastLine = lastMeaningfulLine(text);
  const promptVisible =
    /^\s*[›>]\s?.*$/.test(lastLine) ||
    /use \/skills to list available skills/i.test(text) ||
    /find and fix a bug in @filename/i.test(text);
  const errorVisible =
    /something went wrong/i.test(lower) ||
    /error:/i.test(lower) ||
    /failed:/i.test(lower) ||
    /conversation interrupted/i.test(lower);
  const interruptedVisible = /conversation interrupted/i.test(lower);
  void tool;
  return { promptVisible, errorVisible, interruptedVisible };
}

function deriveObservation(
  sessionId: string,
  tool: string,
  text: string,
  previous: PaneSnapshot | undefined,
): { snapshot: PaneSnapshot; observation?: AgentObservation } {
  const now = Date.now();
  const nextFingerprint = fingerprint(text);
  const { promptVisible, errorVisible, interruptedVisible } = classifyToolPane(tool, text);
  const next: PaneSnapshot = {
    fingerprint: nextFingerprint,
    promptVisible,
    errorVisible,
    lastObservedAt: now,
    lastAppliedActivity: previous?.lastAppliedActivity,
    lastAppliedAttention: previous?.lastAppliedAttention,
  };

  if (!previous || previous.fingerprint !== nextFingerprint) {
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

export function createToolOutputWatcher(context: AgentWatcherContext): AimuxPluginInstance {
  const snapshots = new Map<string, PaneSnapshot>();
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
      if (!metadata.sessionId || target.windowName === "dashboard" || target.windowIndex === 0) continue;
      let text = "";
      try {
        text = tmux.captureTarget(target, { startLine: -80 });
      } catch {
        continue;
      }
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
    },
  };
}
