import React, { type ReactNode } from "react";
import { projectStateKey } from "@/lib/project-key";
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
  AgentActions: (props: { mainCheckoutPath?: string | null }) =>
    React.createElement("AgentActions", { mainCheckoutPath: props.mainCheckoutPath ?? null }),
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
  useRouteProject: () => ({ projectStateKey: projectStateKey({ path: "/repo" }) }),
}));

vi.mock("@/stores/desktopState", () => ({
  desktopStateErrorFamily: vi.fn(),
  desktopStateFamily: vi.fn(),
  worktreeGroupsFamily: vi.fn(),
}));

vi.mock("@/stores/projects", () => ({
  selectedSessionIdAtom: {},
}));

import type { DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { AgentRow, WorktreeCard } from "@/components/WorktreeDashboard";

const IPHONE_PRO_MAX_LOGICAL_WIDTH = 430;

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: HostNode[];
}

type FunctionComponentNode = (props: unknown) => ReactNode;

// React.memo wraps a component in an object, so an element's `type` is no longer
// callable. Unwrap it, or a memoised component renders as nothing here while
// rendering fine in the app.
function componentOf(type: unknown): FunctionComponentNode | null {
  if (typeof type === "function") return type as FunctionComponentNode;
  const memo = type as { $$typeof?: symbol; type?: unknown } | null;
  if (memo && memo.$$typeof === Symbol.for("react.memo")) return componentOf(memo.type);
  return null;
}

function renderNode(node: ReactNode): HostNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(renderNode);
  if (!React.isValidElement(node)) return [];

  if (node.type === React.Fragment) {
    return renderNode((node.props as { children?: ReactNode }).children);
  }

  const component = componentOf(node.type);
  if (component) {
    return renderNode(component(node.props));
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

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (!React.isValidElement(node)) return "";

  if (node.type === React.Fragment) {
    return collectText((node.props as { children?: ReactNode }).children);
  }

  const memoised = componentOf(node.type);
  if (memoised) {
    return collectText(memoised(node.props));
  }

  if (typeof node.type === "function") {
    return collectText((node.type as FunctionComponentNode)(node.props));
  }

  return collectText((node.props as { children?: ReactNode }).children);
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

function session(input: Partial<DesktopSession> & Pick<DesktopSession, "id">): DesktopSession {
  return {
    status: "running",
    // The project service attaches `semantic` to every session, and the row now
    // reads its status word from there rather than recomputing one from
    // `status`. A fixture without it is not a session the app can receive, and
    // the row says "Unknown" for it on purpose.
    semantic: { user: { label: "ready" }, presentation: { statusLabel: "ready" } },
    ...input,
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
        projectStateKey: projectStateKey({ path: "/repo" }),
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

  it("renders project-control sessions in a supervisor lane card", () => {
    const text = collectText(
      React.createElement(WorktreeCard, {
        bucket: {
          key: "__supervisor_lane__",
          name: "Supervisor Lane",
          branch: "",
          path: null,
          isMainCheckout: false,
          isSupervisorLane: true,
          sessions: [
            session({
              id: "boss",
              label: "control",
              role: "overseer",
              overseer: true,
              projectControl: true,
            }),
            session({
              id: "scribe",
              label: "notes",
              role: "scribe",
              scribe: true,
              projectControl: true,
            }),
          ],
          services: [],
        },
        identityTone: "#d787d7",
        compact: false,
        selectedSessionId: null,
        onPickSession: vi.fn(),
        onPickService: vi.fn(),
        onKillSession: vi.fn(),
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
      }),
    );

    expect(text).toContain("Supervisor Lane");
    expect(text).toContain("control");
    expect(text).toContain("notes");
    expect(text).toContain("overseer");
    expect(text).toContain("scribe");
  });
});

// A supervisor-lane agent can only be moved back out of the plane if the row
// knows the project root. Rows used to be handed
// `bucket.isMainCheckout ? session.worktreePath : undefined`, which is never a
// main checkout path for the supervisor lane, so joining was a one-way trip
// from the dashboard while the chat header offered to undo it.
describe("supervisor lane plane action", () => {
  it("hands the agent row the project root, not a per-session stand-in", () => {
    const tree = renderNode(
      React.createElement(WorktreeCard, {
        bucket: {
          key: "__supervisor_lane__",
          name: "Supervisor Lane",
          branch: "",
          path: null,
          isMainCheckout: false,
          isSupervisorLane: true,
          sessions: [session({ id: "boss", label: "control" })],
          services: [],
        },
        identityTone: "#d787d7",
        mainCheckoutPath: "/repo",
        compact: false,
        selectedSessionId: null,
        onPickSession: vi.fn(),
        onPickService: vi.fn(),
        onKillSession: vi.fn(),
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
      }),
    );

    const actions = findNodes(tree, (node) => node.type === "AgentActions");
    expect(actions).not.toHaveLength(0);
    for (const node of actions) {
      expect(node.props.mainCheckoutPath).toBe("/repo");
    }
  });
});

// Sam runs the GUI at ~432px, where the card held a 600px floor and scrolled
// sideways rather than letting the row restack -- and the first two attempts at
// this were guesses, so his ruling is pinned rather than inferred: a two-line
// row below 600px, the name on its own line, then time, status and actions.
// Above it, nothing changes.
describe("a narrow window restacks the row instead of scrolling the card", () => {
  function cardAt(width: number) {
    return renderNode(
      React.createElement(WorktreeCard, {
        bucket: mainCheckoutBucket(),
        identityTone: "#78dce8",
        compact: false,
        contentWidth: width,
        selectedSessionId: null,
        onPickSession: vi.fn(),
        onPickService: vi.fn(),
        onKillSession: vi.fn(),
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
      }),
    );
  }

  function sizedViews(tree: HostNode[]) {
    return findNodes(tree, (node) => {
      if (node.type !== "View") return false;
      const style = node.props.style as { width?: unknown; minWidth?: unknown } | null;
      return (
        typeof style === "object" &&
        style !== null &&
        (typeof style.width === "number" || typeof style.minWidth === "number")
      );
    });
  }

  // The floor is the bug, not a safety net: holding 600px at 432px is exactly
  // what produced the sideways scroll instead of a restack.
  it("does not hold a 600px floor at the width he actually uses", () => {
    const sized = sizedViews(cardAt(432));
    expect(sized).toHaveLength(1);
    const style = sized[0]!.props.style as { width?: number; minWidth?: number };
    expect(style.width).toBe(432);
    expect(style.minWidth).toBeUndefined();
  });

  it("keeps the floor once a single-line row fits", () => {
    const style = sizedViews(cardAt(900))[0]!.props.style as { width?: number };
    expect(style.width).toBe(900);
  });

  // Measured as "is the row a column", because that is the whole shape: a
  // flex-row with the name capped at 55% is the layout that crushed it to "c.".
  function rowAt(narrow: boolean) {
    return renderNode(
      React.createElement(AgentRow, {
        session: session({ id: "claude-a-long-agent-name", label: "a-long-agent-name" }),
        digit: 1,
        selected: false,
        narrow,
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
        onPick: vi.fn(),
        onKilled: vi.fn(),
      }),
    );
  }

  function classNames(tree: HostNode[]) {
    return findNodes(tree, (node) => typeof node.props.className === "string").map(
      (node) => node.props.className as string,
    );
  }

  // Measured as "is the row a column", because that is the whole shape.
  it("stacks the row into two lines when the card says the window is narrow", () => {
    const outer = classNames(rowAt(true)).find((name) => name.includes("rounded-md px-2.5 py-2"));
    expect(outer).toContain("flex-col items-stretch");
  });

  it("leaves the row on one line otherwise", () => {
    const names = classNames(rowAt(false));
    expect(names.some((name) => name.includes("flex-col items-stretch"))).toBe(false);
    // The OUTER row, found by the class only it carries. Matching
    // "flex-row items-center" alone also matched the trailing group's own
    // className, so it passed whichever direction the row had.
    expect(names.some((name) => name.includes("rounded-md px-2.5 py-2"))).toBe(true);
    const outer = names.find((name) => name.includes("rounded-md px-2.5 py-2"));
    expect(outer).toContain("flex-row items-center");
  });

  // The name is the thing the restack exists to protect: capped at 55% of a
  // line it also had to share, it shrank to "c." at 432px.
  it("stops capping the name at 55% once it has its own line", () => {
    expect(classNames(rowAt(true)).some((name) => name.includes("max-w-[55%]"))).toBe(false);
    expect(classNames(rowAt(false)).some((name) => name.includes("max-w-[55%]"))).toBe(true);
  });

  // The left pad only exists to hold the trailing group off a name sharing its
  // line. On its own line it would be a 12px indent for nothing.
  it("drops the left pad from the trailing group once it has its own line", () => {
    expect(classNames(rowAt(true)).some((name) => name.includes("shrink-0 pl-3"))).toBe(false);
    expect(classNames(rowAt(false)).some((name) => name.includes("shrink-0 pl-3"))).toBe(true);
  });
});

describe("AgentRow", () => {
  it("does not render non-coder roles as GUI badges", () => {
    const text = collectText(
      React.createElement(AgentRow, {
        session: session({
          id: "claude-overseer",
          label: "boss",
          command: "claude",
          role: "overseer",
        }),
        digit: 1,
        selected: false,
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
        onPick: vi.fn(),
        onKilled: vi.fn(),
      }),
    );

    expect(text).toContain("boss");
    // The service's word, not one this row derived. It used to say "Running"
    // here off `status` alone, for an agent the service calls `ready`.
    expect(text).toContain("Ready");
    expect(text).not.toContain("overseer");
  });

  it("renders the role column only inside the supervisor lane", () => {
    const text = collectText(
      React.createElement(AgentRow, {
        session: session({
          id: "claude-overseer",
          label: "boss",
          command: "claude",
          role: "overseer",
          overseer: true,
        }),
        digit: 1,
        selected: false,
        supervisorLane: true,
        projectStateKey: projectStateKey({ path: "/repo" }),
        endpoint: null,
        token: null,
        onPick: vi.fn(),
        onKilled: vi.fn(),
      }),
    );

    expect(text).toContain("boss");
    expect(text).toContain("overseer");
  });
});
