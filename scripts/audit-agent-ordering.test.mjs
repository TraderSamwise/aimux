import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scanSource } from "./audit-agent-ordering.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = resolve(repoRoot, "scripts/agent-ordering-allowlist.json");

function runGate() {
  return spawnSync("node", ["scripts/audit-agent-ordering.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("agent ordering gate", () => {
  it("reports a new agent sort that does not use the canonical comparator", () => {
    const offending = `
fn render_agents(agents: &mut Vec<Value>) {
    agents.sort_by(|left, right| left["createdAt"].as_str().cmp(&right["createdAt"].as_str()));
}
`;
    const hits = scanSource("native/crates/aimux/src/some_new_surface.rs", offending);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ canonical: false, fields: ["createdAt"] });
  });

  // Every agent sort in this repo hands off to a named comparator, so a gate
  // that only reads the sort call's own line sees nothing at all.
  it("follows a sort into a named comparator in the same file", () => {
    const offending = `
fn compare_however_i_like(left: &Value, right: &Value) -> Ordering {
    left["lastUsedAt"].as_str().cmp(&right["lastUsedAt"].as_str())
}

fn render_agents(agents: &mut Vec<Value>) {
    agents.sort_by(compare_however_i_like);
}
`;
    const hits = scanSource("native/crates/aimux/src/some_new_surface.rs", offending);

    expect(hits).toHaveLength(1);
    expect(hits[0].canonical).toBe(false);
    expect(hits[0].fields).toContain("lastUsedAt");
  });

  it("passes a sort that goes through the canonical comparator", () => {
    const allowed = `
fn render_agents(agents: &mut Vec<Value>) {
    agents.sort_by(compare_agent_canonical_order);
}

fn compare_agent_canonical_order(left: &Value, right: &Value) -> Ordering {
    left["tmuxWindowIndex"].as_i64().cmp(&right["tmuxWindowIndex"].as_i64())
}
`;
    const hits = scanSource("native/crates/aimux/src/some_new_surface.rs", allowed);

    expect(hits).toHaveLength(1);
    expect(hits[0].canonical).toBe(true);
  });

  it("ignores a sort that decides on nothing an agent is ordered by", () => {
    const unrelated = `
fn render_files(files: &mut Vec<String>) {
    files.sort_by(|left, right| left.len().cmp(&right.len()));
}
`;
    expect(scanSource("native/crates/aimux/src/some_new_surface.rs", unrelated)).toHaveLength(0);
  });

  // A whole-file exemption is the gate's failure mode: the files that build
  // agent lists all contain a legitimate worktree-group sort too, so exempting
  // the file waves through the next agent sort added beside it.
  it("names the enclosing function so an exemption cannot cover a whole file", () => {
    const source = `
fn sort_worktree_groups(groups: &mut Vec<Value>) {
    groups.sort_by(|left, right| left["createdAt"].as_str().cmp(&right["createdAt"].as_str()));
}

fn render_agents(agents: &mut Vec<Value>) {
    agents.sort_by(|left, right| left["createdAt"].as_str().cmp(&right["createdAt"].as_str()));
}
`;
    const hits = scanSource("native/crates/aimux/src/some_surface.rs", source);

    expect(hits.map((hit) => hit.function)).toEqual(["sort_worktree_groups", "render_agents"]);
  });

  it("requires every allowlist entry to name a function and say what it really sorts", () => {
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

    expect(allowlist.entries.length).toBeGreaterThan(0);
    for (const entry of allowlist.entries) {
      expect(entry.file, JSON.stringify(entry)).toBeTruthy();
      expect(entry.function, entry.file).toBeTruthy();
      expect(entry.reason ?? "", entry.file).not.toHaveLength(0);
    }
  });

  it("passes on the repository as it stands, and lists no stale allowlist entry", () => {
    const result = runGate();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.unclassified).toEqual([]);
    expect(report.staleAllowlist).toEqual([]);
    expect(report.hits.filter((hit) => hit.canonical).length).toBeGreaterThan(0);
  });
});
