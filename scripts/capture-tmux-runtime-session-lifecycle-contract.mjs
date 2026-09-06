#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/runtime-session-lifecycle.json", ROOT);
process.env.AIMUX_HOME = "/tmp/aimux-contract-home";
process.env.AIMUX_DAEMON_PORT = "54321";

const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));
const { TMUX_RUNTIME_CONTRACT_OPTION } = await import(new URL("dist/runtime-owner.js", ROOT));

const PROJECT_ROOT = "/repo/mobile";
const SESSION_NAME = "aimux-mobile-078d0ecd20ec";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  const repo = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested
        .split(repo)
        .join("<repo>")
        .split("/tmp/aimux-contract-home")
        .join("<aimux-home>")
        .replace(
          /(?:\/private)?\/var\/folders\/[^'"\s]+\/T\/aimux-tmux-[^'"\s]+\/mouse-bindings\.conf/g,
          "<mouse-bindings.conf>",
        )
        .replace(/\/tmp\/aimux-tmux-[^'"\s]+\/mouse-bindings\.conf/g, "<mouse-bindings.conf>");
    }),
  );
}

function callToValue(args, options) {
  return options === undefined ? { args: [...args] } : { args: [...args], cwd: options.cwd };
}

function createLifecycleExec(input) {
  const calls = [];
  const state = {
    sessionExists: Boolean(input.sessionExists),
    terminalFeatures: input.terminalFeatures ?? "",
    droppedContract: false,
    droppedConfiguration: false,
    legacyRepaired: false,
  };
  const exec = (args, options) => {
    calls.push(callToValue(args, options));
    const joined = args.join(" ");
    if (joined === "-V") return "tmux 3.5a";
    if (joined === "list-sessions -F #{session_name}") {
      if (input.legacySession && !state.legacyRepaired) return input.legacySession;
      return input.sessionList ?? "";
    }
    if (joined.startsWith("rename-session -t ")) {
      state.legacyRepaired = true;
      return "";
    }
    if (joined === `has-session -t ${SESSION_NAME}`) {
      if (!state.sessionExists) throw new Error("missing");
      return "";
    }
    if (joined.startsWith("new-session -d -s ")) {
      state.sessionExists = true;
      return "";
    }
    if (joined === `show-options -v -t ${SESSION_NAME} ${TMUX_RUNTIME_CONTRACT_OPTION}`) {
      return input.currentContract ?? "";
    }
    if (joined === `show-options -v -t ${SESSION_NAME} terminal-features`) {
      return state.terminalFeatures;
    }
    if (args[0] === "set-option" && args[1] === "-as" && args[4] === "terminal-features") {
      const next = args[5]?.replace(/^,/, "") ?? "";
      state.terminalFeatures = [state.terminalFeatures, next].filter(Boolean).join("\n");
      return "";
    }
    if (
      args[0] === "set-option" &&
      args[3] === TMUX_RUNTIME_CONTRACT_OPTION &&
      input.dropDuringContract &&
      !state.droppedContract
    ) {
      state.droppedContract = true;
      state.sessionExists = false;
      throw new Error("no such session: aimux-mobile-abc");
    }
    if (
      args[0] === "set-option" &&
      args[3] === "@aimux-project-root" &&
      input.dropDuringConfiguration &&
      !state.droppedConfiguration
    ) {
      state.droppedConfiguration = true;
      state.sessionExists = false;
      throw new Error("no such session: aimux-mobile-abc");
    }
    if (args.includes("extended-keys-format") && input.extendedKeysFormatError) {
      throw new Error(input.extendedKeysFormatError);
    }
    if (joined.startsWith("list-windows -t ")) return "";
    return "";
  };
  exec.calls = calls;
  exec.state = state;
  return exec;
}

const cases = [];

function record(name, input, run) {
  const exec = createLifecycleExec(input);
  const manager = new TmuxRuntimeManager(exec);
  let result = null;
  let thrown = null;
  try {
    result = run(manager, exec);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const fullInput = { name, projectRoot: PROJECT_ROOT, ...input };
  const output = normalize({
    thrown,
    result,
    execCalls: exec.calls,
    terminalFeatures: exec.state.terminalFeatures,
  });
  cases.push({
    id: `tmux-runtime-session-lifecycle-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api: "TmuxRuntimeManager.ensureProjectSession",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record("creates detached project session with full managed configuration", {}, (manager) =>
  manager.ensureProjectSession(PROJECT_ROOT),
);

record("does not append duplicate terminal features on reconfigure", {}, (manager) => {
  manager.ensureProjectSession(PROJECT_ROOT);
  manager.ensureProjectSession(PROJECT_ROOT);
  return manager.getProjectSession(PROJECT_ROOT);
});

record("stamps an existing project session missing the runtime contract", { sessionExists: true }, (manager) =>
  manager.ensureProjectSession(PROJECT_ROOT),
);

record(
  "skips final runtime contract stamp when existing session already has one",
  {
    sessionExists: true,
    currentContract: "2",
  },
  (manager) => manager.ensureProjectSession(PROJECT_ROOT),
);

record(
  "retries when tmux drops the project session during contract stamping",
  { dropDuringContract: true },
  (manager) => manager.ensureProjectSession(PROJECT_ROOT),
);

record(
  "retries when tmux drops the project session during configuration",
  { dropDuringConfiguration: true },
  (manager) => manager.ensureProjectSession(PROJECT_ROOT),
);

record(
  "continues when an older tmux refuses extended-keys-format",
  {
    extendedKeysFormatError: "invalid option: extended-keys-format",
  },
  (manager) => manager.ensureProjectSession(PROJECT_ROOT),
);

record(
  "propagates non-option failures from extended-keys-format",
  {
    extendedKeysFormatError: "no server running on /tmp/tmux-1000/default",
  },
  (manager) => manager.ensureProjectSession(PROJECT_ROOT),
);

record("uses a custom dashboard command for new host sessions", {}, (manager) =>
  manager.ensureProjectSession(PROJECT_ROOT, {
    cwd: "/repo/mobile/app",
    command: "node",
    args: ["dist/main.js", "dashboard"],
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-runtime-session-lifecycle-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "TmuxRuntimeManager project-session lifecycle behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
