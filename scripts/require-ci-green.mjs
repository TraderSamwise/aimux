#!/usr/bin/env node
// A tag publishes what master already proved. The source-property gates run on
// the master push, and this refuses to publish a tag whose commit ci did not
// conclude successfully -- the drift that shipped v0.1.36 and v0.1.37 from a
// locally-green tree that CI would have rejected.
//
// A tag push lands the branch and the tag together, so the same commit gets a
// ci run on each ref. Either one being green is the evidence; a cancelled run
// is not evidence of anything, because ci cancels superseded runs by ref.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_FAILURES = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export function classifyRuns(runs) {
  const failed = runs.filter(
    (run) => run.status === "completed" && REAL_FAILURES.has(run.conclusion),
  );
  const succeeded = runs.filter((run) => run.conclusion === "success");
  const pending = runs.filter((run) => run.status !== "completed");
  if (failed.length > 0) return { verdict: "failed", failed, succeeded, pending };
  if (succeeded.length > 0 && pending.length === 0) {
    return { verdict: "green", failed, succeeded, pending };
  }
  return { verdict: "waiting", failed, succeeded, pending };
}

function fetchRuns({ repo, workflow, sha }) {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`,
      "--jq",
      "[.workflow_runs[] | {status, conclusion, url: .html_url}]",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${result.stderr?.trim() ?? ""}`);
  }
  return JSON.parse(result.stdout || "[]");
}

const sleep = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

function main() {
  const options = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const [key, ...rest] = argument.replace(/^--/, "").split("=");
      return [key, rest.join("=")];
    }),
  );
  const repo = options.repo;
  const sha = options.sha;
  const workflow = options.workflow ?? "ci.yml";
  const timeoutSeconds = Number(options["timeout-seconds"] ?? 2700);
  const pollSeconds = Number(options["poll-seconds"] ?? 30);
  if (!repo || !sha) {
    process.stderr.write("usage: require-ci-green.mjs --repo OWNER/NAME --sha SHA [--workflow ci.yml]\n");
    process.exit(2);
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const runs = fetchRuns({ repo, workflow, sha });
    const { verdict, failed, succeeded, pending } = classifyRuns(runs);
    if (verdict === "failed") {
      process.stderr.write(`${workflow} did not pass on ${sha}:\n`);
      for (const run of failed) process.stderr.write(`  ${run.conclusion}: ${run.url}\n`);
      process.exit(1);
    }
    if (verdict === "green") {
      process.stdout.write(`${workflow} is green on ${sha} (${succeeded.length} run(s))\n`);
      return;
    }
    process.stdout.write(
      `${workflow} on ${sha}: ${runs.length} run(s), ${succeeded.length} green, ${pending.length} still running\n`,
    );
    if (Date.now() >= deadline) {
      process.stderr.write(
        `timed out after ${timeoutSeconds}s waiting for a green ${workflow} run on ${sha}; ` +
          `${runs.length} run(s) seen, ${succeeded.length} green, ${pending.length} pending\n`,
      );
      process.exit(1);
    }
    sleep(pollSeconds);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
