import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPathAttachment,
  createUploadedAttachment,
  getAttachmentContent,
  getAttachmentRecord,
} from "./attachment-store.js";
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

  it("stores hosted attachment display metadata on uploaded attachments", () => {
    const attachment = createUploadedAttachment({
      filename: "screen.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("png-bytes").toString("base64"),
      sessionId: "codex-1",
      hostedAttachment: {
        contentUrl: "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
        expiresAt: "2099-01-01T00:00:00.000Z",
        sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
        sizeBytes: 9,
      },
    });

    expect(attachment).toMatchObject({
      hostedContentUrl:
        "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
      hostedExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(getAttachmentRecord(attachment.id, "codex-1")?.hostedAttachment).toMatchObject({
      contentUrl: attachment.hostedContentUrl,
      expiresAt: attachment.hostedExpiresAt,
    });
  });

  it("stores hosted attachment display metadata on path attachments", () => {
    const sourcePath = join(repoRoot, "screen.png");
    writeFileSync(sourcePath, "png-bytes");

    const attachment = createPathAttachment({
      projectRoot: repoRoot,
      sourcePath,
      sessionId: "codex-1",
      hostedAttachment: {
        contentUrl: "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
        expiresAt: "2099-01-01T00:00:00.000Z",
        sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
        sizeBytes: 9,
      },
    });

    expect(attachment).toMatchObject({
      hostedContentUrl:
        "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
      hostedExpiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  it("rejects uploaded hosted metadata that does not match the bytes", () => {
    expect(() =>
      createUploadedAttachment({
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("other").toString("base64"),
        sessionId: "codex-1",
        hostedAttachment: {
          contentUrl:
            "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
          expiresAt: "2099-01-01T00:00:00.000Z",
          sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
          sizeBytes: 9,
        },
      }),
    ).toThrow("hosted attachment checksum mismatch");
  });
});
