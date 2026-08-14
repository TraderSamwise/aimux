import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPathAttachment, getAttachmentContent, getAttachmentRecord } from "./attachment-store.js";
import { initPaths } from "./paths.js";

describe("attachment-store path attachments", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-attachment-store-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("copies a regular project file into a session-bound attachment", () => {
    const sourcePath = join(repoRoot, "notes.txt");
    writeFileSync(sourcePath, "hello attachment");

    const attachment = createPathAttachment({
      projectRoot: repoRoot,
      sourcePath,
      sessionId: "codex-1",
    });

    expect(attachment).toMatchObject({
      kind: "text",
      filename: "notes.txt",
      mimeType: "text/plain",
      source: "path",
      sessionId: "codex-1",
    });
    const record = getAttachmentRecord(attachment.id, "codex-1");
    expect(record?.contentPath).toContain(join(repoRoot, ".aimux", "attachments"));
    const content = getAttachmentContent(attachment.id, "codex-1");
    expect(content?.buffer.toString("utf8")).toBe("hello attachment");
  });

  it("rejects files outside the allowed project roots", () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "aimux-attachment-outside-"));
    const sourcePath = join(outsideRoot, "secret.txt");
    writeFileSync(sourcePath, "nope");
    try {
      expect(() =>
        createPathAttachment({
          projectRoot: repoRoot,
          sourcePath,
          sessionId: "codex-1",
        }),
      ).toThrow("attachment source must be inside the project");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinks that point outside the project", () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "aimux-attachment-outside-"));
    const outsidePath = join(outsideRoot, "secret.txt");
    const linkPath = join(repoRoot, "secret-link.txt");
    writeFileSync(outsidePath, "nope");
    symlinkSync(outsidePath, linkPath);
    try {
      expect(() =>
        createPathAttachment({
          projectRoot: repoRoot,
          sourcePath: linkPath,
          sessionId: "codex-1",
        }),
      ).toThrow("attachment source must be a regular file");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
