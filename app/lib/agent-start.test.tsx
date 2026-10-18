import React, { type ReactNode } from "react";
import { createStore, type Atom, type WritableAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

let store: ReturnType<typeof createStore>;

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: <Value,>(target: Atom<Value>) => store.get(target),
  useSetAtom:
    <Value, Args extends unknown[], Result>(target: WritableAtom<Value, Args, Result>) =>
    (...args: Args) =>
      store.set(target, ...args),
}));
vi.mock("react-native", () => ({ View: "View", ActivityIndicator: "ActivityIndicator" }));
vi.mock("lucide-react-native", () => ({
  GitFork: "GitFork",
  Layers: "Layers",
  LogOut: "LogOut",
  Play: "Play",
  Radar: "Radar",
  ShieldOff: "ShieldOff",
  Square: "Square",
  Trash2: "Trash2",
}));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/lib/api", () => ({
  forkAgent: vi.fn(),
  killAgent: vi.fn(),
  resumeAgent: vi.fn(),
  setAgentOverseer: vi.fn(),
  setAgentPlane: vi.fn(),
  stopAgent: vi.fn(),
}));

import { AgentActions } from "@/components/agent-actions";
import { resumeAgent } from "@/lib/api";
import type { DesktopSession, DesktopState } from "@/lib/desktop-state";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { projectStateKey } from "@/lib/project-key";
import { agentActionsFamily } from "@/stores/agentActions";
import {
  applyDesktopStateSuccessAtom,
  desktopStateFamily,
  desktopStateRefreshNonceAtom,
} from "@/stores/desktopState";
import { projectLifecycleTransitionsFamily } from "@/stores/lifecycleTransitions";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import type { ResumeAgentResponse } from "../../src/project-api-contract";

const project = projectStateKey({ machineId: "host-a", path: "/repo" });
const endpoint: ServiceEndpoint = { host: "127.0.0.1", port: 43191 };
const offline: DesktopSession = {
  id: "agent-1",
  label: "Test agent",
  status: "offline",
  restoreState: "ready",
};

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  text: string;
  children: HostNode[];
}

// Node-only inspection of callback/returned props, matching existing row tests.
// It does not mount React Native or simulate native event dispatch.
function hosts(node: ReactNode): HostNode[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(hosts);
  if (typeof node === "string" || typeof node === "number") {
    return [{ type: "text", props: {}, text: String(node), children: [] }];
  }
  if (!React.isValidElement(node)) return [];
  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  if (node.type === React.Fragment) return hosts(props.children);
  if (typeof node.type === "function") {
    return hosts((node.type as (props: unknown) => ReactNode)(props));
  }
  const children = hosts(props.children);
  return [{ type: node.type, props, children, text: children.map((child) => child.text).join("") }];
}

function flatten(nodes: HostNode[]): HostNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function inventory(session: DesktopSession): DesktopState {
  return {
    ok: true,
    sessions: [session],
    services: [],
    worktrees: [],
    worktreeGroups: [
      {
        name: "main",
        path: "/repo",
        branch: "master",
        status: "active",
        sessions: [session],
        services: [],
      },
    ],
  };
}

function row(endpointOverride: ServiceEndpoint | null = endpoint): HostNode[] {
  const session = store.get(desktopStateFamily(project))!.sessions[0];
  return flatten(
    hosts(
      AgentActions({
        session,
        endpoint: endpointOverride,
        token: "token",
        projectStateKey: project,
        compact: true,
      }),
    ),
  );
}

function button(label: string): HostNode {
  const found = row().find(
    (node) => node.type === "Button" && node.props.accessibilityLabel === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

function press(node = button("Resume Test agent")): Promise<void> {
  return (node.props.onPress as () => Promise<void>)();
}

function pendingStart() {
  let resolve!: (response: ResumeAgentResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ResumeAgentResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.mocked(resumeAgent).mockReturnValue(promise);
  return { resolve, reject };
}

beforeEach(() => {
  store = createStore();
  vi.clearAllMocks();
  store.set(applyDesktopStateSuccessAtom, { projectStateKey: project, state: inventory(offline) });
});

describe("GUI row Start", () => {
  it("a plain tap starts the selected agent and success refreshes the running row", async () => {
    vi.mocked(resumeAgent).mockResolvedValue({ ok: true, sessionId: "agent-1", status: "running" });
    await press();
    expect(resumeAgent).toHaveBeenCalledExactlyOnceWith(endpoint, "agent-1", { token: "token" });
    expect(store.get(desktopStateRefreshNonceAtom)).toBeGreaterThan(0);
    expect(store.get(projectApiViewRefreshNonceFamily("agents"))).toBeGreaterThan(0);
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: project,
      state: inventory({ ...offline, status: "running" }),
    });
    expect(store.get(projectLifecycleTransitionsFamily(project))).toEqual([]);
    expect(store.get(desktopStateFamily(project))?.worktreeGroups?.[0].sessions[0]).toMatchObject({
      status: "running",
    });
    expect(button("Stop Test agent").props.disabled).toBe(false);
    expect(row().some((node) => node.type === "ActivityIndicator")).toBe(false);
  });

  it("shows loading on press before a response, even after the optimistic row becomes running", async () => {
    const pending = pendingStart();
    const operation = press();
    const starting = button("Starting Test agent");
    expect(starting.props.disabled).toBe(true);
    expect(starting.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(starting.children.some((node) => node.type === "ActivityIndicator")).toBe(true);
    expect(store.get(desktopStateFamily(project))?.sessions[0]).toMatchObject({
      status: "running",
      pendingAction: "starting",
    });
    expect(
      store.get(desktopStateFamily(project))?.worktreeGroups?.[0].sessions[0].pendingAction,
    ).toBe("starting");
    pending.resolve({ ok: true, sessionId: "agent-1", status: "running" });
    await operation;
  });

  it("double tapping before rerender and tapping the remounted control issue one start", async () => {
    const pending = pendingStart();
    const start = button("Resume Test agent");
    const first = press(start);
    const second = press(start);
    const third = press(button("Starting Test agent"));
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, sessionId: "agent-1", status: "running" });
    await Promise.all([first, second, third]);
  });

  it.each([
    new Error("Network request failed: failed to fetch"),
    new Error("Relay not connected"),
    Object.assign(new Error("Request was cancelled"), { kind: "cancelled" }),
    new Error("Request timed out after 120000ms — may still be running, check first"),
    new Error("Cannot start agent-1; not enough memory"),
  ])("shows the failed start reason and restores the offline row: $message", async (error) => {
    vi.mocked(resumeAgent).mockRejectedValue(error);
    await press();
    expect(row().find((node) => node.props.accessibilityRole === "alert")?.text).toBe(
      error.message,
    );
    expect(row(null).find((node) => node.props.accessibilityRole === "alert")?.text).toBe(
      error.message,
    );
    expect(store.get(projectLifecycleTransitionsFamily(project))).toEqual([]);
    expect(store.get(desktopStateFamily(project))?.sessions[0]).toMatchObject({
      status: "offline",
    });
    expect(button("Resume Test agent").props.disabled).toBe(false);
    expect(
      store.get(agentActionsFamily({ projectStateKey: project, sessionId: "agent-1" })).busyAction,
    ).toBeNull();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("renders the server's blocked reason and offers no start handler", () => {
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: project,
      state: inventory({
        ...offline,
        restoreState: "blocked",
        restoreBlockedReason: "missing exact resumable backend session id",
      }),
    });
    const blocked = button(
      "Resume unavailable for Test agent: missing exact resumable backend session id",
    );
    expect(blocked.props.disabled).toBe(true);
    expect(resumeAgent).not.toHaveBeenCalled();
  });
});
