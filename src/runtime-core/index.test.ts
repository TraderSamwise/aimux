import { describe, expect, it } from "vitest";
import { disabledRuntimeCore, RuntimeCoreDisabledError, type RuntimeCoreOperation } from "./index.js";

describe("disabledRuntimeCore", () => {
  it("fails lifecycle mutations at the runtime-core boundary", async () => {
    await expect(disabledRuntimeCore.spawnAgent({ toolConfigKey: "codex" })).rejects.toMatchObject({
      code: "AIMUX_RUNTIME_CORE_DISABLED",
      operation: "agent.spawn",
      status: 501,
    });
    await expect(disabledRuntimeCore.stopAgent({ sessionId: "codex-1" })).rejects.toBeInstanceOf(
      RuntimeCoreDisabledError,
    );
  });

  it("keeps disabled operation names aligned with runtime-core methods", async () => {
    const checks: Array<[RuntimeCoreOperation, () => Promise<unknown>]> = [
      ["agent.spawn", () => disabledRuntimeCore.spawnAgent({ toolConfigKey: "codex" })],
      ["agent.fork", () => disabledRuntimeCore.forkAgent({ sourceSessionId: "s1", targetToolConfigKey: "codex" })],
      ["agent.createTeammate", () => disabledRuntimeCore.createTeammateAgent({ parentSessionId: "s1" })],
      ["agent.rename", () => disabledRuntimeCore.renameAgent({ sessionId: "s1", label: "new" })],
      ["agent.stop", () => disabledRuntimeCore.stopAgent({ sessionId: "s1" })],
      ["agent.kill", () => disabledRuntimeCore.killAgent({ sessionId: "s1" })],
      ["agent.migrate", () => disabledRuntimeCore.migrateAgent({ sessionId: "s1", targetWorktreePath: "/repo/wt" })],
      ["agent.input", () => disabledRuntimeCore.writeAgentInput({ sessionId: "s1", data: "hello" })],
      ["agent.interrupt", () => disabledRuntimeCore.interruptAgent({ sessionId: "s1" })],
    ];

    for (const [operation, run] of checks) {
      await expect(run()).rejects.toMatchObject({ operation });
    }
  });
});
