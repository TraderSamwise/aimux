#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-review-request.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const TMP_RE = /\/var\/folders\/[^"]+|\/tmp\/aimux-review-request-[^"]+/g;

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split(repoRoot).join("<REPO>").replace(TMP_RE, "<TMP>"));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return async (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
    sync(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function git(repoRoot, args) {
  execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
}

function createRepo(input) {
  const root = mkdtempSync(join(tmpdir(), "aimux-review-request-"));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;
  git(root, ["init", "-b", "master", "repo"]);
  git(repoRoot, ["config", "user.email", "fixture@example.com"]);
  git(repoRoot, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repoRoot, "file.txt"), "before\n");
  git(repoRoot, ["add", "file.txt"]);
  git(repoRoot, ["commit", "-m", "baseline"]);
  if (input.makeDiff !== false) {
    writeFileSync(join(repoRoot, "file.txt"), "before\nafter\n");
  }
  if (input.teamConfig) {
    writeFileSync(join(repoRoot, ".aimux", "team.json"), `${JSON.stringify(input.teamConfig, null, 2)}\n`);
  }
  return repoRoot;
}

async function runCase(input) {
  const repoRoot = createRepo(input);
  await initPaths(repoRoot);
  process.chdir(repoRoot);
  const rec = recorder();
  const host = {
    projectRoot: repoRoot,
    activeSession: clone(input.activeSession ?? null),
    sessionRoles: new Map(Object.entries(input.sessionRoles ?? {})),
    sessionWorktreePaths: new Map(
      Object.entries(input.sessionWorktreePaths ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? value.replace("<REPO>", repoRoot) : value,
      ]),
    ),
    footerFlash: null,
    footerFlashTicks: 0,
    postToProjectService: rec.fn("postToProjectService", async () => {
      if (input.postThrows) {
        const error = new Error(input.postThrows);
        error.tuiApiRecoverable = false;
        throw error;
      }
      return clone(input.postResult ?? { ok: true, task: { assignee: input.returnedAssignee ?? undefined } });
    }),
    showDashboardError: rec.sync("showDashboardError"),
    renderDashboard: rec.sync("renderDashboard"),
  };
  await dashboardInteractionMethods.handleReviewRequest.call(host);
  return normalize(
    {
      footerFlash: host.footerFlash,
      footerFlashTicks: host.footerFlashTicks,
      calls: rec.calls,
    },
    repoRoot,
  );
}

const defaultSession = { id: "codex-1", command: "codex", status: "running" };

const casesInput = [
  {
    name: "no active session is a no-op",
    input: { activeSession: null },
  },
  {
    name: "default coder role assigns review task to configured reviewer with git diff",
    input: {
      activeSession: defaultSession,
      sessionRoles: { "codex-1": "coder" },
      sessionWorktreePaths: { "codex-1": "<REPO>" },
      returnedAssignee: "reviewer",
    },
  },
  {
    name: "role without reviewedBy falls back to review-described role",
    input: {
      activeSession: { id: "worker-1", command: "claude", status: "running" },
      sessionRoles: { "worker-1": "builder" },
      teamConfig: {
        roles: {
          builder: { description: "Builds code", canEdit: true },
          inspector: { description: "Reviews code changes" },
        },
        defaultRole: "builder",
      },
      makeDiff: false,
    },
  },
  {
    name: "missing reviewer role flashes and renders without posting",
    input: {
      activeSession: defaultSession,
      sessionRoles: { "codex-1": "solo" },
      teamConfig: { roles: { solo: { description: "Works alone" } }, defaultRole: "solo" },
    },
  },
  {
    name: "post failure shows review request error and still renders",
    input: {
      activeSession: defaultSession,
      sessionRoles: { "codex-1": "coder" },
      postThrows: "task API unavailable",
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-interaction-review-request-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: "dashboardInteractionMethods.handleReviewRequest",
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-review-request-contract.mjs",
  description:
    "Dashboard review-request reviewer selection, git diff payload, task assignment, and failure rendering captured by running TypeScript handleReviewRequest.",
  cases,
});
