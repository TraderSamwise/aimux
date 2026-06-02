import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

export interface CreateUploadedAttachmentInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

const maxUploadBytes = 10 * 1024 * 1024;
const allowedImageExtensions = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

export function createUploadedAttachment(input: CreateUploadedAttachmentInput): PublicAttachmentRecord {
  const mimeType = input.mimeType.trim().toLowerCase();
  const extension = allowedImageExtensions.get(mimeType);
  if (!extension) {
    throw new Error("unsupported attachment mime type");
  }

  const filename = sanitizeFilename(input.filename);
  const dataBase64 = normalizeBase64(input.dataBase64);
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length === 0) {
    throw new Error("attachment content is required");
  }
  if (buffer.length > maxUploadBytes) {
    throw new Error("attachment exceeds 10 MB");
  }

  const attachmentsDir = getAttachmentsDir();
  mkdirSync(attachmentsDir, { recursive: true });

  const id = `att_${randomUUID().replaceAll("-", "")}`;
  const contentPath = join(attachmentsDir, `${id}${extension}`);
  const record: AttachmentRecord = {
    id,
    kind: "image",
    filename,
    mimeType,
    sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    createdAt: new Date().toISOString(),
    source: "upload",
    contentPath,
  };

  writeFileSync(contentPath, buffer);
  writeFileSync(join(attachmentsDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return toPublicAttachment(record);
}

export function getAttachment(id: string): PublicAttachmentRecord | null {
  const record = getAttachmentRecord(id);
  return record ? toPublicAttachment(record) : null;
}

export function getAttachmentContent(
  id: string,
): { attachment: PublicAttachmentRecord; contentPath: string; buffer: Buffer } | null {
  const record = getAttachmentRecord(id);
  if (!record) return null;
  return {
    attachment: toPublicAttachment(record),
    contentPath: record.contentPath,
    buffer: readFileSync(record.contentPath),
  };
}

export function getAttachmentRecord(id: string): AttachmentRecord | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedId)) return null;
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

function sanitizeFilename(filename: string): string {
  const safeName = basename(filename.trim()).replaceAll(/[\\/]/g, "").trim();
  return safeName || "image";
}

function normalizeBase64(dataBase64: string): string {
  const normalized = dataBase64
    .trim()
    .replace(/^data:[^;]+;base64,/, "")
    .replaceAll(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("attachment content must be base64");
  }
  return normalized;
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
