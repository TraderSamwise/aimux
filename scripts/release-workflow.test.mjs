import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const release = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const scripts = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;

// Top-level `  <name>:` blocks of a workflow, keyed by job id.
function jobs(workflow) {
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

// Flatten the readiness chain to the leaves that actually do work, so a move
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

const releaseJobs = jobs(release);
const ciJobs = jobs(ci);

describe("release readiness runs on master, not on the tag", () => {
  it("runs every step of release:readiness somewhere in ci", () => {
    const ran = new Set(
      [...ciJobs.values()].flatMap((body) =>
        [...body.matchAll(/(?:- run:|run:)\s*(.+)/g)].flatMap(([, step]) => yarnCalls(step)),
      ),
    );
    const covered = new Set([...ran].flatMap((call) => readinessLeaves(call)));
    const leaves = readinessLeaves("release:readiness");
    expect(leaves.length).toBeGreaterThan(5);
    for (const leaf of leaves) {
      expect(covered.has(leaf), `no ci job runs ${leaf}`).toBe(true);
    }
  });

  it("does not re-run the readiness gates on the tag", () => {
    expect([...releaseJobs.keys()].filter((name) => name.startsWith("readiness"))).toEqual([]);
    expect(release).not.toContain("yarn release:readiness");
    expect(release).not.toContain("yarn verify:fast");
    expect(release).not.toContain("yarn installed:gate");
  });

  it("gives each ci job that starts a runtime its own Aimux home and tmux", () => {
    for (const [name, body] of ciJobs) {
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

  // These three ran serially in one job and were the readiness phase's whole
  // critical path. Keep them apart, and keep each one's tmux with it.
  it("runs each installed runtime gate in its own ci job", () => {
    const gates = {
      "idle-spawn": "yarn audit:idle-process-spawn",
      "installed-gate": "yarn installed:gate",
      "installed-local-gate": "yarn installed:local-gate",
    };
    for (const [name, step] of Object.entries(gates)) {
      const job = ciJobs.get(name);
      expect(job, `missing ${name} job`).toBeTruthy();
      expect(job, `${name} does not run ${step}`).toContain(step);
      expect(job, `${name} does not ensure tmux`).toContain("Ensure tmux is available");
      for (const [other, otherStep] of Object.entries(gates)) {
        if (other === name) continue;
        expect(job, `${name} also runs ${otherStep}`).not.toContain(otherStep);
      }
    }
  });
});

describe("one ci run per commit", () => {
  // `release:patch` pushes master and the tag atomically, so a `tags:` trigger
  // here runs the identical commit twice: today that was 14m17s and 12m32s for
  // the same sha. At three tags a day it is the single biggest wasted gate.
  it("does not run ci on tags", () => {
    const triggers = ci.slice(0, ci.indexOf("jobs:"));
    expect(triggers, "ci.yml runs on tags again, duplicating the master run").not.toMatch(
      /^\s*tags:/m,
    );
    expect(triggers, "ci must still run on master").toMatch(/branches:\s*\n\s*- master/);
  });
});

describe("the tag lane builds and publishes, and waits for nothing", () => {
  // It used to block every publishing job on a poll of ci.yml for this commit.
  // `release:patch` creates the version-bump commit and pushes it with the tag,
  // so that commit's ci run started at the same moment and the tag lane simply
  // waited for it -- 15 minutes a tag, at three tags a day. ci on master is the
  // gate; a tag is fire and forget.
  it("has no job that waits on ci", () => {
    expect(releaseJobs.has("require-ci-green")).toBe(false);
    for (const [name, job] of releaseJobs) {
      expect(job, `${name} still polls ci`).not.toContain("require-ci-green.mjs");
    }
  });

  // The matrix used to create the GitHub Release itself, six times over, which
  // is how v0.1.59 put every asset in front of users from a run that failed.
  it("builds assets without publishing them", () => {
    const build = releaseJobs.get("release-assets");
    expect(build, "missing release-assets job").toBeTruthy();
    expect(build).toContain("actions/upload-artifact");
    expect(build, "release-assets still creates the GitHub Release").not.toContain(
      "softprops/action-gh-release",
    );
  });

  // One place creates the release, and only once every asset exists.
  it("publishes once, after every asset is built", () => {
    const publish = releaseJobs.get("publish-release-assets");
    expect(publish, "missing publish-release-assets job").toBeTruthy();
    expect(publish).toContain("softprops/action-gh-release");
    expect(publish).toContain("needs: release-assets");

    for (const name of ["verify-release-assets", "publish-npm", "update-homebrew-tap"]) {
      const job = releaseJobs.get(name);
      expect(job, `missing ${name} job`).toBeTruthy();
      expect(dependsOn(name, "publish-release-assets"), `${name} can publish early`).toBe(true);
    }
  });
});

function dependsOn(jobName, ancestor, seen = new Set()) {
  if (seen.has(jobName)) return false;
  seen.add(jobName);
  const body = releaseJobs.get(jobName);
  if (!body) return false;
  const header = body.slice(0, body.indexOf("steps:"));
  const needs = [...header.matchAll(/^\s+-\s+([a-z][a-z0-9-]*)\s*$/gm)].map(([, name]) => name);
  const inline = /needs:\s*([a-z][a-z0-9-]*)\s*$/m.exec(header);
  if (inline) needs.push(inline[1]);
  if (needs.includes(ancestor)) return true;
  return needs.some((name) => dependsOn(name, ancestor, seen));
}
