import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import {
  filterProjectPickerProjects,
  isProjectOnline,
  projectOnlineState,
} from "@/lib/project-picker";

// The app half of the cross-surface project-liveness check. AGENTS.md "One
// Answer, Many Surfaces": a per-surface test passes happily while the surfaces
// disagree. The CLI reads this same file in
// native/crates/aimux/tests/project_liveness_surfaces.rs.
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "testdata",
  "contracts",
  "v1",
  "project-liveness",
  "surfaces.json",
);

interface LivenessCase {
  why: string;
  project: Partial<DaemonProject> & { name: string; path: string };
  cliWord: string;
  appState: "online" | "offline" | "unknown";
  hiddenUnderActive: boolean;
}

const cases: LivenessCase[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).cases;

function project(input: LivenessCase["project"]): DaemonProject {
  return {
    id: input.name,
    dashboardSessionName: `aimux-${input.name}`,
    service: null,
    serviceAlive: false,
    serviceEndpoint: null,
    ...input,
  } as DaemonProject;
}

describe("the app renders the shared liveness answer", () => {
  it("covers every case the fixture carries", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((item) => item.appState))).toEqual(
      new Set(["online", "offline", "unknown"]),
    );
  });

  for (const item of cases) {
    it(`${item.project.name}: ${item.why}`, () => {
      expect(projectOnlineState(project(item.project))).toBe(item.appState);
      expect(isProjectOnline(project(item.project))).toBe(item.appState === "online");
    });
  }

  it("hides exactly the projects the fixture says are hidden under Active", () => {
    const all = cases.map((item) => project(item.project));
    const visible = filterProjectPickerProjects(all, { showAll: false });
    const visibleNames = new Set(visible.map((item) => item.name));
    for (const item of cases) {
      expect(visibleNames.has(item.project.name), `${item.project.name}: ${item.why}`).toBe(
        !item.hiddenUnderActive,
      );
    }
    expect(filterProjectPickerProjects(all, { showAll: true })).toHaveLength(cases.length);
  });
});

describe("the two surfaces agree", () => {
  // Reading both columns of the fixture in one place: if someone changes only
  // the CLI word or only the app state, these stop lining up.
  const EXPECTED_PAIRS: Record<string, string> = {
    live: "online",
    idle: "offline",
    unknown: "unknown",
  };

  for (const item of cases) {
    it(`${item.project.name} maps ${item.cliWord} to ${item.appState}`, () => {
      expect(EXPECTED_PAIRS[item.cliWord]).toBe(item.appState);
    });
  }
});
