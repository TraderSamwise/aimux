import { Command } from "commander";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimeTypeForPublishedAttachment, registerAttachmentCommand, relayHttpUrl } from "./attachment.js";

describe("attachment CLI helpers", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    vi.restoreAllMocks();
  });

  it("maps publishable attachment MIME types", () => {
    expect(mimeTypeForPublishedAttachment("screenshot.PNG")).toBe("image/png");
    expect(mimeTypeForPublishedAttachment("clip.webm")).toBe("video/webm");
    expect(mimeTypeForPublishedAttachment("archive.bin")).toBe("application/octet-stream");
  });

  it("normalizes websocket relay URLs to HTTP URLs", () => {
    expect(relayHttpUrl("wss://relay.aimux.app/socket")).toBe("https://relay.aimux.app/socket");
    expect(relayHttpUrl("ws://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("registers attachment publish with resolved path, hosted metadata, and project-service route", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aimux-attachment-cli-"));
    const sourcePath = join(tempDir, "note.txt");
    writeFileSync(sourcePath, "hello");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    const prepareProjectContext = vi.fn(async () => tempDir!);
    const postProjectServiceJson = vi.fn(async () => ({ referenceText: "Attached files:\n- note.txt" }));
    const hostPublishedAttachment = vi.fn(async () => ({
      contentUrl: "https://relay.aimux.app/attachments/hosted/ha_123/content",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    registerAttachmentCommand(program, {
      prepareProjectContext,
      postProjectServiceJson,
      listWorktrees: () => [],
      hostPublishedAttachment,
    });

    await program.parseAsync(
      [
        "attachment",
        "publish",
        sourcePath,
        "--session",
        "codex-1",
        "--project",
        tempDir,
        "--name",
        "renamed.txt",
        "--mime",
        "text/plain",
      ],
      { from: "user" },
    );

    const publishedPath = hostPublishedAttachment.mock.calls[0]?.[0].sourcePath;
    expect(publishedPath).toBeTruthy();
    expect(realpathSync(publishedPath!)).toBe(realpathSync(sourcePath));
    expect(prepareProjectContext).toHaveBeenCalledWith(tempDir);
    expect(hostPublishedAttachment).toHaveBeenCalledWith({
      sourcePath: publishedPath,
      filename: "renamed.txt",
      mimeType: "text/plain",
      sessionId: "codex-1",
    });
    expect(postProjectServiceJson).toHaveBeenCalledWith(
      "/attachments/publish",
      {
        path: publishedPath,
        sessionId: "codex-1",
        filename: "renamed.txt",
        mimeType: "text/plain",
        hostedAttachment: {
          contentUrl: "https://relay.aimux.app/attachments/hosted/ha_123/content",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { projectRoot: tempDir },
    );
    expect(log).toHaveBeenCalledWith("Attached files:\n- note.txt");
  });
});
