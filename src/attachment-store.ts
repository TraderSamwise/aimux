import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * The one gate every publish goes through, wherever it starts.
 *
 * The CLI hosts a copy to the relay before the project service ever sees the
 * request, so a check that lived only in the service would upload the bytes
 * first and refuse afterwards. Returns the resolved real path — checking one
 * path and reading another is the same hole wearing a different hat.
 */
export function assertPublishableSource(input: {
  sourcePath: string;
  projectRoot: string;
  allowedRoots?: string[];
}): string {
  const requestedPath = resolve(input.sourcePath);
  let sourceRealPath: string;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(requestedPath);
    sourceRealPath = realpathSync(requestedPath);
  } catch {
    throw new Error(`attachment source does not exist: ${requestedPath}`);
  }
  // A symlink is refused rather than followed: the CLI hosts the bytes before
  // the project service sees them, so both callers must reject the same shapes.
  if (!stat.isFile()) {
    throw new Error("attachment source must be a regular file");
  }
  if (isSensitiveAttachmentSource(sourceRealPath)) {
    throw new Error(sensitiveAttachmentSourceError(sourceRealPath));
  }
  if (!isPathUnderAnyRoot(sourceRealPath, publishableRoots(input.projectRoot, input.allowedRoots))) {
    throw new Error(
      `attachment source must be inside the project, one of its worktrees, or a temporary directory: ${sourceRealPath}`,
    );
  }
  return sourceRealPath;
}

export function createPathAttachment(input: CreatePathAttachmentInput): PublicAttachmentRecord {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    throw new Error("attachment sessionId is required");
  }
  const sourcePath = resolve(input.sourcePath);
  const sourceRealPath = assertPublishableSource({
    sourcePath,
    projectRoot: input.projectRoot,
    allowedRoots: input.allowedRoots,
  });

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
  rememberPublishedAttachment(record);

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

/**
 * The last few files this session published, newest first.
 *
 * Kept in memory because the chat polls the pane twice a second and every read
 * asks this question; hydrated from the records on disk the first time a
 * session asks, so a restarted service does not lose an image that is still on
 * screen.
 *
 * Only agent publishes are tracked. An upload from the chat composer belongs to
 * the operator who sent it and already appears as their message — carrying it
 * here would re-attribute it to the agent.
 */
export interface PublishedAttachmentEntry {
  record: PublicAttachmentRecord;
  /** The transcript message this was merged into, once it has been merged. */
  anchorMessageId?: string;
}

const recentPublishedBySession = new Map<string, PublishedAttachmentEntry[]>();
const hydratedSessions = new Set<string>();
const RECENT_PUBLISHED_PER_SESSION = 5;

function rememberPublishedAttachment(record: AttachmentRecord): void {
  if (record.source !== "path" || !record.sessionId) return;
  const recent = recentPublishedBySession.get(record.sessionId) ?? [];
  recentPublishedBySession.set(
    record.sessionId,
    [{ record: toPublicAttachment(record) }, ...recent.filter((entry) => entry.record.id !== record.id)].slice(
      0,
      RECENT_PUBLISHED_PER_SESSION,
    ),
  );
}

function hydrateSessionAttachments(sessionId: string): void {
  if (hydratedSessions.has(sessionId)) return;
  hydratedSessions.add(sessionId);
  let attachmentsDir: string;
  try {
    attachmentsDir = getAttachmentsDir();
  } catch {
    return;
  }
  if (!existsSync(attachmentsDir)) return;
  const records: AttachmentRecord[] = [];
  for (const entry of readdirSync(attachmentsDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(attachmentsDir, entry), "utf-8")) as AttachmentRecord;
      if (record.source === "path" && attachmentBelongsToSession(record, sessionId)) records.push(record);
    } catch {
      continue;
    }
  }
  records.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const known = recentPublishedBySession.get(sessionId) ?? [];
  const knownIds = new Set(known.map((entry) => entry.record.id));
  const hydrated = records
    .filter((record) => !knownIds.has(record.id))
    .slice(0, RECENT_PUBLISHED_PER_SESSION)
    .map((record) => ({ record: toPublicAttachment(record) }));
  recentPublishedBySession.set(sessionId, [...known, ...hydrated].slice(0, RECENT_PUBLISHED_PER_SESSION));
}

export function listSessionAttachments(sessionId: string, opts: { limit?: number } = {}): PublishedAttachmentEntry[] {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return [];
  hydrateSessionAttachments(trimmedSessionId);
  return (recentPublishedBySession.get(trimmedSessionId) ?? []).slice(0, opts.limit ?? RECENT_PUBLISHED_PER_SESSION);
}

/**
 * Pin an attachment to the turn it was shown in.
 *
 * Without this the merge re-attaches to whatever reply is newest, so an image
 * published ten turns ago walks down the transcript and shows up again under
 * every later answer.
 */
export function anchorSessionAttachment(sessionId: string, attachmentId: string, messageId: string): void {
  const recent = recentPublishedBySession.get(sessionId.trim());
  if (!recent) return;
  const entry = recent.find((candidate) => candidate.record.id === attachmentId);
  if (!entry) return;
  entry.anchorMessageId = messageId;
}

/** Test seam. Publishing and reading share a process, so they share this map. */
export function forgetSessionAttachments(sessionId?: string): void {
  if (sessionId) {
    recentPublishedBySession.delete(sessionId.trim());
    hydratedSessions.delete(sessionId.trim());
  } else {
    recentPublishedBySession.clear();
    hydratedSessions.clear();
  }
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

/**
 * Where a publish may read from. Agents write their working files to a scratch
 * directory under the system temp root, so refusing everything outside the
 * checkout meant an agent could never show what it had just produced.
 */
function publishableRoots(projectRoot: string, extraRoots: string[] | undefined): string[] {
  return [projectRoot, ...(extraRoots ?? []), ...temporaryRoots()].filter(Boolean);
}

/** Both temp roots: macOS gives per-user `/var/folders/...` and plain `/tmp`. */
function temporaryRoots(): string[] {
  return [tmpdir(), "/tmp"];
}

const SENSITIVE_SOURCE_DIRECTORIES = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".gcloud"];
const SENSITIVE_SOURCE_FILENAMES = new Set([
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const SENSITIVE_SOURCE_EXTENSIONS = new Set([".jks", ".key", ".keystore", ".p12", ".pem", ".pfx"]);
/** Committed templates carry no secrets and are the one `.env*` worth showing. */
const PUBLISHABLE_ENV_FILENAMES = new Set([".env.dist", ".env.example", ".env.sample", ".env.template"]);

/**
 * Is this the kind of file nobody means to paste into a chat? Matched on path
 * segments rather than substrings, so `.envoy.ts` and `notes.sshx` stay
 * publishable, and case-insensitively for case-folding filesystems.
 */
export function isSensitiveAttachmentSource(path: string): boolean {
  const segments = path.split(sep).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => SENSITIVE_SOURCE_DIRECTORIES.includes(segment))) return true;
  const name = basename(path).toLowerCase();
  if (PUBLISHABLE_ENV_FILENAMES.has(name)) return false;
  if (SENSITIVE_SOURCE_FILENAMES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return SENSITIVE_SOURCE_EXTENSIONS.has(extname(name).toLowerCase());
}

export function sensitiveAttachmentSourceError(path: string): string {
  return `attachment source looks like a credential or secret file and cannot be published: ${basename(path)}`;
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
