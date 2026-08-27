import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

const CORS_ALLOWED_ORIGINS = new Set([
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:8091",
  "http://127.0.0.1:8091",
  "http://localhost:43192",
  "http://127.0.0.1:43192",
]);

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      req.destroy();
      throw new BodyTooLarge(limit);
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  if (!res.hasHeader("access-control-allow-origin")) {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader("connection", "close");
  res.end(payload);
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, mimeType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", mimeType);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader("x-content-type-options", "nosniff");
  if (!res.hasHeader("access-control-allow-origin")) {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader("connection", "close");
  res.end(body);
}

export function requestHeaderRecord(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[name] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[name] = value.join(", ");
    }
  }
  return headers;
}

export function isAllowedCorsOrigin(origin: string): boolean {
  if (CORS_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && !isAllowedCorsOrigin(origin)) return false;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (origin && req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  return true;
}

export function rejectCors(res: ServerResponse): void {
  const payload = JSON.stringify({ ok: false, error: "origin not allowed" });
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("connection", "close");
  res.end(payload);
}

export function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function parseOptionalInteger(
  raw: string | null,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true };
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${field} must be an integer` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} must be a safe integer` };
  return { ok: true, value };
}

export function parseIntegerValue(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} must be an integer` };
    return { ok: true, value };
  }
  if (typeof value !== "string") return { ok: false, error: `${field} must be an integer` };
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${field} must be an integer` };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { ok: false, error: `${field} must be a safe integer` };
  return { ok: true, value: parsed };
}

export function parsePositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseIntegerValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value < 1) return { ok: false, error: `${field} must be an integer >= 1` };
  return parsed;
}

export function parseBoundedLimit(
  raw: string | null,
  field: string,
  defaults: { defaultValue: number; maxValue: number },
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, value: defaults.defaultValue };
  const parsed = parsePositiveInteger(raw, field);
  if (!parsed.ok) return parsed;
  return { ok: true, value: Math.min(parsed.value, defaults.maxValue) };
}
