import { describe, expect, it } from "vitest";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { parseRuntimeMetadataCliArgs } from "./metadata-cli-routing.js";

describe("parseRuntimeMetadataCliArgs", () => {
  it("parses endpoint commands", () => {
    expect(parseRuntimeMetadataCliArgs(["metadata", "endpoint"])).toEqual({ ok: true, command: "endpoint" });
  });

  it("parses status mutations with option values", () => {
    expect(parseRuntimeMetadataCliArgs(["metadata", "set-status", "claude-1", "Ready", "--tone=success"])).toEqual({
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setStatus,
      body: { session: "claude-1", text: "Ready", tone: "success" },
    });
  });

  it("parses dash-prefixed status text after an option terminator", () => {
    expect(parseRuntimeMetadataCliArgs(["metadata", "set-status", "claude-1", "--", "-starting"])).toEqual({
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setStatus,
      body: { session: "claude-1", text: "-starting", tone: "info" },
    });
  });

  it("parses dash-prefixed log messages after an option terminator", () => {
    expect(parseRuntimeMetadataCliArgs(["metadata", "log", "claude-1", "--", "-message"])).toEqual({
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.log,
      body: { session: "claude-1", message: "-message" },
    });
  });

  it("parses context mutations with nested PR data", () => {
    expect(
      parseRuntimeMetadataCliArgs([
        "metadata",
        "set-context",
        "claude-1",
        "--cwd",
        "/repo",
        "--branch",
        "feature",
        "--pr-number",
        "42",
        "--pr-title",
        "Ship it",
      ]),
    ).toEqual({
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setContext,
      body: {
        session: "claude-1",
        context: {
          cwd: "/repo",
          branch: "feature",
          pr: { number: 42, title: "Ship it" },
        },
      },
    });
  });

  it("rejects malformed metadata commands", () => {
    expect(parseRuntimeMetadataCliArgs(["metadata", "set-status"])).toEqual({
      ok: false,
      error: "metadata set-status requires <session> and <text>",
    });
  });
});
