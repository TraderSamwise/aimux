#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/launch/launcher-env.json", ROOT);
const launcher = await import(new URL("dist/launcher-env.js", ROOT));
const localLauncher = await import(new URL("dist/local-launcher-env.js", ROOT));
const { cliEntryFor, prepareStableCliEnv } = launcher;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `launch-launcher-env-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/launcher-env.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function prepared(env) {
  const copy = { ...env };
  prepareStableCliEnv(copy);
  return copy;
}
function routes(argvs) {
  return argvs.map((argv) => ({ argv, entry: cliEntryFor(argv) }));
}
function localRoutes(argvs) {
  return argvs.map((argv) => ({ argv, entry: localLauncher.cliEntryFor(argv) }));
}
async function captureWrapperCalls(distPath, dependencySpecifier, sourcePath) {
  const tempRoot = await mkdtemp(join(tmpdir(), "aimux-launcher-wrapper-"));
  const previousCalls = globalThis.__aimuxLauncherWrapperCalls;
  globalThis.__aimuxLauncherWrapperCalls = [];
  try {
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(tempRoot, basename(distPath)), readFileSync(new URL(distPath, ROOT), "utf8"));
    await writeFile(
      join(tempRoot, dependencySpecifier.startsWith("./") ? dependencySpecifier.slice(2) : dependencySpecifier),
      [
        "export function prepareStableCliEnv() { globalThis.__aimuxLauncherWrapperCalls.push('prepareStableCliEnv'); }",
        "export function runRoutedCli() { globalThis.__aimuxLauncherWrapperCalls.push('runRoutedCli'); }",
        "",
      ].join("\n"),
    );
    await import(`${pathToFileURL(join(tempRoot, basename(distPath))).href}?capture=${Date.now()}-${Math.random()}`);
    return { sourcePath, dependencySpecifier, calls: [...globalThis.__aimuxLauncherWrapperCalls] };
  } finally {
    if (previousCalls === undefined) delete globalThis.__aimuxLauncherWrapperCalls;
    else globalThis.__aimuxLauncherWrapperCalls = previousCalls;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

record("fills blank aimux defaults", "prepareStableCliEnv", { env: {} }, prepared({}));
record(
  "preserves explicit custom targeting",
  "prepareStableCliEnv",
  {
    env: {
      AIMUX_HOME: join(homedir(), ".aimux-scratch"),
      AIMUX_DAEMON_PORT: "44190",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
      AIMUX_SESSION_ID: "codex-custom",
    },
  },
  prepared({
    AIMUX_HOME: join(homedir(), ".aimux-scratch"),
    AIMUX_DAEMON_PORT: "44190",
    AIMUX_ENV: "development",
    AIMUX_WEB_APP_URL: "http://localhost:8081",
    AIMUX_SESSION_ID: "codex-custom",
  }),
);

record(
  "routes sidecar-owned control-plane commands to the lean core CLI",
  "cliEntryForBatch",
  {
    argvs: [
      ["node", "/p/bin/aimux", "host", "status"],
      ["node", "/p/bin/aimux", "daemon", "ensure"],
      ["node", "/p/bin/aimux", "daemon", "status", "--json"],
      ["node", "/p/bin/aimux", "daemon", "projects"],
      ["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "/p"],
      ["node", "/p/bin/aimux", "daemon", "restart"],
      ["node", "/p/bin/aimux", "daemon", "restart", "--json"],
      ["node", "/p/bin/aimux", "serve"],
      ["node", "/p/bin/aimux", "host", "stop"],
      ["node", "/p/bin/aimux", "host", "kill"],
      ["node", "/p/bin/aimux", "host", "restart"],
      ["node", "/p/bin/aimux", "host", "restart", "--serve"],
      ["node", "/p/bin/aimux", "host", "restart", "--open"],
      ["node", "/p/bin/aimux", "projects", "list"],
      ["node", "/p/bin/aimux", "remote", "status"],
      ["/Users/sam/.nvm/versions/node/v24.16.0/bin/node", "/p/bin/aimux", "remote", "status"],
      ["node", "/p/bin/aimux", "remote", "enable"],
      ["node", "/p/bin/aimux", "remote", "disable"],
    ],
  },
  routes([
    ["node", "/p/bin/aimux", "host", "status"],
    ["node", "/p/bin/aimux", "daemon", "ensure"],
    ["node", "/p/bin/aimux", "daemon", "status", "--json"],
    ["node", "/p/bin/aimux", "daemon", "projects"],
    ["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "/p"],
    ["node", "/p/bin/aimux", "daemon", "restart"],
    ["node", "/p/bin/aimux", "daemon", "restart", "--json"],
    ["node", "/p/bin/aimux", "serve"],
    ["node", "/p/bin/aimux", "host", "stop"],
    ["node", "/p/bin/aimux", "host", "kill"],
    ["node", "/p/bin/aimux", "host", "restart"],
    ["node", "/p/bin/aimux", "host", "restart", "--serve"],
    ["node", "/p/bin/aimux", "host", "restart", "--open"],
    ["node", "/p/bin/aimux", "projects", "list"],
    ["node", "/p/bin/aimux", "remote", "status"],
    ["/Users/sam/.nvm/versions/node/v24.16.0/bin/node", "/p/bin/aimux", "remote", "status"],
    ["node", "/p/bin/aimux", "remote", "enable"],
    ["node", "/p/bin/aimux", "remote", "disable"],
  ]),
);
const mainArgvs = [
  ["node", "/p/bin/aimux", "--debug", "remote", "status"],
  ["node", "/p/bin/aimux", "remote", "enable", "--debug"],
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "/p", "--trace"],
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "--log-level", "debug", "--project", "/p"],
  ["node", "/p/bin/aimux", "remote", "enable", "--help"],
  ["node", "/p/bin/aimux", "remote", "enable", "--json"],
  ["node", "/p/bin/aimux", "remote", "disable", "--dry-run"],
  ["node", "/p/bin/aimux", "remote", "enable", "extra"],
  ["node", "/p/bin/aimux", "daemon", "status", "extra"],
  ["node", "/p/bin/aimux", "projects", "list", "extra", "--json"],
  ["node", "/p/bin/aimux", "remote", "enable", "extra", "--debug"],
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "-h"],
  ["node", "/p/bin/aimux", "expose", "--project-root", "/p"],
  ["node", "/p/bin/aimux", "spawn"],
  ["node", "/p/bin/aimux", "daemon", "restart", "--project", "/p"],
  ["node", "/p/bin/aimux", "serve", "--json"],
  ["node", "/p/bin/aimux", "host", "stop", "--open"],
  ["node", "/p/bin/aimux", "host", "agent-stream", "claude-1"],
  ["node", "/p/bin/aimux", "dashboard-reload", "--client-tty=-x"],
  ["node", "/p/bin/aimux", "restart-runtime", "--project-root=-x"],
  ["node", "/p/bin/aimux", "remote", "unlock"],
  ["node", "/p/bin/aimux", "--help"],
  ["node", "/p/bin/aimux"],
];
record("keeps runtime and help commands on the full CLI", "cliEntryForBatch", { argvs: mainArgvs }, routes(mainArgvs));
record(
  "local source-checkout launcher uses the same core/main/expose routing",
  "localCliEntryForBatch",
  { argvs: [...mainArgvs, ["node", "/p/bin/aimux", "daemon", "status"], ["node", "/p/bin/aimux", "expose"]] },
  localRoutes([...mainArgvs, ["node", "/p/bin/aimux", "daemon", "status"], ["node", "/p/bin/aimux", "expose"]]),
);
const repairArgvs = [
  ["node", "/p/bin/aimux", "dashboard-reload"],
  ["node", "/p/bin/aimux", "dashboard-reload", "--open", "--client-tty", "/dev/ttys001"],
  ["node", "/p/bin/aimux", "restart-runtime"],
  ["node", "/p/bin/aimux", "restart-runtime", "--project-root=/p", "--current-client-session=aimux-repo-client-1234abcd"],
];
record("routes the repair commands to main, which is the only place they exist", "cliEntryForBatch", { argvs: repairArgvs }, routes(repairArgvs));
const malformedArgvs = [
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "--json"],
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "--dry-run"],
  ["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "--json", "--debug"],
];
record("routes malformed project-ensure to core so it cannot mutate through Commander parsing", "cliEntryForBatch", { argvs: malformedArgvs }, routes(malformedArgvs));
record(
  "launcher wrapper prepares the stable environment before routing",
  "launcherWrapperCalls",
  { distPath: "dist/launcher-bin.js", dependencySpecifier: "./launcher-env.js", sourcePath: "src/launcher-bin.ts" },
  await captureWrapperCalls("dist/launcher-bin.js", "./launcher-env.js", "src/launcher-bin.ts"),
);
record(
  "local launcher wrapper prepares the stable environment before routing",
  "launcherWrapperCalls",
  {
    distPath: "dist/local-launcher-bin.js",
    dependencySpecifier: "./local-launcher-env.js",
    sourcePath: "src/local-launcher-bin.ts",
  },
  await captureWrapperCalls("dist/local-launcher-bin.js", "./local-launcher-env.js", "src/local-launcher-bin.ts"),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: ["src/launcher-env.test.ts", "src/launcher-bin.ts", "src/local-launcher-bin.ts", "src/local-launcher-env.ts"],
  generatedBy: "scripts/capture-launcher-env-contract.mjs",
  description:
    "Stable CLI environment defaults, launcher core/main/expose routing, and entrypoint wrapper side effects captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
