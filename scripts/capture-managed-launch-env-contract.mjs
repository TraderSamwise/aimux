#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/launch/managed-env.json", ROOT);
const launchEnv = await import(new URL("dist/managed-launch-env.js", ROOT));
const { buildManagedLaunchEnv, wrapCommandWithManagedLaunchEnv } = launchEnv;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `launch-managed-env-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/managed-launch-env.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const allowlistInput = {
  HOME: "/Users/sam",
  PATH: "/Users/sam/.volta/bin:/usr/bin",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: "en_US.UTF-8",
  VOLTA_HOME: "/Users/sam/.volta",
  TMUX: "/tmp/tmux-501/default,123,0",
  TMUX_PANE: "%1",
  PWD: "/repo",
  SHLVL: "3",
  _VOLTA_TOOL_RECURSION: "1",
  FOO_RECURSION_STATE: "1",
  BUNDLE_GEMFILE: "/repo/Gemfile",
  OPENAI_API_KEY: "sk-real",
  TEALSTREET_DISCORD_BOT_ADMIN_TOKEN: "real-token",
  DATABASE_URL: "postgres://localhost/app",
  AWS_PROFILE: "prod",
  RANDOM_PROJECT_ENV: "project-value",
  LC_ALL: "C.UTF-8",
  CODEX_HOME: "/Users/sam/.codex",
  CLAUDE_CONFIG_DIR: "/Users/sam/.claude",
  SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
};
record(
  "preserves only the launch allowlist plus aimux-owned extras",
  "buildManagedLaunchEnv",
  { env: allowlistInput, extraEnv: { AIMUX_SESSION_ID: "codex-1", NOT_AIMUX_SECRET: "extra-secret" } },
  buildManagedLaunchEnv(allowlistInput, { AIMUX_SESSION_ID: "codex-1", NOT_AIMUX_SECRET: "extra-secret" }),
);

record(
  "normalizes control-process terminal env for interactive agents",
  "buildManagedLaunchEnv",
  { env: { HOME: "/Users/sam", PATH: "/usr/bin", TERM: "dumb", NO_COLOR: "1" } },
  buildManagedLaunchEnv({ HOME: "/Users/sam", PATH: "/usr/bin", TERM: "dumb", NO_COLOR: "1" }),
);

const proxyEnv = {
  HOME: "/Users/sam",
  PATH: "/usr/bin",
  HTTPS_PROXY: "http://127.0.0.1:8888",
  https_proxy: "http://127.0.0.1:8888",
  HTTP_PROXY: "http://127.0.0.1:8888",
  http_proxy: "http://127.0.0.1:8888",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
record("passes proxy settings through, in both spellings", "buildManagedLaunchEnv", { env: proxyEnv }, buildManagedLaunchEnv(proxyEnv));

const wrappedProxy = wrapCommandWithManagedLaunchEnv({
  command: "codex",
  args: [],
  env: { HOME: "/home/aimux", PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:8888" },
});
record("carries the proxy into the env -i argv the tool actually launches with", "wrapCommandWithManagedLaunchEnv", {
  command: "codex",
  args: [],
  env: { HOME: "/home/aimux", PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:8888" },
}, {
  command: wrappedProxy.command,
  contains: {
    "HTTPS_PROXY=http://127.0.0.1:8888": wrappedProxy.args.includes("HTTPS_PROXY=http://127.0.0.1:8888"),
  },
});

const wrapped = wrapCommandWithManagedLaunchEnv({
  command: "claude",
  args: ["--print"],
  env: { HOME: "/Users/sam", PATH: "/usr/bin", TMUX: "bad" },
  extraEnv: { AIMUX_SESSION_ID: "claude-1" },
});
record("wraps managed launches through env -i", "wrapCommandWithManagedLaunchEnv", {
  command: "claude",
  args: ["--print"],
  env: { HOME: "/Users/sam", PATH: "/usr/bin", TMUX: "bad" },
  extraEnv: { AIMUX_SESSION_ID: "claude-1" },
}, {
  command: wrapped.command,
  firstArg: wrapped.args[0],
  contains: {
    "HOME=/Users/sam": wrapped.args.includes("HOME=/Users/sam"),
    "PATH=/usr/bin": wrapped.args.includes("PATH=/usr/bin"),
    "AIMUX_SESSION_ID=claude-1": wrapped.args.includes("AIMUX_SESSION_ID=claude-1"),
  },
  excludes: {
    "TMUX=bad": !wrapped.args.includes("TMUX=bad"),
  },
  penultimate: wrapped.args.at(-2),
  last: wrapped.args.at(-1),
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/managed-launch-env.test.ts",
  generatedBy: "scripts/capture-managed-launch-env-contract.mjs",
  description: "Managed launch environment allowlist, terminal normalization, proxy passthrough, extra env injection, and env -i wrapper behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
