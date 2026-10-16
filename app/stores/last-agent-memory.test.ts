import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  lastAgentByProjectAtom,
  selectedProjectRefAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

/**
 * The memory, driven rather than read.
 *
 * A source gate on this store passed while the write that persists the memory
 * was deleted, and again while the project key it is written against was
 * replaced by a constant -- so nothing was remembered, or everything was
 * remembered against one key. Jotai needs no renderer: a store, a few sets,
 * and the atoms answer for themselves.
 */
function store() {
  const jotai = createStore();
  // Start from a clean memory: the storage atom's first value can be whatever
  // a previous test in this file left.
  jotai.set(lastAgentByProjectAtom, {});
  return jotai;
}

describe("the last-agent memory", () => {
  it("records the agent against the project that was open", () => {
    const jotai = store();
    jotai.set(selectedProjectRefAtom, { machineId: "mac", path: "/repo" });
    jotai.set(selectedSessionIdAtom, "claude-7");

    expect(jotai.get(selectedSessionIdAtom)).toBe("claude-7");
    const memory = jotai.get(lastAgentByProjectAtom);
    expect(Object.values(memory), "the agent is remembered").toContain("claude-7");
    expect(Object.keys(memory), "against one project, not globally").toHaveLength(1);
  });

  it("keeps one agent per project rather than one overall", () => {
    const jotai = store();
    jotai.set(selectedProjectRefAtom, { machineId: "mac", path: "/repo" });
    jotai.set(selectedSessionIdAtom, "claude-7");
    jotai.set(selectedProjectRefAtom, { machineId: "mini", path: "/repo" });
    jotai.set(selectedSessionIdAtom, "codex-2");

    const memory = jotai.get(lastAgentByProjectAtom);
    // The same checkout on two machines is two projects. A memory keyed by
    // anything else collapses them, which is the two-machine case this exists
    // for.
    expect(Object.keys(memory), "two projects, two memories").toHaveLength(2);
    expect(Object.values(memory).sort()).toEqual(["claude-7", "codex-2"]);
  });

  // The transient selection is cleared whenever the open project changes, and
  // the next launch is exactly when the memory is read.
  it("does not forget when the selection is cleared", () => {
    const jotai = store();
    jotai.set(selectedProjectRefAtom, { machineId: "mac", path: "/repo" });
    jotai.set(selectedSessionIdAtom, "claude-7");
    jotai.set(selectedSessionIdAtom, null);

    expect(jotai.get(selectedSessionIdAtom)).toBeNull();
    expect(Object.values(jotai.get(lastAgentByProjectAtom))).toContain("claude-7");
  });

  it("records nothing when no project is open", () => {
    const jotai = store();
    jotai.set(selectedProjectRefAtom, null);
    jotai.set(selectedSessionIdAtom, "claude-7");

    expect(jotai.get(selectedSessionIdAtom)).toBe("claude-7");
    expect(jotai.get(lastAgentByProjectAtom)).toEqual({});
  });
});
