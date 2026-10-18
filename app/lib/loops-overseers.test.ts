import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSession, DesktopState, WorktreeBucket } from "@/lib/desktop-state";

const harness = vi.hoisted(() => ({
  state: null as unknown,
  groups: [] as unknown[],
  clear: vi.fn(),
  select: vi.fn(),
  push: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("expo-router", () => ({
  usePathname: () => "/loops",
  useRouter: () => ({ push: harness.push }),
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: string) =>
    atom === "state" ? harness.state : atom === "groups" ? harness.groups : null,
  useSetAtom: (atom: string) => (atom === "selected" ? harness.select : vi.fn()),
}));
vi.mock("lucide-react-native", () => ({
  Eye: "Eye",
  RefreshCw: "RefreshCw",
  ShieldCheck: "ShieldCheck",
  Target: "Target",
}));
vi.mock("nativewind", () => ({ useColorScheme: () => ({ colorScheme: "dark" }) }));
vi.mock("@/components/PageLayout", () => ({
  Page: "Page",
  PageHeader: "PageHeader",
  PageStateCard: "PageStateCard",
}));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/ui/card", () => ({ Card: "Card" }));
vi.mock("@/components/ui/input", () => ({ Input: "Input" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/lib/api", () => ({ setAgentOverseer: harness.clear, setAgentLoop: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getToken: async () => "test-token" }) }));
vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({
    project: { name: "repo", path: "/repo" },
    projectPath: "/repo",
    projectRef: { path: "/repo" },
    endpoint: { host: "127.0.0.1", port: 43190 },
    projectLoading: false,
  }),
}));
vi.mock("@/stores/desktopState", () => ({
  desktopStateErrorFamily: () => "error",
  desktopStateFamily: () => "state",
  worktreeGroupsFamily: () => "groups",
  kickDesktopStateRefreshAtom: "refresh",
}));
vi.mock("@/stores/projectViews", () => ({ kickProjectApiViewRefreshAtom: "views" }));
vi.mock("@/stores/projects", () => ({ selectedSessionIdAtom: "selected" }));

import LoopsScreen from "@/app/(main)/(tabs)/loops";

interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostNode[];
  text: string;
}

function render(node: ReactNode): HostNode[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number")
    return [{ type: "text", props: {}, children: [], text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(render);
  if (!React.isValidElement(node)) throw new Error("unsupported rendered node");
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (node.type === React.Fragment) return render(props.children);
  const component =
    typeof node.type === "function" ? node.type : (node.type as { type?: unknown }).type;
  if (typeof component === "function") return render(component(props));
  if (typeof node.type !== "string") throw new Error("unsupported rendered component");
  const children = render(props.children);
  return [{ type: node.type, props, children, text: children.map((child) => child.text).join("") }];
}

function nodes(tree: HostNode[]): HostNode[] {
  return tree.flatMap((node) => [node, ...nodes(node.children)]);
}

function fixture(ids: string[]) {
  const row = (id: string, overseer = false): DesktopSession => ({
    id,
    label: `director-${id}`,
    command: "claude",
    status: "running",
    overseer,
    worktreeName: "feature",
    lane: { kind: "worktree", worktreePath: "/repo/feature" },
  });
  const worker = row("overseer-worker", true);
  const group: WorktreeBucket = {
    key: "main",
    name: "repo",
    branch: "master",
    path: null,
    isMainCheckout: true,
    sessions: [worker],
    services: [],
  };
  const state: DesktopState = {
    ok: true,
    sessions: [row("alpha"), worker, row("beta"), row("gamma")],
    overseerSessionIds: ids,
    services: [],
    worktrees: [],
    mainCheckoutPath: "/repo",
  };
  harness.state = state;
  harness.groups = [group];
}

describe("Loops screen published overseer identities", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const ids of [
    ["beta", "alpha"],
    ["gamma", "beta", "alpha"],
  ]) {
    it(`renders all ${ids.length} identities in service order and clears the second`, async () => {
      fixture(ids);
      const tree = nodes(render(React.createElement(LoopsScreen)));
      const clearButtons = tree.filter(
        (node) =>
          node.type === "Button" &&
          String(node.props.accessibilityLabel).startsWith("Clear overseer "),
      );
      expect(clearButtons.map((node) => node.props.accessibilityLabel)).toEqual(
        ids.map((id) => `Clear overseer director-${id}`),
      );
      expect(
        tree.some((node) => node.type === "Card" && node.text === `${ids.length}Overseers`),
      ).toBe(true);
      for (const id of ids) {
        const row = tree.find(
          (node) => node.type === "Pressable" && node.text.includes(`director-${id}`),
        );
        expect(row, `published ${id} need not be in any local group`).toBeDefined();
        (row!.props.onPress as () => void)();
      }
      expect(harness.select.mock.calls.map(([id]) => id)).toEqual(ids);
      expect(clearButtons[1].props.disabled).toBe(false);
      await (clearButtons[1].props.onPress as () => Promise<void>)();
      expect(harness.clear).toHaveBeenCalledExactlyOnceWith(
        { host: "127.0.0.1", port: 43190 },
        { sessionId: ids[1], active: false, worktreePath: "/repo" },
        { token: "test-token" },
      );
    });
  }
});
