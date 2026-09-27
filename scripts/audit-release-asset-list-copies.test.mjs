import { describe, expect, it } from "vitest";

import { allowedLines, hardcodedAssetNames, matrixBlockRange } from "./audit-release-asset-list-copies.mjs";

const WORKFLOW = [
  "jobs:",
  "  release-assets:",
  "    strategy:",
  "      matrix:",
  "        include:",
  "          - platform: darwin",
  "            asset: aimux-darwin-arm64",
  "          - platform: linux",
  "            asset: aimux-linux-x64",
  "",
  "    steps:",
  "      - run: echo ${{ matrix.asset }}",
  "  other:",
  "    steps:",
  "      - run: |",
  "          while IFS=$'\\t' read -r _p _a _v a; do",
  "            echo $a",
  "          done < <(python3 scripts/release-asset-matrix.py)",
].join("\n");

describe("the release asset set has one copy", () => {
  it("finds the matrix include block", () => {
    const { end, start } = matrixBlockRange(WORKFLOW.split("\n"));
    expect(WORKFLOW.split("\n")[start].trim()).toBe("include:");
    expect(end).toBeGreaterThan(start);
  });

  it("passes a workflow that only reads the matrix", () => {
    expect(hardcodedAssetNames(WORKFLOW)).toEqual([]);
  });

  it("catches an asset list written down outside the matrix", () => {
    const stale = WORKFLOW.replace(
      "          while IFS=$'\\t' read -r _p _a _v a; do",
      "          for a in aimux-darwin-arm64 aimux-darwin-x64; do",
    );
    const found = hardcodedAssetNames(stale);
    expect(found.map((entry) => entry.name)).toEqual(["aimux-darwin-arm64", "aimux-darwin-x64"]);
  });

  it("lets a recorded template binding stand", () => {
    const bound = WORKFLOW.replace(
      "            echo $a",
      '            export DARWIN_ARM64="$(extract aimux-darwin-arm64)"',
    );
    const line = 'export DARWIN_ARM64="$(extract aimux-darwin-arm64)"';
    expect(hardcodedAssetNames(bound).map((entry) => entry.text)).toEqual([line]);
    expect(hardcodedAssetNames(bound, new Set([line]))).toEqual([]);
  });

  // The first version of this audit only matched literal names, so
  // `aimux-darwin-${arch}` in a `for arch in arm64 x64` loop passed -- and that
  // copy failed the npm publish on v0.1.61 with every asset already published.
  it("catches an interpolated asset name", () => {
    const interpolated = WORKFLOW.replace(
      "            echo $a",
      '            gh release download --pattern "aimux-darwin-${arch}.tar.gz"',
    );
    expect(hardcodedAssetNames(interpolated).map((entry) => entry.name)).toEqual(["aimux-darwin-${arch}"]);
  });

  it("catches a platform loop that enumerates arches", () => {
    const looped = WORKFLOW.replace(
      "          while IFS=$'\\t' read -r _p _a _v a; do",
      "          for arch in arm64 x64; do",
    );
    expect(hardcodedAssetNames(looped).map((entry) => entry.name)).toEqual(["platform loop"]);
  });

  it("does not flag a comment that names the asset which broke a tag", () => {
    const documented = WORKFLOW.replace(
      "            echo $a",
      "            # aimux-darwin-x64 was dropped when Intel was",
    );
    expect(hardcodedAssetNames(documented)).toEqual([]);
  });

  it("scans a file with no matrix in it", () => {
    const formulaTemplate = '      url "${BASE_URL}/aimux-darwin-arm64.tar.gz"';
    expect(hardcodedAssetNames(formulaTemplate, new Set(), { hasMatrix: false }).map((entry) => entry.name)).toEqual([
      "aimux-darwin-arm64",
    ]);
  });

  it("refuses an allowlist with no reason written down", () => {
    expect(() => allowedLines(JSON.stringify({ files: {} }))).toThrow(/description/);
    expect(() => allowedLines(JSON.stringify({ description: "  ", files: {} }))).toThrow(/description/);
  });

  it("refuses an allowlist with no files map", () => {
    expect(() => allowedLines(JSON.stringify({ description: "why" }))).toThrow(/files map/);
    expect(() => allowedLines(JSON.stringify({ description: "why", files: { a: "x" } }))).toThrow(/not an array/);
  });

  // Per file, so a binding recorded for the formula template cannot silently
  // excuse the same line appearing in the workflow.
  it("keeps the recorded lines separate per file", () => {
    const byFile = allowedLines(JSON.stringify({ description: "why", files: { "a.yml": ["one"], "b.sh": ["two"] } }));
    expect(byFile.get("a.yml")).toEqual(new Set(["one"]));
    expect(byFile.get("b.sh")).toEqual(new Set(["two"]));
  });
});
