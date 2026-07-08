import { describe, expect, it } from "vitest";
import { toExposeOptions } from "./popup-expose.js";

describe("toExposeOptions", () => {
  it("resolves the two paths and passes the rest through", () => {
    expect(
      toExposeOptions({
        projectRoot: "/proj",
        projectStateDir: "/proj/.aimux/state",
        currentClientSession: "sess-1",
        clientTty: "/dev/ttys009",
        currentWindow: "dashboard",
        currentWindowId: "@7",
        currentPath: "/proj/sub",
        paneId: "%3",
        aimuxHome: "/home/u/.aimux",
        backdropFile: "/tmp/backdrop",
      }),
    ).toEqual({
      projectRoot: "/proj",
      projectStateDir: "/proj/.aimux/state",
      currentClientSession: "sess-1",
      clientTty: "/dev/ttys009",
      currentWindow: "dashboard",
      currentWindowId: "@7",
      currentPath: "/proj/sub",
      paneId: "%3",
      aimuxHome: "/home/u/.aimux",
      backdropFile: "/tmp/backdrop",
    });
  });

  it("resolves relative paths to absolute and leaves omitted options undefined", () => {
    const out = toExposeOptions({ projectRoot: "rel/proj", projectStateDir: "rel/state" });
    expect(out.projectRoot.startsWith("/")).toBe(true);
    expect(out.projectStateDir.endsWith("rel/state")).toBe(true);
    expect(out.currentWindowId).toBeUndefined();
    expect(out.backdropFile).toBeUndefined();
  });
});
