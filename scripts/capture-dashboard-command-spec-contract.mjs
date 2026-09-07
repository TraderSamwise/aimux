#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/command-spec.json", ROOT);
const { prepareStableCliEnv } = await import(new URL("dist/launcher-defaults.js", ROOT));
const { getDashboardCommandSpec } = await import(new URL("dist/dashboard/command-spec.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rootPath = ROOT.pathname.replace(/\/$/, "");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, tempDir = "") {
  const stamps = new Map();
  let nextStamp = 1;
  let json = JSON.stringify(value).split(rootPath).join("<REPO>");
  if (tempDir) {
    json = json.split(tempDir).join("<TMP>");
  }
  return JSON.parse(
    json.replace(/[0-9a-f]{16}-[0-9a-f]{64}/g, (stamp) => {
      if (!stamps.has(stamp)) stamps.set(stamp, `<stamp:${nextStamp++}>`);
      return stamps.get(stamp);
    }),
  );
}

function summarizeSpec(spec) {
  const command = spec.dashboardCommand.args[1] ?? "";
  return {
    scriptPath: spec.scriptPath,
    dashboardBuildStamp: spec.dashboardBuildStamp,
    dashboardCommand: spec.dashboardCommand,
    derived: {
      shellSyntaxOk: spawnSync("bash", ["-n", "-c", command], { encoding: "utf-8" }).status === 0,
      usesBashWrapper: spec.dashboardCommand.command === "bash" && spec.dashboardCommand.args[0] === "-lc",
      includesLegacyNodeDashboardEntrypoint: command.includes("--tmux-dashboard-internal"),
      includesNativeDashboardEntrypoint: command.includes("__dashboard-internal-native"),
      quotesPrintfNewline: command.includes("printf '%s\\n'"),
      hasExitCleanupTrap: command.includes(`trap 'rm -f "$output_file"' EXIT`),
      hasSignalCleanupTrap: command.includes(`trap 'rm -f "$output_file"; exit 130' INT TERM HUP`),
      appendsSharedDebugLog: command.includes("/tmp/aimux-debug.log") || command.includes("tee -a"),
      printsStartupFrameBeforeEntrypoint:
        command.indexOf("Starting Aimux dashboard...") >= 0 &&
        command.indexOf("--tmux-dashboard-internal") > command.indexOf("Starting Aimux dashboard..."),
      entersAlternateScreenBeforeStartup: command.includes("\x1b[?1049h"),
    },
  };
}

function record(cases, name, input, run, tempDir = "") {
  const output = run();
  const normalizedInput = normalize(input, tempDir);
  cases.push({
    id: `dashboard-command-spec-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/dashboard/command-spec.test.ts",
    api: "getDashboardCommandSpec",
    input: normalizedInput,
    output: normalize(output, tempDir),
    inputSha256: hash(normalizedInput),
  });
}

function createNativeInstall(tempDir, label, mtimeMs, nativeContents = label) {
  const root = join(tempDir, "native", `${label}-${nativeContents}`);
  const bin = join(root, "bin");
  const dist = join(root, "dist");
  const native = join(root, "native", `${process.platform}-${process.arch}`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(dist, { recursive: true });
  mkdirSync(native, { recursive: true });
  writeFileSync(join(bin, "aimux"), "#!/usr/bin/env sh\n");
  for (const file of ["launcher-bin.js", "main.js"]) {
    const path = join(dist, file);
    writeFileSync(path, `${label}:${file}`);
    const seconds = mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
  }
  const nativePath = join(native, "aimux");
  writeFileSync(nativePath, nativeContents);
  const seconds = mtimeMs / 1000;
  utimesSync(nativePath, seconds, seconds);
  return root;
}

const cases = [];
const baseProjectRoot = "/tmp/repo";

record(cases, "default source checkout command", { projectRoot: baseProjectRoot, env: {} }, () =>
  summarizeSpec(getDashboardCommandSpec(baseProjectRoot, {})),
);

record(cases, "allowlisted environment is quoted", {
  projectRoot: baseProjectRoot,
  env: {
    AIMUX_HOME: "/tmp/custom'home; echo unsafe",
    AIMUX_DAEMON_PORT: "43219",
    SECRET_TOKEN: "not-for-tmux",
  },
}, () =>
  summarizeSpec(
    getDashboardCommandSpec(baseProjectRoot, {
      AIMUX_HOME: "/tmp/custom'home; echo unsafe",
      AIMUX_DAEMON_PORT: "43219",
      SECRET_TOKEN: "not-for-tmux",
    }),
  ),
);

record(cases, "source checkout unsets stable shim env", {
  projectRoot: baseProjectRoot,
  env: {
    AIMUX_HOME: "/tmp/aimux",
    AIMUX_CLI_BIN: "/Users/sam/.local/bin/aimux",
    AIMUX_INSTALL_ROOT: "/Users/sam/.aimux/native",
  },
}, () =>
  summarizeSpec(
    getDashboardCommandSpec(baseProjectRoot, {
      AIMUX_HOME: "/tmp/aimux",
      AIMUX_CLI_BIN: "/Users/sam/.local/bin/aimux",
      AIMUX_INSTALL_ROOT: "/Users/sam/.aimux/native",
    }),
  ),
);

record(cases, "environment change alters build stamp", { projectRoot: baseProjectRoot, envs: [{ AIMUX_DAEMON_PORT: "43190" }, { AIMUX_DAEMON_PORT: "43191" }] }, () => {
  const one = getDashboardCommandSpec(baseProjectRoot, { AIMUX_DAEMON_PORT: "43190" });
  const two = getDashboardCommandSpec(baseProjectRoot, { AIMUX_DAEMON_PORT: "43191" });
  return {
    first: summarizeSpec(one),
    second: summarizeSpec(two),
    sameStamp: one.dashboardBuildStamp === two.dashboardBuildStamp,
  };
});

record(cases, "explicit production defaults do not alter build stamp", {
  projectRoot: baseProjectRoot,
  envs: [{}, { AIMUX_ENV: "production", AIMUX_WEB_APP_URL: "https://aimux.app" }],
}, () => {
  const implicit = getDashboardCommandSpec(baseProjectRoot, {});
  const explicit = getDashboardCommandSpec(baseProjectRoot, {
    AIMUX_ENV: "production",
    AIMUX_WEB_APP_URL: "https://aimux.app",
  });
  return {
    implicit: summarizeSpec(implicit),
    explicit: summarizeSpec(explicit),
    sameStamp: explicit.dashboardBuildStamp === implicit.dashboardBuildStamp,
  };
});

record(cases, "prepared stable CLI defaults do not alter build stamp", { projectRoot: baseProjectRoot, envPreparedBy: "prepareStableCliEnv" }, () => {
  const implicit = getDashboardCommandSpec(baseProjectRoot, {});
  const prepared = {};
  prepareStableCliEnv(prepared);
  const spec = getDashboardCommandSpec(baseProjectRoot, prepared);
  return {
    implicit: summarizeSpec(implicit),
    prepared: summarizeSpec(spec),
    sameStamp: spec.dashboardBuildStamp === implicit.dashboardBuildStamp,
  };
});

record(cases, "non-default web app env changes build stamp", {
  projectRoot: baseProjectRoot,
  envs: [
    { AIMUX_ENV: "production", AIMUX_WEB_APP_URL: "https://aimux.app" },
    { AIMUX_ENV: "development", AIMUX_WEB_APP_URL: "http://localhost:8081" },
  ],
}, () => {
  const production = getDashboardCommandSpec(baseProjectRoot, {
    AIMUX_ENV: "production",
    AIMUX_WEB_APP_URL: "https://aimux.app",
  });
  const development = getDashboardCommandSpec(baseProjectRoot, {
    AIMUX_ENV: "development",
    AIMUX_WEB_APP_URL: "http://localhost:8081",
  });
  return {
    production: summarizeSpec(production),
    development: summarizeSpec(development),
    sameStamp: development.dashboardBuildStamp === production.dashboardBuildStamp,
  };
});

const tempDir = mkdtempSync(join(tmpdir(), "aimux-dashboard-spec-"));
try {
  const shim = join(tempDir, "bin", "aimux");
  mkdirSync(dirname(shim), { recursive: true });

  {
    const firstInstall = createNativeInstall(tempDir, "first", 1_700_000_000);
    const secondInstall = createNativeInstall(tempDir, "second", 1_800_000_000);
    symlinkSync(join(firstInstall, "bin", "aimux"), shim);
    const env = { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(process.cwd(), "src") };
    const first = getDashboardCommandSpec(baseProjectRoot, env);
    unlinkSync(shim);
    symlinkSync(join(secondInstall, "bin", "aimux"), shim);
    const second = getDashboardCommandSpec(baseProjectRoot, env);
    record(
      cases,
      "stable shim launch stamp follows install root",
      { projectRoot: baseProjectRoot, env },
      () => ({ first: summarizeSpec(first), second: summarizeSpec(second), sameStamp: second.dashboardBuildStamp === first.dashboardBuildStamp }),
      tempDir,
    );
    unlinkSync(shim);
  }

  {
    const firstInstall = createNativeInstall(tempDir, "same", 1_700_000_000, "native-one");
    const secondInstall = createNativeInstall(tempDir, "same", 1_700_000_000, "native-two");
    symlinkSync(join(firstInstall, "bin", "aimux"), shim);
    const env = { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(process.cwd(), "src") };
    const first = getDashboardCommandSpec(baseProjectRoot, env);
    unlinkSync(shim);
    symlinkSync(join(secondInstall, "bin", "aimux"), shim);
    const second = getDashboardCommandSpec(baseProjectRoot, env);
    record(
      cases,
      "stable shim launch stamp follows native binary bytes",
      { projectRoot: baseProjectRoot, env },
      () => ({ first: summarizeSpec(first), second: summarizeSpec(second), sameStamp: second.dashboardBuildStamp === first.dashboardBuildStamp }),
      tempDir,
    );
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-command-spec-contract.mjs",
  source: "src/dashboard/command-spec.test.ts",
  sources: ["src/dashboard/command-spec.test.ts", "src/dashboard/command-spec.ts"],
  subject: "getDashboardCommandSpec",
  description: "Dashboard tmux launch command and build-stamp behavior captured by running TypeScript getDashboardCommandSpec.",
  normalizedFields: ["script paths", "temp paths", "dashboardBuildStamp"],
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
