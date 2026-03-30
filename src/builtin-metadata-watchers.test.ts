import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getPlansDir, getStatusDir } from "./paths.js";
import { createBuiltinMetadataWatchers } from "./builtin-metadata-watchers.js";

describe("createBuiltinMetadataWatchers", () => {
  let repoRoot = "";
  const statuses: Array<[string, string, string | undefined]> = [];
  const progresses: Array<[string, number, number, string | undefined]> = [];

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-watchers-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    statuses.length = 0;
    progresses.length = 0;
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("loads initial status and plan progress", () => {
    mkdirSync(getStatusDir(), { recursive: true });
    mkdirSync(getPlansDir(), { recursive: true });
    writeFileSync(join(getStatusDir(), "s1.md"), "Working through auth\nmore");
    writeFileSync(
      join(getPlansDir(), "s1.md"),
      ["# Plan", "", "- [x] inspect", "- [ ] patch", "- [ ] test"].join("\n"),
    );

    const watchers = createBuiltinMetadataWatchers({
      setStatus(session, text, tone) {
        statuses.push([session, text, tone]);
      },
      setProgress(session, current, total, label) {
        progresses.push([session, current, total, label]);
      },
      log() {},
      clearLog() {},
    });

    for (const watcher of watchers) watcher.start?.();

    expect(statuses).toContainEqual(["s1", "Working through auth", "info"]);
    expect(progresses).toContainEqual(["s1", 1, 3, "plan"]);
  });
});
