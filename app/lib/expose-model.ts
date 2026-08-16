import type { DaemonProject } from "@/lib/api";
import type { AnsiSpan } from "@/lib/ansi";
import type { AgentTranscriptMessage, ChatMessage } from "@/lib/events";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { firstTokenOf } from "@/lib/status-tone";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import { toChatMessages } from "@/lib/transcript-view";
import { worktreeTone } from "@/lib/worktree-tone";
import type { ExposeChatPreview, ExposePreviewSnapshot } from "../../src/project-api-contract";

export type ExposeFilter = "all" | "working" | "attention" | "ready";

export type ExposeStatusKind =
  | "working"
  | "ready"
  | "idle"
  | "offline"
  | "needs"
  | "error"
  | "done"
  | "blocked"
  | "service"
  | "serviceOff";

export interface ExposeSourceItem {
  id?: string;
  target?: {
    windowId?: string;
    windowIndex?: number;
    windowName?: string;
    sessionName?: string;
  };
  metadata?: {
    sessionId?: string;
    kind?: string;
    command?: string;
    toolConfigKey?: string;
    label?: string;
    role?: string;
    worktreePath?: string;
  };
  label?: string;
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
  previewSnapshot?: ExposePreviewSnapshot;
  chatPreview?: ExposeChatPreview | { messages?: AgentTranscriptMessage[] };
  exposeContext?: {
    worktree?: string;
    project?: string;
    tone?: number;
  };
  exposeStatus?: {
    kind?: string;
    label?: string;
  };
}

export interface ExposeSource {
  project: DaemonProject;
  items: ExposeSourceItem[];
}

export interface ExposeTile {
  id: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  serviceEndpoint: ServiceEndpoint | null;
  sessionId: string;
  windowId?: string;
  windowIndex?: number;
  label: string;
  tool: string;
  role?: string;
  kind: "agent" | "service";
  status: string | null;
  statusKind: ExposeStatusKind | null;
  worktreeName: string;
  worktreePath?: string;
  semanticTitle: string;
  contextSubtitle: string;
  sectionKey: string;
  sectionLabel: string;
  tone: string;
  terminalPreviewLines: AnsiSpan[][];
  chatPreviewMessages: ChatMessage[];
}

export interface ExposeSection {
  key: string;
  label: string;
  tone: string;
  tiles: ExposeTile[];
}

export interface ExposeSummary {
  total: number;
  working: number;
  attention: number;
  ready: number;
}

const EXPOSE_TERMINAL_PREVIEW_DIVIDER_WIDTH = 48;

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function normalizeStatusKind(kind: string | undefined): ExposeStatusKind | null {
  switch (kind) {
    case "working":
    case "ready":
    case "idle":
    case "needs":
    case "done":
    case "blocked":
    case "error":
    case "service":
    case "serviceOff":
    case "offline":
      return kind;
    default:
      return null;
  }
}

function previewLinesFor(item: ExposeSourceItem): AnsiSpan[][] {
  const output = item.previewSnapshot?.output ?? "";
  if (!output.trim()) return [];
  const lines = formatTerminalOutputForDisplay(output.replace(/\r/g, ""), {
    dividerWidth: EXPOSE_TERMINAL_PREVIEW_DIVIDER_WIDTH,
  }).map((line) => trimAnsiLineEnd(line));
  return trimBlankPreviewEdges(lines);
}

function chatPreviewMessagesFor(item: ExposeSourceItem, sessionId: string): ChatMessage[] {
  const messages = item.chatPreview?.messages ?? [];
  if (messages.length === 0) return [];
  return toChatMessages(messages, sessionId).slice(-6);
}

function ansiLineText(line: readonly AnsiSpan[]): string {
  return line.map((span) => span.text).join("");
}

function trimAnsiLineEnd(line: readonly AnsiSpan[]): AnsiSpan[] {
  let trimRemaining = ansiLineText(line).length - ansiLineText(line).trimEnd().length;
  if (trimRemaining <= 0) return [...line];
  const next = [...line];
  for (let index = next.length - 1; index >= 0 && trimRemaining > 0; index -= 1) {
    const span = next[index]!;
    const trimCount = Math.min(trimRemaining, span.text.length);
    const text = span.text.slice(0, span.text.length - trimCount);
    trimRemaining -= trimCount;
    if (text) next[index] = { ...span, text };
    else next.splice(index, 1);
  }
  return next;
}

function isBlankAnsiLine(line: readonly AnsiSpan[]): boolean {
  return ansiLineText(line).trim().length === 0;
}

function trimBlankPreviewEdges(lines: readonly AnsiSpan[][]): AnsiSpan[][] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankAnsiLine(lines[start]!)) start += 1;
  while (end > start && isBlankAnsiLine(lines[end - 1]!)) end -= 1;
  return lines.slice(start, end);
}

function toneFor(
  item: ExposeSourceItem,
  projectRoot: string,
  worktreeName: string,
  projectName: string,
): string {
  return worktreeTone({
    path: item.metadata?.worktreePath ?? projectRoot,
    name: worktreeName,
    projectRoot,
    projectName,
  });
}

export function buildExposeTiles(sources: ExposeSource[]): ExposeTile[] {
  const tiles: ExposeTile[] = [];
  for (const source of sources) {
    source.items.forEach((item, index) => {
      const metadata = item.metadata ?? {};
      const context = item.exposeContext ?? {};
      const projectName = context.project || item.projectName || source.project.name;
      const projectRoot = item.projectRoot || source.project.path;
      const worktreeName = context.worktree || "main";
      const semanticTitle = context.project ? `${projectName} / ${worktreeName}` : worktreeName;
      const statusKind = normalizeStatusKind(item.exposeStatus?.kind);
      const label = item.label || metadata.label || item.id || "agent";
      const sessionId = metadata.sessionId || item.id || label;
      const tool =
        metadata.toolConfigKey ||
        firstTokenOf(metadata.command) ||
        label.split(/[(-]/)[0] ||
        "agent";
      tiles.push({
        id: `${projectRoot}:${item.target?.windowId ?? item.id ?? index}`,
        projectId: item.projectId || source.project.id,
        projectName,
        projectRoot,
        serviceEndpoint: source.project.serviceEndpoint,
        sessionId,
        windowId: item.target?.windowId,
        windowIndex: item.target?.windowIndex,
        label,
        tool,
        role: metadata.role,
        kind: metadata.kind === "service" ? "service" : "agent",
        status: item.exposeStatus?.label || (statusKind ? cap(statusKind) : null),
        statusKind,
        worktreeName,
        worktreePath: metadata.worktreePath,
        semanticTitle,
        contextSubtitle: context.project ? projectName : source.project.name,
        sectionKey: `${projectRoot}:${semanticTitle}`,
        sectionLabel: semanticTitle,
        tone: toneFor(item, projectRoot, worktreeName, projectName),
        terminalPreviewLines: previewLinesFor(item),
        chatPreviewMessages: chatPreviewMessagesFor(item, sessionId),
      });
    });
  }
  return tiles;
}

export function filterExposeTiles(tiles: ExposeTile[], filter: ExposeFilter): ExposeTile[] {
  if (filter === "all") return tiles;
  if (filter === "attention")
    return tiles.filter(
      (tile) =>
        tile.statusKind === "needs" || tile.statusKind === "blocked" || tile.statusKind === "error",
    );
  if (filter === "ready")
    return tiles.filter(
      (tile) =>
        tile.statusKind === "ready" || tile.statusKind === "idle" || tile.statusKind === "done",
    );
  return tiles.filter((tile) => tile.statusKind === filter);
}

export function groupExposeTiles(tiles: ExposeTile[]): ExposeSection[] {
  const sections: ExposeSection[] = [];
  const byKey = new Map<string, ExposeSection>();
  for (const tile of tiles) {
    let section = byKey.get(tile.sectionKey);
    if (!section) {
      section = { key: tile.sectionKey, label: tile.sectionLabel, tone: tile.tone, tiles: [] };
      byKey.set(tile.sectionKey, section);
      sections.push(section);
    }
    section.tiles.push(tile);
  }
  return sections;
}

export function summarizeExposeTiles(tiles: ExposeTile[]): ExposeSummary {
  const summary: ExposeSummary = {
    total: tiles.length,
    working: 0,
    attention: 0,
    ready: 0,
  };
  for (const tile of tiles) {
    if (tile.statusKind === "working") summary.working++;
    else if (
      tile.statusKind === "needs" ||
      tile.statusKind === "blocked" ||
      tile.statusKind === "error"
    )
      summary.attention++;
    else if (
      tile.statusKind === "ready" ||
      tile.statusKind === "idle" ||
      tile.statusKind === "done"
    )
      summary.ready++;
  }
  return summary;
}
