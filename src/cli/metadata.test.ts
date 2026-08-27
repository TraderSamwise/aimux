import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { registerMetadataCommand, serviceMetadataFromUrls } from "./metadata.js";

function commandWithMetadata(deps: Parameters<typeof registerMetadataCommand>[1]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerMetadataCommand(program, deps);
  return program;
}

describe("metadata CLI command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("prints the metadata endpoint", async () => {
    const getProjectServiceEndpoint = vi.fn(async () => ({ host: "127.0.0.1", port: 4321 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await commandWithMetadata({ getProjectServiceEndpoint, postProjectServiceJson: vi.fn() }).parseAsync(
      ["metadata", "endpoint"],
      { from: "user" },
    );

    expect(log).toHaveBeenCalledWith("http://127.0.0.1:4321");
  });

  it("maps service URLs to runtime metadata", () => {
    expect(serviceMetadataFromUrls(["http://localhost:3000", "https://example.com/app"], "web")).toEqual([
      { label: "web", url: "http://localhost:3000", port: 3000 },
      { label: "web", url: "https://example.com/app", port: undefined },
    ]);
  });

  it("posts set-services to the runtime metadata route", async () => {
    const postProjectServiceJson = vi.fn(async () => ({ ok: true }));

    await commandWithMetadata({
      getProjectServiceEndpoint: vi.fn(),
      postProjectServiceJson,
    }).parseAsync(
      [
        "metadata",
        "set-services",
        "codex-1",
        "--url",
        "http://localhost:3000",
        "http://127.0.0.1:5173/",
        "--label",
        "dev",
      ],
      { from: "user" },
    );

    expect(postProjectServiceJson).toHaveBeenCalledWith(PROJECT_API_ROUTES.runtime.setServices, {
      session: "codex-1",
      services: [
        { label: "dev", url: "http://localhost:3000", port: 3000 },
        { label: "dev", url: "http://127.0.0.1:5173/", port: 5173 },
      ],
    });
  });

  it("rejects non-numeric progress values without posting", async () => {
    const postProjectServiceJson = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await commandWithMetadata({
      getProjectServiceEndpoint: vi.fn(),
      postProjectServiceJson,
    }).parseAsync(["metadata", "set-progress", "codex-1", "one", "2"], { from: "user" });

    expect(error).toHaveBeenCalledWith("metadata set-progress requires numeric <current> and <total>");
    expect(process.exitCode).toBe(1);
    expect(postProjectServiceJson).not.toHaveBeenCalled();
  });
});
