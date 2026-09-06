#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/connection-targets/targets.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, source, api, input, output) => ({
  id: `connection-targets-${String(index + 1).padStart(3, "0")}`,
  name,
  source,
  api,
  input,
  output,
  inputSha256: hash(input),
});

const cliTargets = await import(new URL("dist/connection-targets.js", ROOT));

function compileAppModule(tempRoot, relativePath) {
  const sourcePath = new URL(relativePath, ROOT).pathname;
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const outPath = join(tempRoot, relativePath.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, transpiled);
}

async function loadAppTargets() {
  const tempRoot = mkdtempSync(join(tmpdir(), "aimux-connection-targets-app-"));
  try {
    mkdirSync(join(tempRoot, "node_modules", "react-native"), { recursive: true });
    writeFileSync(join(tempRoot, "node_modules", "react-native", "index.js"), "exports.Platform = { OS: 'web' };\n");
    compileAppModule(tempRoot, "app/lib/envRuntime.ts");
    compileAppModule(tempRoot, "app/lib/connection-targets.ts");
    return {
      tempRoot,
      module: await import(`file://${join(tempRoot, "app/lib/connection-targets.js")}`),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

const ORIGINAL_ENV = { ...process.env };
function setExactEnv(env) {
  for (const key of [
    "AIMUX_ENV",
    "AIMUX_HOME",
    "AIMUX_DAEMON_PORT",
    "AIMUX_WEB_APP_URL",
    "AIMUX_RELAY_URL",
    "NODE_ENV",
    "EXPO_PUBLIC_AIMUX_CONNECTION_MODE",
    "EXPO_PUBLIC_AIMUX_DAEMON_URL",
    "EXPO_PUBLIC_AIMUX_RELAY_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}
function restoreEnv() {
  process.env = ORIGINAL_ENV;
}

function captureError(fn) {
  try {
    return fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const cases = [];
const add = (name, source, api, env, outputFn) => {
  setExactEnv(env);
  const input = { env };
  cases.push(recordCase(cases.length, name, source, api, input, outputFn()));
};

add("defaults production CLI login to the hosted app and relay", "src/connection-targets.test.ts", "cliTargets", {}, () => ({
  webAppUrl: cliTargets.resolveWebAppUrl(),
  relayUrl: cliTargets.resolveRelayUrl(),
}));
add(
  "defaults development CLI login to local web while keeping the production relay",
  "src/connection-targets.test.ts",
  "cliTargets",
  { AIMUX_ENV: "development" },
  () => ({ webAppUrl: cliTargets.resolveWebAppUrl(), relayUrl: cliTargets.resolveRelayUrl() }),
);
add(
  "allows explicit web app and relay overrides",
  "src/connection-targets.test.ts",
  "cliTargets",
  {
    AIMUX_ENV: "development",
    AIMUX_WEB_APP_URL: "https://preview.example.com/",
    AIMUX_RELAY_URL: "wss://relay-preview.example.com/",
  },
  () => ({ webAppUrl: cliTargets.resolveWebAppUrl(), relayUrl: cliTargets.resolveRelayUrl() }),
);
add(
  "ignores blank CLI target overrides",
  "src/connection-targets.test.ts",
  "cliTargets",
  { AIMUX_ENV: "development", AIMUX_WEB_APP_URL: "   ", AIMUX_RELAY_URL: "" },
  () => ({ webAppUrl: cliTargets.resolveWebAppUrl(), relayUrl: cliTargets.resolveRelayUrl() }),
);
for (const [name, env] of [
  ["is false with no lane signals", {}],
  ["detects dev from AIMUX_ENV", { AIMUX_ENV: "development" }],
  ["does not infer development from a custom home", { AIMUX_HOME: "/tmp/aimux-custom" }],
  ["does not infer development from a custom daemon port", { AIMUX_DAEMON_PORT: "44190" }],
  ["does not infer development from an explicit local web app url", { AIMUX_WEB_APP_URL: "http://localhost:8081" }],
]) {
  add(name, "src/connection-targets.test.ts", "cliDevelopment", env, () => ({ development: cliTargets.isDevelopmentRuntime() }));
}

const appTargets = await loadAppTargets();
try {
  add("defaults development app builds to local daemon mode", "app/lib/connection-targets.test.ts", "app", { NODE_ENV: "development" }, () => ({
    mode: appTargets.module.resolveAppConnectionMode(),
    daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
    relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
  }));
  add("defaults production app builds to hosted relay mode", "app/lib/connection-targets.test.ts", "app", { NODE_ENV: "production" }, () => ({
    mode: appTargets.module.resolveAppConnectionMode(),
    daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
    relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
  }));
  add(
    "allows explicit app relay target override",
    "app/lib/connection-targets.test.ts",
    "app",
    {
      NODE_ENV: "development",
      EXPO_PUBLIC_AIMUX_CONNECTION_MODE: "relay",
      EXPO_PUBLIC_AIMUX_RELAY_URL: "wss://relay-preview.example.com/",
    },
    () => ({
      mode: appTargets.module.resolveAppConnectionMode(),
      daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
      relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
    }),
  );
  add(
    "allows explicit app local daemon target override",
    "app/lib/connection-targets.test.ts",
    "app",
    {
      NODE_ENV: "development",
      EXPO_PUBLIC_AIMUX_CONNECTION_MODE: "local",
      EXPO_PUBLIC_AIMUX_DAEMON_URL: "http://localhost:43210/",
    },
    () => ({
      mode: appTargets.module.resolveAppConnectionMode(),
      daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
      relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
    }),
  );
  add(
    "does not let app relay URL override switch development default",
    "app/lib/connection-targets.test.ts",
    "app",
    { NODE_ENV: "development", EXPO_PUBLIC_AIMUX_RELAY_URL: "wss://relay-preview.example.com/" },
    () => ({
      mode: appTargets.module.resolveAppConnectionMode(),
      daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
      relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
    }),
  );
  add(
    "does not let app daemon URL override switch production default",
    "app/lib/connection-targets.test.ts",
    "app",
    { NODE_ENV: "production", EXPO_PUBLIC_AIMUX_DAEMON_URL: "http://localhost:43210/" },
    () => ({
      mode: appTargets.module.resolveAppConnectionMode(),
      daemonUrl: appTargets.module.resolveAppDaemonUrl() ?? null,
      relayUrl: appTargets.module.resolveAppRelayUrl() ?? null,
    }),
  );
  add(
    "rejects invalid explicit app connection modes",
    "app/lib/connection-targets.test.ts",
    "app",
    { EXPO_PUBLIC_AIMUX_CONNECTION_MODE: "remote" },
    () => captureError(() => appTargets.module.resolveAppConnectionMode()),
  );
} finally {
  rmSync(appTargets.tempRoot, { recursive: true, force: true });
  restoreEnv();
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/connection-targets.test.ts + app/lib/connection-targets.test.ts",
  generatedBy: "scripts/capture-connection-targets-contract.mjs",
  description: "CLI and app connection target resolution contracts captured by running TypeScript resolvers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
