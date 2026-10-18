import React, { type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../../src/project-api-contract";

vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));

import { UsageMonitor } from "@/components/UsageMonitor";

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
  expect(appLines()).toEqual([]);
});

const probePath = process.env.AIMUX_USAGE_SURFACE_PROBE;
const probe = probePath
  ? (JSON.parse(readFileSync(probePath, "utf8")) as {
      cases: { usage: UsageSnapshot; tuiLines: string[]; cliLines: string[] }[];
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
      }
    });
  },
);
