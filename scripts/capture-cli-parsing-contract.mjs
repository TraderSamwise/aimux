#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/parsing.json", ROOT);
const { commandArgValueMatches } = await import(new URL("dist/process-args.js", ROOT));
const { parseEnvAssignments, parseShellArgs } = await import(new URL("dist/shell-args.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, source, api, input, run) {
  let output;
  try {
    output = { ok: true, value: run() };
  } catch (error) {
    output = { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
  cases.push({
    id: `cli-parsing-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const processArgs =
  "node /opt/aimux/dist/launcher-bin.js __project-service-internal --project-id repo-old --project-root /repo-old";
record("rejects project-id prefix matches", "src/process-args.test.ts", "commandArgValueMatches", {
  args: processArgs,
  flag: "--project-id",
  expected: "repo",
}, () => commandArgValueMatches(processArgs, "--project-id", "repo"));
record("rejects project-root prefix matches", "src/process-args.test.ts", "commandArgValueMatches", {
  args: processArgs,
  flag: "--project-root",
  expected: "/repo",
}, () => commandArgValueMatches(processArgs, "--project-root", "/repo"));
record("accepts exact project-root match", "src/process-args.test.ts", "commandArgValueMatches", {
  args: processArgs,
  flag: "--project-root",
  expected: "/repo-old",
}, () => commandArgValueMatches(processArgs, "--project-root", "/repo-old"));
const spacedArgs = "node aimux __project-service-internal --project-id repo --project-root /Users/sam/My Repo";
record("matches final flag values that contain spaces", "src/process-args.test.ts", "commandArgValueMatches", {
  args: spacedArgs,
  flag: "--project-root",
  expected: "/Users/sam/My Repo",
}, () => commandArgValueMatches(spacedArgs, "--project-root", "/Users/sam/My Repo"));
record("rejects partial final flag values that contain spaces", "src/process-args.test.ts", "commandArgValueMatches", {
  args: spacedArgs,
  flag: "--project-root",
  expected: "/Users/sam/My",
}, () => commandArgValueMatches(spacedArgs, "--project-root", "/Users/sam/My"));

record("splits whitespace separated args", "src/shell-args.test.ts", "parseShellArgs", {
  input: "--model gpt-5.5 --danger",
}, () => parseShellArgs("--model gpt-5.5 --danger"));
record("preserves quoted groups", "src/shell-args.test.ts", "parseShellArgs", {
  input: "--message \"hello world\" --name 'sam test'",
}, () => parseShellArgs("--message \"hello world\" --name 'sam test'"));
record("supports backslash escapes outside single quotes", "src/shell-args.test.ts", "parseShellArgs", {
  input: "--name hello\\ world --literal 'a\\b'",
}, () => parseShellArgs("--name hello\\ world --literal 'a\\b'"));
record("preserves empty quoted args", "src/shell-args.test.ts", "parseShellArgs", {
  input: '--empty "" --next',
}, () => parseShellArgs('--empty "" --next'));
record("rejects unterminated double quotes", "src/shell-args.test.ts", "parseShellArgs", {
  input: '--message "hello',
}, () => parseShellArgs('--message "hello'));
record("parses space-separated NAME=VALUE tokens", "src/shell-args.test.ts", "parseEnvAssignments", {
  input: "CLAUDE_YOLO=1 FOO=bar",
}, () => parseEnvAssignments("CLAUDE_YOLO=1 FOO=bar"));
record("returns an empty object for blank input", "src/shell-args.test.ts", "parseEnvAssignments", {
  input: "   ",
}, () => parseEnvAssignments("   "));
record("supports quoted env values with spaces", "src/shell-args.test.ts", "parseEnvAssignments", {
  input: 'MSG="hello world"',
}, () => parseEnvAssignments('MSG="hello world"'));
record("throws on a token that is not an assignment", "src/shell-args.test.ts", "parseEnvAssignments", {
  input: "FOO=bar --flag",
}, () => parseEnvAssignments("FOO=bar --flag"));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: ["src/process-args.test.ts", "src/shell-args.test.ts"],
  generatedBy: "scripts/capture-cli-parsing-contract.mjs",
  description: "CLI process-argument matching and shell/env assignment parsing captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
