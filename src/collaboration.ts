import type { IncomingHttpHeaders } from "node:http";

import type { AgentInputPart } from "./agent-message-parts.js";

export type CollaborationChatMode = "single" | "multi";
export type CollaborationRole = "owner" | "guest";

export interface CollaborationActor {
  userId: string;
  displayName: string;
  email?: string;
  role?: CollaborationRole;
}

export interface AgentCollaborationContext {
  shareId?: string;
  mode?: CollaborationChatMode;
  actor?: CollaborationActor;
}

type HeaderMap = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

export function collaborationContextFromHeaders(headers: HeaderMap): AgentCollaborationContext | undefined {
  const shareId = headerValue(headers, "x-aimux-share-id");
  const mode = parseMode(headerValue(headers, "x-aimux-share-mode"));
  const userId = headerValue(headers, "x-aimux-actor-user-id");
  const displayName = headerValue(headers, "x-aimux-actor-name");
  const email = headerValue(headers, "x-aimux-actor-email");
  const role = parseRole(headerValue(headers, "x-aimux-actor-role"));

  if (!shareId && !mode && !userId && !displayName && !email && !role) {
    return undefined;
  }

  return {
    shareId,
    mode,
    actor: userId
      ? {
          userId,
          displayName: displayName || email || userId,
          email,
          role,
        }
      : undefined,
  };
}

export function applyAgentCollaborationPrefix(
  input: { data?: string; parts?: AgentInputPart[] },
  collaboration?: AgentCollaborationContext,
): { data?: string; parts?: AgentInputPart[] } {
  const actor = collaboration?.actor;
  if (collaboration?.mode !== "multi" || !actor) {
    return input;
  }

  const prefix = `[${formatSpeakerName(actor.displayName)}]:`;
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    let applied = false;
    const parts = input.parts.map((part) => {
      if (part.type !== "text" || applied) return part;
      const text = String(part.text ?? "");
      if (!text.trim()) return part;
      applied = true;
      return { ...part, text: `${prefix} ${text}` };
    });
    return {
      data: input.data,
      parts: applied ? parts : [{ type: "text", text: prefix }, ...input.parts],
    };
  }

  const data = String(input.data ?? "");
  return {
    data: data.trim() ? `${prefix} ${data}` : prefix,
    parts: input.parts,
  };
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseMode(value?: string): CollaborationChatMode | undefined {
  const mode = value?.toLowerCase();
  return mode === "single" || mode === "multi" ? mode : undefined;
}

function parseRole(value?: string): CollaborationRole | undefined {
  const role = value?.toLowerCase();
  return role === "owner" || role === "guest" ? role : undefined;
}

function formatSpeakerName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 80) || "User";
}
