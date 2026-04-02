import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getAttachmentsDir } from "./paths.js";

export interface AttachmentRecord {
  id: string;
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  source: "path" | "upload";
  contentPath: string;
}

export interface PublicAttachmentRecord {
  id: string;
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  source: "path" | "upload";
  contentUrl: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export function ingestAttachmentFromPath(path: string): PublicAttachmentRecord {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    throw new Error("attachment path is required");
  }
  const buffer = readFileSync(trimmedPath);
  const filename = basename(trimmedPath) || "image";
  return writeAttachment(buffer, {
    filename,
    mimeType: inferMimeType(filename),
    source: "path",
  });
}

export function ingestAttachmentFromBase64(input: {
  contentBase64: string;
  filename?: string;
  mimeType?: string;
}): PublicAttachmentRecord {
  const contentBase64 = input.contentBase64.trim();
  if (!contentBase64) {
    throw new Error("contentBase64 is required");
  }
  const buffer = Buffer.from(contentBase64, "base64");
  if (buffer.length === 0) {
    throw new Error("attachment content is empty");
  }
  const filename = input.filename?.trim() || "image";
  const mimeType = input.mimeType?.trim() || inferMimeType(filename);
  return writeAttachment(buffer, {
    filename,
    mimeType,
    source: "upload",
  });
}

export function getAttachment(id: string): PublicAttachmentRecord | null {
  const record = loadAttachmentRecord(id);
  return record ? toPublicAttachment(record) : null;
}

export function getAttachmentContent(
  id: string,
): { attachment: PublicAttachmentRecord; contentPath: string; buffer: Buffer } | null {
  const record = loadAttachmentRecord(id);
  if (!record) return null;
  return {
    attachment: toPublicAttachment(record),
    contentPath: record.contentPath,
    buffer: readFileSync(record.contentPath),
  };
}

export function resolveAttachmentPath(id: string): string | null {
  const record = loadAttachmentRecord(id);
  return record?.contentPath ?? null;
}

function writeAttachment(
  buffer: Buffer,
  input: { filename: string; mimeType: string; source: "path" | "upload" },
): PublicAttachmentRecord {
  ensureAttachmentsDir();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const id = `att_${sha256.slice(0, 16)}`;
  const extension = normalizeExtension(extname(input.filename), input.mimeType);
  const contentPath = join(getAttachmentsDir(), `${id}${extension}`);
  const metadataPath = join(getAttachmentsDir(), `${id}.json`);

  if (!existsSync(contentPath)) {
    writeFileSync(contentPath, buffer);
  }

  const record: AttachmentRecord = {
    id,
    kind: "image",
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: buffer.length,
    sha256,
    createdAt: existsSync(metadataPath)
      ? loadAttachmentRecord(id)?.createdAt || new Date().toISOString()
      : new Date().toISOString(),
    source: input.source,
    contentPath,
  };
  writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return toPublicAttachment(record);
}

function loadAttachmentRecord(id: string): AttachmentRecord | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const metadataPath = join(getAttachmentsDir(), `${normalizedId}.json`);
  if (!existsSync(metadataPath)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as AttachmentRecord;
  if (!parsed.contentPath || !existsSync(parsed.contentPath)) {
    return null;
  }
  return parsed;
}

function toPublicAttachment(record: AttachmentRecord): PublicAttachmentRecord {
  return {
    id: record.id,
    kind: record.kind,
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    createdAt: record.createdAt,
    source: record.source,
    contentUrl: `/attachments/${record.id}/content`,
  };
}

function ensureAttachmentsDir(): void {
  mkdirSync(getAttachmentsDir(), { recursive: true });
}

function inferMimeType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] || "application/octet-stream";
}

function normalizeExtension(extension: string, mimeType: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed) {
    return trimmed;
  }
  const matched = Object.entries(MIME_BY_EXT).find(([, candidateMime]) => candidateMime === mimeType)?.[0];
  return matched || "";
}
