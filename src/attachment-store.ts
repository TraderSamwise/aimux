import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getAttachmentsDir } from "./paths.js";
import { atomicWrite, writeJsonAtomic } from "./atomic-write.js";

export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

export interface AttachmentRecord {
  id: string;
  kind: AttachmentKind;
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
  hostedAttachment?: HostedAttachmentReference;
}

export interface HostedAttachmentReference {
  contentUrl: string;
  expiresAt: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface PublicAttachmentRecord {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  source: "path" | "upload";
  contentUrl: string;
  hostedContentUrl?: string;
  hostedExpiresAt?: string;
  sessionId?: string;
}

export interface CreateUploadedAttachmentInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
  /** Required: an attachment with no owner cannot be reached by a remote operator. */
  sessionId: string;
  hostedAttachment?: HostedAttachmentReference;
}

export interface CreatePathAttachmentInput {
  filename?: string;
  mimeType?: string;
  projectRoot: string;
  sourcePath: string;
  allowedRoots?: string[];
  /** Required: an attachment with no owner cannot be reached by a remote operator. */
  sessionId: string;
  hostedAttachment?: HostedAttachmentReference;
}

const maxUploadBytes = 10 * 1024 * 1024;
const mimeExtensions = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["audio/aac", ".aac"],
  ["audio/flac", ".flac"],
  ["audio/m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/wav", ".wav"],
  ["audio/webm", ".webm"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["application/pdf", ".pdf"],
  ["application/json", ".json"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
]);

const activeMimeTypes = new Set([
  "application/javascript",
  "application/ecmascript",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/ecmascript",
  "text/html",
  "text/javascript",
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
  const mimeType = normalizeMimeType(input.mimeType);
  const kind = inferAttachmentKind(mimeType);

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
  const hostedAttachment = input.hostedAttachment
    ? normalizeHostedAttachmentReference(input.hostedAttachment, {
        sha256: createHash("sha256").update(buffer).digest("hex"),
        sizeBytes: buffer.length,
      })
    : undefined;

  const attachmentsDir = getAttachmentsDir();
  mkdirSync(attachmentsDir, { recursive: true });

  const id = `att_${randomUUID().replaceAll("-", "")}`;
  const extension = extensionForAttachment(mimeType, filename);
  const contentPath = join(attachmentsDir, `${id}${extension}`);
  const record: AttachmentRecord = {
    id,
    kind,
    filename,
    mimeType,
    sizeBytes: buffer.length,
    sha256: hostedAttachment?.sha256 ?? createHash("sha256").update(buffer).digest("hex"),
    createdAt: new Date().toISOString(),
    source: "upload",
    contentPath,
    sessionId,
    ...(hostedAttachment ? { hostedAttachment } : {}),
  };

  atomicWrite(contentPath, buffer);
  writeJsonAtomic(join(attachmentsDir, `${id}.json`), record);

  return toPublicAttachment(record);
}

export function createPathAttachment(input: CreatePathAttachmentInput): PublicAttachmentRecord {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    throw new Error("attachment sessionId is required");
  }
  const sourcePath = resolve(input.sourcePath);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error("attachment source must be a regular file");
  }
  const sourceRealPath = realpathSync(sourcePath);
  const allowedRoots = [input.projectRoot, ...(input.allowedRoots ?? [])].filter(Boolean);
  if (!isPathUnderAnyRoot(sourceRealPath, allowedRoots)) {
    throw new Error("attachment source must be inside the project");
  }

  const buffer = readFileSync(sourceRealPath);
  if (buffer.length === 0) {
    throw new Error("attachment content is required");
  }
  if (buffer.length > maxUploadBytes) {
    throw new Error("attachment exceeds 10 MB");
  }
  const bufferSha256 = createHash("sha256").update(buffer).digest("hex");
  const hostedAttachment = input.hostedAttachment
    ? normalizeHostedAttachmentReference(input.hostedAttachment, {
        sha256: bufferSha256,
        sizeBytes: buffer.length,
      })
    : undefined;

  const filename = sanitizeFilename(input.filename || basename(sourcePath));
  const mimeType = normalizeMimeType(input.mimeType || mimeTypeFromFilename(filename));
  const kind = inferAttachmentKind(mimeType);
  const attachmentsDir = getAttachmentsDir();
  mkdirSync(attachmentsDir, { recursive: true });

  const id = `att_${randomUUID().replaceAll("-", "")}`;
  const extension = extensionForAttachment(mimeType, filename);
  const contentPath = join(attachmentsDir, `${id}${extension}`);
  const record: AttachmentRecord = {
    id,
    kind,
    filename,
    mimeType,
    sizeBytes: buffer.length,
    sha256: hostedAttachment?.sha256 ?? bufferSha256,
    createdAt: new Date().toISOString(),
    source: "path",
    contentPath,
    sessionId,
    ...(hostedAttachment ? { hostedAttachment } : {}),
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
  return safeName || "attachment";
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new Error("attachment mime type is invalid");
  }
  if (activeMimeTypes.has(normalized)) {
    throw new Error("unsupported attachment mime type");
  }
  return normalized;
}

export function inferAttachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return "file";
}

function extensionForAttachment(mimeType: string, filename: string): string {
  const fromMime = mimeExtensions.get(mimeType);
  if (fromMime) return fromMime;
  const fromName = extname(filename).toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(fromName)) return fromName;
  return ".bin";
}

function mimeTypeFromFilename(filename: string): string {
  const extension = extname(filename).toLowerCase();
  for (const [mimeType, candidateExtension] of mimeExtensions) {
    if (candidateExtension === extension) return mimeType;
  }
  if (extension === ".mjs" || extension === ".cjs") return "application/javascript";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function isPathUnderAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      const rootRealPath = realpathSync(root);
      if (path === rootRealPath) return true;
      const delta = relative(rootRealPath, path);
      return Boolean(delta) && !delta.startsWith("..") && !isAbsolute(delta);
    } catch {
      return false;
    }
  });
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
    ...(record.hostedAttachment
      ? {
          hostedContentUrl: record.hostedAttachment.contentUrl,
          hostedExpiresAt: record.hostedAttachment.expiresAt,
        }
      : {}),
    sessionId: record.sessionId,
  };
}

function normalizeHostedAttachmentReference(
  input: HostedAttachmentReference,
  expected: { sha256: string; sizeBytes: number },
): HostedAttachmentReference {
  const contentUrl = input.contentUrl?.trim();
  if (!contentUrl) throw new Error("hosted attachment contentUrl is required");
  let parsed: URL;
  try {
    parsed = new URL(contentUrl);
  } catch {
    throw new Error("hosted attachment contentUrl is invalid");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    throw new Error("hosted attachment contentUrl must be HTTPS");
  }
  const expiresAt = input.expiresAt?.trim();
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("hosted attachment expiresAt is invalid");
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new Error("hosted attachment is expired");
  }
  if (input.sha256 && input.sha256 !== expected.sha256) {
    throw new Error("hosted attachment checksum mismatch");
  }
  if (input.sizeBytes !== undefined && input.sizeBytes !== expected.sizeBytes) {
    throw new Error("hosted attachment size mismatch");
  }
  return {
    contentUrl,
    expiresAt,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
  };
}
