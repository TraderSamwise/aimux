#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/session-bootstrap/action-args.json", ROOT);
const { SessionBootstrapService } = await import(new URL("dist/session-bootstrap.js", ROOT));

const bootstrap = SessionBootstrapService.prototype;
const UUID = "019ec656-fbab-7cb2-b842-b7831add8c80";
const NEW_ID = "NEW-ID";
const CLAUDE = {
  args: ["--dangerously-skip-permissions"],
  resumeArgs: ["--resume", "{sessionId}"],
  resumeFallback: ["--continue"],
  forkArgs: ["--resume", "{sessionId}", "--fork-session"],
};
const CODEX = {
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  resumeArgs: ["resume", "{sessionId}"],
  resumeFallback: ["resume", "--last"],
  forkArgs: ["fork", "{sessionId}"],
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const strip = (toolCfg, args) => bootstrap.stripToolActionArgs.call(bootstrap, toolCfg, args);
const compose = (toolCfg, action, saved) => bootstrap.composeToolLaunch.call(bootstrap, toolCfg, action, saved);
const resumeVerbCount = (args) => args.filter((arg) => arg === "resume" || arg === "--resume").length;

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `session-bootstrap-action-args-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/session-bootstrap-action-args.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function recordStripBatch(name, items) {
  record(
    name,
    "stripToolActionArgsBatch",
    { items },
    items.map(({ toolCfg, args }) => ({ toolCfg, args, stripped: strip(toolCfg, args) })),
  );
}

recordStripBatch("repairs the shapes actually found on disk", [
  { toolCfg: CODEX, args: ["resume"] },
  { toolCfg: CODEX, args: ["resume", UUID] },
  { toolCfg: CODEX, args: ["--dangerously-bypass-approvals-and-sandbox", "resume"] },
  { toolCfg: CODEX, args: ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID] },
  { toolCfg: CLAUDE, args: ["--dangerously-skip-permissions", "--resume", UUID] },
]);
recordStripBatch("takes the verb without the id, leaving fallback-shaped user args alone", [
  { toolCfg: CODEX, args: ["resume"] },
  { toolCfg: CLAUDE, args: ["--resume"] },
  { toolCfg: CODEX, args: ["resume", "--last"] },
  { toolCfg: CLAUDE, args: ["--continue"] },
  { toolCfg: { ...CLAUDE, resumeArgs: undefined, forkArgs: undefined }, args: ["--continue"] },
]);
recordStripBatch("leaves everything that is not one of this tool's own verbs", [
  { toolCfg: CLAUDE, args: ["--model", "opus", "--verbose"] },
  { toolCfg: CLAUDE, args: ["resume", UUID] },
  { toolCfg: CODEX, args: ["--resume", UUID] },
  { toolCfg: undefined, args: ["--resume", UUID] },
]);
recordStripBatch("keeps a real argument that merely follows a verb", [
  { toolCfg: CLAUDE, args: ["--resume", "--model", "opus"] },
]);
recordStripBatch("does not let an embedded placeholder swallow the next argument", [
  { toolCfg: { args: [], resumeArgs: ["--resume={sessionId}"] }, args: ["--model", "opus"] },
]);

record(
  "launches with the verb and remembers without it",
  "composeToolLaunch",
  {
    toolCfg: CODEX,
    action: ["resume", UUID],
    saved: ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.5"],
  },
  compose(CODEX, ["resume", UUID], ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.5"]),
);

let remembered = ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID];
const repeated = [];
for (let launchCount = 0; launchCount < 3; launchCount += 1) {
  const result = compose(CODEX, ["resume", UUID], remembered);
  repeated.push({
    launchCount,
    launch: result.launch,
    persist: result.persist,
    resumeVerbCount: result.launch.filter((arg) => arg === "resume").length,
  });
  remembered = result.persist;
}
record(
  "stays put when the same session is launched again and again",
  "composeRepeatedLaunch",
  {
    toolCfg: CODEX,
    action: ["resume", UUID],
    saved: ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID],
    iterations: 3,
  },
  repeated,
);

const onDisk = [
  [CODEX, ["resume"]],
  [CODEX, ["resume", UUID]],
  [CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume"]],
  [CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID]],
  [CLAUDE, ["--dangerously-skip-permissions", "--resume", UUID]],
];
record(
  "each on-disk row launches with one verb and is remembered with none",
  "composeOnDiskRows",
  {
    rows: onDisk.map(([toolCfg, saved]) => ({ toolCfg, saved })),
    newId: NEW_ID,
  },
  onDisk.map(([toolCfg, saved]) => {
    const action = toolCfg.resumeArgs.map((arg) => arg.replace("{sessionId}", NEW_ID));
    const result = compose(toolCfg, action, saved);
    return {
      saved,
      launch: result.launch,
      persist: result.persist,
      resumeVerbCount: resumeVerbCount(result.launch),
      containsNewId: result.launch.includes(NEW_ID),
    };
  }),
);
const bugTool = onDisk[3][0];
const bugSaved = onDisk[3][1];
const bugAction = bugTool.resumeArgs.map((arg) => arg.replace("{sessionId}", NEW_ID));
const bugFirst = compose(bugTool, bugAction, bugSaved);
const bugRelaunched = compose(bugTool, bugAction, bugFirst.launch);
record(
  "would have caught the persisted-launch relaunch bug",
  "composePersistedLaunchRegression",
  {
    toolCfg: bugTool,
    action: bugAction,
    saved: bugSaved,
  },
  {
    launch: bugFirst.launch,
    launchResumeCount: bugFirst.launch.filter((arg) => arg === "resume").length,
    relaunched: bugRelaunched.launch,
    relaunchedResumeCount: bugRelaunched.launch.filter((arg) => arg === "resume").length,
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/session-bootstrap-action-args.test.ts",
  generatedBy: "scripts/capture-session-bootstrap-action-args-contract.mjs",
  description: "Session bootstrap launch action argument stripping and launch/persist composition captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
