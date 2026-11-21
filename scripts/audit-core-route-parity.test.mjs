import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareEntries,
  fixtureEntries,
  mirrorEntries,
} from "./audit-core-route-parity.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

describe("core route parity", () => {
  // The case the audit exists for. Four routes really were missing from the
  // mirror when it was written, so this is the drift it caught, replayed.
  it("names a route the mirror is missing", () => {
    const problems = compareEntries(
      "core routes",
      new Map([["a", "/a"]]),
      new Map([
        ["a", "/a"],
        ["b", "/b"],
      ]),
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("b");
    expect(problems[0]).toContain("not the mirror");
  });

  // The second direction. A mirror naming a route the daemon does not serve is
  // a client calling a 404, which is the same class of break pointing the
  // other way -- and the direction a one-sided check would miss.
  it("names a route only the mirror has", () => {
    const problems = compareEntries(
      "core routes",
      new Map([
        ["a", "/a"],
        ["ghost", "/ghost"],
      ]),
      new Map([["a", "/a"]]),
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ghost");
    expect(problems[0]).toContain("not the fixture");
  });

  // Same name, different path: present on both sides, so a key-only check
  // passes and the client calls the wrong URL.
  it("names a path that differs", () => {
    const problems = compareEntries(
      "core routes",
      new Map([["a", "/old"]]),
      new Map([["a", "/new"]]),
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/old");
    expect(problems[0]).toContain("/new");
  });

  it("is quiet when the two agree regardless of order", () => {
    const problems = compareEntries(
      "core routes",
      new Map([
        ["b", "/b"],
        ["a", "/a"],
      ]),
      new Map([
        ["a", "/a"],
        ["b", "/b"],
      ]),
      [],
    );
    expect(problems).toEqual([]);
  });

  // The extractor has to stop at the object it was asked for. The file holds
  // CORE_API_ROUTES and CORE_COMMAND_NAMES back to back, and a regex run over
  // the whole file collects both -- which reads as twelve extra routes and is
  // not drift. That mistake happened while this audit was being written.
  it("reads one exported object and not its neighbour", () => {
    const source = read("src/core-command-contract.ts");
    const routes = mirrorEntries(source, "CORE_API_ROUTES");
    const commands = mirrorEntries(source, "CORE_COMMAND_NAMES");

    expect(routes.has("ping")).toBe(false);
    expect(routes.has("relayDisable")).toBe(false);
    expect(commands.has("usageText")).toBe(false);
    expect(commands.get("ping")).toBe("core.ping");
  });

  it("fails loudly when the object it names is gone", () => {
    expect(() => mirrorEntries("export const SOMETHING_ELSE = {} as const;", "CORE_API_ROUTES"))
      .toThrow(/is gone/);
  });

  // Errors are not empty values: a fixture that cannot be parsed into rows
  // must not read as a fixture with no routes, which would make the audit pass
  // by having nothing to compare.
  it("fails loudly when the fixture has no rows", () => {
    expect(() => fixtureEntries('{"nothing": []}', "routes")).toThrow(/no "routes" array/);
  });

  // And the live tree, so the audit's own subject is covered rather than only
  // its helpers.
  it("holds for the real contract and fixture", () => {
    const problems = compareEntries(
      "core routes",
      mirrorEntries(read("src/core-command-contract.ts"), "CORE_API_ROUTES"),
      fixtureEntries(read("testdata/contracts/v1/core-command/routes.json"), "routes"),
      [],
    );
    expect(problems).toEqual([]);
  });
});
