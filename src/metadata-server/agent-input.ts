import type { AttachmentRecord, HostedAttachmentReference } from "../attachment-store.js";

export type SharedChatActorRole = "owner" | "guest";

export interface SharedChatActorForPrompt {
  role: SharedChatActorRole;
  displayName?: string;
  email?: string;
}

function trimmedBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function bodySharedChatActor(body: unknown): SharedChatActorForPrompt | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).sharedChatActor;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = record.role;
  if (role !== "owner" && role !== "guest") return null;
  const displayName = trimmedBodyString(record.displayName);
  const email = trimmedBodyString(record.email);
  if (!displayName && !email) return null;
  return { role, displayName, email };
}

export function hostedAttachmentFromBody(value: unknown): HostedAttachmentReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.contentUrl !== "string" || typeof record.expiresAt !== "string") return undefined;
  return {
    contentUrl: record.contentUrl,
    expiresAt: record.expiresAt,
    sha256: typeof record.sha256 === "string" ? record.sha256 : undefined,
    sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
  };
}

export function safeSharedChatActorName(actor: SharedChatActorForPrompt): string {
  const fallback = actor.role === "owner" ? "chat owner" : "shared guest";
  const raw = actor.displayName?.trim() || actor.email?.trim() || fallback;
  return raw.replace(/\s+/g, " ").slice(0, 80) || fallback;
}

export function formatSharedChatAgentInput(text: string, actor: SharedChatActorForPrompt): string {
  return `[${safeSharedChatActorName(actor)}] ${text.trim()}`;
}

export function formatAgentInputWithAttachments(text: string, attachments: AttachmentRecord[]): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) return text;

  const body = trimmedText || "Please review the attached file(s).";
  const attachmentLines = attachments.map((attachment) => {
    return `- ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.contentPath}`;
  });

  return `${body}\n\nAttached files:\n${attachmentLines.join("\n")}`;
}
