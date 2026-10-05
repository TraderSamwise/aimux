import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// No surface may render an agent's raw `status` as a word.
//
// `session.status` is whether the process is alive. The project service decides
// what the agent's state is CALLED and publishes it as
// `semantic.presentation.statusLabel`. The agent row reimplemented that answer
// and said "Running" for an agent sitting at an empty prompt; while that was
// being fixed, two more surfaces turned out to be rendering the raw field
// inline -- the loops list and the For You feed subtitle. A per-surface test
// cannot catch the next one, so this is a search.
// Everything that can hold a component or a selector. `stores` is in here
// because a card's subtitle is as likely to be assembled in a selector as in
// JSX -- the For You feed's was. There is no `hooks` directory; the assertion
// below caught that the moment it was added speculatively.
const ROOTS = ["app", "components", "lib", "stores"] as const;

// Comparing a status is fine and necessary -- `status !== "offline"` is a real
// question. Only putting it in front of a person as a word is not.
// Scoped to an agent SESSION. A service has its own status vocabulary and
// renders it legitimately, a topology row's status is a different domain, and
// `${res.status}` is an HTTP code -- an earlier, looser version of this guard
// reported all three and would have been switched off rather than obeyed.
const RENDERS_STATUS_AS_A_WORD = [
  // `[..., session.status].filter(...)` joined into a subtitle, which is how
  // both of the surfaces found during this change spelled it.
  /,\s*(?:\w+\.)*(?:session|agent)\.status\s*\]\s*\.?\s*(?:\n\s*)?\.filter/i,
  // `{session.status}` straight into JSX.
  /\{\s*(?:\w+\.)*(?:session|agent)\.status\s*\}/i,
];

// `withFileTypes` rather than a `statSync` per entry: a dangling symlink makes
// `statSync` throw, which would fail this suite for a reason that has nothing
// to do with what it checks.
function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("the agent status word has one author", () => {
  // Asserted, not assumed: a renamed or moved directory would otherwise make
  // this search quietly cover less while still passing.
  it("searches directories that exist", () => {
    for (const root of ROOTS) {
      expect(sourceFiles(root).length, `${root} has source files`).toBeGreaterThan(0);
    }
  });

  it("is read off the payload by every surface, never recomputed from status", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const pattern of RENDERS_STATUS_AS_A_WORD) {
          if (pattern.test(source)) offenders.push(`${file} :: ${pattern}`);
        }
      }
    }
    expect(
      offenders,
      "render semantic.presentation.statusLabel (servedStatusWord) instead of session.status",
    ).toEqual([]);
  });

  // The guard has to be able to fail, or it is decoration. Asserted against a
  // literal rather than a file, because the repo is supposed to contain none.
  it("would catch the two spellings that were actually in the tree", () => {
    const loops = '{[entry.worktree.name, entry.session.status].filter(Boolean).join(" · ")}';
    const jsx = "<Text>{session.status}</Text>";
    expect(RENDERS_STATUS_AS_A_WORD.some((pattern) => pattern.test(loops))).toBe(true);
    expect(RENDERS_STATUS_AS_A_WORD.some((pattern) => pattern.test(jsx))).toBe(true);
  });

  // And must not fire on the things that legitimately render a status word.
  it.each([
    ["comparing it", 'if (session.status === "offline") return null;'],
    ["an HTTP code", "throw new Error(`failed (${res.status})`);"],
    [
      "a service, which has its own vocabulary",
      "[service.worktreeName, service.status].filter(Boolean)",
    ],
    ["a topology row, a different domain", "{[row.detail, row.status].filter(Boolean)}"],
    ["Exposé's chip, which is already the served word", "<Text>{tile.status}</Text>"],
  ])("does not fire on %s", (_why, source) => {
    expect(RENDERS_STATUS_AS_A_WORD.some((pattern) => pattern.test(source))).toBe(false);
  });
});
