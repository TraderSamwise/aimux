import type { DaemonProject } from "@/lib/api";
import type { DesktopSession, DesktopService, WorktreeBucket } from "@/lib/desktop-state";
import type { AgentTranscriptMessage } from "@/lib/events";
import { firstTokenOf } from "@/lib/status-tone";
import { WORKTREE_TONES } from "@/lib/worktree-tone";

export type ExposeFilter = "all" | "working" | "attention" | "ready" | "offline";
export type ExposePreviewMode = "chat" | "terminal";

export interface ExposeProjectSource {
  project: DaemonProject;
  groups: WorktreeBucket[];
}

export interface ExposeTile {
  id: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  sessionId: string;
  windowId?: string;
  windowIndex?: number;
  label: string;
  tool: string;
  role?: string;
  kind: "agent" | "service";
  status: string;
  statusKind: "working" | "attention" | "ready" | "offline";
  attention?: string;
  worktreeName: string;
  worktreePath?: string;
  branch?: string;
  tone: string;
  previewMode: ExposePreviewMode;
  previewLines: string[];
  chatPreviewMessages: ExposeChatPreviewMessage[];
}

export interface ExposeChatPreviewMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface BuildExposeTilesOptions {
  previewMode?: ExposePreviewMode;
}

export interface ExposeSummary {
  total: number;
  working: number;
  attention: number;
  ready: number;
  offline: number;
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function sessionStatusKind(session: DesktopSession): ExposeTile["statusKind"] {
  if (
    session.attention === "error" ||
    session.attention === "blocked" ||
    session.attention === "needs_input" ||
    session.attention === "needs_response"
  ) {
    return "attention";
  }
  if (session.status === "running" || session.status === "waiting") return "working";
  if (session.status === "idle") return "ready";
  return "offline";
}

function serviceStatusKind(service: DesktopService): ExposeTile["statusKind"] {
  return service.status === "running" ? "working" : "offline";
}

function previewLinesFor(session: DesktopSession): string[] {
  const output = session.previewSnapshot?.output ?? "";
  if (!output.trim()) return session.previewLine ? [session.previewLine] : [];
  return output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-7);
}

function transcriptMessageText(message: AgentTranscriptMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .map((part) => (part.type === "text" ? part.text : `[${part.label || "image"}]`))
    .join("\n")
    .trim();
  return text || message.text?.trim() || "";
}

function chatPreviewMessagesFor(session: DesktopSession): ExposeChatPreviewMessage[] {
  return (session.chatPreview?.messages ?? [])
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: transcriptMessageText(message),
    }))
    .filter((message) => message.text.length > 0);
}

function sessionStatusLabel(session: DesktopSession): string {
  if (session.pendingAction) return cap(session.pendingAction);
  if (session.attention === "needs_input") return "Needs input";
  if (session.attention === "needs_response") return "Needs reply";
  if (session.attention === "blocked") return "Blocked";
  if (session.attention === "error") return "Error";
  return cap(session.status);
}

export function buildExposeTiles(
  sources: ExposeProjectSource[],
  options: BuildExposeTilesOptions = {},
): ExposeTile[] {
  const tiles: ExposeTile[] = [];
  const requestedPreviewMode = options.previewMode ?? "terminal";
  for (const source of sources) {
    source.groups.forEach((group, groupIndex) => {
      const tone = WORKTREE_TONES[groupIndex % WORKTREE_TONES.length]!;
      for (const session of group.sessions) {
        const chatPreviewMessages = chatPreviewMessagesFor(session);
        const previewMode =
          requestedPreviewMode === "chat" && chatPreviewMessages.length > 0 ? "chat" : "terminal";
        tiles.push({
          id: `${source.project.path}:agent:${session.id}`,
          projectId: source.project.id,
          projectName: source.project.name,
          projectRoot: source.project.path,
          sessionId: session.id,
          windowId: session.tmuxWindowId,
          windowIndex: session.tmuxWindowIndex,
          label: session.label || session.id,
          tool: session.toolConfigKey || firstTokenOf(session.command) || "agent",
          role: session.role,
          kind: "agent",
          status: sessionStatusLabel(session),
          statusKind: sessionStatusKind(session),
          attention: session.attention,
          worktreeName: group.name,
          worktreePath: group.path ?? undefined,
          branch: group.branch,
          tone,
          previewMode,
          previewLines: previewLinesFor(session),
          chatPreviewMessages,
        });
      }
      for (const service of group.services) {
        tiles.push({
          id: `${source.project.path}:service:${service.id}`,
          projectId: source.project.id,
          projectName: source.project.name,
          projectRoot: source.project.path,
          sessionId: service.id,
          windowId: service.tmuxWindowId,
          windowIndex: service.tmuxWindowIndex,
          label: service.label || service.id,
          tool: "service",
          kind: "service",
          status: cap(service.pendingAction ?? service.status),
          statusKind: serviceStatusKind(service),
          worktreeName: group.name,
          worktreePath: group.path ?? undefined,
          branch: group.branch,
          tone,
          previewMode: "terminal",
          previewLines: service.previewLine ? [service.previewLine] : [],
          chatPreviewMessages: [],
        });
      }
    });
  }
  return tiles;
}

export function filterExposeTiles(tiles: ExposeTile[], filter: ExposeFilter): ExposeTile[] {
  if (filter === "all") return tiles;
  return tiles.filter((tile) => tile.statusKind === filter);
}

export function summarizeExposeTiles(tiles: ExposeTile[]): ExposeSummary {
  const summary: ExposeSummary = {
    total: tiles.length,
    working: 0,
    attention: 0,
    ready: 0,
    offline: 0,
  };
  for (const tile of tiles) summary[tile.statusKind]++;
  return summary;
}
