#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/backend-session-discovery/discovery.json", ROOT);

const {
  claudeTranscriptPath,
  discoverBackendSessionId,
  discoverClaudeBackendSessionId,
  discoverCodexBackendSessionId,
  relocateClaudeTranscript,
} = await import(new URL("dist/backend-session-discovery.js", ROOT));
const { SessionBootstrapService } = await import(new URL("dist/session-bootstrap.js", ROOT));

const UUID_A = "0710a963-a473-430f-9f9a-e27dd4546328";
const UUID_B = "11111111-2222-3333-4444-555555555555";
const SOURCE_ID = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6af";
const FORKED_ID = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6b0";
const CLAUDE_CWD = "/Users/x/cs/proj/.aimux/worktrees/chat-sync";
const CLAUDE_ENCODED = "-Users-x-cs-proj--aimux-worktrees-chat-sync";
const CODEX_CWD = "/Users/x/cs/proj/.aimux/worktrees/chat-sync";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const recordCase = (cases, name, api, input, output) => {
  cases.push({
    id: `backend-session-discovery-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/backend-session-discovery.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
};

function withEnv(vars, fn) {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeClaudeTranscript(projectsDir, encoded, name, mtimeSec, content = "{}\n") {
  const dir = join(projectsDir, encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
  return relative(projectsDir, path);
}

function writeCodexTranscript(sessionsDir, day, uuid, cwd, options = {}) {
  const dir = join(sessionsDir, "2026", "06", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-06-${day}T00-00-00-${uuid}.jsonl`);
  const payload = {
    type: "session_meta",
    payload: {
      id: uuid,
      cwd,
      ...(options.extraPayload ?? {}),
    },
  };
  writeFileSync(path, `${JSON.stringify(payload)}\n${options.trailing ?? "{}\n"}`);
  if (options.mtimeSec !== undefined) utimesSync(path, options.mtimeSec, options.mtimeSec);
  return relative(sessionsDir, path);
}

function captureClaudeCases(cases) {
  recordCase(
    cases,
    "derives claude transcript path from cwd and backend id",
    "claudeTranscriptPath",
    {
      cwd: CLAUDE_CWD,
      backendSessionId: UUID_A,
      projectsDir: "/fixtures/claude/projects",
    },
    claudeTranscriptPath(CLAUDE_CWD, UUID_A, "/fixtures/claude/projects"),
  );

  for (const scenario of [
    {
      name: "returns single claude transcript uuid for worktree",
      cwd: CLAUDE_CWD,
      files: [{ name: `${UUID_A}.jsonl`, mtimeSec: 1000 }],
    },
    {
      name: "refuses ambiguous claude transcript matches",
      cwd: CLAUDE_CWD,
      files: [
        { name: `${UUID_A}.jsonl`, mtimeSec: 1000 },
        { name: `${UUID_B}.jsonl`, mtimeSec: 2000 },
      ],
    },
    {
      name: "ignores non-uuid and non-jsonl claude files",
      cwd: CLAUDE_CWD,
      files: [
        { name: "not-a-uuid.jsonl", mtimeSec: 5000 },
        { name: `${UUID_A}.txt`, mtimeSec: 6000 },
        { name: `${UUID_A}.jsonl`, mtimeSec: 1000 },
      ],
    },
    {
      name: "returns null when claude worktree directory is absent",
      cwd: "/Users/x/other",
      files: [],
    },
  ]) {
    withTempDir("aimux-contract-claude-projects-", (projectsDir) => {
      const files = scenario.files.map((file) =>
        writeClaudeTranscript(projectsDir, CLAUDE_ENCODED, file.name, file.mtimeSec),
      );
      const input = { cwd: scenario.cwd, projectsDirShape: files };
      recordCase(
        cases,
        scenario.name,
        "discoverClaudeBackendSessionId",
        input,
        discoverClaudeBackendSessionId(scenario.cwd, projectsDir),
      );
    });
  }

  withTempDir("aimux-contract-claude-projects-", (configDir) => {
    writeClaudeTranscript(join(configDir, "projects"), CLAUDE_ENCODED, `${UUID_A}.jsonl`, 1000);
    const input = {
      env: { CLAUDE_CONFIG_DIR: "<temp>" },
      calls: [{ toolConfigKey: "claude" }, { toolConfigKey: "unknown", cwd: CLAUDE_CWD }],
    };
    const output = withEnv({ CLAUDE_CONFIG_DIR: configDir }, () => ({
      missingCwd: discoverBackendSessionId("claude", undefined),
      unknownTool: discoverBackendSessionId("unknown", CLAUDE_CWD),
    }));
    recordCase(cases, "dispatcher requires cwd and rejects unknown tools", "discoverBackendSessionId", input, output);
  });
}

function captureCodexCases(cases) {
  for (const scenario of [
    {
      name: "returns single codex transcript id for cwd",
      files: [{ day: "14", uuid: UUID_A, cwd: CODEX_CWD }],
    },
    {
      name: "handles large codex session_meta records",
      files: [
        {
          day: "14",
          uuid: UUID_A,
          cwd: CODEX_CWD,
          extraPayload: { base_instructions: { text: "x".repeat(80 * 1024) } },
          trailing: '{"type":"response","payload":{"text":"not read by discovery"}}\n',
        },
      ],
    },
    {
      name: "refuses ambiguous codex cwd matches",
      files: [
        { day: "14", uuid: UUID_A, cwd: CODEX_CWD },
        { day: "15", uuid: UUID_B, cwd: CODEX_CWD },
      ],
    },
    {
      name: "ignores old codex transcripts below launch lower bound",
      options: { sinceMs: 1_500_000 },
      files: [
        { day: "14", uuid: UUID_A, cwd: CODEX_CWD, mtimeSec: 1000 },
        { day: "15", uuid: UUID_B, cwd: CODEX_CWD, mtimeSec: 2000 },
      ],
    },
    {
      name: "ignores codex transcripts for other cwd values",
      files: [{ day: "14", uuid: UUID_A, cwd: "/Users/x/other" }],
    },
  ]) {
    withTempDir("aimux-contract-codex-home-", (home) => {
      const sessionsDir = join(home, "sessions");
      const files = scenario.files.map((file) =>
        writeCodexTranscript(sessionsDir, file.day, file.uuid, file.cwd, file),
      );
      const input = { cwd: CODEX_CWD, sessionsDirShape: files, options: scenario.options ?? {} };
      recordCase(
        cases,
        scenario.name,
        "discoverCodexBackendSessionId",
        input,
        discoverCodexBackendSessionId(CODEX_CWD, sessionsDir, scenario.options ?? {}),
      );
    });
  }

  withTempDir("aimux-contract-codex-home-", (home) => {
    const sessionsDir = join(home, "sessions");
    writeCodexTranscript(sessionsDir, "14", UUID_A, CODEX_CWD);
    const input = { env: { CODEX_HOME: "<temp>" }, toolConfigKey: "codex", cwd: CODEX_CWD };
    const output = withEnv({ CODEX_HOME: home }, () => discoverBackendSessionId("codex", CODEX_CWD));
    recordCase(
      cases,
      "dispatcher handles codex when cwd has one transcript",
      "discoverBackendSessionId",
      input,
      output,
    );
  });

  withTempDir("aimux-contract-codex-sibling-", (home) => {
    const sessionsDir = join(home, "sessions");
    const cwd = join(home, "worktree");
    mkdirSync(cwd, { recursive: true });
    const files = [
      writeCodexTranscript(sessionsDir, "08", SOURCE_ID, cwd),
      writeCodexTranscript(sessionsDir, "08", FORKED_ID, cwd),
    ];
    const input = { cwd: "<temp>/worktree", sessionsDirShape: files, source: SOURCE_ID, forked: FORKED_ID };
    const output = {
      withoutExclude: discoverCodexBackendSessionId(cwd, sessionsDir),
      excludingSource: discoverCodexBackendSessionId(cwd, sessionsDir, { excludeBackendSessionIds: [SOURCE_ID] }),
      excludingBoth: discoverCodexBackendSessionId(cwd, sessionsDir, {
        excludeBackendSessionIds: [SOURCE_ID, FORKED_ID],
      }),
    };
    recordCase(cases, "ignores id already held by live sibling", "discoverCodexBackendSessionId", input, output);
  });
}

function captureRelocationCases(cases) {
  withTempDir("aimux-contract-claude-projects-", (projectsDir) => {
    const source = "/Users/someone/cs/proj";
    const target = "/Users/someone/cs/proj/.aimux/worktrees/feature";
    const id = "4849a2ce-ea35-44f3-9206-d8054a5704bc";
    const from = claudeTranscriptPath(source, id, projectsDir);
    const to = claudeTranscriptPath(target, id, projectsDir);
    mkdirSync(dirname(from), { recursive: true });
    writeFileSync(from, '{"type":"user","message":{"content":"write me a poem"}}\n');

    const input = {
      sourceCwd: source,
      targetCwd: target,
      backendSessionId: id,
      sourceExistsBefore: existsSync(from),
      targetExistsBefore: existsSync(to),
    };
    const relocated = relocateClaudeTranscript(source, target, id, projectsDir);
    const output = {
      relocated,
      sourceExistsAfter: existsSync(from),
      targetExistsAfter: existsSync(to),
      targetContentIncludesPoem: existsSync(to) && readFileSync(to, "utf-8").includes("write me a poem"),
    };
    recordCase(cases, "relocates claude transcript to target worktree", "relocateClaudeTranscript", input, output);
  });

  withTempDir("aimux-contract-claude-projects-empty-", (projectsDir) => {
    const id = "4849a2ce-ea35-44f3-9206-d8054a5704bc";
    const input = {
      missingSource: { sourceCwd: "/a", targetCwd: "/b", backendSessionId: id },
      samePlace: { sourceCwd: "/a", targetCwd: "/a", backendSessionId: id },
    };
    const output = {
      missingSource: relocateClaudeTranscript("/a", "/b", id, projectsDir),
      samePlace: relocateClaudeTranscript("/a", "/a", id, projectsDir),
    };
    recordCase(cases, "reports missing source and no-ops same-place move", "relocateClaudeTranscript", input, output);
  });
}

function captureBootstrapArgs(cases) {
  const compose = (base, action, saved) =>
    SessionBootstrapService.prototype.composeToolArgs.call(null, { args: base }, action, saved);
  const base = ["--dangerously-skip-permissions"];
  const first = "0f0e2b1a-1111-2222-3333-444455556666";
  const firstMove = compose(base, ["--resume", first], base);
  const secondMove = compose(base, ["--resume", first], base);
  const rememberedLaunch = compose(base, ["--resume", first], firstMove);
  const input = { base, action: ["--resume", first], saved: { original: base, rememberedLaunch: firstMove } };
  const output = {
    firstMove,
    secondMove,
    secondMoveResumeCount: secondMove.filter((arg) => arg === "--resume").length,
    ifRememberedLaunch: rememberedLaunch,
    ifRememberedLaunchResumeCount: rememberedLaunch.filter((arg) => arg === "--resume").length,
  };
  recordCase(
    cases,
    "moved session args do not accumulate resume flags",
    "SessionBootstrapService.composeToolArgs",
    input,
    output,
  );
}

const cases = [];
captureClaudeCases(cases);
captureCodexCases(cases);
captureRelocationCases(cases);
captureBootstrapArgs(cases);

const contract = {
  version: 1,
  source: "src/backend-session-discovery.ts",
  generatedBy: "scripts/capture-backend-session-discovery-contract.mjs",
  description:
    "Backend session discovery, transcript relocation, and moved-session argv contracts captured by running TypeScript filesystem helpers.",
  cases,
};

await writeContractJson(FIXTURE_PATH, contract);
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
