#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const CONFIG_FIXTURE = new URL("testdata/contracts/v1/config/behavior.json", ROOT);
const INSTALL_FIXTURE = new URL("testdata/contracts/v1/install-config/config.json", ROOT);
const configModule = await import(new URL("dist/config.js", ROOT));
const installModule = await import(new URL("dist/install-config.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));

const { loadConfig, loadGlobalConfig } = configModule;
const {
  DEFAULT_INSTALLS_CONFIG,
  MIN_INSTALL_CLEANUP_INTERVAL_MS,
  MIN_INSTALL_RETENTION_DAYS,
  isPrimaryInstallLane,
  loadInstallsConfig,
  normalizeInstallsConfig,
} = installModule;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  mkdirSync(dirname(url.pathname), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  writeFileSync(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function select(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function withProjectState(input, run) {
  const previousAimuxHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-config-contract-home-"));
  const repo = mkdtempSync(join(tmpdir(), "aimux-config-contract-repo-"));
  try {
    process.env.AIMUX_HOME = home;
    mkdirSync(join(repo, ".git"), { recursive: true });
    paths.initPaths(repo);
    if (input.global !== undefined) {
      writeFileSync(paths.getGlobalConfigPath(), JSON.stringify(input.global, null, 2) + "\n");
    }
    if (input.project !== undefined) {
      mkdirSync(join(repo, ".aimux"), { recursive: true });
      writeFileSync(join(repo, ".aimux/config.json"), JSON.stringify(input.project, null, 2) + "\n");
    }
    return run({ home, repo });
  } finally {
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const configCases = [];
function recordConfig(name, input) {
  const output = withProjectState(input, ({ repo }) => {
    const options = {};
    if (input.includeGlobal === false) options.includeGlobal = false;
    if (input.projectRoot === "current") options.projectRoot = repo;
    const loaded = input.mode === "loadGlobalConfig" ? loadGlobalConfig() : loadConfig(options);
    return select(loaded, input.select);
  });
  configCases.push({
    id: `config-behavior-${String(configCases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/config.test.ts",
    api: input.mode ?? "loadConfig",
    input,
    output,
    inputSha256: hash(input),
  });
}

recordConfig("leaves automatic scribe creation disabled by default", {
  includeGlobal: false,
  select: ["scribe"],
});
recordConfig("loads a global default scribe agent through global config", {
  mode: "loadGlobalConfig",
  global: { scribe: { defaultAgent: "claude" } },
  select: ["scribe", "defaultAgent"],
});
recordConfig("loads a global default scribe agent through merged config", {
  global: { scribe: { defaultAgent: "claude" } },
  select: ["scribe", "defaultAgent"],
});
recordConfig("lets project config disable a global default scribe agent", {
  global: { scribe: { defaultAgent: "claude" } },
  project: { scribe: { defaultAgent: null } },
  select: ["scribe", "defaultAgent"],
});
recordConfig("normalizes object-form default scribe launch options", {
  includeGlobal: false,
  project: {
    scribe: {
      defaultAgent: {
        tool: "claude",
        extraArgs: ["--model", "sonnet"],
        env: { AIMUX_TEST_MODEL: "sonnet" },
      },
    },
  },
  select: ["scribe", "defaultAgent"],
});
recordConfig("normalizes exact Claude resume as backend-session resumable", {
  includeGlobal: false,
  project: {
    tools: {
      claude: {
        command: "claude",
        args: ["--dangerously-skip-permissions"],
        enabled: true,
        sessionIdFlag: ["--session-id", "{sessionId}"],
        resumeArgs: ["--resume", "{sessionId}"],
        resumeByBackendSessionId: false,
      },
    },
  },
  select: ["tools", "claude", "resumeByBackendSessionId"],
});
recordConfig("normalizes stale built-in resume args while preserving fallbacks", {
  includeGlobal: false,
  project: {
    tools: {
      claude: {
        command: "claude",
        args: ["--dangerously-skip-permissions"],
        enabled: true,
        preambleFlag: ["--append-system-prompt"],
        resumeArgs: ["--continue"],
      },
      codex: {
        command: "codex",
        args: [],
        enabled: true,
        resumeArgs: ["resume", "--last"],
      },
    },
  },
  select: ["tools"],
});
recordConfig("preserves explicit built-in resumeFallback overrides", {
  includeGlobal: false,
  project: {
    tools: {
      claude: {
        command: "claude",
        enabled: true,
        resumeArgs: ["--continue"],
        resumeFallback: ["--resume-fallback", "claude-explicit"],
      },
      codex: {
        command: "codex",
        enabled: true,
        resumeArgs: ["resume", "--last"],
        resumeFallback: ["resume", "codex-explicit"],
      },
    },
  },
  select: ["tools"],
});
recordConfig("preserves explicit exact-resume opt-outs on built-in tools", {
  includeGlobal: false,
  project: {
    tools: {
      claude: {
        command: "claude",
        enabled: true,
        resumeArgs: ["--continue"],
        resumeByBackendSessionId: false,
      },
      codex: {
        command: "codex",
        enabled: true,
        resumeArgs: ["resume", "--last"],
        resumeByBackendSessionId: false,
      },
    },
  },
  select: ["tools"],
});
recordConfig("preserves unknown built-in non-placeholder resume args", {
  includeGlobal: false,
  project: {
    tools: {
      claude: { command: "claude", enabled: true, resumeArgs: ["--custom-continue"] },
      codex: { command: "codex", enabled: true, resumeArgs: ["resume", "custom"] },
    },
  },
  select: ["tools"],
});
recordConfig("does not normalize stale resume args for custom tool configs", {
  includeGlobal: false,
  project: {
    tools: {
      "codex-custom": {
        command: "codex",
        args: [],
        enabled: true,
        resumeArgs: ["resume", "--last"],
      },
    },
  },
  select: ["tools", "codex-custom", "resumeArgs"],
});
recordConfig("ships a default claude config that assigns a backend session id at launch", {
  includeGlobal: false,
  select: ["tools", "claude"],
});
recordConfig("defaults logging to disabled structured project logs", {
  includeGlobal: false,
  select: ["logging"],
});
recordConfig("defaults notification view acknowledgement behavior", {
  includeGlobal: false,
  select: ["notifications"],
});
recordConfig("defaults expose to the current worktree", {
  includeGlobal: false,
  select: ["expose"],
});
recordConfig("allows project config to choose the initial expose scope", {
  includeGlobal: false,
  project: { expose: { initialScope: "global" } },
  select: ["expose", "initialScope"],
});
recordConfig("allows config to disable expose hot snapshots", {
  includeGlobal: false,
  project: { expose: { hotSnapshotsEnabled: false } },
  select: ["expose"],
});
recordConfig("loads global expose hot snapshot config without project config", {
  mode: "loadGlobalConfig",
  global: { expose: { initialScope: "global", hotSnapshotsEnabled: false } },
  project: { expose: { initialScope: "project" } },
  select: ["expose"],
});
recordConfig("normalizes invalid expose scope config", {
  includeGlobal: false,
  project: { expose: { initialScope: "somewhere" } },
  select: ["expose", "initialScope"],
});
recordConfig("reads an explicit projectRoot config without touching global path state", {
  includeGlobal: false,
  projectRoot: "current",
  project: { worktrees: { baseDir: ".custom-worktrees" } },
  select: ["worktrees", "baseDir"],
});
recordConfig("defaults worktree cache cleanup to scheduled dry-run reports", {
  includeGlobal: false,
  select: ["worktrees"],
});
recordConfig("normalizes invalid worktree cache cleanup config", {
  includeGlobal: false,
  project: {
    worktrees: {
      cacheCleanupDirs: "node_modules",
      cacheCleanupEnabled: "yes",
      cacheCleanupApply: "yes",
      cacheCleanupIntervalMs: -1,
      cacheCleanupInitialDelayMs: 0,
    },
  },
  select: ["worktrees"],
});
recordConfig("normalizes array worktree config to defaults", {
  includeGlobal: false,
  project: { worktrees: [] },
  select: ["worktrees"],
});
recordConfig("defaults inbox cleanup to a retention window and item cap", {
  includeGlobal: false,
  select: ["inbox"],
});
recordConfig("defaults graveyard cleanup to a retention window", {
  includeGlobal: false,
  select: ["graveyard"],
});
recordConfig("allows project loop copy config to override global loop copy config", {
  global: { loop: { overseerBriefingTemplate: "global {{count}}\n{{candidates}}" } },
  project: { loop: { overseerBriefingTemplate: "project {{count}}\n{{candidates}}" } },
  select: ["loop"],
});
recordConfig("allows project graveyard config to override global graveyard config", {
  global: { graveyard: { cleanupEnabled: false, retentionDays: 30 } },
  project: { graveyard: { retentionDays: 7 } },
  select: ["graveyard"],
});
recordConfig("deep merges logging config overrides", {
  includeGlobal: false,
  project: { logging: { enabled: true, level: "debug", categories: ["daemon", "session"] } },
  select: ["logging"],
});

const installCases = [];
function recordInstall(name, source, api, input, output) {
  installCases.push({
    id: `install-config-${String(installCases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function recordNormalize(name, raw) {
  recordInstall(name, "src/install-config.test.ts", "normalizeInstallsConfig", { raw }, normalizeInstallsConfig(raw));
}
function recordLane(name, env) {
  recordInstall(name, "src/install-config.test.ts", "isPrimaryInstallLane", { home: homedir(), env }, isPrimaryInstallLane(env));
}
function recordLoad(name, globalConfigText) {
  const previousAimuxHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-install-config-contract-"));
  try {
    process.env.AIMUX_HOME = home;
    if (globalConfigText !== null) {
      writeFileSync(join(home, "config.json"), globalConfigText);
    }
    const config = loadInstallsConfig();
    const quarantineFiles = readdirSync(home).filter((name) => name.startsWith("config.json.corrupt-"));
    recordInstall(
      name,
      "src/install-config.test.ts",
      "loadInstallsConfig",
      { globalConfigText },
      {
        config,
        globalConfigExistsAfter: existsSync(join(home, "config.json")),
        quarantineFileCountAfter: quarantineFiles.length,
      },
    );
  } finally {
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

recordLoad("returns defaults when no global config exists", null);
recordLoad("returns defaults when the config exists but declares no installs block", JSON.stringify({ defaultTool: "claude" }));
recordLoad(
  "reads the installs block from the global config",
  JSON.stringify({ installs: { cleanupEnabled: false, keepRecent: 3 } }),
);
recordLoad("quarantines a corrupt global config rather than throwing", "{ not json");
recordLane("sweeps when AIMUX_HOME is the default home", { AIMUX_HOME: join(homedir(), ".aimux") });
recordLane("sweeps when AIMUX_HOME is the default home with trailing slash", { AIMUX_HOME: `${join(homedir(), ".aimux")}/` });
recordLane("sweeps when AIMUX_HOME is tilde default", { AIMUX_HOME: "~/.aimux" });
recordLane("sweeps when AIMUX_HOME is unset", {});
recordLane("sweeps when AIMUX_HOME is blank", { AIMUX_HOME: "   " });
recordLane("does not sweep from a lane pointed at another home", { AIMUX_HOME: "/tmp/aimux-lane" });
recordLane("does not sweep from a dev home next to the default home", { AIMUX_HOME: join(homedir(), ".aimux-dev") });
recordNormalize("falls back to defaults when the block is null", null);
recordNormalize("falls back to defaults when the block is malformed", { retentionDays: "soon", keepRecent: null });
recordNormalize("sweeps by default", {});
recordNormalize("lets the sweep be turned off", { cleanupEnabled: false });
recordNormalize("refuses retention below the floor", { retentionDays: 0 });
recordNormalize("accepts retention at the floor", { retentionDays: MIN_INSTALL_RETENTION_DAYS });
recordNormalize("refuses a sweep interval faster than the floor", { cleanupIntervalMs: 1_000 });
recordNormalize("accepts a sweep interval at the floor", { cleanupIntervalMs: MIN_INSTALL_CLEANUP_INTERVAL_MS });
recordNormalize("accepts a keepRecent of zero", { keepRecent: 0 });
recordNormalize("rejects a negative keepRecent", { keepRecent: -1 });
recordNormalize("truncates fractional values", { retentionDays: 45.9 });
recordNormalize("treats a non-object block as absent", "enabled");
recordNormalize("treats an array block as absent", [1, 2, 3]);
recordNormalize("treats a numeric block as absent", 42);
recordNormalize("ignores an out-of-range retention instead of clamping it", { retentionDays: 99_999 });
recordInstall(
  "records default installs constants",
  "src/install-config.test.ts",
  "defaultInstallsConfig",
  {},
  DEFAULT_INSTALLS_CONFIG,
);

await writeContractJson(CONFIG_FIXTURE, {
  version: 1,
  source: "src/config.test.ts",
  generatedBy: "scripts/capture-config-contract.mjs",
  description: "Config merge and normalization behavior captured by running TypeScript config tests through loadConfig/loadGlobalConfig.",
  cases: configCases,
});
await writeContractJson(INSTALL_FIXTURE, {
  version: 1,
  source: "src/install-config.test.ts",
  generatedBy: "scripts/capture-config-contract.mjs",
  description: "Global install cleanup config normalization, lane detection, and corrupt-config side effects captured by running TypeScript.",
  cases: installCases,
});
console.log(`${CONFIG_FIXTURE.pathname}: ${configCases.length} cases`);
console.log(`${INSTALL_FIXTURE.pathname}: ${installCases.length} cases`);
