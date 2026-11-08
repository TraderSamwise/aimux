import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release-asset-matrix.py");

/**
 * The shipped platform set, and what happens when the matrix is not a bare
 * list of entries.
 *
 * This script is the single source of truth for "what a complete release looks
 * like" -- the tag workflow downloads by it, npm stages by it, Homebrew renders
 * by it, and the completeness gate verifies by it. That last one is why a
 * parsing bug here is so quiet: the gate asks this same function what the set
 * should be, so a set that lost a platform still verifies as complete.
 *
 * v0.1.74 is the release that happened. A YAML comment added between two
 * matrix entries ended the parse, both Darwin entries vanished, the asset-set
 * gate passed on the four that remained, and then npm failed on a missing
 * `native/darwin-arm64` and the Homebrew render failed on an empty
 * `DARWIN_ARM64`. Every asset was sitting on the release the whole time.
 */
function runOn(workflowText) {
  return execFileSync("python3", [SCRIPT, "-"], {
    encoding: "utf8",
    input: workflowText,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

const ENTRIES = [
  "          - platform: linux",
  "            arch: x64",
  "            variant: full",
  "            asset: aimux-linux-x64",
  "            runner: ubuntu-latest",
  "          - platform: darwin",
  "            arch: arm64",
  "            variant: full",
  "            asset: aimux-darwin-arm64",
  "            runner: macos-15",
];

function workflow(...extra) {
  return [
    "jobs:",
    "  release-assets:",
    "    strategy:",
    "      matrix:",
    "        include:",
    ...extra,
  ].join("\n");
}

describe("the release asset matrix", () => {
  it("reads every entry out of a plain list", () => {
    expect(runOn(workflow(...ENTRIES))).toEqual([
      "linux\tx64\tfull\taimux-linux-x64",
      "darwin\tarm64\tfull\taimux-darwin-arm64",
    ]);
  });

  it("does not let a comment between entries end the list", () => {
    // The v0.1.74 failure, as a gate. Delete the comment skip in the parser
    // and this returns only the linux entry -- which is exactly what shipped.
    const commented = [
      ...ENTRIES.slice(0, 5),
      "          # macos-15, because GitHub retired macos-14",
      ...ENTRIES.slice(5),
    ];

    expect(runOn(workflow(...commented))).toEqual([
      "linux\tx64\tfull\taimux-linux-x64",
      "darwin\tarm64\tfull\taimux-darwin-arm64",
    ]);
  });

  it("still stops at the end of the matrix", () => {
    // The comment skip must not let the parse run on into the rest of the
    // job and invent entries out of unrelated keys.
    const followed = [...ENTRIES, "", "    steps:", "      - run: echo hi"];

    expect(runOn(workflow(...followed))).toHaveLength(2);
  });

  it("agrees with the workflow that is actually checked in", () => {
    const shipped = execFileSync("python3", [SCRIPT], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    // Both variants of both Darwin and Linux architectures. A release missing
    // any of these is the failure this file exists for.
    expect(shipped).toContain("darwin\tarm64\tfull\taimux-darwin-arm64");
    expect(shipped).toContain("darwin\tarm64\tlocal\taimux-local-darwin-arm64");
    expect(shipped.length).toBeGreaterThanOrEqual(6);
  });
});
