import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  return {
    Pressable: "div",
    ScrollView: "div",
    Text: "span",
    View: "div",
  };
});

vi.mock("lucide-react-native", () => ({
  GitBranch: "span",
}));

vi.mock("expo-router", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/agent-create-panel", () => ({
  AgentCreatePanel: () => null,
}));

vi.mock("@/components/agent-actions", () => ({
  AgentActions: () => null,
}));

vi.mock("@/components/PageLayout", () => ({
  PageStateCard: () => null,
}));

vi.mock("@/components/service-actions", () => ({
  ServiceActions: () => null,
}));

vi.mock("@/components/worktree-management-panel", () => ({
  WorktreeManagementPanel: () => null,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ getToken: vi.fn() }),
}));

vi.mock("@/lib/blur-web-active-element", () => ({
  blurWebActiveElement: vi.fn(),
}));

vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({ projectPath: "/repo", endpoint: null }),
}));

vi.mock("@/stores/desktopState", () => ({
  desktopStateErrorFamily: () => ({}),
  desktopStateFamily: () => ({}),
  worktreeGroupsFamily: () => ({}),
}));

vi.mock("@/stores/projects", () => ({
  selectedSessionIdAtom: {},
}));

import type { DesktopSession } from "@/lib/desktop-state";
import { AgentRow } from "@/components/WorktreeDashboard";

function session(input: Partial<DesktopSession> & Pick<DesktopSession, "id">): DesktopSession {
  return {
    status: "running",
    ...input,
  };
}

function renderAgentRow(input: DesktopSession): string {
  return collectText(
    <AgentRow
      session={input}
      digit={1}
      selected={false}
      projectPath="/repo"
      endpoint={null}
      token={null}
      onPress={vi.fn()}
      onKilled={vi.fn()}
    />,
  );
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    if (typeof node.type === "function") {
      const Component = node.type as (componentProps: typeof props) => ReactNode;
      return collectText(Component(props));
    }
    return collectText(props.children);
  }
  return "";
}

describe("WorktreeList agent rows", () => {
  it("does not render non-coder roles as GUI badges", () => {
    const html = renderAgentRow(
      session({
        id: "claude-overseer",
        label: "boss",
        command: "claude",
        role: "overseer",
      }),
    );

    expect(html).toContain("boss");
    expect(html).toContain("Running");
    expect(html).not.toContain("overseer");
  });
});
