import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { agentToolName, type AgentDisplayInput } from "@/lib/agent-display";

interface AgentDescriptor extends AgentDisplayInput {
  id: string;
  tool: string;
  toolConfigKey: string;
  status: string;
}

interface ForkSurfaceProbe {
  agents: { agents: AgentDescriptor[] };
  desktop: { sessions: AgentDescriptor[]; teammates?: AgentDescriptor[] };
  expectedTool: string;
  sourceId: string;
  targetId: string;
  canonicalId: string;
  tmuxMetadataTool: string;
  tuiTool: string;
  statuslineTool: string;
}

function compareForkSurfaces(probe: ForkSurfaceProbe) {
  expect(probe.expectedTool).not.toBe("");
  expect(probe.targetId).not.toBe(probe.sourceId);
  const target = probe.agents.agents.find((agent) => agent.id === probe.targetId);
  const source = probe.agents.agents.find((agent) => agent.id === probe.sourceId);
  const desktopSessions = [...probe.desktop.sessions, ...(probe.desktop.teammates ?? [])];
  const desktopTarget = desktopSessions.find((agent) => agent.id === probe.targetId);
  const desktopSource = desktopSessions.find((agent) => agent.id === probe.sourceId);
  expect(target, "the service must expose the new fork").toBeDefined();
  expect(source, "forking must preserve the source").toBeDefined();
  expect(desktopTarget, "the desktop must expose the new fork").toBeDefined();
  expect(desktopSource, "the desktop must preserve the source").toBeDefined();
  if (!target || !source || !desktopTarget || !desktopSource) {
    throw new Error("fork and source descriptors are required on both service surfaces");
  }
  expect(["running", "idle", "waiting"]).toContain(source.status);
  expect(["running", "idle", "waiting"]).toContain(desktopSource.status);
  expect(source.toolConfigKey).not.toBe(probe.expectedTool);
  expect(desktopSource.toolConfigKey).toBe(source.toolConfigKey);
  expect(desktopSource.command).toBe(source.command);
  for (const descriptor of [target, desktopTarget]) {
    expect(descriptor.tool).toBe(probe.expectedTool);
    expect(descriptor.toolConfigKey).toBe(probe.expectedTool);
    expect(agentToolName(descriptor)).toBe(probe.expectedTool);
    expect(agentToolName({ ...descriptor, id: source.id, label: source.label })).toBe(
      probe.expectedTool,
    );
  }
  expect(desktopTarget.command).toBe(target.command);
  expect([probe.canonicalId, probe.tmuxMetadataTool, probe.tuiTool, probe.statuslineTool]).toEqual(
    Array(4).fill(probe.expectedTool),
  );
}

function staticProbe(): ForkSurfaceProbe {
  const source: AgentDescriptor = {
    id: "codex-source",
    label: "codex source label",
    command: "/configured/bin/claude",
    tool: "claude",
    toolConfigKey: "claude",
    status: "running",
  };
  const target: AgentDescriptor = {
    id: "claude-fork",
    label: "claude misleading label",
    command: "/configured/bin/codex",
    tool: "configured-codex",
    toolConfigKey: "configured-codex",
    status: "running",
  };
  return {
    agents: { agents: [source, target] },
    desktop: { sessions: [source, target] },
    expectedTool: "configured-codex",
    sourceId: source.id,
    targetId: target.id,
    canonicalId: "configured-codex",
    tmuxMetadataTool: "configured-codex",
    tuiTool: "configured-codex",
    statuslineTool: "configured-codex",
  };
}

const probePath = process.env.AIMUX_FORK_SURFACE_PROBE;

describe("fork class identity across surfaces", () => {
  if (probePath !== undefined) {
    it("compares the real fork across every surface", () => {
      compareForkSurfaces(JSON.parse(readFileSync(probePath, "utf8")) as ForkSurfaceProbe);
    });
  } else {
    it("compares a static fixture with misleading source and target names", () => {
      compareForkSurfaces(staticProbe());
    });
  }
});
