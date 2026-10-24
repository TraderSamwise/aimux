import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { projectKey, projectNameFromPath, unresolvedProjectSelection } from "@/lib/project-key";
import { componentBody } from "@/test/component-source";

// The project screen is a route component no renderer in this app executes,
// and the defect here was an ORDER: a selection whose host had not answered
// fell through to the branch that says nothing is selected.
const PROJECT_SCREEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
  "(main)",
  "(tabs)",
  "project",
  "index.tsx",
);

const copy = componentBody(PROJECT_SCREEN, "function unresolvedSelectionCopy(");

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
    expect(copy, "the copy helper names the quiet host").toContain(
      "`Waiting for ${ref.machineId}`",
    );
    expect(copy, "and says which project, so the message is actionable").toContain(
      "${ref.path} is the project you had open",
    );
    // Three reasons, three answers. Two of them shared one message, and a
    // machineless ref took the one that says the project is gone.
    expect(copy).toContain('reason === "host-quiet"');
    expect(copy).toContain('reason === "ambiguous"');
    expect(copy).toContain('title: "Project not found"');
    expect(screen, "through the one helper that decides the wording").toContain(
      "unresolvedSelectionCopy(unresolvedSelection)",
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
      /unresolvedProjectSelection\(\{\s*project,\s*effectiveRefKey,\s*listSynced: lastSyncAt !== null,\s*projects,\s*shareOwnsRoute: Boolean\(activeShare\),\s*\}\)/,
    );
  });

  // The call shape alone was not enough: replacing the snapshot with `[]` kept
  // every test green, and `hostIsListed` then never fires -- so a checkout
  // that is genuinely gone says "Waiting for strix" forever, the inverse of
  // the bug this fixed.
  it("reads those inputs from the store, not from constants", () => {
    expect(hook).toContain("useAtomValue(projectsAtom)");
    expect(hook).toContain("useAtomValue(lastSyncAtAtom)");
  });

  it("returns it to the surfaces", () => {
    expect(hook).toContain("unresolvedSelection,");
  });
});

describe("unresolvedProjectSelection", () => {
  const selected = projectKey({ machineId: "strix", path: "/repo/aimux" });
  const base = {
    project: null as { path: string } | null,
    effectiveRefKey: selected,
    listSynced: true,
    projects: [] as readonly { machineId?: string; path: string }[],
    shareOwnsRoute: false,
  };

  it("is nothing when the snapshot has the project", () => {
    expect(unresolvedProjectSelection({ ...base, project: { path: "/repo/aimux" } })).toBeNull();
  });

  // Quiet: the selection names a host this snapshot does not speak for.
  it("waits on a host the snapshot does not include", () => {
    expect(
      unresolvedProjectSelection({ ...base, projects: [{ machineId: "mbp", path: "/repo/x" }] }),
    ).toEqual({ ref: { machineId: "strix", path: "/repo/aimux" }, reason: "host-quiet" });
  });

  // Gone: the host is right there and does not have the path, so nothing is
  // coming and saying "waiting" would wait forever.
  it("reports not-on-host when the snapshot speaks for that machine", () => {
    expect(
      unresolvedProjectSelection({ ...base, projects: [{ machineId: "strix", path: "/repo/x" }] }),
    ).toMatchObject({ reason: "not-on-host" });
  });

  // A machineless ref names a path and no host. Exactly one match would have
  // RESOLVED, so an unresolved one with several matches is a question for the
  // user -- it was being called gone while two machines had it.
  it("reports ambiguous when several machines have a machineless path", () => {
    expect(
      unresolvedProjectSelection({
        ...base,
        effectiveRefKey: projectKey({ path: "/repo/aimux" }),
        projects: [
          { machineId: "mbp", path: "/repo/aimux" },
          { machineId: "strix", path: "/repo/aimux" },
        ],
      }),
    ).toMatchObject({ reason: "ambiguous" });
  });

  it("reports not-on-host when a machineless path is nowhere", () => {
    expect(
      unresolvedProjectSelection({
        ...base,
        effectiveRefKey: projectKey({ path: "/repo/gone" }),
        projects: [{ machineId: "mbp", path: "/repo/aimux" }],
      }),
    ).toMatchObject({ reason: "not-on-host" });
  });

  // A share's project root is the OWNER's, carries no machine, and the
  // viewer's snapshot says nothing about it -- so a receiver with any local
  // project was told the owner's project was gone.
  it("says nothing about a project a share owns", () => {
    expect(
      unresolvedProjectSelection({
        ...base,
        effectiveRefKey: projectKey({ path: "/owner/repo" }),
        projects: [{ machineId: "mbp", path: "/repo/aimux" }],
        shareOwnsRoute: true,
      }),
    ).toBeNull();
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
