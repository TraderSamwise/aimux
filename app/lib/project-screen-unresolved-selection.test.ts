import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { projectKey, projectNameFromPath, unresolvedProjectSelection } from "@/lib/project-key";
import { componentBody } from "@/test/component-source";

// The project screen is a route component no renderer in this app executes,
// and the defect here was an ORDER: a selection whose host had not answered
// fell through to the branch that says nothing is selected.
const screen = componentBody(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "app",
    "(main)",
    "(tabs)",
    "project",
    "index.tsx",
  ),
  "export default function ProjectScreen(",
);

describe("a selected project that is not in the current snapshot", () => {
  it("is asked about at all", () => {
    expect(screen, "from the one place that derives it").toContain("unresolvedSelection");
    expect(screen).toContain("} = useRouteProject();");
  });

  // The bug, as an ordering. `selectionWasContradicted` deliberately keeps a
  // selection whose machine is merely quiet, so this branch has to come first
  // or the screen denies a selection it still holds -- with that machine's
  // projects missing and every other project in the sidebar beside the
  // message.
  it("is answered before the branch that says nothing is selected", () => {
    const waiting = screen.indexOf("unresolvedSelection ? (");
    const nothingSelected = screen.indexOf('<EmptyCard title="No project selected"');
    expect(waiting, "the waiting branch is rendered").toBeGreaterThan(-1);
    expect(nothingSelected, "and so is the empty one").toBeGreaterThan(-1);
    expect(waiting, "but the waiting branch is reached first").toBeLessThan(nothingSelected);
  });

  // The header is a second surface on the same screen, and it had the same
  // fallback. Naming the project there is what tells Sam WHICH one is waiting.
  it("is named in the header rather than denied there too", () => {
    const named = screen.indexOf("projectNameFromPath(unresolvedSelection.ref.path)");
    const denied = screen.indexOf('"No project selected"');
    expect(named, "the header names it").toBeGreaterThan(-1);
    expect(named, "before falling back").toBeLessThan(denied);
  });

  it("names the host it is waiting for, when it knows one", () => {
    expect(screen).toContain("`Waiting for ${unresolvedSelection.ref.machineId}`");
    expect(screen, "and says which project, so the message is actionable").toContain(
      "unresolvedSelection.ref.path",
    );
    expect(screen, "and does not promise a deleted checkout will arrive").toContain(
      'unresolvedSelection.hostAnswered\n              ? "Project not found"',
    );
  });
});

// Expose is the other surface that guesses. It asks the project service for
// tiles, so guessing costs a real request and a visible flash.
describe("the expose screen while the selection is unread", () => {
  const expose = componentBody(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "components",
      "screens",
      "ExposeScreen.tsx",
    ),
    "export default function ExposeScreen(",
  );

  it("waits for the stored selection before falling back to the first project", () => {
    expect(expose).toContain("useAtomValue(selectedProjectHydratedAtom)");
    expect(expose, "the displayed project waits").toContain(
      "selectionRead ? projectRefOf(projects[0]) : null",
    );
    expect(expose, "and so does the one it requests tiles for").toContain(
      "currentProjectRef || !selectionRead ? null :",
    );
  });
});

describe("projectNameFromPath", () => {
  it("is the last segment of the path", () => {
    expect(projectNameFromPath("/Users/sam/cs/aimux")).toBe("aimux");
    expect(projectNameFromPath("/Users/sam/cs/aimux/")).toBe("aimux");
  });

  // Never empty: it is rendered as a title.
  it("falls back to the path when there is no segment", () => {
    expect(projectNameFromPath("/")).toBe("/");
    expect(projectNameFromPath("")).toBe("");
  });
});

// The rule is tested directly above and the screen is gated below, which
// still left the WIRING between them unpinned: passing a constant here killed
// the feature outright with every test, lint and typecheck green.
describe("the hook that derives it", () => {
  const hook = componentBody(
    join(dirname(fileURLToPath(import.meta.url)), "use-route-project.ts"),
    "export function useRouteProject(): RouteProject {",
  );

  it("passes the real snapshot, selection and sync state", () => {
    expect(hook).toMatch(
      /unresolvedProjectSelection\(\{\s*project,\s*effectiveRefKey,\s*listSynced: lastSyncAt !== null,\s*projects,\s*\}\)/,
    );
  });

  it("returns it to the surfaces", () => {
    expect(hook).toContain("unresolvedSelection,");
  });
});

describe("unresolvedProjectSelection", () => {
  const selected = projectKey({ machineId: "strix", path: "/repo/aimux" });
  const base = { project: null, effectiveRefKey: selected, listSynced: true, projects: [] };

  it("is nothing when the snapshot has the project", () => {
    expect(unresolvedProjectSelection({ ...base, project: { path: "/repo/aimux" } })).toBeNull();
  });

  // The case the screen renders: the selection names a host this snapshot does
  // not speak for, so the project is quiet rather than gone.
  it("is the selected ref, not yet answered, when its host is absent", () => {
    expect(unresolvedProjectSelection({ ...base, projects: [{ machineId: "mbp" }] })).toEqual({
      ref: { machineId: "strix", path: "/repo/aimux" },
      hostAnswered: false,
    });
  });

  // And the one that must NOT say "waiting": the host is right there and does
  // not have the path, so nothing is coming.
  it("reports the host as answered when the snapshot speaks for it", () => {
    expect(
      unresolvedProjectSelection({ ...base, projects: [{ machineId: "strix" }] }),
    ).toMatchObject({ hostAnswered: true });
  });

  // Local mode names no machine, and the list speaks for everything.
  it("treats a machineless selection as answered", () => {
    expect(
      unresolvedProjectSelection({ ...base, effectiveRefKey: projectKey({ path: "/repo/gone" }) }),
    ).toMatchObject({ hostAnswered: true });
  });

  // The promise made before the question was asked: an empty list on a cold
  // launch is not an answer about anything.
  it("is nothing before the project list has been asked at all", () => {
    expect(unresolvedProjectSelection({ ...base, listSynced: false })).toBeNull();
  });

  it("is nothing when nothing is selected either", () => {
    expect(unresolvedProjectSelection({ ...base, effectiveRefKey: null })).toBeNull();
  });
});
