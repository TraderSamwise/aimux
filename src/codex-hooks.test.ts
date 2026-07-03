import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexHookCommand,
  codexHooksPath,
  codexLaunchHookArgs,
  installCodexHooks,
  isAimuxOwnedCodexHookCommand,
  mergeCodexHooks,
  parseCodexHookPayload,
  type CodexHooksFile,
} from "./codex-hooks.js";

const MANAGED_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"];

describe("buildCodexHookCommand", () => {
  it("posts through the project service endpoint and falls back to empty JSON", () => {
    const cmd = buildCodexHookCommand("permission-request");
    expect(cmd).toContain("AIMUX_SESSION_ID");
    expect(cmd).toContain("AIMUX_METADATA_ENDPOINT_FILE");
    expect(cmd).toContain("/hooks/codex");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("permission-request");
    expect(cmd).not.toContain("codex-hook");
    expect(cmd).not.toContain("--project");
    expect(cmd).not.toContain("bin/aimux");
    expect(cmd.endsWith("'")).toBe(true);
  });
});

describe("codexLaunchHookArgs", () => {
  it("enables + trusts hooks per-launch with no config.toml mutation", () => {
    expect(codexLaunchHookArgs()).toEqual(["-c", "features.hooks=true", "--dangerously-bypass-hook-trust"]);
  });
});

describe("isAimuxOwnedCodexHookCommand", () => {
  it("matches only aimux commands, not cmux or foreign ones", () => {
    expect(isAimuxOwnedCodexHookCommand("curl http://127.0.0.1:1/hooks/codex?action=stop")).toBe(true);
    expect(isAimuxOwnedCodexHookCommand("aimux codex-hook stop --project /tmp/repo")).toBe(true);
    expect(isAimuxOwnedCodexHookCommand("cmux hooks codex stop")).toBe(false);
    expect(isAimuxOwnedCodexHookCommand("my-own-thing.sh")).toBe(false);
    expect(isAimuxOwnedCodexHookCommand(undefined)).toBe(false);
  });
});

describe("mergeCodexHooks", () => {
  it("adds aimux groups for all managed events, including PermissionRequest", () => {
    const merged = mergeCodexHooks({});
    expect(Object.keys(merged.hooks ?? {})).toEqual(MANAGED_EVENTS);
    for (const event of MANAGED_EVENTS) {
      const groups = merged.hooks![event];
      expect(groups).toHaveLength(1);
      expect(isAimuxOwnedCodexHookCommand(groups[0].hooks![0].command)).toBe(true);
    }
  });

  it("gives PermissionRequest a long timeout and lifecycle events a short one", () => {
    const merged = mergeCodexHooks({});
    expect(merged.hooks!.PermissionRequest[0].hooks![0].timeout).toBe(120000);
    expect(merged.hooks!.Stop[0].hooks![0].timeout).toBe(5000);
  });

  it("preserves a foreign (cmux) hook in a managed event and appends ours", () => {
    const existing: CodexHooksFile = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop", timeout: 5000 }] }] },
    };
    const merged = mergeCodexHooks(existing);
    const stop = merged.hooks!.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks![0].command).toBe("cmux hooks codex stop");
    expect(isAimuxOwnedCodexHookCommand(stop[1].hooks![0].command)).toBe(true);
  });

  it("is idempotent — re-merging does not duplicate aimux groups", () => {
    const once = mergeCodexHooks({});
    const twice = mergeCodexHooks(once);
    expect(twice).toEqual(once);
  });

  it("removes legacy aimux-owned codex-hook commands while adding the service hook", () => {
    const existing: CodexHooksFile = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "aimux codex-hook stop --project /tmp/repo" }] }] },
    };
    const merged = mergeCodexHooks(existing);
    const stop = merged.hooks!.Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks![0].command).toContain("/hooks/codex");
    expect(stop[0].hooks![0].command).not.toContain("codex-hook");
  });

  it("preserves unrelated top-level keys", () => {
    const merged = mergeCodexHooks({ version: 1 } as CodexHooksFile);
    expect(merged.version).toBe(1);
  });
});

describe("installCodexHooks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-codex-home-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes hooks.json then is a no-op on second run", () => {
    const first = installCodexHooks({ codexHome: dir });
    expect(first.changed).toBe(true);
    expect(existsSync(codexHooksPath(dir))).toBe(true);
    const second = installCodexHooks({ codexHome: dir });
    expect(second.changed).toBe(false);
  });

  it("merges into an existing foreign hooks.json without clobbering it", () => {
    const path = codexHooksPath(dir);
    writeFileSync(
      path,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop" }] }] } }),
    );
    installCodexHooks({ codexHome: dir });
    const written = JSON.parse(readFileSync(path, "utf8")) as CodexHooksFile;
    expect(written.hooks!.Stop[0].hooks![0].command).toBe("cmux hooks codex stop");
    expect(written.hooks!.Stop).toHaveLength(2);
  });

  it("throws on a non-JSON hooks file rather than clobbering it", () => {
    writeFileSync(codexHooksPath(dir), "not json");
    expect(() => installCodexHooks({ codexHome: dir })).toThrow(/not valid JSON/);
  });
});

describe("parseCodexHookPayload", () => {
  it("extracts fields and tolerates garbage", () => {
    expect(parseCodexHookPayload('{"session_id":"abc","tool_name":"Bash"}')).toMatchObject({
      session_id: "abc",
      tool_name: "Bash",
    });
    expect(parseCodexHookPayload("nope")).toEqual({});
  });
});
