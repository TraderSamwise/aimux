import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stateDir = "";

vi.mock("../paths.js", () => ({
  getDashboardOperationFailuresPath: () => join(stateDir, "dashboard-operation-failures.json"),
}));

describe("dashboard operation failures", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "aimux-operation-failures-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists active failures and clears matching failures", async () => {
    const { addDashboardOperationFailure, clearDashboardOperationFailures, listDashboardOperationFailures } =
      await import("./operation-failures.js");

    const failure = addDashboardOperationFailure({
      targetKind: "worktree",
      operation: "create",
      title: 'Failed to create worktree "demo"',
      message: "branch already exists",
      worktreePath: "/repo/.aimux/worktrees/demo",
      worktreeName: "demo",
    });

    expect(listDashboardOperationFailures()).toEqual([expect.objectContaining({ id: failure.id })]);

    clearDashboardOperationFailures({
      targetKind: "worktree",
      operation: "create",
      worktreePath: "/repo/.aimux/worktrees/demo",
    });

    expect(listDashboardOperationFailures()).toEqual([]);
  });

  it("clears a failed agent create when a later one in the same worktree succeeds", async () => {
    const { addDashboardOperationFailure, clearDashboardOperationFailures, listDashboardOperationFailures } =
      await import("./operation-failures.js");

    addDashboardOperationFailure({
      targetKind: "agent",
      operation: "create",
      title: "Failed to create codex agent",
      message: "tmux refused the window",
      // The session that never came up. The retry gets a different id, which is
      // why clearing by target id left this on screen for a day.
      targetId: "codex-793soe",
      worktreePath: "/repo/.aimux/worktrees/demo",
    });

    clearDashboardOperationFailures({
      targetKind: "agent",
      operation: "create",
      worktreePath: "/repo/.aimux/worktrees/demo",
    });

    expect(listDashboardOperationFailures()).toEqual([]);
  });

  it("keeps main-checkout and worktree failures apart", async () => {
    const { addDashboardOperationFailure, clearDashboardOperationFailures, listDashboardOperationFailures } =
      await import("./operation-failures.js");

    addDashboardOperationFailure({
      targetKind: "agent",
      operation: "create",
      title: "Failed to create codex agent",
      message: "main checkout",
    });
    addDashboardOperationFailure({
      targetKind: "agent",
      operation: "create",
      title: "Failed to create codex agent",
      message: "in a worktree",
      worktreePath: "/repo/.aimux/worktrees/demo",
    });

    clearDashboardOperationFailures({ targetKind: "agent", operation: "create", worktreePath: null });

    expect(listDashboardOperationFailures()).toEqual([
      expect.objectContaining({ worktreePath: "/repo/.aimux/worktrees/demo" }),
    ]);
  });
});
