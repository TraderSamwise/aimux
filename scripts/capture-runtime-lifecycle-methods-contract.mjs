#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/runtime-lifecycle-methods.json", ROOT);
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { runtimeLifecycleMethods } = await import(new URL("dist/multiplexer/runtime-lifecycle-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const managedStart = "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const managedEnd = "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const managedBlock = [managedStart, "# aimux Agent Instructions", "old generated content", managedEnd, ""].join("\n");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "does not create AGENTS by default",
    files: {},
    operations: ["writeInstructionFiles"],
  },
  {
    name: "ignores legacy configured instruction files without overwriting user content",
    config: { tools: { codex: { instructionsFile: "AGENTS.md" } } },
    files: { "AGENTS.md": "# Project Rules\n\nKeep this user rule.\n" },
    operations: ["writeInstructionFiles"],
  },
  {
    name: "does not create configured generated-only instruction files",
    config: { tools: { codex: { instructionsFile: "AGENTS.md" } } },
    files: {},
    operations: ["writeInstructionFiles"],
  },
  {
    name: "removes stale default managed block while preserving user content",
    files: {
      "AGENTS.md": ["# Project Rules", "", "Keep this user rule.", "", managedBlock].join("\n"),
    },
    operations: ["writeInstructionFiles"],
  },
  {
    name: "leaves user-authored AGENTS without managed block untouched",
    files: { "AGENTS.md": "# Project Rules\n\nKeep this user rule.\n\n" },
    operations: ["writeInstructionFiles"],
  },
  {
    name: "deletes generated-only AGENTS when projection is no longer configured",
    files: { "AGENTS.md": managedBlock },
    operations: ["writeInstructionFiles"],
  },
  {
    name: "removes stale managed blocks from legacy adapter docs",
    files: {
      "CLAUDE.md": ["# Adapter", "", managedBlock].join("\n"),
      "CODEX.md": ["# Adapter", "", managedBlock].join("\n"),
    },
    operations: ["writeInstructionFiles"],
  },
  {
    name: "removeInstructionFiles cleans tracked managed files and clears tracking",
    files: {
      "CLAUDE.md": ["# Adapter", "", managedBlock].join("\n"),
      "notes.md": "# Notes\n\nKeep me.\n",
    },
    initialWrittenInstructionFiles: ["CLAUDE.md", "notes.md"],
    operations: ["removeInstructionFiles"],
  },
];

async function run(input) {
  const repoRoot = await mkdtemp(join(tmpdir(), "aimux-runtime-lifecycle-contract-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    process.chdir(repoRoot);
    if (input.config) {
      await mkdir(join(repoRoot, ".aimux"), { recursive: true });
      await writeFile(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config, null, 2)}\n`);
    }
    for (const [relativePath, content] of Object.entries(input.files ?? {})) {
      await mkdir(join(repoRoot, relativePath, ".."), { recursive: true });
      await writeFile(join(repoRoot, relativePath), content);
    }
    const writtenInstructionFiles = new Set((input.initialWrittenInstructionFiles ?? []).map((file) => join(repoRoot, file)));
    const host = { writtenInstructionFiles };
    for (const operation of input.operations) {
      runtimeLifecycleMethods[operation].call(host);
    }
    const files = {};
    for (const file of ["AGENTS.md", "CLAUDE.md", "CODEX.md", "notes.md"]) {
      const filePath = join(repoRoot, file);
      files[file] = existsSync(filePath)
        ? { exists: true, content: await readFile(filePath, "utf8") }
        : { exists: false };
    }
    return {
      files,
      writtenInstructionFiles: [...writtenInstructionFiles].map((file) => file.replace(`${repoRoot}/`, "")),
    };
  } finally {
    process.chdir(previousCwd);
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const cases = [];
for (const [index, input] of inputs.entries()) {
  cases.push({
    id: `runtime-lifecycle-methods-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/runtime-lifecycle-methods.test.ts",
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/runtime-lifecycle-methods.test.ts",
  generatedBy: "scripts/capture-runtime-lifecycle-methods-contract.mjs",
  description:
    "Runtime lifecycle instruction-file cleanup contracts captured by running TypeScript runtimeLifecycleMethods against temporary project files.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
