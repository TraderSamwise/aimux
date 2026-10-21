#!/usr/bin/env node
// A context used where GitHub does not provide it does not warn, and does not
// fail one job: it rejects the whole workflow file. The run then reports
// "failure" with ZERO jobs, which reads like an outage rather than a typo, and
// every gate this repo relies on silently stops existing.
//
// That happened: `runner.temp` in workflow-level `env` took CI off master
// entirely, and the only visible symptom was a run with nothing in it. This
// checks the one thing cheap to check and expensive to miss.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = ".github/workflows";

// Available only once a job is running, so never in workflow-level `env`,
// `on`, `defaults`, or `concurrency`.
const JOB_SCOPED_CONTEXTS = ["runner", "job", "steps", "matrix", "needs", "strategy"];

/** Lines belonging to top-level blocks, i.e. before the first `jobs:` key. */
function topLevelRegion(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  return (jobsAt === -1 ? lines : lines.slice(0, jobsAt)).map((line, index) => ({
    line,
    number: index + 1,
  }));
}

const failures = [];
for (const name of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const path = join(WORKFLOW_DIR, name);
  for (const { line, number } of topLevelRegion(readFileSync(path, "utf8"))) {
    if (/^\s*#/.test(line)) continue;
    for (const context of JOB_SCOPED_CONTEXTS) {
      if (new RegExp(`\\$\\{\\{\\s*${context}\\.`).test(line)) {
        failures.push(
          `${path}:${number}: \`${context}\` is not available above \`jobs:\`; ` +
            `GitHub rejects the whole file and every job disappears.\n    ${line.trim()}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("workflow context audit failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `workflow context audit passed: ${readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).length} workflow(s) scanned`,
);
