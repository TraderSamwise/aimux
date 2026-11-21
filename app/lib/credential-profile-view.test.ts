import { describe, expect, it } from "vitest";

import { credentialProfileView, profileDirectories } from "@/lib/credential-profile-view";

describe("the credential profile panel's view", () => {
  it("lists profiles and marks the active one", () => {
    const view = credentialProfileView({
      ok: true,
      active: "work",
      profiles: [
        { name: "personal", codexHome: "/profiles/personal/.codex" },
        { name: "work", claudeConfigDir: "/profiles/work/.claude" },
      ],
    });
    expect(view).toEqual({
      kind: "list",
      active: "work",
      profiles: [
        { name: "personal", codexHome: "/profiles/personal/.codex" },
        { name: "work", claudeConfigDir: "/profiles/work/.claude" },
      ],
    });
  });

  /// A machine with profiles but none chosen is a real state and must not read
  /// as one with a profile active.
  it("has no active profile when none is chosen", () => {
    const view = credentialProfileView({
      ok: true,
      active: null,
      profiles: [{ name: "work", claudeConfigDir: "/w" }],
    });
    expect(view.kind).toBe("list");
    if (view.kind === "list") expect(view.active).toBeNull();
  });

  it("says so when the machine has no profiles configured", () => {
    expect(credentialProfileView({ ok: true, active: null, profiles: [] })).toEqual({
      kind: "none",
    });
  });

  // The distinction the helper exists for. A block that could not be READ is
  // not a machine with NO profiles: collapsing them tells somebody their
  // machine has none when it may have several it cannot parse, and the switch
  // then looks unavailable rather than broken.
  it("keeps an unreadable block apart from a machine with none", () => {
    const view = credentialProfileView({
      ok: false,
      error: "credentialProfiles is not an object in the Aimux config",
    });
    expect(view).toEqual({
      kind: "unreadable",
      reason: "credentialProfiles is not an object in the Aimux config",
    });
    expect(view.kind).not.toBe("none");
  });

  it("falls back to its own words when an unreadable block carries no reason", () => {
    const view = credentialProfileView({ ok: false });
    expect(view.kind).toBe("unreadable");
    if (view.kind === "unreadable") expect(view.reason).toContain("could not be read");
  });

  it("is loading before the first answer arrives", () => {
    expect(credentialProfileView(null)).toEqual({ kind: "loading" });
  });

  describe("profileDirectories", () => {
    it("joins the directories a profile actually switches", () => {
      expect(profileDirectories({ claudeConfigDir: "/c", codexHome: "/x" })).toBe("/c, /x");
    });

    /// A Claude-only profile must not render a stray separator, and an absent
    /// directory is not an empty string.
    it("names only the tool a profile switches", () => {
      expect(profileDirectories({ claudeConfigDir: "/c" })).toBe("/c");
      expect(profileDirectories({ codexHome: "/x", claudeConfigDir: null })).toBe("/x");
      expect(profileDirectories({})).toBe("");
    });
  });
});
