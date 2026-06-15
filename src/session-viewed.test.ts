import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "./paths.js";
import { loadMetadataState, updateSessionMetadata } from "./metadata-store.js";
import { addNotification, listNotifications } from "./notifications.js";
import { markSessionViewed } from "./session-viewed.js";

describe("markSessionViewed", () => {
  let repoRoot = "";
  let aimuxHome = "";
  let previousAimuxHome: string | undefined;

  beforeEach(async () => {
    previousAimuxHome = process.env.AIMUX_HOME;
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-session-viewed-home-"));
    process.env.AIMUX_HOME = aimuxHome;
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-viewed-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
  });

  function seedAttention(sessionId: string, attention: "needs_input" | "needs_response" | "blocked"): void {
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          activity: "waiting",
          attention,
          unseenCount: 3,
        },
      }),
      repoRoot,
    );
  }

  it("marks notifications read and clears generic needs-input attention by default", () => {
    seedAttention("claude-1", "needs_input");
    addNotification({ title: "Needs input", body: "Agent is waiting", sessionId: "claude-1", kind: "needs_input" });

    const result = markSessionViewed("claude-1", repoRoot);

    const derived = loadMetadataState(repoRoot).sessions["claude-1"]?.derived;
    expect(result).toEqual({ notificationsRead: 1, attentionCleared: true });
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.attention).toBe("normal");
    expect(listNotifications({ sessionId: "claude-1" })[0]?.unread).toBe(false);
  });

  it("does not clear formal interaction attention by default", () => {
    seedAttention("codex-ask", "needs_response");
    addNotification({ title: "Question", body: "Pick an option", sessionId: "codex-ask", kind: "interaction_request" });

    const result = markSessionViewed("codex-ask", repoRoot);

    const derived = loadMetadataState(repoRoot).sessions["codex-ask"]?.derived;
    expect(result).toEqual({ notificationsRead: 1, attentionCleared: false });
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.attention).toBe("needs_response");
    expect(listNotifications({ sessionId: "codex-ask" })[0]?.unread).toBe(false);
  });

  it("does not clear blocked attention on view", () => {
    seedAttention("codex-blocked", "blocked");

    const result = markSessionViewed("codex-blocked", repoRoot);

    const derived = loadMetadataState(repoRoot).sessions["codex-blocked"]?.derived;
    expect(result).toEqual({ notificationsRead: 0, attentionCleared: false });
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.attention).toBe("blocked");
  });

  it("honors view behavior config overrides", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          notifications: {
            markReadOnView: false,
            clearNeedsInputOnView: false,
            clearFormalInteractionsOnView: true,
          },
        },
        null,
        2,
      ) + "\n",
    );
    seedAttention("codex-ask", "needs_response");
    addNotification({ title: "Question", body: "Pick an option", sessionId: "codex-ask", kind: "interaction_request" });

    const result = markSessionViewed("codex-ask", repoRoot);

    const derived = loadMetadataState(repoRoot).sessions["codex-ask"]?.derived;
    expect(result).toEqual({ notificationsRead: 0, attentionCleared: true });
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.attention).toBe("normal");
    expect(listNotifications({ sessionId: "codex-ask" })[0]?.unread).toBe(true);
  });
});
