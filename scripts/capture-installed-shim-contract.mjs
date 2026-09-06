#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SHIM_PATH = new URL("scripts/installed-aimux-shim.sh", ROOT).pathname;
const FIXTURE_PATH = new URL("testdata/contracts/v1/release/installed-shim.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function platformArch() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

async function writeNativeBin(root, label) {
  await mkdir(root, { recursive: true });
  const nativeBin = join(root, "aimux");
  await writeFile(nativeBin, `#!/bin/sh\nprintf '${label} %s\\n' "$*"\n`);
  await chmod(nativeBin, 0o755);
  return nativeBin;
}

async function capture(input) {
  const root = await mkdtemp(join(tmpdir(), "aimux-installed-shim-contract-"));
  try {
    const env = { PATH: "/bin:/usr/bin" };
    if (input.mode === "explicit-native") {
      env.AIMUX_NATIVE_BIN = await writeNativeBin(root, "native-explicit");
    } else {
      env.AIMUX_ROOT = root;
      if (input.mode === "root-native") {
        await writeNativeBin(join(root, "native", platformArch()), "native-root");
      }
    }
    const result = spawnSync("/bin/sh", [SHIM_PATH, ...input.args], {
      encoding: "utf8",
      env,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr.replaceAll(root, "<tmp>"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios = [
  {
    name: "delegates to AIMUX_NATIVE_BIN when it is set",
    mode: "explicit-native",
    args: ["daemon", "status"],
  },
  {
    name: "resolves the installed native binary from AIMUX_ROOT",
    mode: "root-native",
    args: ["--version"],
  },
  {
    name: "fails when no native binary is available",
    mode: "missing-native",
    args: ["daemon", "ensure"],
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const input = { mode: scenario.mode, args: scenario.args };
  cases.push({
    id: `release-installed-shim-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/installed-shim.test.ts",
    sourceName: scenario.name,
    api: "scripts/installed-aimux-shim.sh",
    input,
    output: await capture(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/installed-shim.test.ts",
  generatedBy: "scripts/capture-installed-shim-contract.mjs",
  description:
    "Installed native shim delegation, AIMUX_ROOT native binary resolution, and missing-binary failure behavior captured by running scripts/installed-aimux-shim.sh.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
