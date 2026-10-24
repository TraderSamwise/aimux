import React, { type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../../src/project-api-contract";
import type { DesktopState } from "@/lib/desktop-state";
import type { Atom } from "jotai";

const harness = vi.hoisted(() => ({
  store: null as ReturnType<typeof import("jotai").createStore> | null,
  root: "/usage-surface",
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
    useEffect: () => {},
    useRef: (current: unknown) => ({ current }),
    useMemo: (compute: () => unknown) => compute(),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("jotai", async (original) => {
  const jotai = await original<typeof import("jotai")>();
  return {
    ...jotai,
    useAtomValue: <Value>(atom: Atom<Value>) => harness.store!.get(atom),
    useSetAtom: () => vi.fn(),
  };
});

vi.mock("react-native", () => ({
  View: "View",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  Platform: { OS: "web" },
}));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("expo-router", () => ({
  usePathname: () => "/project",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/SubagentBadge", () => ({ SubagentBadge: "SubagentBadge" }));
vi.mock("@/components/agent-create-panel", () => ({ AgentCreatePanel: "AgentCreatePanel" }));
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
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/blur-web-active-element", () => ({ blurWebActiveElement: vi.fn() }));
vi.mock("@/lib/recency-clock", () => ({ useRecencyClock: () => 0 }));
vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({
    projectPath: harness.root,
    projectRef: { path: harness.root },
    endpoint: { host: "127.0.0.1", port: 43191 },
  }),
}));
vi.mock("@/stores/projects", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    selectedSessionIdAtom: atom(null),
    lastAgentByProjectAtom: atom({}),
    // Read: this harness renders the dashboard, which waits for the stored
    // memory before spending the launch's one reopen.
    lastAgentHydratedAtom: atom(true),
  };
});

import { UsageMonitor } from "@/components/UsageMonitor";
import { WorktreeDashboard } from "@/components/WorktreeDashboard";
import { applyDesktopStateSuccessAtom } from "@/stores/desktopState";
import { projectStateKey } from "@/lib/project-key";
import { createStore } from "jotai";

function textRows(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(textRows);
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (!React.isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (typeof node.type === "function") {
    return textRows((node.type as (componentProps: typeof props) => ReactNode)(props));
  }
  return textRows(props.children);
}

function appLines(usage?: UsageSnapshot): string[] {
  const rows = textRows(React.createElement(UsageMonitor, { usage }));
  return rows.filter((_, index) => index > 0);
}

function dashboardLines(desktop: DesktopState): string[] {
  harness.root = desktop.mainCheckoutPath ?? "/usage-surface";
  harness.store = createStore();
  harness.store.set(applyDesktopStateSuccessAtom, {
    projectStateKey: projectStateKey({ path: harness.root }),
    state: desktop,
  });
  const lines: string[] = [];
  function visit(node: ReactNode): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!React.isValidElement(node)) return;
    const props = node.props as { children?: ReactNode; usage?: UsageSnapshot } & Record<
      string,
      unknown
    >;
    if (node.type === UsageMonitor) {
      lines.push(...appLines(props.usage));
      return;
    }
    const component =
      typeof node.type === "function" ? node.type : (node.type as { type?: unknown }).type;
    if (typeof component === "function")
      visit((component as (componentProps: typeof props) => ReactNode)(props));
    else visit(props.children);
  }
  visit(React.createElement(WorktreeDashboard));
  return lines;
}

it("renders every service line in order, retaining tool labels, unknowns, errors, and extra windows", () => {
  const displayLines = [
    "Claude: 5h: 0% used",
    "Claude: Weekly: unknown: runtime did not report usage",
    "Codex: tokens: 117 billed-equivalent tokens since monitoring began",
    "Codex: monthly: error: open quota cache: permission denied",
    "Aider: tokens: unknown: runtime does not report usage",
  ];
  const usage: UsageSnapshot = {
    state: "error",
    observedAt: 1_000,
    startedAt: 500,
    collectionIntervalMs: 300_000,
    tools: [],
    displayLines,
    reason: "open quota cache: permission denied",
  };
  expect(appLines(usage)).toEqual(displayLines);
  expect(dashboardLines({ ok: true, sessions: [], services: [], worktrees: [], usage })).toEqual(
    displayLines,
  );
  expect(appLines()).toEqual([]);
});

const probePath = process.env.AIMUX_USAGE_SURFACE_PROBE;
const probe = probePath
  ? (JSON.parse(readFileSync(probePath, "utf8")) as {
      cases: {
        usage: UsageSnapshot;
        desktop: DesktopState;
        tuiLines: string[];
        cliLines: string[];
      }[];
    })
  : null;

describe.skipIf(!probe)(
  "usage compared directly against service, CLI, and running TUI rendering",
  () => {
    it("renders exactly the same provider-labelled lines from each service outcome", () => {
      if (!probe) throw new Error("native service and TUI observations are required");
      expect(probe.cases.length).toBeGreaterThanOrEqual(3);
      for (const entry of probe.cases) {
        expect(appLines(entry.usage)).toEqual(entry.usage.displayLines);
        expect(appLines(entry.usage)).toEqual(entry.tuiLines);
        expect(appLines(entry.usage)).toEqual(entry.cliLines);
        expect(dashboardLines(entry.desktop)).toEqual(entry.cliLines);
      }
    });
  },
);
