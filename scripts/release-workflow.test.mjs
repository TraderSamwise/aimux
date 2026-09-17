import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");

function count(needle) {
  return workflow.split(needle).length - 1;
}

function section(start, end) {
  const startIndex = workflow.indexOf(start);
  expect(startIndex, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing ${end}`).toBeGreaterThan(startIndex);
  return workflow.slice(startIndex, endIndex);
}

describe("release workflow readiness gate", () => {
  it("runs release readiness once before the asset matrix", () => {
    const readiness = section("  readiness:", "  release-assets:");
    const assetJobs = workflow.slice(workflow.indexOf("  release-assets:"));

    expect(count("yarn release:readiness")).toBe(1);
    expect(readiness).toContain("- run: yarn release:readiness");
    expect(assetJobs).not.toContain("yarn release:readiness");
    expect(assetJobs).toContain("needs: readiness");
  });

  it("provisions tmux and an isolated Aimux runtime for installed gates", () => {
    const readiness = section("  readiness:", "  release-assets:");

    expect(readiness).toContain("AIMUX_HOME=$RUNNER_TEMP/aimux-home-release-readiness");
    expect(readiness).toContain("AIMUX_TMUX_SOCKET_PATH=$RUNNER_TEMP/aimux-release-readiness-tmux.sock");
    expect(readiness).toContain("Ensure tmux is available");
    expect(readiness).toContain("apt-get install -y tmux");
    expect(readiness).toContain("brew install tmux");
    expect(readiness).toContain("unsupported runner OS for installed-runtime gates");
  });
});
