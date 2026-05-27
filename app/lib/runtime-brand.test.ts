import { describe, expect, it } from "vitest";
import { runtimeBrandForCommand, runtimeBrandForKind } from "@/lib/runtime-brand";

describe("runtime brand", () => {
  it("recognizes core agent runtimes from commands", () => {
    expect(runtimeBrandForCommand("claude --continue").id).toBe("claude");
    expect(runtimeBrandForCommand("codex exec").id).toBe("codex");
    expect(runtimeBrandForCommand("zsh").id).toBe("shell");
  });

  it("falls services back to service identity", () => {
    expect(runtimeBrandForKind("service", "yarn dev").id).toBe("service");
    expect(runtimeBrandForKind("agent", undefined).id).toBe("unknown");
  });
});
