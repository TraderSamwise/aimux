#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-takeover/takeover.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeString(value, replacements) {
  let normalized = value;
  for (const [needle, token] of replacements) {
    normalized = normalized.split(needle).join(token);
  }
  return normalized;
}

function normalize(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested, replacements)]));
  }
  return typeof value === "string" ? normalizeString(value, replacements) : value;
}

function listen() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: req.url,
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      res.writeHead(process.env.AIMUX_TAKEOVER_HTTP_STATUS === "500" ? 500 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(process.env.AIMUX_TAKEOVER_HTTP_STATUS === "500" ? { ok: false } : { ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

const tempBin = mkdtempSync(join(tmpdir(), "aimux-project-takeover-bin-"));
writeFileSync(
  join(tempBin, "ps"),
  `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "stat=" ]; then
  printf 'S\\n'
  exit 0
fi
case "$AIMUX_TAKEOVER_MODE" in
  exact) printf 'node /opt/aimux/dist/launcher-bin.js __project-service-internal --project-id %s --project-root %s\\n' "$AIMUX_TAKEOVER_PROJECT_ID" "$AIMUX_TAKEOVER_PROJECT_ROOT" ;;
  sleep) printf 'sleep 999\\n' ;;
  prefix) printf 'node /opt/aimux/dist/launcher-bin.js __project-service-internal --project-id %s-old --project-root %s-old\\n' "$AIMUX_TAKEOVER_PROJECT_ID" "$AIMUX_TAKEOVER_PROJECT_ROOT" ;;
  legacy) printf 'node /opt/aimux/dist/main.js __project-service-internal\\n' ;;
  *) printf '' ;;
esac
`,
);
writeFileSync(
  join(tempBin, "lsof"),
  `#!/bin/sh
printf 'p%s\\nfcwd\\nn%s\\n' "$3" "$AIMUX_TAKEOVER_PROJECT_ROOT"
`,
);
chmodSync(join(tempBin, "ps"), 0o755);
chmodSync(join(tempBin, "lsof"), 0o755);

const originalPath = process.env.PATH ?? "";
const originalKill = process.kill;
process.env.PATH = `${tempBin}:${originalPath}`;

const paths = await import(new URL("dist/paths.js", ROOT));
const { takeOverProjectFromOtherOwners } = await import(new URL("dist/project-takeover.js", ROOT));

const cases = [];
function record(name, input, output) {
  cases.push({
    id: `project-takeover-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-takeover.test.ts",
    api: "takeOverProjectFromOtherOwners",
    input,
    output,
    inputSha256: hash(input),
  });
}

async function runScenario(name, options) {
  const tempRoot = mkdtempSync(join(tmpdir(), "aimux-project-takeover-contract-"));
  const defaultHome = join(tempRoot, ".aimux");
  const currentHome = join(tempRoot, ".aimux-custom");
  const projectRoot = join(tempRoot, "repo-a");
  const otherProjectRoot = join(tempRoot, "repo-b");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  mkdirSync(join(otherProjectRoot, ".git"), { recursive: true });
  const projectId = paths.getProjectIdFor(projectRoot);
  const otherProjectId = paths.getProjectIdFor(otherProjectRoot);
  const projectStateDir = join(defaultHome, "projects", projectId);
  const server = await listen();
  const livePids = new Set([1001, 2001, 2002]);
  const killed = [];
  const replacements = [
    [tempRoot, "<tempRoot>"],
    [projectRoot, "<projectRoot>"],
    [otherProjectRoot, "<otherProjectRoot>"],
    [defaultHome, "<defaultHome>"],
    [currentHome, "<currentHome>"],
    [projectId, "<projectId>"],
    [otherProjectId, "<otherProjectId>"],
  ];
  const previous = {
    home: process.env.HOME,
    aimuxHome: process.env.AIMUX_HOME,
    mode: process.env.AIMUX_TAKEOVER_MODE,
    projectId: process.env.AIMUX_TAKEOVER_PROJECT_ID,
    projectRoot: process.env.AIMUX_TAKEOVER_PROJECT_ROOT,
    httpStatus: process.env.AIMUX_TAKEOVER_HTTP_STATUS,
  };
  process.env.HOME = tempRoot;
  process.env.AIMUX_HOME = currentHome;
  process.env.AIMUX_TAKEOVER_MODE = options.mode;
  process.env.AIMUX_TAKEOVER_PROJECT_ID = projectId;
  process.env.AIMUX_TAKEOVER_PROJECT_ROOT = projectRoot;
  if (options.httpStatus) process.env.AIMUX_TAKEOVER_HTTP_STATUS = String(options.httpStatus);
  else delete process.env.AIMUX_TAKEOVER_HTTP_STATUS;
  process.kill = ((pid, signal) => {
    const numericPid = Number(pid);
    if (!livePids.has(numericPid)) throw new Error(`pid ${numericPid} not alive`);
    if (signal && signal !== 0) {
      killed.push([numericPid, signal]);
      livePids.delete(numericPid);
    }
    return true;
  });
  try {
    mkdirSync(join(defaultHome, "daemon"), { recursive: true });
    mkdirSync(projectStateDir, { recursive: true });
    writeJson(join(defaultHome, "daemon", "daemon.json"), { pid: 1001, port: server.port });
    writeJson(join(defaultHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      projects: {
        [projectId]: { pid: 2001, projectRoot },
        ...(options.includeOtherProject ? { [otherProjectId]: { pid: 2002, projectRoot: otherProjectRoot } } : {}),
      },
    });
    if (options.writeTopology) writeFileSync(join(projectStateDir, "runtime-topology.yaml"), options.writeTopology);
    writeJson(join(projectStateDir, "metadata-api.json"), { host: "127.0.0.1", port: server.port });
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `http://127.0.0.1:${server.port}\n`);
    if (options.writeHostJson) writeJson(join(projectStateDir, "host.json"), { legacy: true });

    await takeOverProjectFromOtherOwners(projectRoot);

    const statePath = join(defaultHome, "daemon", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const output = {
      requests: server.requests,
      killed,
      livePids: [...livePids].sort((a, b) => a - b),
      stateProjectIds: Object.keys(state.projects ?? {}).sort(),
      files: {
        metadataJson: existsSync(join(projectStateDir, "metadata-api.json")),
        metadataText: existsSync(join(projectStateDir, "metadata-api.txt")),
        hostJson: existsSync(join(projectStateDir, "host.json")),
        topology: options.writeTopology ? readFileSync(join(projectStateDir, "runtime-topology.yaml"), "utf8") : null,
      },
    };
    record(name, normalize({ ...options, projectRoot, otherProjectRoot }, replacements), normalize(output, replacements));
  } finally {
    server.server.close();
    process.kill = originalKill;
    process.env.PATH = `${tempBin}:${originalPath}`;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.aimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous.aimuxHome;
    if (previous.mode === undefined) delete process.env.AIMUX_TAKEOVER_MODE;
    else process.env.AIMUX_TAKEOVER_MODE = previous.mode;
    if (previous.projectId === undefined) delete process.env.AIMUX_TAKEOVER_PROJECT_ID;
    else process.env.AIMUX_TAKEOVER_PROJECT_ID = previous.projectId;
    if (previous.projectRoot === undefined) delete process.env.AIMUX_TAKEOVER_PROJECT_ROOT;
    else process.env.AIMUX_TAKEOVER_PROJECT_ROOT = previous.projectRoot;
    if (previous.httpStatus === undefined) delete process.env.AIMUX_TAKEOVER_HTTP_STATUS;
    else process.env.AIMUX_TAKEOVER_HTTP_STATUS = previous.httpStatus;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await runScenario("stops only the matching project service in the default aimux home", {
  mode: "exact",
  includeOtherProject: true,
  writeHostJson: true,
});
await runScenario("preserves the default owner topology while clearing stale connection files", {
  mode: "exact",
  includeOtherProject: false,
  writeTopology: "version: 1\nsessions:\n  - id: codex-custom\n    status: offline\n",
});
await runScenario("does not signal a stale pid that is not an aimux project service", {
  mode: "sleep",
  includeOtherProject: false,
  httpStatus: 500,
});
await runScenario("does not signal a stale pid whose project root only prefix-matches", {
  mode: "prefix",
  includeOtherProject: false,
  httpStatus: 500,
});
await runScenario("accepts legacy project service pids only when cwd matches the project", {
  mode: "legacy",
  includeOtherProject: false,
  httpStatus: 500,
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-takeover.test.ts",
  generatedBy: "scripts/capture-project-takeover-contract.mjs",
  description:
    "Project takeover alternate-owner stop requests, stale project state cleanup, endpoint file removal, topology preservation, and process-signal decisions captured by running TypeScript project-takeover against fake ps/lsof and a local daemon endpoint.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);

process.env.PATH = originalPath;
process.kill = originalKill;
rmSync(tempBin, { recursive: true, force: true });
