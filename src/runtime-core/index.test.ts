import { describe, expect, it } from "vitest";
import { disabledRuntimeCore, RuntimeCoreDisabledError } from "./index.js";

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
});
