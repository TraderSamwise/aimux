import React, { type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, spawn: vi.fn() }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = harness.cursor++;
      if (slot >= harness.cells.length) {
        harness.cells[slot] = typeof initial === "function" ? initial() : initial;
      }
      return [
        harness.cells[slot],
        (value: unknown) => {
          harness.cells[slot] = typeof value === "function" ? value(harness.cells[slot]) : value;
        },
      ];
    },
    useMemo: (compute: () => unknown) => compute(),
    useEffect: () => {},
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => {
      const slot = harness.cursor++;
      if (slot >= harness.cells.length) harness.cells[slot] = { current };
      return harness.cells[slot];
    },
  };
});
vi.mock("react-native", () => ({
  Modal: "Modal",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  Platform: { OS: "web" },
  StyleSheet: { absoluteFill: {} },
  Alert: { alert: vi.fn() },
}));
vi.mock("expo-router", () => ({
  usePathname: () => "/project",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("jotai", () => ({ useAtomValue: vi.fn(), useSetAtom: () => vi.fn() }));
vi.mock("lucide-react-native", () => ({ Plus: "Plus" }));
vi.mock("@/lib/api", () => ({ spawnAgent: harness.spawn, createWorktree: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/ui/card", () => ({ Card: "Card" }));
vi.mock("@/components/ui/input", () => ({ Input: "Input" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/components/ui/segmented-control", () => ({ SegmentedControl: "SegmentedControl" }));
vi.mock("@/components/agent-actions", () => ({ AgentActions: "AgentActions" }));
vi.mock("@/components/operation-failure-card", () => ({
  OperationFailureCard: "OperationFailureCard",
}));
vi.mock("@/components/PageLayout", () => ({ PageStateCard: "PageStateCard" }));
vi.mock("@/components/service-actions", () => ({ ServiceActions: "ServiceActions" }));
vi.mock("@/components/status-dot", () => ({ StatusDotMini: "StatusDotMini" }));
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
  desktopStateFamily: vi.fn(),
  worktreeGroupsFamily: vi.fn(),
  desktopStateOperationFailuresFamily: vi.fn(),
  kickDesktopStateRefreshAtom: {},
  desktopStateAgentCreationFamily: vi.fn(),
  desktopStatePresentFamily: vi.fn(),
}));
vi.mock("@/stores/projects", () => ({ selectedSessionIdAtom: {}, lastAgentByProjectAtom: {} }));
vi.mock("@/stores/lifecycleTransitions", () => ({ recordProjectLifecycleTransitionAtom: {} }));
vi.mock("@/stores/projectViews", () => ({ kickProjectApiViewRefreshAtom: {} }));

import { CreateInProjectDialog } from "@/components/CreateInProjectDialog";
import { AgentCreatePanel } from "@/components/agent-create-panel";
import { WorktreeList } from "@/components/WorktreeDashboard";
import { groupByWorktree, type DesktopState } from "@/lib/desktop-state";
import { projectStateKey } from "@/lib/project-key";

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: HostNode[];
  text: string;
}

function render(node: ReactNode): HostNode[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number")
    return [{ type: "text", props: {}, children: [], text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(render);
  if (!React.isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (node.type === React.Fragment) return render(props.children);
  const component =
    typeof node.type === "function" ? node.type : (node.type as { type?: unknown }).type;
  if (typeof component === "function") return render(component(props));
  const children = render(props.children);
  return [{ type: node.type, props, children, text: children.map((child) => child.text).join("") }];
}

function nodes(tree: HostNode[]): HostNode[] {
  return tree.flatMap((node) => [node, ...nodes(node.children)]);
}

const probePath = process.env.AIMUX_SUPERVISOR_SURFACE_PROBE;
const probe = probePath
  ? (JSON.parse(readFileSync(probePath, "utf8")) as {
      state: DesktopState;
      defaultSpawn: Record<string, unknown>;
      worktreeSpawn: Record<string, unknown>;
      tuiSupervisorVisible: boolean;
    })
  : null;

describe.skipIf(!probe)("supervisor lane, compared directly against the running TUI code", () => {
  it("renders the same empty lane and submits the same default and chosen worktree roles", async () => {
    if (!probe) throw new Error("native surface observations are required");
    const groups = groupByWorktree(probe.state);
    const key = projectStateKey({ path: probe.state.mainCheckoutPath ?? "/repo" });
    const endpoint = { host: "127.0.0.1", port: 43190 };
    harness.cells = [];
    harness.cursor = 0;
    const list = render(
      React.createElement(WorktreeList, {
        groups,
        projectPath: probe.state.mainCheckoutPath ?? "/repo",
        projectStateKey: key,
        endpoint,
        token: null,
        padded: false,
        compact: true,
        activeOnly: true,
        selectedSessionId: null,
        onPickSession: vi.fn(),
        onPickService: vi.fn(),
        onKillSession: vi.fn(),
      }),
    );
    expect(list.some((node) => node.text.includes("Supervisor Lane"))).toBe(
      probe.tuiSupervisorVisible,
    );
    expect(list.some((node) => node.text.includes("No supervisor agents"))).toBe(true);

    harness.cells = [];
    harness.spawn.mockResolvedValue({ ok: true, sessionId: "control-1" });
    const dialog = () => {
      harness.cursor = 0;
      return render(
        React.createElement(CreateInProjectDialog, {
          groups,
          endpoint,
          token: null,
          projectStateKey: key,
          agentCreation: probe.state.agentCreation,
          onDismiss: vi.fn(),
        }),
      );
    };
    let tree = dialog();
    const supervisor = nodes(tree).find(
      (node) => node.props.accessibilityLabel === "Supervisor Lane",
    );
    expect(supervisor?.props.accessibilityState).toEqual({ selected: true });
    let launch = nodes(tree).find((node) => node.type === "Button" && node.text === "Launch agent");
    expect(launch?.props.disabled).toBe(false);
    await (launch!.props.onPress as () => Promise<void>)();
    await Promise.resolve();
    expect(harness.spawn).toHaveBeenCalledOnce();
    expect(harness.spawn.mock.calls[0][1]).toEqual(probe.defaultSpawn);

    tree = dialog();
    const feature = nodes(tree).find((node) => node.props.accessibilityLabel === "feature");
    expect(feature, "the existing worktree remains selectable").toBeDefined();
    (feature!.props.onPress as () => void)();
    tree = dialog();
    launch = nodes(tree).find((node) => node.type === "Button" && node.text === "Launch agent");
    await (launch!.props.onPress as () => Promise<void>)();
    await Promise.resolve();
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.spawn.mock.calls[1][1]).toEqual(probe.worktreeSpawn);
  });

  it("compares the Project screen panel's default, override, and late policy against the TUI", async () => {
    if (!probe) throw new Error("native surface observations are required");
    const groups = groupByWorktree(probe.state);
    const key = projectStateKey({ path: probe.state.mainCheckoutPath ?? "/repo" });
    const endpoint = { host: "127.0.0.1", port: 43190 };
    harness.cells = [];
    harness.spawn.mockClear();
    harness.spawn.mockResolvedValue({ ok: true, sessionId: "control-panel" });
    const panel = (agentCreation = probe.state.agentCreation) => {
      harness.cursor = 0;
      return render(
        React.createElement(AgentCreatePanel, {
          groups,
          endpoint,
          token: null,
          projectStateKey: key,
          agentCreation,
        }),
      );
    };
    const chip = (tree: HostNode[], label: string) =>
      nodes(tree).find((node) => node.type === "Pressable" && node.text === label);
    const launch = (tree: HostNode[]) =>
      nodes(tree).find((node) => node.props.accessibilityLabel === "Create agent")!;

    let tree = panel();
    expect(chip(tree, "Supervisor Lane")?.props.accessibilityState).toEqual({ selected: true });
    expect(launch(tree).props.disabled).toBe(false);
    await (launch(tree).props.onPress as () => Promise<void>)();
    expect(harness.spawn.mock.calls[0][1]).toEqual(probe.defaultSpawn);

    tree = panel();
    expect(
      chip(tree, "feature"),
      "the Project panel must preserve the worktree choice",
    ).toBeDefined();
    (chip(tree, "feature")!.props.onPress as () => void)();
    tree = panel();
    expect(chip(tree, "feature")?.props.accessibilityState).toEqual({ selected: true });
    await (launch(tree).props.onPress as () => Promise<void>)();
    expect(harness.spawn.mock.calls[1][1]).toEqual(probe.worktreeSpawn);

    tree = panel();
    (chip(tree, "Supervisor Lane")!.props.onPress as () => void)();
    tree = panel();
    await (launch(tree).props.onPress as () => Promise<void>)();
    expect(harness.spawn.mock.calls[2][1]).toEqual(probe.defaultSpawn);

    harness.cells = [];
    harness.cursor = 0;
    tree = render(
      React.createElement(AgentCreatePanel, {
        groups,
        endpoint,
        token: null,
        projectStateKey: key,
      }),
    );
    expect(launch(tree).props.disabled).toBe(true);
    tree = panel();
    expect(chip(tree, "Supervisor Lane")?.props.accessibilityState).toEqual({ selected: true });
    expect(launch(tree).props.disabled).toBe(false);
    await (launch(tree).props.onPress as () => Promise<void>)();
    expect(harness.spawn.mock.calls[3][1]).toEqual(probe.defaultSpawn);
    expect(harness.spawn).toHaveBeenCalledTimes(4);
  });
});
