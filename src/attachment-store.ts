import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
