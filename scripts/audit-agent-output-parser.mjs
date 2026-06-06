#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { auditAgentOutputParserCorpus } from "../dist/agent-output-parser-audit.js";

const usage = `Usage:
  yarn build
  node scripts/audit-agent-output-parser.mjs [--history <dir>] [--context <dir>] [--max <n>] [--flag <flag>] [--json] [--fail-on-findings]

Defaults:
  --history .aimux/history
  --context .aimux/context
`;

const validFlags = new Set(["prompt-from-response-record", "raw-block", "status-leak-response", "action-status-leak"]);
const args = process.argv.slice(2);
const historyDirs = [];
const contextDirs = [];
const flags = [];
let maxFindings = 80;
let json = false;
let failOnFindings = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--help" || arg === "-h") {
    console.log(usage);
    process.exit(0);
  }
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--fail-on-findings") {
    failOnFindings = true;
    continue;
  }
  if (arg === "--history") {
    const value = args[index + 1];
    if (!value) throw new Error("--history requires a directory");
    historyDirs.push(resolve(value));
    index += 1;
    continue;
  }
  if (arg === "--context") {
    const value = args[index + 1];
    if (!value) throw new Error("--context requires a directory");
    contextDirs.push(resolve(value));
    index += 1;
    continue;
  }
  if (arg === "--max") {
    const value = Number(args[index + 1]);
    if (!Number.isFinite(value) || value < 0) throw new Error("--max requires a non-negative number");
    maxFindings = value;
    index += 1;
    continue;
  }
  if (arg === "--flag") {
    const value = args[index + 1];
    if (!value || !validFlags.has(value)) {
      throw new Error(`--flag requires one of: ${Array.from(validFlags).join(", ")}`);
    }
    flags.push(value);
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}\n${usage}`);
}

if (historyDirs.length === 0) historyDirs.push(resolve(".aimux/history"));
if (contextDirs.length === 0) contextDirs.push(resolve(".aimux/context"));

const existingHistoryDirs = historyDirs.filter((dir) => existsSync(dir));
const existingContextDirs = contextDirs.filter((dir) => existsSync(dir));
const summary = auditAgentOutputParserCorpus({
  historyDirs: existingHistoryDirs,
  contextDirs: existingContextDirs,
  maxFindings,
  flags,
});

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Scanned ${summary.scanned} parser candidate(s).`);
  console.log(`Findings: ${summary.findings.length}`);
  for (const [flag, count] of Object.entries(summary.countsByFlag)) {
    if (count > 0) console.log(`- ${flag}: ${count}`);
  }
  for (const finding of summary.findings) {
    const record = finding.recordIndex === undefined ? "" : `:${finding.recordIndex}`;
    console.log(`\n${finding.flags.join(", ")} ${finding.source}${record} [${finding.tool}/${finding.blockType}]`);
    console.log(`  ${finding.sample}`);
  }
}

if (failOnFindings && summary.findings.length > 0) {
  process.exitCode = 1;
}
