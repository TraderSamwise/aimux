import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_ATTACHMENT_TTL_MS,
  createHostedAttachment,
  hostedAttachmentIdFromPath,
  serveHostedAttachment,
} from "./attachments.js";
import type { Env } from "./types.js";

class FakeR2Bucket {
  objects = new Map<
    string,
    {
      body: Uint8Array;
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    }
  >();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
  ) {
    const body =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, {
      body,
      customMetadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata,
    });
    return null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: object.body,
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

describe("hosted relay attachments", () => {
  it("stores uploaded bytes with a seven day hosted content URL", async () => {
    const bucket = new FakeR2Bucket();
    const now = new Date("2026-08-16T00:00:00.000Z");

    const hosted = await createHostedAttachment(
      { ATTACHMENTS: bucket as unknown as R2Bucket } as Env,
      "https://relay.aimux.app/shares/user/share",
      {
        ownerUserId: "user_owner",
        shareId: "share_123",
        sessionId: "codex-1",
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
      },
      now,
    );

    expect(hosted).toMatchObject({
      contentUrl: expect.stringMatching(/^https:\/\/relay\.aimux\.app\/attachments\/hosted\/ha_[A-Za-z0-9_-]{43}\/content$/),
      expiresAt: new Date(now.getTime() + HOSTED_ATTACHMENT_TTL_MS).toISOString(),
      sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
      sizeBytes: 9,
    });
    const id = hostedAttachmentIdFromPath(new URL(hosted!.contentUrl).pathname)!;
    const stored = bucket.objects.get(`attachments/${id}`);
    expect(stored?.customMetadata).toMatchObject({
      ownerUserId: "user_owner",
      shareId: "share_123",
      sessionId: "codex-1",
      filename: "screen.png",
      mimeType: "image/png",
      expiresAt: hosted!.expiresAt,
    });
  });

  it("serves hosted content until expiry and then deletes it", async () => {
    vi.useFakeTimers();
    const bucket = new FakeR2Bucket();
    const now = new Date("2026-08-16T00:00:00.000Z");
    vi.setSystemTime(now);
    const hosted = await createHostedAttachment(
      { ATTACHMENTS: bucket as unknown as R2Bucket } as Env,
      "https://relay.aimux.app",
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        dataBase64: btoa("hello"),
      },
      now,
    );
    const id = hostedAttachmentIdFromPath(new URL(hosted!.contentUrl).pathname)!;

    const ok = await serveHostedAttachment({ ATTACHMENTS: bucket as unknown as R2Bucket } as Env, id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("text/plain");
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await ok.text()).toBe("hello");

    vi.setSystemTime(new Date(now.getTime() + HOSTED_ATTACHMENT_TTL_MS + 1));
    const expired = await serveHostedAttachment({ ATTACHMENTS: bucket as unknown as R2Bucket } as Env, id);
    expect(expired.status).toBe(410);
    expect(bucket.objects.has(`attachments/${id}`)).toBe(false);
    vi.useRealTimers();
  });

  it("rejects active MIME types before storing", async () => {
    const bucket = new FakeR2Bucket();
    await expect(
      createHostedAttachment({ ATTACHMENTS: bucket as unknown as R2Bucket } as Env, "https://relay.aimux.app", {
        filename: "page.html",
        mimeType: "text/html",
        dataBase64: btoa("<script></script>"),
      }),
    ).rejects.toThrow("unsupported attachment mime type");
    expect(bucket.objects.size).toBe(0);
  });
});
