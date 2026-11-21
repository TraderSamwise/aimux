import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FleetUsageMachine, FleetUsageResponse } from "@/lib/api";
import type { UsageSnapshot } from "../../src/project-api-contract";

// The screen is rendered without a runtime: hooks are stubbed so one pass
// produces the tree, the same way usage-monitor.cross-surface.test.ts does it.
const harness = vi.hoisted(() => ({
  resource: null as unknown,
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
    useAtomValue: () => harness.resource,
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
vi.mock("@/components/ui/card", () => ({ Card: "Card" }));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ getFleetUsage: vi.fn() }));

import FleetScreen from "../app/(main)/fleet";

function textRows(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(textRows);
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (!React.isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (typeof node.type === "function") {
    return textRows((node.type as (p: typeof props) => ReactNode)(props));
  }
  const nested = Object.values(props).filter((value) => React.isValidElement(value));
  return [...textRows(props.children), ...nested.flatMap((value) => textRows(value as ReactNode))];
}

function screenRows(value: FleetUsageResponse | null, extra?: Record<string, unknown>): string[] {
  harness.resource = {
    value,
    error: null,
    pending: false,
    pendingRequestKey: null,
    stale: false,
    updatedAt: null,
    ...extra,
  };
  return textRows(React.createElement(FleetScreen));
}

const snapshot = (line: string): UsageSnapshot => ({
  state: "known",
  observedAt: 0,
  startedAt: 0,
  collectionIntervalMs: 60_000,
  tools: [],
  displayLines: [line],
  reason: null,
});

const answered = (machineId: string, line: string): FleetUsageMachine => ({
  machineId,
  ok: true,
  status: 200,
  usage: { ok: true, usage: snapshot(line) },
});

describe("the fleet screen", () => {
  // The reason the ordering was moved into the report. If this screen sorted
  // for itself it would pass its own test while disagreeing with
  // `aimux fleet usage`, which is the failure mode AGENTS.md names.
  it("lists machines in the order the report gave, without re-sorting", () => {
    const rows = screenRows({
      ok: true,
      asked: 3,
      machines: [
        { machineId: "strix", ok: false, error: "peer was never asked, so it did not answer" },
        answered("mbp", "Claude: 5h: 12% used"),
        answered("mini", "Claude: 5h: 3% used"),
      ],
    });

    const order = ["strix", "mbp", "mini"].map((id) => rows.indexOf(id));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  // Absent and empty are opposite claims, and the report distinguishes them
  // deliberately. A screen that renders both as "no machines" throws that away.
  it("says the fleet is unknown when there is no machine list, not that it is empty", () => {
    const rows = screenRows({
      ok: false,
      error: "the relay has not sent the owner table yet",
    });

    expect(rows.join("\n")).toContain("the relay has not sent the owner table yet");
    expect(rows.join("\n")).not.toContain("No other machines are online");
  });

  it("says the fleet is empty when the relay said there are none", () => {
    const rows = screenRows({ ok: true, asked: 0, machines: [] });

    expect(rows.join("\n")).toContain("No other machines are online");
    expect(rows.join("\n")).not.toContain("not known");
  });

  // A machine that never answered must still be named, with its reason -- the
  // whole point of keeping it in the report.
  it("names a machine that did not answer and shows why", () => {
    const rows = screenRows({
      ok: true,
      asked: 2,
      machines: [
        { machineId: "strix", ok: false, error: "peer was never asked, so it did not answer" },
        answered("mbp", "Claude: 5h: 12% used"),
      ],
    });

    const text = rows.join("\n");
    expect(text).toContain("strix");
    expect(text).toContain("peer was never asked");
    expect(text).toContain("no answer");
  });

  // A peer can answer 200 and still carry its own error. That is a third
  // outcome, and it is the peer's own words.
  it("shows a peer's own error rather than replacing it", () => {
    const rows = screenRows({
      ok: true,
      asked: 1,
      machines: [
        {
          machineId: "mini",
          ok: false,
          status: 502,
          usage: { ok: false, error: "project service usage collection failed" },
        },
      ],
    });

    const text = rows.join("\n");
    expect(text).toContain("project service usage collection failed");
    expect(text).toContain("answered 502");
  });

  // A failed refresh is not an unknown fleet: the last good answer stays.
  it("keeps the last answer on screen when a refresh fails", () => {
    const rows = screenRows(
      { ok: true, asked: 1, machines: [answered("mbp", "Claude: 5h: 12% used")] },
      { error: "Unable to read fleet usage: network down" },
    );

    const text = rows.join("\n");
    expect(text).toContain("network down");
    expect(text).toContain("mbp");
    expect(text).toContain("Showing the last answer that arrived");
  });
});
