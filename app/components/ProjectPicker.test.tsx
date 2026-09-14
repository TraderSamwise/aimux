import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  View: "View",
}));

vi.mock("@/components/ui/text", () => ({
  Text: "Text",
}));

import type { DaemonProject } from "@/lib/api";
import { ProjectPicker } from "@/components/ProjectPicker";

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: HostNode[];
}

type FunctionComponentNode = (props: unknown) => ReactNode;

function project(
  input: Partial<DaemonProject> & Pick<DaemonProject, "id" | "name">,
): DaemonProject {
  return {
    dashboardSessionName: `aimux-${input.id}`,
    path: `/repo/${input.id}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
    ...input,
  };
}

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

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("\n");
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function collectHostText(nodes: HostNode[]): string {
  return nodes
    .map(
      (node) =>
        `${collectText(node.props.children as ReactNode)}\n${collectHostText(node.children)}`,
    )
    .join("\n");
}

function findNodes(root: HostNode[], predicate: (node: HostNode) => boolean): HostNode[] {
  const matches: HostNode[] = [];
  for (const node of root) {
    if (predicate(node)) matches.push(node);
    matches.push(...findNodes(node.children, predicate));
  }
  return matches;
}

function renderPickerText(projects: DaemonProject[], showAllProjects: boolean): string {
  return collectText(
    ProjectPicker({
      projects,
      selectedPath: null,
      showAllProjects,
      onShowAllProjectsChange: vi.fn(),
      onSelect: vi.fn(),
    }),
  );
}

describe("ProjectPicker", () => {
  it("hides dead-service projects with unknown agent counts under Active and shows them under All", () => {
    const projects = [
      project({ id: "aimux", name: "aimux", serviceAlive: true, onlineAgentCount: undefined }),
      project({ id: "glyde", name: "glyde", serviceAlive: true, onlineAgentCount: undefined }),
      project({
        id: "scratch-live",
        name: "scratch-live",
        serviceAlive: true,
        onlineAgentCount: undefined,
      }),
      project({
        id: "glyde-backend",
        name: "glyde-backend",
        serviceAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "glyde-frontend",
        name: "glyde-frontend",
        serviceAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "premys",
        name: "premys",
        serviceAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "serenity",
        name: "serenity",
        serviceAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
    ];

    const activeText = renderPickerText(projects, false);

    expect(activeText).toContain("aimux");
    expect(activeText).toContain("glyde");
    expect(activeText).toContain("scratch-live");
    expect(activeText).not.toContain("glyde-backend");
    expect(activeText).not.toContain("glyde-frontend");
    expect(activeText).not.toContain("premys");
    expect(activeText).not.toContain("serenity");

    const allText = renderPickerText(projects, true);

    expect(allText).toContain("aimux");
    expect(allText).toContain("glyde");
    expect(allText).toContain("scratch-live");
    expect(allText).toContain("glyde-backend");
    expect(allText).toContain("glyde-frontend");
    expect(allText).toContain("premys");
    expect(allText).toContain("serenity");
  });

  it("renders native filter controls that dispatch active/all state changes", () => {
    const onShowAllProjectsChange = vi.fn();
    const tree = renderNode(
      ProjectPicker({
        projects: [
          project({ id: "active", name: "active", serviceAlive: true }),
          project({ id: "offline", name: "offline", serviceAlive: false, serviceEndpoint: null }),
        ],
        selectedPath: null,
        showAllProjects: false,
        onShowAllProjectsChange,
        onSelect: vi.fn(),
      }),
    );

    const pressables = findNodes(tree, (node) => node.type === "Pressable");
    const allControl = pressables.find((node) =>
      collectText(node.props.children as ReactNode).includes("All"),
    );
    const activeControl = pressables.find((node) =>
      collectText(node.props.children as ReactNode).includes("Active"),
    );

    expect(allControl).toBeDefined();
    expect(activeControl).toBeDefined();

    (allControl!.props.onPress as () => void)();
    (activeControl!.props.onPress as () => void)();

    expect(onShowAllProjectsChange).toHaveBeenNthCalledWith(1, true);
    expect(onShowAllProjectsChange).toHaveBeenNthCalledWith(2, false);
  });

  it("renders the filtered project result rather than the unfiltered source", () => {
    const tree = renderNode(
      ProjectPicker({
        projects: [
          project({ id: "active", name: "active", serviceAlive: true }),
          project({ id: "offline", name: "offline", serviceAlive: false, serviceEndpoint: null }),
        ],
        selectedPath: null,
        showAllProjects: false,
        onShowAllProjectsChange: vi.fn(),
        onSelect: vi.fn(),
      }),
    );

    const text = collectHostText(tree);
    expect(text).toContain("active");
    expect(text).not.toContain("offline");
  });
});
