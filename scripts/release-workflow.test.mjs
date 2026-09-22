import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
const scripts = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;

// Top-level `  <name>:` blocks of the workflow, keyed by job id.
function jobs() {
  const found = new Map();
  let current = null;
  for (const line of workflow.split("\n")) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header) {
      current = header[1];
      found.set(current, []);
      continue;
    }
    if (current) found.get(current).push(line);
  }
  return new Map([...found].map(([name, body]) => [name, body.join("\n")]));
}

// `yarn --cwd app test` and `yarn test` are different work, so a package name
// is part of the identity. `yarn install` is setup, not a readiness step.
const YARN_CALL = /(?:scripts\/run-yarn|\byarn)\s+(?:--cwd\s+(\S+)\s+)?([a-z][a-z0-9:_-]*)/g;

function yarnCalls(text) {
  return [...text.matchAll(YARN_CALL)]
    .map(([, cwd, script]) => (cwd ? `${cwd}:${script}` : script))
    .filter((call) => call !== "install");
}

// Flatten the readiness chain to the leaves that actually do work, so a split
// that silently drops one of them is caught here rather than in a release.
function readinessLeaves(call, seen = new Set()) {
  if (seen.has(call)) return [];
  seen.add(call);
  const body = call.includes(":") && !(call in scripts) ? undefined : scripts[call];
  if (!body) return [call];
  const children = yarnCalls(body);
  if (children.length === 0) return [call];
  return children.flatMap((child) => readinessLeaves(child, seen));
}

describe("release workflow readiness gate", () => {
  const allJobs = jobs();
  const readinessJobs = [...allJobs].filter(([name]) => name.startsWith("readiness"));

  it("splits readiness across parallel jobs rather than one serial job", () => {
    expect(readinessJobs.length).toBeGreaterThan(1);
    expect(allJobs.has("readiness")).toBe(false);
  });

  it("runs every step of release:readiness somewhere in the readiness jobs", () => {
    const ran = new Set(
      readinessJobs.flatMap(([, body]) =>
        [...body.matchAll(/- run:\s*(.+)/g)].flatMap(([, step]) => yarnCalls(step)),
      ),
    );
    const covered = new Set([...ran].flatMap((call) => readinessLeaves(call)));
    const leaves = readinessLeaves("release:readiness");
    expect(leaves.length).toBeGreaterThan(5);
    for (const leaf of leaves) {
      expect(covered.has(leaf), `no readiness job runs ${leaf}`).toBe(true);
    }
  });

  it("gates the asset matrix on every readiness job", () => {
    const assets = allJobs.get("release-assets");
    expect(assets, "missing release-assets job").toBeTruthy();
    const needs = assets.slice(0, assets.indexOf("runs-on:"));
    for (const [name] of readinessJobs) {
      expect(needs, `release-assets does not need ${name}`).toContain(`- ${name}`);
    }
    expect(workflow.slice(workflow.indexOf("  release-assets:"))).not.toContain(
      "yarn release:readiness",
    );
  });

  it("gives each readiness job its own isolated Aimux runtime and tmux", () => {
    for (const [name, body] of readinessJobs) {
      if (!body.includes("Prepare isolated Aimux runtime")) continue;
      expect(body, `${name} shares an AIMUX_HOME`).toContain(
        "AIMUX_HOME=$RUNNER_TEMP/aimux-home-${{ github.job }}",
      );
      expect(body, `${name} shares a tmux socket`).toContain(
        "AIMUX_TMUX_SOCKET_PATH=$RUNNER_TEMP/aimux-${{ github.job }}-tmux.sock",
      );
      expect(body, `${name} does not ensure tmux`).toContain("Ensure tmux is available");
    }
  });

  it("provisions tmux for the installed runtime gates", () => {
    const installed = allJobs.get("readiness-installed-gates");
    expect(installed, "missing readiness-installed-gates job").toBeTruthy();
    expect(installed).toContain("Ensure tmux is available");
    expect(installed).toContain("apt-get install -y tmux");
    expect(installed).toContain("yarn installed:gate");
    expect(installed).toContain("yarn installed:local-gate");
  });
});
