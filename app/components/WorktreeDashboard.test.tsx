import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));

vi.mock("expo-router", () => ({
  usePathname: () => "/project",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("jotai", () => ({
  useAtomValue: vi.fn(),
  useSetAtom: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/agent-actions", () => ({
  AgentActions: () => React.createElement("AgentActions"),
}));

vi.mock("@/components/agent-create-panel", () => ({
  AgentCreatePanel: () => React.createElement("AgentCreatePanel"),
}));

vi.mock("@/components/PageLayout", () => ({
  PageStateCard: () => React.createElement("PageStateCard"),
}));

vi.mock("@/components/service-actions", () => ({
  ServiceActions: () => React.createElement("ServiceActions"),
}));

vi.mock("@/components/status-dot", () => ({
  StatusDotMini: () => React.createElement("StatusDotMini"),
}));

vi.mock("@/components/ui/text", () => ({
  Text: "Text",
}));

vi.mock("@/components/worktree-management-panel", () => ({
  WorktreeManagementPanel: () => React.createElement("WorktreeManagementPanel"),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ token: null }),
}));

vi.mock("@/lib/blur-web-active-element", () => ({
  blurWebActiveElement: vi.fn(),
}));

vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({ projectPath: "/repo" }),
}));

vi.mock("@/stores/desktopState", () => ({
  desktopStateErrorFamily: vi.fn(),
  desktopStateFamily: vi.fn(),
  worktreeGroupsFamily: vi.fn(),
}));

vi.mock("@/stores/projects", () => ({
  selectedSessionIdAtom: {},
}));

import type { WorktreeBucket } from "@/lib/desktop-state";
import { WorktreeCard } from "@/components/WorktreeDashboard";

const IPHONE_PRO_MAX_LOGICAL_WIDTH = 430;

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: HostNode[];
}

type FunctionComponentNode = (props: unknown) => ReactNode;

function renderNode(node: ReactNode): HostNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(renderNode);
  if (!React.isValidElement(node)) return [];

  if (node.type === React.Fragment) {
    return renderNode((node.props as { children?: ReactNode }).children);
  }

  if (typeof node.type === "function") {
    return renderNode((node.type as FunctionComponentNode)(node.props));
  }

  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  return [
    {
      type: node.type,
      props,
      children: renderNode(props.children),
    },
  ];
}

function findNodes(root: HostNode[], predicate: (node: HostNode) => boolean): HostNode[] {
  const matches: HostNode[] = [];
  for (const node of root) {
    if (predicate(node)) matches.push(node);
    matches.push(...findNodes(node.children, predicate));
  }
  return matches;
}

function mainCheckoutBucket(): WorktreeBucket {
  return {
    key: "__main_checkout__",
    name: "aimux",
    branch: "master",
    path: null,
    isMainCheckout: true,
    sessions: [],
    services: [],
  };
}

describe("WorktreeCard", () => {
  it("renders non-compact worktree cards wider than an iPhone Pro Max viewport", () => {
    const tree = renderNode(
      React.createElement(WorktreeCard, {
        bucket: mainCheckoutBucket(),
        identityTone: "#78dce8",
        compact: false,
        selectedSessionId: null,
        onPickSession: vi.fn(),
        onPickService: vi.fn(),
        onKillSession: vi.fn(),
        projectPath: "/repo",
        endpoint: null,
        token: null,
      }),
    );

    const cardContentViews = findNodes(tree, (node) => {
      if (node.type !== "View") return false;
      const style = node.props.style;
      return (
        typeof style === "object" &&
        style !== null &&
        "minWidth" in style &&
        typeof (style as { minWidth?: unknown }).minWidth === "number"
      );
    });

    expect(cardContentViews).toHaveLength(1);
    expect((cardContentViews[0]!.props.style as { minWidth: number }).minWidth).toBeGreaterThan(
      IPHONE_PRO_MAX_LOGICAL_WIDTH,
    );
  });
});
