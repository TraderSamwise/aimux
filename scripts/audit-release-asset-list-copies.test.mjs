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

  it("refuses an allowlist with no reason written down", () => {
    expect(() => allowedLines(JSON.stringify({ lines: ["x"] }))).toThrow(/description/);
    expect(() => allowedLines(JSON.stringify({ description: "  ", lines: [] }))).toThrow(/description/);
  });

  it("reads the recorded lines", () => {
    expect(allowedLines(JSON.stringify({ description: "why", lines: ["a", "b"] }))).toEqual(new Set(["a", "b"]));
  });
});
