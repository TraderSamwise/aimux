#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime/cli-launcher.json", ROOT);
const {
  getAimuxCurrentCliIdentity,
  getAimuxDaemonLaunchCommand,
  getAimuxDashboardLaunchCommand,
  getAimuxProjectServiceLaunchCommand,
} = await import(new URL("dist/cli-launcher.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const platformArch = `${process.platform}-${process.arch}`;
const repoRoot = ROOT.pathname.replace(/\/$/, "");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function createNativeInstall(root, build = "old-build") {
  const installRoot = join(root, "native", build);
  const nativeEntry = join(installRoot, "dist", "launcher-bin.js");
  const nativeBinary = join(installRoot, "native", platformArch, "aimux");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(installRoot, "bin"), { recursive: true });
  await mkdir(join(installRoot, "dist"), { recursive: true });
  await mkdir(join(installRoot, "native", platformArch), { recursive: true });
  await writeFile(join(installRoot, "bin", "aimux"), "#!/usr/bin/env sh\n");
  await writeFile(nativeEntry, "console.log('old');\n");
  await writeFile(nativeBinary, "#!/usr/bin/env sh\n");
  await symlink(join(installRoot, "bin", "aimux"), join(root, "bin", "aimux"));
  return {
    shim: join(root, "bin", "aimux"),
    nativeEntry,
    nativeBinary: await realpath(nativeBinary),
    installRoot,
  };
}

function normalize(value, tempRoot, realTempRoot) {
  return JSON.parse(
    JSON.stringify(value)
      .split(realTempRoot)
      .join("<tmp>")
      .split(tempRoot)
      .join("<tmp>")
      .split(repoRoot)
      .join("<repo>")
      .split(process.execPath)
      .join("<node>")
      .split(platformArch)
      .join("<platform-arch>"),
  );
}

async function runCase(input) {
  switch (input.api) {
    case "getAimuxDaemonLaunchCommand":
      return getAimuxDaemonLaunchCommand(input.options);
    case "getAimuxDashboardLaunchCommand":
      return getAimuxDashboardLaunchCommand(input.options);
    case "getAimuxProjectServiceLaunchCommand":
      return getAimuxProjectServiceLaunchCommand(input.projectId, input.projectRoot, input.options);
    case "getAimuxCurrentCliIdentity":
      return getAimuxCurrentCliIdentity(input.options);
    default:
      throw new Error(`unknown cli-launcher api ${input.api}`);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "aimux-launcher-contract-"));
const realTempRoot = await realpath(tempRoot);
try {
  const install = await createNativeInstall(tempRoot);
  const sourceEntry = join(tempRoot, "checkout", "dist", "launcher-bin.js");
  const cases = [
    {
      name: "uses the installed native binary for daemon launch when the current entry is a native install",
      api: "getAimuxDaemonLaunchCommand",
      options: {
        env: { AIMUX_CLI_BIN: install.shim, AIMUX_INSTALL_ROOT: join(tempRoot, "native") },
        currentArgvEntry: install.nativeEntry,
      },
    },
    {
      name: "keeps source runs on the current entry when not inside a native install",
      api: "getAimuxDaemonLaunchCommand",
      options: {
        env: { AIMUX_CLI_BIN: install.shim, AIMUX_INSTALL_ROOT: join(tempRoot, "native") },
        currentArgvEntry: sourceEntry,
      },
    },
    {
      name: "uses a dedicated dashboard launch contract",
      api: "getAimuxDashboardLaunchCommand",
      options: {
        env: { AIMUX_CLI_BIN: install.shim, AIMUX_INSTALL_ROOT: join(tempRoot, "native") },
        currentArgvEntry: install.nativeEntry,
      },
    },
    {
      name: "uses the installed native binary for native dashboard launch",
      api: "getAimuxDashboardLaunchCommand",
      options: {
        env: {
          AIMUX_CLI_BIN: install.shim,
          AIMUX_INSTALL_ROOT: join(tempRoot, "native"),
          AIMUX_DASHBOARD_IMPLEMENTATION: "native",
        },
        currentArgvEntry: install.nativeEntry,
      },
    },
    {
      name: "uses the installed native binary for project service launch",
      api: "getAimuxProjectServiceLaunchCommand",
      projectId: "project-1",
      projectRoot: "/repo/alpha",
      options: {
        env: { AIMUX_CLI_BIN: install.shim, AIMUX_INSTALL_ROOT: join(tempRoot, "native") },
        currentArgvEntry: install.nativeEntry,
      },
    },
    {
      name: "uses the installed native binary when native install paths resolve through symlink aliases",
      api: "getAimuxDashboardLaunchCommand",
      setup: "alias-root",
      options: null,
    },
    {
      name: "exposes current CLI identity without launch arguments for diagnostics",
      api: "getAimuxCurrentCliIdentity",
      options: {
        env: { AIMUX_CLI_BIN: install.shim, AIMUX_INSTALL_ROOT: join(tempRoot, "native") },
        currentArgvEntry: install.nativeEntry,
      },
    },
  ];

  const contractCases = [];
  for (const [index, input] of cases.entries()) {
    if (input.setup === "alias-root") continue;
    const output = await runCase(input);
    const normalizedInput = normalize(input, tempRoot, realTempRoot);
    contractCases.push({
      id: `runtime-cli-launcher-${String(index + 1).padStart(3, "0")}`,
      name: input.name,
      source: "src/cli-launcher.test.ts",
      input: normalizedInput,
      output: normalize(output, tempRoot, realTempRoot),
      inputSha256: hash(normalizedInput),
    });
  }

  const realRoot = join(tempRoot, "real");
  const aliasRoot = join(tempRoot, "alias");
  const aliasInstall = await createNativeInstall(realRoot);
  await rm(join(realRoot, "bin"), { recursive: true, force: true });
  await symlink(realRoot, aliasRoot, "dir");
  const aliasShim = install.shim;
  await rm(aliasShim, { force: true });
  await symlink(join(aliasInstall.installRoot, "bin", "aimux"), aliasShim);
  cases[5].options = {
    env: {
      AIMUX_CLI_BIN: aliasShim,
      AIMUX_INSTALL_ROOT: join(realRoot, "native"),
      AIMUX_DASHBOARD_IMPLEMENTATION: "native",
    },
    currentArgvEntry: join(aliasRoot, "native", "old-build", "dist", "launcher-bin.js"),
  };

  const aliasOutput = await runCase(cases[5]);
  const normalizedAliasInput = normalize(cases[5], tempRoot, realTempRoot);
  contractCases.splice(5, 0, {
    id: "runtime-cli-launcher-006",
    name: cases[5].name,
    source: "src/cli-launcher.test.ts",
    input: normalizedAliasInput,
    output: normalize(aliasOutput, tempRoot, realTempRoot),
    inputSha256: hash(normalizedAliasInput),
  });

  await writeContractJson(FIXTURE_PATH, {
    version: 1,
    source: "src/cli-launcher.test.ts",
    sources: ["src/cli-launcher.test.ts", "src/cli-launcher.ts"],
    generatedBy: "scripts/capture-cli-launcher-contract.mjs",
    description:
      "Aimux launcher command selection captured by running the TypeScript cli-launcher helpers with temp paths, Node path, and platform-native subdir normalized.",
    normalization: {
      "<tmp>": "temporary test directory",
      "<repo>": "repository root",
      "<node>": "process.execPath",
      "<platform-arch>": "process.platform-process.arch native subdirectory",
    },
    cases: contractCases,
  });

  console.log(`${FIXTURE_PATH.pathname}: ${contractCases.length} cases`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
