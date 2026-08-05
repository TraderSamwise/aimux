import http from "node:http";
import https from "node:https";
import { log } from "./debug.js";

export interface HttpJsonResponse<T = any> {
  status: number;
  json: T;
}

export class HttpTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export function isHttpTimeoutError(error: unknown): boolean {
  if (error instanceof HttpTimeoutError) return true;
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  return code === "ETIMEDOUT";
}

export interface HttpBytesResponse {
  status: number;
  body: Buffer;
  contentType: string | null;
}

export class HttpBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`);
    this.name = "HttpBodyTooLargeError";
  }
}

/**
 * Fetch a response as raw bytes.
 *
 * The binary twin of `requestJson`, for routes that answer with an image
 * rather than an object. It exists because running those through the JSON path
 * does not merely lose the content type — `JSON.stringify` on a Buffer yields
 * `{"type":"Buffer","data":[…]}`, roughly six times the size, which then trips
 * whatever response ceiling is in force at a fraction of the real limit.
 *
 * `maxBytes` is enforced mid-stream rather than after buffering, for the same
 * reason the request side does it: a cap applied to something already held in
 * memory has not capped anything.
 */
export async function requestBinary(
  urlString: string,
  options: { method?: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<HttpBytesResponse> {
  const url = new URL(urlString);
  const logUrl = `${url.origin}${url.pathname}`;
  const transport = url.protocol === "https:" ? https : http;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;

  return await new Promise<HttpBytesResponse>((resolve, reject) => {
    const method = options.method ?? "GET";
    const req = transport.request(url, { method, headers: options.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
          req.destroy(new HttpBodyTooLargeError(maxBytes));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          contentType: res.headers["content-type"] ?? null,
        });
      });
    });
    req.on("error", (error) => {
      log.warn("http binary request failed", "http", {
        method,
        url: logUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      reject(error);
    });
    req.setTimeout(options.timeoutMs ?? 0, () => {
      req.destroy(new HttpTimeoutError(options.timeoutMs ?? 0));
    });
    req.end();
  });
}

export async function requestJson<T = any>(
  urlString: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<HttpJsonResponse<T>> {
  const url = new URL(urlString);
  const logUrl = `${url.origin}${url.pathname}`;
  const transport = url.protocol === "https:" ? https : http;
  const bodyString =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (bodyString !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  if (bodyString !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = Buffer.byteLength(bodyString).toString();
  }

  return await new Promise<HttpJsonResponse<T>>((resolve, reject) => {
    const method = options.method ?? (bodyString === undefined ? "GET" : "POST");
    const req = transport.request(
      url,
      {
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          let json: T;
          try {
            json = raw ? (JSON.parse(raw) as T) : ({} as T);
          } catch (error) {
            log.warn("http json parse failed", "http", {
              method,
              url: logUrl,
              status: res.statusCode ?? 0,
              bytes: Buffer.byteLength(raw),
              error: error instanceof Error ? error.message : String(error),
            });
            reject(error);
            return;
          }
          if ((res.statusCode ?? 0) >= 400) {
            log.warn("http request returned error status", "http", {
              method,
              url: logUrl,
              status: res.statusCode ?? 0,
            });
          }
          resolve({
            status: res.statusCode ?? 0,
            json,
          });
        });
      },
    );
    req.on("error", (error) => {
      log.warn("http request failed", "http", {
        method,
        url: logUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      reject(error);
    });
    req.setTimeout(options.timeoutMs ?? 0, () => {
      log.warn("http request timed out", "http", {
        method,
        url: logUrl,
        timeoutMs: options.timeoutMs ?? 0,
      });
      req.destroy(new HttpTimeoutError(options.timeoutMs ?? 0));
    });
    if (bodyString !== undefined) {
      req.write(bodyString);
    }
    req.end();
  });
}
