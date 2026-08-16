import type { Env } from "./types.js";

export const HOSTED_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HOSTED_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const HOSTED_ATTACHMENT_ID_PATTERN = /^ha_[A-Za-z0-9_-]{43}$/;
const HOSTED_ATTACHMENT_PATH_PATTERN = /^\/attachments\/hosted\/(ha_[A-Za-z0-9_-]{43})\/content$/;
const ACTIVE_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/ecmascript",
  "text/html",
  "text/javascript",
]);

export interface HostedAttachmentPointer {
  contentUrl: string;
  expiresAt: string;
}

export interface HostedAttachmentUploadInput {
  ownerUserId?: string;
  shareId?: string;
  sessionId?: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface HostedAttachmentUploadResult extends HostedAttachmentPointer {
  id: string;
  sha256: string;
  sizeBytes: number;
}

interface HostedAttachmentMetadata {
  id: string;
  ownerUserId?: string;
  shareId?: string;
  sessionId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export function hostedAttachmentContentPath(id: string): string {
  return `/attachments/hosted/${id}/content`;
}

export function hostedAttachmentIdFromPath(pathname: string): string | null {
  return pathname.match(HOSTED_ATTACHMENT_PATH_PATTERN)?.[1] ?? null;
}

export async function createHostedAttachment(
  env: Env,
  requestUrl: string,
  input: HostedAttachmentUploadInput,
  now = new Date(),
): Promise<HostedAttachmentUploadResult | null> {
  if (!env.ATTACHMENTS) return null;
  const mimeType = normalizeMimeType(input.mimeType);
  const filename = sanitizeFilename(input.filename);
  const bytes = decodeBase64(input.dataBase64);
  if (bytes.byteLength === 0) throw new Error("attachment content is required");
  if (bytes.byteLength > HOSTED_ATTACHMENT_MAX_BYTES) throw new Error("attachment exceeds 10 MB");

  const id = `ha_${randomBase64Url(32)}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + HOSTED_ATTACHMENT_TTL_MS).toISOString();
  const sha256 = await sha256Hex(bytes);
  const metadata: HostedAttachmentMetadata = {
    id,
    ownerUserId: trimOptional(input.ownerUserId),
    shareId: trimOptional(input.shareId),
    sessionId: trimOptional(input.sessionId),
    filename,
    mimeType,
    sizeBytes: String(bytes.byteLength),
    sha256,
    createdAt,
    expiresAt,
  };

  await env.ATTACHMENTS.put(objectKey(id), bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: compactMetadata(metadata),
  });

  return {
    id,
    contentUrl: `${hostedAttachmentBaseUrl(env, requestUrl)}${hostedAttachmentContentPath(id)}`,
    expiresAt,
    sha256,
    sizeBytes: bytes.byteLength,
  };
}

export async function serveHostedAttachment(env: Env, id: string): Promise<Response> {
  if (!env.ATTACHMENTS || !HOSTED_ATTACHMENT_ID_PATTERN.test(id)) {
    return json({ ok: false, error: "attachment not found" }, 404);
  }
  const object = await env.ATTACHMENTS.get(objectKey(id));
  if (!object) return json({ ok: false, error: "attachment not found" }, 404);

  const metadata = object.customMetadata as Partial<HostedAttachmentMetadata> | undefined;
  const expiresAt = metadata?.expiresAt ? Date.parse(metadata.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await env.ATTACHMENTS.delete(objectKey(id));
    return json({ ok: false, error: "attachment expired" }, 410);
  }

  const mimeType = normalizeMimeType(metadata?.mimeType ?? object.httpMetadata?.contentType ?? "application/octet-stream");
  const filename = sanitizeFilename(metadata?.filename ?? "attachment");
  return new Response(object.body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `${shouldServeInline(mimeType) ? "inline" : "attachment"}; filename="${filename.replaceAll(/["\\]/g, "_")}"`,
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function hostedAttachmentBaseUrl(env: Env, requestUrl: string): string {
  const configured = env.HOSTED_ATTACHMENT_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

function objectKey(id: string): string {
  return `attachments/${id}`;
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new Error("attachment mime type is invalid");
  }
  if (ACTIVE_MIME_TYPES.has(normalized)) {
    throw new Error("unsupported attachment mime type");
  }
  return normalized;
}

function sanitizeFilename(filename: string): string {
  const safe = filename.trim().replaceAll(/[\\/]/g, "").replaceAll(/[\r\n]/g, " ").trim();
  return safe || "attachment";
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function decodeBase64(dataBase64: string): Uint8Array {
  const normalized = dataBase64
    .trim()
    .replace(/^data:[^;]+;base64,/, "")
    .replaceAll(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("attachment content must be base64");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shouldServeInline(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType === "application/json"
  );
}

function compactMetadata(metadata: HostedAttachmentMetadata): Record<string, string> {
  const entries = Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
