import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAttachmentsDir } from "./paths.js";
import { atomicWrite, writeJsonAtomic } from "./atomic-write.js";

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
  /**
   * The session this attachment belongs to.
   *
   * Optional only because records written before attachments were bound have
   * no such field. Those are unowned, and `attachmentBelongsToSession` refuses
   * every session for them — see its comment for why that is the safe default.
   */
  sessionId?: string;
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
  sessionId?: string;
}

export interface CreateUploadedAttachmentInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
  /** Required: an attachment with no owner cannot be reached by a remote operator. */
  sessionId: string;
}

const maxUploadBytes = 10 * 1024 * 1024;
const allowedImageExtensions = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

/**
 * Does this attachment belong to the session asking for it?
 *
 * A record with no `sessionId` predates attachment binding, so nothing can
 * prove which session it came from. It answers false for every session rather
 * than true for all of them: an unprovable claim must not become an access
 * grant on the path where the agent will read the bytes off disk.
 */
export function attachmentBelongsToSession(record: AttachmentRecord, sessionId: string): boolean {
  return Boolean(record.sessionId) && record.sessionId === sessionId;
}

export function createUploadedAttachment(input: CreateUploadedAttachmentInput): PublicAttachmentRecord {
  const mimeType = input.mimeType.trim().toLowerCase();
  const extension = allowedImageExtensions.get(mimeType);
  if (!extension) {
    throw new Error("unsupported attachment mime type");
  }

  // Charset is checked at the HTTP boundary, which owns request validation.
  // This only refuses to write a record that would be unowned by accident.
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    throw new Error("attachment sessionId is required");
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
    sessionId,
  };

  atomicWrite(contentPath, buffer);
  writeJsonAtomic(join(attachmentsDir, `${id}.json`), record);

  return toPublicAttachment(record);
}

/**
 * The display path, which tolerates an unowned record where the strict path
 * refuses one.
 *
 * A separate function rather than a flag on the strict one, because a boolean
 * that relaxes an access check is the kind of argument that goes missing in a
 * refactor and fails open silently. The two paths are asked for by name.
 *
 * The relaxation is bounded and deliberate. A record with no owner predates
 * attachment binding; refusing those would blank out images already visible in
 * a local user's own pane. Reaching one still requires its 122-bit random id,
 * which only appears in the transcript of the session that used it — and every
 * record written from now on has an owner, so the set never grows. A record
 * owned by a DIFFERENT session is still refused, and so is every unowned
 * record on the input path, which is the one that matters: see
 * `getAttachmentRecord`.
 */
function getAttachmentForDisplay(id: string, sessionId?: string): AttachmentRecord | null {
  const record = getAttachmentRecord(id);
  if (!record) return null;
  if (sessionId !== undefined && record.sessionId && record.sessionId !== sessionId) return null;
  return record;
}

export function getAttachment(id: string, sessionId?: string): PublicAttachmentRecord | null {
  const record = getAttachmentForDisplay(id, sessionId);
  return record ? toPublicAttachment(record) : null;
}

export function getAttachmentContent(
  id: string,
  sessionId?: string,
): { attachment: PublicAttachmentRecord; contentPath: string; buffer: Buffer } | null {
  const record = getAttachmentForDisplay(id, sessionId);
  if (!record) return null;
  return {
    attachment: toPublicAttachment(record),
    contentPath: record.contentPath,
    buffer: readFileSync(record.contentPath),
  };
}

/**
 * The strict path: an attachment must PROVE it belongs to the named session.
 *
 * Used where the agent will be told to open the file, so an unowned record is
 * refused along with a mismatched one. `getAttachmentForDisplay` is the
 * relaxed twin; read its comment before moving a caller between them.
 */
export function getAttachmentRecord(id: string, sessionId?: string): AttachmentRecord | null {
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
  // Null, not a distinct refusal: a caller that could tell "exists but not
  // yours" from "does not exist" could confirm another session's attachment
  // ids by probing.
  if (sessionId !== undefined && !attachmentBelongsToSession(parsed, sessionId)) {
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
    // Carries the owner so a client can fetch it back without having to know
    // to append the session itself. Unowned legacy records stay unqualified,
    // which is the URL the display path still accepts.
    contentUrl: record.sessionId
      ? `/attachments/${record.id}/content?sessionId=${encodeURIComponent(record.sessionId)}`
      : `/attachments/${record.id}/content`,
    sessionId: record.sessionId,
  };
}
