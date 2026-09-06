#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/process/inspector.json", ROOT);

const tempBin = mkdtempSync(join(tmpdir(), "aimux-process-inspector-bin-"));
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${tempBin}:${originalPath}`;

writeFileSync(
  join(tempBin, "ps"),
  `#!/bin/sh
case "$AIMUX_PROCESS_CASE" in
  read-args) printf 'node dist/launcher-bin.js --flag\\n' ;;
  read-empty) printf '\\n' ;;
  read-error) exit 1 ;;
  list-args) printf '  12 node a\\nbad\\n  34 /bin/sh -c echo ok\\n' ;;
  project-exact) printf 'node dist/launcher-bin.js __project-service-internal --project-id aimux-1 --project-root /tmp/aimux\\n' ;;
  project-non-service) printf 'node dist/launcher-bin.js daemon\\n' ;;
  legacy-service) printf 'node /opt/aimux/dist/main.js __project-service-internal\\n' ;;
  *) printf '' ;;
esac
`,
);
writeFileSync(
  join(tempBin, "lsof"),
  `#!/bin/sh
case "$AIMUX_PROCESS_CASE" in
  read-cwd|legacy-service) printf 'p123\\nn/Users/sam/cs/aimux\\n' ;;
  *) printf '' ;;
esac
`,
);
chmodSync(join(tempBin, "ps"), 0o755);
chmodSync(join(tempBin, "lsof"), 0o755);

const inspector = await import(new URL("dist/process-inspector.js", ROOT));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function withProcessCase(name, fn) {
  process.env.AIMUX_PROCESS_CASE = name;
  try {
    return fn();
  } finally {
    delete process.env.AIMUX_PROCESS_CASE;
  }
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `process-inspector-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/process-inspector.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "reads process args from ps stdout",
  "readProcessArgs",
  { pid: 123, psStdout: "node dist/launcher-bin.js --flag\n", psStatus: 0 },
  withProcessCase("read-args", () => inspector.readProcessArgs(123)),
);

record(
  "returns null when process args cannot be read",
  "readProcessArgs",
  { pid: 123, psStdout: "", psStatus: 1 },
  withProcessCase("read-error", () => inspector.readProcessArgs(123)),
);

record(
  "lists process args from ps output",
  "listProcessArgs",
  { psStdout: "  12 node a\nbad\n  34 /bin/sh -c echo ok\n" },
  withProcessCase("list-args", () => inspector.listProcessArgs()),
);

record(
  "reads process cwd from lsof output",
  "readProcessCwd",
  { pid: 123, lsofStdout: "p123\nn/Users/sam/cs/aimux\n" },
  withProcessCase("read-cwd", () => inspector.readProcessCwd(123)),
);

for (const state of ["Z+", "S+", "  Z", ""]) {
  record("maps process state to exited boolean", "isExitedProcessState", { state }, inspector.isExitedProcessState(state));
}

record(
  "verifies project service identity by exact project id and root args",
  "isAimuxProjectServiceProcess",
  {
    pid: 123,
    psStdout: "node dist/launcher-bin.js __project-service-internal --project-id aimux-1 --project-root /tmp/aimux\n",
    expected: { projectId: "aimux-1", projectRoot: "/tmp/aimux" },
  },
  withProcessCase("project-exact", () =>
    inspector.isAimuxProjectServiceProcess(123, { projectId: "aimux-1", projectRoot: "/tmp/aimux" }),
  ),
);

record(
  "rejects prefix-only project service identities",
  "isAimuxProjectServiceProcess",
  {
    pid: 123,
    psStdout: "node dist/launcher-bin.js __project-service-internal --project-id aimux-1 --project-root /tmp/aimux\n",
    expected: { projectId: "aimux", projectRoot: "/tmp/aim" },
  },
  withProcessCase("project-exact", () =>
    inspector.isAimuxProjectServiceProcess(123, { projectId: "aimux", projectRoot: "/tmp/aim" }),
  ),
);

record(
  "falls back to cwd for legacy project services without identity args",
  "isAimuxProjectServiceProcess",
  {
    pid: 123,
    psStdout: "node /opt/aimux/dist/main.js __project-service-internal\n",
    lsofStdout: "p123\nn/Users/sam/cs/aimux\n",
    expected: { projectRoot: "/Users/sam/cs/aimux" },
  },
  withProcessCase("legacy-service", () =>
    inspector.isAimuxProjectServiceProcess(123, { projectRoot: "/Users/sam/cs/aimux" }),
  ),
);

record(
  "rejects non project-service processes",
  "isAimuxProjectServiceProcess",
  {
    pid: 123,
    psStdout: "node dist/launcher-bin.js daemon\n",
    expected: { projectId: "aimux-1" },
  },
  withProcessCase("project-non-service", () => inspector.isAimuxProjectServiceProcess(123, { projectId: "aimux-1" })),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/process-inspector.test.ts",
  generatedBy: "scripts/capture-process-inspector-contract.mjs",
  description:
    "Process args, process list, cwd, exited-state, and project-service identity contracts captured by running TypeScript process-inspector helpers against fake ps/lsof commands.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);

process.env.PATH = originalPath;
rmSync(tempBin, { recursive: true, force: true });
