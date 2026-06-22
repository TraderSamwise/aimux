import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getProjectRepairLogPathFor } from "./paths.js";
import { notifyRepair, recordRepairEvent } from "./repair-events.js";

const sendDesktopNotificationMock = vi.hoisted(() => vi.fn());

vi.mock("./desktop-notifier.js", () => ({
  sendDesktopNotification: sendDesktopNotificationMock,
}));

describe("repair events", () => {
  it("records repair events in the project repair log", () => {
    const projectRoot = "/tmp/aimux-repair-project";

    recordRepairEvent({
      ts: "2026-06-22T00:00:00.000Z",
      projectRoot,
      action: "tmux-runtime-repair",
      reason: "runtime contract drift",
      status: "repaired",
      details: { currentDaemonPid: 123 },
    });

    const path = getProjectRepairLogPathFor(projectRoot);
    expect(existsSync(path)).toBe(true);
    const [line] = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(line!)).toMatchObject({
      projectRoot,
      action: "tmux-runtime-repair",
      reason: "runtime contract drift",
      status: "repaired",
      details: { currentDaemonPid: 123 },
    });
  });

  it("sends quiet desktop notifications for repairs", () => {
    notifyRepair("Aimux repaired itself", "1 repair step completed.");

    expect(sendDesktopNotificationMock).toHaveBeenCalledWith({
      title: "Aimux repaired itself",
      message: "1 repair step completed.",
      sound: false,
    });
  });
});
