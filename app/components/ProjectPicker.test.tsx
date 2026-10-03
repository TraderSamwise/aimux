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
import {
  PROJECT_LIST_LOADING,
  projectListFailed,
  projectListUnavailable,
  type ProjectListStatus,
} from "@/lib/project-list-status";

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

function renderPickerText(
  projects: DaemonProject[],
  showAllProjects: boolean,
  status?: ProjectListStatus,
): string {
  return collectText(
    ProjectPicker({
      projects,
      status,
      selectedRef: null,
      showAllProjects,
      onShowAllProjectsChange: vi.fn(),
      onSelect: vi.fn(),
    }),
  );
}

describe("ProjectPicker", () => {
  it("hides projects with no dashboard under Active and shows them under All", () => {
    const projects = [
      project({ id: "aimux", name: "aimux", dashboardAlive: true, onlineAgentCount: undefined }),
      project({ id: "glyde", name: "glyde", dashboardAlive: true, onlineAgentCount: undefined }),
      project({
        id: "scratch-live",
        name: "scratch-live",
        dashboardAlive: true,
        onlineAgentCount: undefined,
      }),
      project({
        id: "glyde-backend",
        name: "glyde-backend",
        dashboardAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "glyde-frontend",
        name: "glyde-frontend",
        dashboardAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "premys",
        name: "premys",
        dashboardAlive: false,
        serviceEndpoint: null,
        onlineAgentCount: undefined,
      }),
      project({
        id: "serenity",
        name: "serenity",
        dashboardAlive: false,
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
          project({ id: "active", name: "active", dashboardAlive: true }),
          project({ id: "offline", name: "offline", dashboardAlive: false, serviceEndpoint: null }),
        ],
        selectedRef: null,
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
          project({ id: "active", name: "active", dashboardAlive: true }),
          project({ id: "offline", name: "offline", dashboardAlive: false, serviceEndpoint: null }),
        ],
        selectedRef: null,
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

describe("an empty picker says why it is empty", () => {
  // Sam had five dashboards running and the GUI said "No projects detected".
  // The list was empty because the fetch never landed, and nothing on screen
  // said so.
  it("does not claim there are no projects when the daemon is unreachable", () => {
    const text = renderPickerText([], false, projectListUnavailable("Relay is connecting."));
    expect(text).toContain("Cannot reach the daemon");
    expect(text).toContain("Relay is connecting.");
    expect(text).not.toContain("No projects detected");
  });

  it("shows the error when the request failed", () => {
    const text = renderPickerText([], false, projectListFailed("HTTP 502 from /projects"));
    expect(text).toContain("Could not load projects");
    expect(text).toContain("HTTP 502 from /projects");
    expect(text).not.toContain("No projects detected");
  });

  it("distinguishes a list that has not loaded yet", () => {
    expect(renderPickerText([], false, PROJECT_LIST_LOADING)).toContain("Loading projects");
  });

  it("still says no projects when the daemon genuinely reported none", () => {
    expect(renderPickerText([], false)).toContain("No projects detected");
  });
});

describe("a list that is on screen but not refreshing is marked stale", () => {
  const projects = [project({ id: "aimux", name: "aimux", dashboardAlive: true })];

  it("warns when the refresh is failing", () => {
    const text = renderPickerText(projects, false, projectListFailed("socket hang up"));
    expect(text).toContain("Not refreshing: socket hang up");
    expect(text).toContain("aimux");
  });

  it("stays quiet when the list is current", () => {
    expect(renderPickerText(projects, false)).not.toContain("Not refreshing");
  });
});

describe("ProjectPicker machine sections", () => {
  function machineProject(name: string, machineId: string, machineName: string) {
    return project({ id: name, name, dashboardAlive: true, machineId, machineName });
  }

  // Every machine at once. A switcher would hide two thirds of the fleet.
  it("heads each machine's projects with that machine", () => {
    const text = collectText(
      ProjectPicker({
        projects: [
          machineProject("aimux", "mbp", "sam-mbp"),
          machineProject("tealstreet", "strix", "sam-strix"),
        ],
        machines: [
          { id: "mbp", name: "sam-mbp" },
          { id: "strix", name: "sam-strix" },
        ],
        selectedRef: null,
        showAllProjects: false,
        onShowAllProjectsChange: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    expect(text).toContain("sam-mbp");
    expect(text).toContain("sam-strix");
    expect(text).toContain("aimux");
    expect(text).toContain("tealstreet");
  });

  // Going away is information, not absence.
  it("says a machine is offline and still shows what it had", () => {
    const text = collectText(
      ProjectPicker({
        projects: [
          machineProject("aimux", "mbp", "sam-mbp"),
          machineProject("tealstreet", "strix", "sam-strix"),
        ],
        machines: [{ id: "mbp", name: "sam-mbp" }],
        selectedRef: null,
        showAllProjects: false,
        onShowAllProjectsChange: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    expect(text).toContain("sam-strix");
    expect(text).toContain("offline");
    expect(text).toContain("tealstreet");
  });

  // Local mode and a shared surface have one host to mean; a header there is
  // chrome around a list of one thing.
  it("renders no machine header when nothing is machine-scoped", () => {
    const text = collectText(
      ProjectPicker({
        projects: [project({ id: "aimux", name: "aimux", dashboardAlive: true })],
        machines: [],
        selectedRef: null,
        showAllProjects: false,
        onShowAllProjectsChange: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    expect(text).toContain("aimux");
    expect(text).not.toContain("this machine");
    expect(text).not.toContain("offline");
  });

  it("selects the row's own machine, not the other host's copy of the path", () => {
    const onSelect = vi.fn();
    const tree = renderNode(
      ProjectPicker({
        projects: [
          machineProject("aimux", "mbp", "sam-mbp"),
          machineProject("aimux", "strix", "sam-strix"),
        ],
        machines: [
          { id: "mbp", name: "sam-mbp" },
          { id: "strix", name: "sam-strix" },
        ],
        selectedRef: null,
        showAllProjects: false,
        onShowAllProjectsChange: vi.fn(),
        onSelect,
      }),
    );
    const rows = findNodes(tree, (node) => node.type === "Pressable").filter((node) =>
      collectText(node.props.children as ReactNode).includes("aimux"),
    );
    expect(rows).toHaveLength(2);
    rows.forEach((row) => (row.props as { onPress?: () => void }).onPress?.());
    expect(onSelect.mock.calls.map(([ref]) => ref.machineId).sort()).toEqual(["mbp", "strix"]);
  });
});
