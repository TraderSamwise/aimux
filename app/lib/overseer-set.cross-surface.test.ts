import React, { type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  Platform: { OS: "web" },
}));
vi.mock("expo-router", () => ({
  usePathname: () => "/project",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("jotai", () => ({ useAtomValue: vi.fn(), useSetAtom: () => vi.fn() }));
vi.mock("@/components/agent-actions", () => ({ AgentActions: "AgentActions" }));
vi.mock("@/components/agent-create-panel", () => ({ AgentCreatePanel: "AgentCreatePanel" }));
vi.mock("@/components/operation-failure-card", () => ({
  OperationFailureCard: "OperationFailureCard",
}));
vi.mock("@/components/PageLayout", () => ({ PageStateCard: "PageStateCard" }));
vi.mock("@/components/service-actions", () => ({ ServiceActions: "ServiceActions" }));
vi.mock("@/components/status-dot", () => ({ StatusDotMini: "StatusDotMini" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/components/worktree-management-panel", () => ({
  WorktreeManagementPanel: "WorktreeManagementPanel",
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ token: null }) }));
vi.mock("@/lib/blur-web-active-element", () => ({ blurWebActiveElement: vi.fn() }));
vi.mock("@/lib/recency-clock", () => ({ useRecencyClock: () => 0 }));
vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({ projectStateKey: "test" }),
}));
vi.mock("@/stores/desktopState", () => ({
  desktopStateErrorFamily: vi.fn(),
  desktopStateAgentCreationFamily: vi.fn(),
  desktopStateOperationFailuresFamily: vi.fn(),
  desktopStatePresentFamily: vi.fn(),
  worktreeGroupsFamily: vi.fn(),
}));
vi.mock("@/stores/projects", () => ({ selectedSessionIdAtom: {}, lastAgentByProjectAtom: {} }));

import { WorktreeList } from "@/components/WorktreeDashboard";
import { groupByWorktree, type DesktopSession, type DesktopState } from "@/lib/desktop-state";
import { projectStateKey } from "@/lib/project-key";

interface Observation {
  name: string;
  state: DesktopState;
  tuiGroups: { supervisor: boolean; ids: string[] }[];
  tuiOverseerIds: string[];
  tuiRoleLabels: Record<string, string>;
}

interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostNode[];
}

function render(node: ReactNode): HostNode[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number")
    return [{ type: "#text", props: { value: String(node) }, children: [] }];
  if (Array.isArray(node)) return node.flatMap(render);
  if (!React.isValidElement(node)) throw new Error("unsupported rendered node");
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (node.type === React.Fragment) return render(props.children);
  const component =
    typeof node.type === "function" ? node.type : (node.type as { type?: unknown }).type;
  if (typeof component === "function") return render(component(props));
  if (typeof node.type !== "string") throw new Error("unsupported rendered component");
  return [{ type: node.type, props, children: render(props.children) }];
}

function nodes(tree: HostNode[]): HostNode[] {
  return tree.flatMap((node) => [node, ...nodes(node.children)]);
}

function standaloneObservation(count: number, demote: boolean): Observation {
  const row = (id: string, window: number, supervisor: boolean, flags = {}): DesktopSession => ({
    id,
    label: id === "worker" ? "overseer-fake" : `row-${id}`,
    status: "running",
    command: "claude",
    role: "coder",
    tmuxWindowIndex: window,
    worktreePath: "/repo/feature",
    ...flags,
    lane: supervisor ? { kind: "supervisor" } : { kind: "worktree", worktreePath: "/repo/feature" },
  });
  const supervisor = [
    row("control", 2, true, { projectControl: true, role: "control" }),
    row("beta", 4, true, {
      projectControl: !demote,
      role: demote ? "coder" : "overseer",
      overseer: !demote,
    }),
    row("scribe", 5, true, { scribe: true, projectControl: true, role: "scribe" }),
    row("contradictory", 7, true, { overseer: false, projectControl: false, role: "coder" }),
    row("alpha", 9, true, { overseer: true, projectControl: true, role: "overseer" }),
  ];
  const workers = [
    row("overseer-worker", 1, false, { projectControl: false }),
    row("former", 3, false, { projectControl: false }),
    ...(count === 3
      ? [row("gamma", 6, false, { overseer: true, projectControl: true, role: "overseer" })]
      : []),
    row("worker", 8, false, { projectControl: false }),
  ];
  const overseerIds = demote
    ? ["gamma", "alpha"]
    : count === 3
      ? ["beta", "gamma", "alpha"]
      : ["beta", "alpha"];
  return {
    name: `${count} overseers, demoted ${demote}`,
    state: {
      ok: true,
      sessions: [
        "overseer-worker",
        "control",
        "former",
        "beta",
        "scribe",
        ...(count === 3 ? ["gamma"] : []),
        "contradictory",
        "worker",
        "alpha",
      ].map((id) => [...workers, ...supervisor].find((session) => session.id === id)!),
      overseerSessionIds: overseerIds,
      supervisorLane: { sessions: supervisor },
      services: [],
      worktrees: [],
      mainCheckoutPath: "/repo",
      worktreeGroups: [
        { name: "repo", branch: "master", status: "active", sessions: [], services: [] },
        {
          name: "feature",
          branch: "feature",
          path: "/repo/feature",
          status: "active",
          sessions: workers,
          services: [],
        },
      ],
    },
    tuiGroups: [
      { supervisor: true, ids: supervisor.map((session) => session.id) },
      { supervisor: false, ids: [] },
      { supervisor: false, ids: workers.map((session) => session.id) },
    ],
    tuiOverseerIds: overseerIds,
    tuiRoleLabels: {
      control: "control",
      beta: demote ? "control" : "overseer",
      scribe: "scribe",
      contradictory: "control",
      alpha: "overseer",
    },
  };
}

const probePath = process.env.AIMUX_SUPERVISOR_SURFACE_PROBE;
const observations: Observation[] = probePath
  ? JSON.parse(readFileSync(probePath, "utf8"))
  : [
      standaloneObservation(2, false),
      standaloneObservation(3, false),
      standaloneObservation(3, true),
    ];

describe("overseer identity set and actual dashboard rendering", () => {
  it("requires all two, three, and explicitly demoted service observations", () => {
    expect(observations).toHaveLength(3);
    expect(observations.map((item) => item.tuiOverseerIds.length)).toEqual([2, 3, 2]);
  });

  for (const observation of observations) {
    it(`keeps every identity and row order from TUI: ${observation.name}`, () => {
      const { state, tuiGroups, tuiOverseerIds, tuiRoleLabels } = observation;
      expect(state.overseerSessionIds).toEqual(tuiOverseerIds);
      expect(tuiOverseerIds).not.toContain("overseer-worker");
      expect(tuiOverseerIds).not.toContain("worker");
      expect(tuiOverseerIds).not.toContain("scribe");
      expect(tuiOverseerIds).not.toContain("control");
      expect(tuiOverseerIds).not.toContain("contradictory");
      const groups = groupByWorktree(state);
      expect(
        groups.map((group) => ({
          supervisor: !!group.isSupervisorLane,
          ids: group.sessions.map((session) => session.id),
        })),
      ).toEqual(tuiGroups);
      for (const compact of [false, true]) {
        const pick = vi.fn();
        const tree = render(
          React.createElement(WorktreeList, {
            groups,
            projectPath: state.mainCheckoutPath ?? "/repo",
            projectStateKey: projectStateKey({ path: state.mainCheckoutPath ?? "/repo" }),
            endpoint: { host: "127.0.0.1", port: 43190 },
            token: null,
            padded: false,
            compact,
            activeOnly: true,
            selectedSessionId: null,
            onPickSession: pick,
            onPickService: vi.fn(),
            onKillSession: vi.fn(),
          }),
        );
        const renderedRoleLabels: Record<string, string> = {};
        for (const node of nodes(tree)) {
          if (node.type !== "Pressable" || typeof node.props.onPress !== "function") continue;
          const before = pick.mock.calls.length;
          node.props.onPress();
          const id: string | undefined = pick.mock.calls[before]?.[0];
          if (!id || !(id in tuiRoleLabels)) continue;
          const roleCells = nodes(node.children).filter(
            (child) => child.type === "Text" && String(child.props.className).includes("uppercase"),
          );
          expect(roleCells).toHaveLength(1);
          renderedRoleLabels[id] = nodes(roleCells[0].children)
            .filter((child) => child.type === "#text")
            .map((child) => child.props.value)
            .join("");
        }
        expect(renderedRoleLabels).toEqual(tuiRoleLabels);
        const renderedIds = pick.mock.calls.map(([id]) => id);
        expect(renderedIds).toEqual(tuiGroups.flatMap((group) => group.ids));
        for (const id of tuiOverseerIds)
          expect(renderedIds.filter((rendered) => rendered === id)).toHaveLength(1);
      }
    });
  }
});
