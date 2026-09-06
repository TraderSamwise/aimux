#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/statusline-script.json", ROOT);
const SCRIPT_PATH = new URL("scripts/tmux-statusline.sh", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function listFiles(root) {
  const files = {};
  if (!existsSync(root)) return files;
  const visit = (path) => {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) {
        visit(child);
      } else {
        files[relative(root, child)] = normalizeText(readFileSync(child, "utf8"));
      }
    }
  };
  visit(root);
  return files;
}

function normalizeText(text) {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} /gm, "<timestamp> ");
}

function denormalize(value, stateDir) {
  return value.replaceAll("<state>", stateDir);
}

function runCase(definition, index) {
  const stateDir = mkdtempSync(join(tmpdir(), "aimux-statusline-script-contract-"));
  try {
    for (const [name, content] of Object.entries(definition.files ?? {})) {
      const path = join(stateDir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, denormalize(content, stateDir));
    }
    const args = definition.args.map((arg) => denormalize(arg, stateDir));
    const result = spawnSync("sh", [SCRIPT_PATH.pathname, ...args], { encoding: "utf8" });
    const input = {
      name: definition.name,
      args: definition.args,
      files: definition.files ?? {},
    };
    return {
      id: `tmux-statusline-script-${String(index + 1).padStart(3, "0")}`,
      name: definition.name,
      source: "src/tmux/statusline-script.test.ts",
      api: "scripts/tmux-statusline.sh",
      input,
      output: {
        status: result.status,
        stdout: normalizeText(result.stdout),
        stderr: normalizeText(result.stderr),
        files: listFiles(stateDir),
      },
      inputSha256: hash(input),
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const definitions = [
  {
    name: "stays quiet before line parsing can configure logging",
    args: ["--project-state-dir", "<state>"],
  },
  {
    name: "stays quiet before project state dir configures logging",
    args: ["--line", "bottom"],
  },
  {
    name: "top prefers current window status file",
    args: ["--line", "top", "--project-state-dir", "<state>", "--current-window-id", "@1"],
    files: {
      "tmux-statusline/top-@1.txt": "top-window\n",
      "tmux-statusline/top-dashboard.txt": "top-dashboard\n",
    },
  },
  {
    name: "top falls back to dashboard status file",
    args: ["--line", "top", "--project-state-dir", "<state>", "--current-window-id", "@missing"],
    files: {
      "tmux-statusline/top-dashboard.txt": "top-dashboard\n",
    },
  },
  {
    name: "top logs missing status file",
    args: [
      "--line",
      "top",
      "--project-state-dir",
      "<state>",
      "--current-window-id",
      "@missing",
      "--current-window",
      "codex",
      "--current-session",
      "aimux-repo",
    ],
  },
  {
    name: "dashboard bottom prefers client-session status file",
    args: [
      "--line",
      "bottom",
      "--project-state-dir",
      "<state>",
      "--current-window",
      "dashboard-live",
      "--current-session",
      "aimux-repo-client-live",
    ],
    files: {
      "tmux-statusline/bottom-dashboard-aimux-repo-client-live.txt": "bottom-client\n",
      "tmux-statusline/bottom-dashboard.txt": "bottom-dashboard\n",
    },
  },
  {
    name: "dashboard bottom falls back to dashboard status file",
    args: [
      "--line",
      "bottom",
      "--project-state-dir",
      "<state>",
      "--current-window",
      "dashboard-live",
      "--current-session",
      "aimux-repo-client-live",
    ],
    files: {
      "tmux-statusline/bottom-dashboard.txt": "bottom-dashboard\n",
    },
  },
  {
    name: "window bottom reads current window status file",
    args: ["--line", "bottom", "--project-state-dir", "<state>", "--current-window", "codex", "--current-window-id", "@2"],
    files: {
      "tmux-statusline/bottom-@2.txt": "bottom-window\n",
    },
  },
  {
    name: "window bottom logs missing status file",
    args: [
      "--line",
      "bottom",
      "--project-state-dir",
      "<state>",
      "--current-window",
      "codex",
      "--current-window-id",
      "@missing",
      "--current-session",
      "aimux-repo",
    ],
  },
  {
    name: "unsupported line logs after project state dir is known",
    args: ["--line", "middle", "--project-state-dir", "<state>"],
  },
];

const cases = definitions.map(runCase);
await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  source: "src/tmux/statusline-script.test.ts",
  sources: ["src/tmux/statusline-script.test.ts", "scripts/tmux-statusline.sh"],
  subject: "scripts/tmux-statusline.sh",
  caseCount: cases.length,
  description: "tmux statusline cache-file lookup and silent-failure behavior captured by running the shipped shell script.",
  cases,
});
console.log(`wrote ${FIXTURE_PATH.pathname} (${cases.length} cases)`);
