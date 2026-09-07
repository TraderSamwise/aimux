#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/doctor.json", ROOT);
const { buildTmuxDoctorReport, renderTmuxDoctorReport, repairTmuxRuntime } = await import(
  new URL("dist/tmux/doctor.js", ROOT)
);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rootPath = ROOT.pathname.replace(/\/$/, "");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, tempDir = "") {
  let json = JSON.stringify(value).split(rootPath).join("<REPO>");
  if (tempDir) json = json.split(tempDir).join("<TMP>");
  return JSON.parse(json);
}

function createDoctorExec(calls = []) {
  return (args) => {
    const joined = args.join(" ");
    calls.push(args);
    if (joined === "-V") return "tmux 3.5a";
    if (joined === "has-session -t aimux-mobile-abc") return "";
    if (joined === "display-message -p #{client_session}") return "aimux-mobile-abc";
    if (joined === "display-message -p #{window_id}") return "@3";
    if (joined === "display-message -p #{window_name}") return "codex";
    if (joined === "show-options -v -t aimux-mobile-abc prefix") return "C-a";
    if (joined === "show-options -v -t aimux-mobile-abc prefix2") return "C-b";
    if (joined === "show-options -v -t aimux-mobile-abc mouse") return "on";
    if (joined === "show-options -v -t aimux-mobile-abc window-size") return "latest";
    if (joined === "show-options -v -t aimux-mobile-abc history-limit") return "20000";
    if (joined === "show-options -v -t aimux-mobile-abc extended-keys") return "always";
    if (joined === "show-options -v -t aimux-mobile-abc extended-keys-format") return "csi-u";
    if (joined === "show-options -v -t aimux-mobile-abc terminal-features") {
      return "xterm*:clipboard:ccolour:cstyle:focus:title\nxterm*:RGB\nxterm*:extkeys\nxterm*:hyperlinks";
    }
    if (joined === "show-options -v -t aimux-mobile-abc status-format[0]") return "#(top)";
    if (joined === "show-options -v -t aimux-mobile-abc status-format[1]") return "#(bottom)";
    if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) {
      return [
        "@0\t0\tdashboard\t0\t0\t0\t",
        `@3\t3\tcodex\t1\t0\t0\t${JSON.stringify({
          sessionId: "codex-abc123",
          command: "codex",
          args: ["--full-auto"],
          toolConfigKey: "codex",
          worktreePath: "/repo/mobile",
        })}`,
      ].join("\n");
    }
    if (joined === "show-window-options -v -t @3 @aimux-tool") return "codex";
    if (joined === "show-window-options -v -t @3 allow-passthrough") return "on";
    if (joined === "show-window-options -v -t @3 aggressive-resize") return "on";
    throw new Error(`Unhandled tmux call: ${joined}`);
  };
}

function record(cases, name, input, run, tempDir = "") {
  const normalizedInput = normalize(input, tempDir);
  cases.push({
    id: `tmux-doctor-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/doctor.test.ts",
    api: input.api,
    input: normalizedInput,
    output: normalize(run(), tempDir),
    inputSha256: hash(normalizedInput),
  });
}

const cases = [];
record(
  cases,
  "builds compatibility report for active managed session",
  {
    api: "buildTmuxDoctorReport",
    projectRoot: "/repo/mobile",
    env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1000/default,123,0" },
    sessionName: "aimux-mobile-abc",
  },
  () => {
    const calls = [];
    const report = buildTmuxDoctorReport(new TmuxRuntimeManager(createDoctorExec(calls)), {
      projectRoot: "/repo/mobile",
      env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1000/default,123,0" },
      sessionName: "aimux-mobile-abc",
    });
    return { report, calls };
  },
);

record(
  cases,
  "renders readable report",
  {
    api: "renderTmuxDoctorReport",
    projectRoot: "/repo/mobile",
    env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1000/default,123,0" },
    sessionName: "aimux-mobile-abc",
  },
  () => {
    const report = buildTmuxDoctorReport(new TmuxRuntimeManager(createDoctorExec()), {
      projectRoot: "/repo/mobile",
      env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1000/default,123,0" },
      sessionName: "aimux-mobile-abc",
    });
    return { text: renderTmuxDoctorReport(report) };
  },
);

const tmpRoot = mkdtempSync(join(tmpdir(), "aimux-doctor-contract-"));
try {
  const realRoot = join(tmpRoot, "repo");
  const aliasRoot = join(tmpRoot, "repo-link");
  mkdirSync(realRoot);
  symlinkSync(realRoot, aliasRoot, "dir");
  const expectedSession = new TmuxRuntimeManager(createDoctorExec()).getProjectSession(realpathSync(aliasRoot)).sessionName;
  const aliasSession = new TmuxRuntimeManager(createDoctorExec()).getProjectSession(aliasRoot).sessionName;

  record(
    cases,
    "canonicalizes symlinked project root before managed session lookup",
    { api: "buildTmuxDoctorReport", projectRoot: aliasRoot },
    () => {
      const calls = [];
      const exec = (args) => {
        const joined = args.join(" ");
        calls.push(args);
        if (joined === "-V") return "tmux 3.5a";
        if (joined === `has-session -t ${expectedSession}`) return "";
        if (joined === `show-options -v -t ${expectedSession} prefix`) return "C-a";
        if (joined === `show-options -v -t ${expectedSession} prefix2`) return "C-b";
        if (joined === `show-options -v -t ${expectedSession} mouse`) return "on";
        if (joined === `show-options -v -t ${expectedSession} window-size`) return "latest";
        if (joined === `show-options -v -t ${expectedSession} history-limit`) return "20000";
        if (joined === `show-options -v -t ${expectedSession} extended-keys`) return "always";
        if (joined === `show-options -v -t ${expectedSession} extended-keys-format`) return "csi-u";
        if (joined === `show-options -v -t ${expectedSession} terminal-features`) {
          return "xterm*:RGB\nxterm*:extkeys\nxterm*:hyperlinks";
        }
        if (joined === `show-options -v -t ${expectedSession} status-format[0]`) return "#(top)";
        if (joined === `show-options -v -t ${expectedSession} status-format[1]`) return "#(bottom)";
        if (joined.startsWith(`list-windows -t ${expectedSession} -F `)) return "";
        throw new Error(`Unhandled tmux call: ${joined}`);
      };
      return {
        aliasSession,
        expectedSession,
        report: buildTmuxDoctorReport(new TmuxRuntimeManager(exec), { projectRoot: aliasRoot, env: {} }),
        calls,
      };
    },
    tmpRoot,
  );

  record(
    cases,
    "repairs alias-derived managed sessions for canonical project",
    { api: "repairTmuxRuntime", projectRoot: aliasRoot },
    () => {
      const canonicalRoot = realpathSync(aliasRoot);
      const canonicalSession = new TmuxRuntimeManager(createDoctorExec()).getProjectSession(canonicalRoot).sessionName;
      const configured = [];
      const target = {
        sessionName: canonicalSession,
        windowId: "@dashboard",
        windowIndex: 0,
        windowName: "dashboard",
      };
      const calls = [];
      const tmux = {};
      for (const [name, impl] of Object.entries({
        isAvailable: () => true,
        isInsideTmux: () => false,
        currentClientSession: () => null,
        listSessionNames: () => [canonicalSession, aliasSession],
        hasSession: (sessionName) => sessionName === canonicalSession || sessionName === aliasSession,
        isManagedSessionName: (sessionName) => sessionName.startsWith("aimux-"),
        getSessionOption: (sessionName, option) => (option === "@aimux-project-root" && sessionName === aliasSession ? aliasRoot : null),
        getProjectSession: (projectRoot) => ({ projectRoot, projectId: "repo", sessionName: canonicalSession }),
        ensureProjectSession: (projectRoot) => ({ projectRoot, projectId: "repo", sessionName: canonicalSession }),
        configureManagedSession: (sessionName, projectRoot) => configured.push([sessionName, projectRoot]),
        getOpenSessionName: (sessionName) => sessionName,
        ensureDashboardWindow: () => target,
        getWindowOption: () => null,
        isWindowAlive: () => true,
        respawnWindow: () => undefined,
        replaceWindowWhenReady: () => target,
        setSessionOption: () => undefined,
        setWindowOption: () => undefined,
        listManagedWindows: () => [],
        applyManagedAgentWindowPolicy: () => undefined,
      })) {
        tmux[name] = (...args) => {
          calls.push({ method: name, args });
          return impl(...args);
        };
      }
      const result = repairTmuxRuntime(tmux, { projectRoot: aliasRoot });
      return { result, configured, calls };
    },
    tmpRoot,
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-doctor-contract.mjs",
  source: "src/tmux/doctor.test.ts",
  sources: ["src/tmux/doctor.test.ts", "src/tmux/doctor.ts"],
  subject: "tmux doctor report and repair",
  description: "tmux doctor reports, rendered text, and repair side effects captured by running TypeScript with mocked tmux.",
  normalizedFields: ["temp symlink roots", "repository path"],
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
