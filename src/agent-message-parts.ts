export type AgentInputPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      path?: string;
      url?: string;
      attachmentId?: string;
      alt?: string;
    };

export function serializeAgentInput(
  input: {
    data?: string;
    parts?: AgentInputPart[];
  },
  options: { tool?: string; resolveAttachmentPath?: (attachmentId: string) => string | null } = {},
): string {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (parts.length === 0) {
    return String(input.data ?? "");
  }

  const serializedParts = parts.map((part) => serializePart(part, options)).filter((chunk) => chunk.length > 0);

  if (serializedParts.length === 0) {
    return String(input.data ?? "");
  }
  return serializedParts.join("\n\n");
}

function serializePart(
  part: AgentInputPart,
  options: { tool?: string; resolveAttachmentPath?: (attachmentId: string) => string | null },
): string {
  if (part.type === "text") {
    return String(part.text ?? "");
  }

  const tool = (options.tool || "agent").trim() || "agent";
  const resolvedAttachmentPath = part.attachmentId?.trim()
    ? options.resolveAttachmentPath?.(part.attachmentId.trim())
    : null;
  const source = part.path?.trim() || resolvedAttachmentPath || part.url?.trim() || part.attachmentId?.trim() || "";
  if (!source) {
    return "";
  }

  const alt = part.alt?.trim();
  const lines = [`[inline image for ${tool}]`, `source: ${source}`];
  if (alt) {
    lines.push(`alt: ${alt}`);
  }
  return lines.join("\n");
}
