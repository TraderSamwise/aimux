import { describe, expect, it, vi } from "vitest";
import relay from "./index";
import type { Env } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

function allowHeaderSet(response: Response): Set<string> {
  return new Set(
    (response.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
}

describe("relay CORS", () => {
  it("allows sharing preflights with actor/share headers and owner mutation methods", async () => {
    const response = await relay.fetch(
      new Request("https://relay.aimux.app/shares", {
        method: "OPTIONS",
        headers: {
          Origin: "https://aimux.app",
          "Access-Control-Request-Method": "DELETE",
          "Access-Control-Request-Headers": [
            "authorization",
            "x-aimux-actor-user-id",
            "x-aimux-actor-display-name",
            "x-aimux-actor-email",
            "x-aimux-actor-role",
            "x-aimux-share-id",
            "x-aimux-share-session-id",
          ].join(","),
        },
      }),
      {} as Env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    const allowedHeaders = allowHeaderSet(response);
    for (const header of [
      "authorization",
      "x-aimux-actor-user-id",
      "x-aimux-actor-display-name",
      "x-aimux-actor-email",
      "x-aimux-actor-role",
      "x-aimux-share-id",
      "x-aimux-share-session-id",
    ]) {
      expect(allowedHeaders.has(header)).toBe(true);
    }
  });

  it("keeps CLI token preflights restricted to configured origins", async () => {
    const env = { CLI_TOKEN_ALLOWED_ORIGINS: "https://aimux.app" } as Env;

    const allowed = await relay.fetch(
      new Request("https://relay.aimux.app/cli/issue-token", {
        method: "OPTIONS",
        headers: { Origin: "https://aimux.app" },
      }),
      env,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://aimux.app");
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");

    const denied = await relay.fetch(
      new Request("https://relay.aimux.app/cli/issue-token", {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      }),
      env,
    );
    expect(denied.status).toBe(403);
  });
});
