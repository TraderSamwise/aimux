import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  BodyTooLarge,
  isAllowedCorsOrigin,
  parseBoundedLimit,
  parseIntegerValue,
  parseOptionalInteger,
  parsePositiveInteger,
  readJson,
  requestHeaderRecord,
  send,
  setCorsHeaders,
} from "./http.js";

function requestFromChunks(chunks: Array<string | Buffer>, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return {
    headers,
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
}

function responseRecorder() {
  const headers = new Map<string, unknown>();
  return {
    statusCode: 0,
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.set(name.toLowerCase(), value);
    }),
    hasHeader: vi.fn((name: string) => headers.has(name.toLowerCase())),
    end: vi.fn(),
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
}

describe("metadata server http helpers", () => {
  it("reads JSON with a streaming byte limit", async () => {
    await expect(readJson(requestFromChunks(['{"ok":true}']), 32)).resolves.toEqual({ ok: true });

    const req = requestFromChunks(["abcdef"]);
    await expect(readJson(req, 3)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(req.destroy).toHaveBeenCalled();
  });

  it("normalizes request headers", () => {
    expect(
      requestHeaderRecord(
        requestFromChunks([], {
          one: "1",
          many: ["a", "b"],
          empty: [],
        }),
      ),
    ).toEqual({ one: "1", many: "a, b" });
  });

  it("sets CORS headers for allowed local origins", () => {
    const res = responseRecorder();
    expect(setCorsHeaders(requestFromChunks([], { origin: "http://localhost:4545" }), res as any)).toBe(true);
    expect(res.header("Access-Control-Allow-Origin")).toBe("http://localhost:4545");
    expect(isAllowedCorsOrigin("https://aimux.app")).toBe(false);
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
  });

  it("sends JSON responses without clobbering existing CORS headers", () => {
    const res = responseRecorder();
    res.setHeader("access-control-allow-origin", "http://localhost:3000");
    send(res as any, 201, { ok: true });

    expect(res.statusCode).toBe(201);
    expect(res.header("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it("parses integer inputs consistently", () => {
    expect(parseOptionalInteger(null, "startLine")).toEqual({ ok: true });
    expect(parseOptionalInteger(" 5 ", "startLine")).toEqual({ ok: true, value: 5 });
    expect(parseIntegerValue("bad", "rows")).toEqual({ ok: false, error: "rows must be an integer" });
    expect(parsePositiveInteger(0, "rows")).toEqual({ ok: false, error: "rows must be an integer >= 1" });
    expect(parseBoundedLimit("999", "limit", { defaultValue: 10, maxValue: 100 })).toEqual({ ok: true, value: 100 });
  });
});
