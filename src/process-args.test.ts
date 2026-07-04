import { describe, expect, it } from "vitest";

import { commandArgValueMatches } from "./process-args.js";

describe("commandArgValueMatches", () => {
  it("requires exact flag values instead of prefix matches", () => {
    const args =
      "node /opt/aimux/dist/launcher-bin.js __project-service-internal --project-id repo-old --project-root /repo-old";

    expect(commandArgValueMatches(args, "--project-id", "repo")).toBe(false);
    expect(commandArgValueMatches(args, "--project-root", "/repo")).toBe(false);
    expect(commandArgValueMatches(args, "--project-root", "/repo-old")).toBe(true);
  });

  it("matches final flag values that contain spaces", () => {
    const args = "node aimux __project-service-internal --project-id repo --project-root /Users/sam/My Repo";

    expect(commandArgValueMatches(args, "--project-root", "/Users/sam/My Repo")).toBe(true);
    expect(commandArgValueMatches(args, "--project-root", "/Users/sam/My")).toBe(false);
  });
});
