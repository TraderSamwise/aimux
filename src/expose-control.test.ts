import { describe, expect, it, vi } from "vitest";
import { listAllProjectsExposeItems } from "./expose-control.js";

describe("listAllProjectsExposeItems", () => {
  it("flattens switchable items from every registered running project", () => {
    const tmux = {
      listSessionNames: vi.fn(() => ["aimux-one", "aimux-two", "random"]),
      getSessionOption: vi.fn((sessionName: string) => {
        if (sessionName === "aimux-one") return "/repo/one";
        if (sessionName === "aimux-two") return "/repo/two";
        return "";
      }),
    };
    const listItemsFn = vi.fn((context: { projectRoot: string }) => [
      {
        id: `${context.projectRoot}-agent`,
        label: "claude",
        target: { sessionName: "s", windowId: `@${context.projectRoot.at(-1)}`, windowIndex: 1, windowName: "claude" },
        metadata: { sessionId: `${context.projectRoot}-agent` },
        urgency: 0,
        activity: 1,
        recentRank: 1,
      },
    ]);

    const items = listAllProjectsExposeItems({
      tmux: tmux as never,
      listProjectsFn: () => [
        { id: "two", name: "two", repoRoot: "/repo/two", lastSeen: "" },
        { id: "one", name: "one", repoRoot: "/repo/one", lastSeen: "" },
        { id: "stopped", name: "stopped", repoRoot: "/repo/stopped", lastSeen: "" },
      ],
      listItemsFn: listItemsFn as never,
    });

    expect(items.map((item) => [item.projectName, item.projectRoot])).toEqual([
      ["one", "/repo/one"],
      ["two", "/repo/two"],
    ]);
    expect(listItemsFn).toHaveBeenCalledTimes(2);
  });
});
