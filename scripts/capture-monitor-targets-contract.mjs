#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/monitor/targets.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function transpile(path) {
  const url = new URL(path, ROOT);
  const source = await readFile(url, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const statusToneUrl = moduleUrl(await transpile("app/lib/status-tone.ts"));
const agentDisplayUrl = moduleUrl(
  (await transpile("app/lib/agent-display.ts")).replace(
    /from ["']@\/lib\/status-tone["'];/g,
    `from "${statusToneUrl}";`,
  ),
);
const projectConnectionUrl = moduleUrl(await transpile("app/lib/project-connection-display.ts"));
const monitorTargetsUrl = moduleUrl(
  (await transpile("app/lib/monitor-targets.ts"))
    .replace(/from ["']@\/lib\/agent-display["'];/g, `from "${agentDisplayUrl}";`)
    .replace(/from ["']@\/lib\/project-connection-display["'];/g, `from "${projectConnectionUrl}";`),
);

const {
  monitorProjectTargetId,
  monitorSessionTargetsForProject,
  monitorSharedTargetId,
  monitorSharedTargets,
  monitorTargetLabel,
  targetMatchesSettings,
} = await import(monitorTargetsUrl);

const project = {
  id: "project-1",
  name: "aimux",
  path: "/repo/aimux",
  dashboardSessionName: "aimux",
  service: null,
  serviceAlive: true,
  serviceEndpoint: { host: "127.0.0.1", port: 43192 },
};
const state = {
  ok: true,
  sessions: [
    { id: "claude-1", status: "running", label: "Claude" },
    { id: "overseer-1", status: "running", label: "Overseer", overseer: true },
    { id: "scribe-1", status: "running", label: "Scribe", scribe: true },
    { id: "dead-1", status: "exited", label: "Dead" },
  ],
  services: [],
  worktrees: [],
};
const settings = {
  intervalSeconds: 10,
  targetKind: "project-agent",
  captureMode: "camera",
  cameraViewport: { centerX: 0.5, centerY: 0.5, zoom: 1 },
  speechToText: true,
  speechOnDeviceOnly: true,
  speechInterimResults: true,
  speechLanguage: "en-US",
  audioSampleRate: 16000,
  projectPath: "/repo/aimux",
  sessionId: "claude-1",
  shareOwnerUserId: null,
  shareId: null,
};
const share = {
  shareId: "share-1",
  ownerUserId: "owner-1",
  projectRoot: "/repo/scratch",
  sessionId: "claude-2",
  serviceEndpoint: { host: "relay", port: 443 },
  acceptedAt: "2026-08-14T00:00:00.000Z",
};

function run(input) {
  if (input.api === "monitorSessionTargetsForProject") return monitorSessionTargetsForProject(input.project, input.state);
  if (input.api === "monitorSharedTargets") return monitorSharedTargets(input.shares);
  if (input.api === "targetMatchesSettings") return targetMatchesSettings(input.target, input.settings);
  if (input.api === "monitorTargetLabel") return monitorTargetLabel(input.target);
  if (input.api === "monitorProjectTargetId") return monitorProjectTargetId(input.projectPath, input.sessionId);
  if (input.api === "monitorSharedTargetId") return monitorSharedTargetId(input.ownerUserId, input.shareId);
  throw new Error(`unknown api ${input.api}`);
}

const [projectTarget] = monitorSessionTargetsForProject(project, state);
const [sharedTarget] = monitorSharedTargets([share]);
const generatedState = {
  ...state,
  sessions: [{ id: "codex-o6o4kf", status: "running", label: "codex-o6o4kf", command: "codex --model gpt-5.5", role: "coder" }],
};

const inputs = [
  { name: "lists only active non-control project sessions", api: "monitorSessionTargetsForProject", project, state },
  { name: "collapses generated agent labels in monitor presentation labels", api: "monitorSessionTargetsForProject", project, state: generatedState },
  { name: "does not expose project sessions while host service is unavailable", api: "monitorSessionTargetsForProject", project: { ...project, serviceAlive: false }, state },
  { name: "maps shared chat sessions into monitor targets", api: "monitorSharedTargets", shares: [share] },
  { name: "matches persisted project target selections", api: "targetMatchesSettings", target: projectTarget, settings },
  { name: "matches persisted shared target selections", api: "targetMatchesSettings", target: sharedTarget, settings: { ...settings, targetKind: "shared-chat", projectPath: "/repo/scratch", sessionId: "claude-2", shareOwnerUserId: "owner-1", shareId: "share-1" } },
  { name: "rejects project target selection mismatch", api: "targetMatchesSettings", target: projectTarget, settings: { ...settings, sessionId: "other" } },
  { name: "labels project targets with project and session", api: "monitorTargetLabel", target: projectTarget },
  { name: "labels shared targets as shared chat", api: "monitorTargetLabel", target: sharedTarget },
  { name: "labels missing targets with chooser copy", api: "monitorTargetLabel", target: null },
  { name: "builds project target ids", api: "monitorProjectTargetId", projectPath: "/repo/aimux", sessionId: "claude-1" },
  { name: "builds shared target ids", api: "monitorSharedTargetId", ownerUserId: "owner-1", shareId: "share-1" },
];

const cases = inputs.map((input, index) => ({
  id: `monitor-targets-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/monitor-targets.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/monitor-targets.test.ts",
  generatedBy: "scripts/capture-monitor-targets-contract.mjs",
  description:
    "App monitor project/shared target filtering, generated-label presentation, persisted settings matching, target labels, and stable target id behavior captured by running TypeScript monitor-targets helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
