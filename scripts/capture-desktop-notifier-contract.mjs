#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/desktop-notifier/notifier.json", ROOT);

const {
  buildDesktopNotifierDoctorReport,
  findMacNotifierHelper,
  macNotifierCandidates,
  renderDesktopNotifierDoctorReport,
  sendDesktopNotification,
  sendDesktopNotificationAndWait,
} = await import(new URL("dist/desktop-notifier.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function execFileMock(result, calls) {
  return (file, args, optionsOrCallback, callback) => {
    const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    calls.push({ file, args, options: typeof optionsOrCallback === "function" ? null : (optionsOrCallback ?? null) });
    const error = result?.error ? Object.assign(new Error(result.error.message), { code: result.error.code }) : null;
    cb?.(error, result?.stdout ?? "", result?.stderr ?? "");
  };
}

function deps(input, calls) {
  return {
    platform: input.deps?.platform,
    arch: input.deps?.arch,
    env: input.deps?.env ?? {},
    moduleDir: input.deps?.moduleDir ?? "/tmp/aimux/dist",
    existsSync: (candidate) => {
      calls.exists.push(candidate);
      return (input.deps?.existingPaths ?? []).includes(candidate);
    },
    execFile: execFileMock(input.deps?.execResult, calls.execFile),
    nodeNotifier: {
      notify(options) {
        calls.nodeNotify.push(options);
      },
    },
  };
}

async function run(input) {
  const calls = { exists: [], execFile: [], nodeNotify: [] };
  const testDeps = deps(input, calls);
  let result;

  if (input.api === "macNotifierCandidates") {
    result = macNotifierCandidates(testDeps);
  } else if (input.api === "findMacNotifierHelper") {
    result = findMacNotifierHelper(testDeps);
  } else if (input.api === "sendDesktopNotification") {
    result = sendDesktopNotification(input.payload, testDeps);
  } else if (input.api === "sendDesktopNotificationAndWait") {
    result = await sendDesktopNotificationAndWait(input.payload, testDeps);
  } else if (input.api === "buildDesktopNotifierDoctorReport") {
    result = await buildDesktopNotifierDoctorReport(testDeps);
  } else if (input.api === "renderDesktopNotifierDoctorReport") {
    result = renderDesktopNotifierDoctorReport(input.report);
  } else {
    throw new Error(`unknown api ${input.api}`);
  }

  return { result, calls };
}

const helper = "/tmp/aimux-notifier.app/Contents/MacOS/aimux-notifier";
const rawHelper = "/tmp/aimux-notifier";
const cases = [
  {
    name: "derives bundled macOS helper candidates",
    input: { api: "macNotifierCandidates", deps: { moduleDir: "/tmp/aimux/dist", arch: "x64", env: {} } },
  },
  {
    name: "keeps only app-bundled helper overrides",
    input: {
      api: "macNotifierCandidates",
      deps: { moduleDir: "/tmp/aimux/dist", arch: "arm64", env: { AIMUX_NOTIFIER_HELPER: rawHelper } },
    },
  },
  {
    name: "resolves existing macOS helper override",
    input: {
      api: "findMacNotifierHelper",
      deps: { env: { AIMUX_NOTIFIER_HELPER: helper }, existingPaths: [helper] },
    },
  },
  {
    name: "ignores missing helper candidates",
    input: { api: "findMacNotifierHelper", deps: { moduleDir: "/tmp/aimux/dist", arch: "x64", env: {} } },
  },
  {
    name: "uses the macOS helper when available",
    input: {
      api: "sendDesktopNotification",
      payload: { title: "aimux", message: "agent waiting", sound: true },
      deps: { platform: "darwin", env: { AIMUX_NOTIFIER_HELPER: helper }, existingPaths: [helper] },
    },
  },
  {
    name: "falls back to node-notifier when no macOS helper is installed",
    input: {
      api: "sendDesktopNotification",
      payload: { title: "aimux", message: "agent waiting", sound: true },
      deps: { platform: "darwin", env: {} },
    },
  },
  {
    name: "uses node-notifier directly on non-macOS platforms",
    input: {
      api: "sendDesktopNotification",
      payload: { title: "aimux", message: "agent waiting", sound: false },
      deps: { platform: "linux", env: { AIMUX_NOTIFIER_HELPER: helper }, existingPaths: [helper] },
    },
  },
  {
    name: "does not use an external transport when notifications are disabled",
    input: {
      api: "sendDesktopNotification",
      payload: { title: "aimux", message: "agent waiting", sound: true },
      deps: { platform: "darwin", env: { AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS: "1" }, existingPaths: [helper] },
    },
  },
  {
    name: "awaits macOS helper delivery for diagnostic sends",
    input: {
      api: "sendDesktopNotificationAndWait",
      payload: { title: "aimux", message: "agent waiting", sound: true },
      deps: {
        platform: "darwin",
        env: { AIMUX_NOTIFIER_HELPER: helper },
        existingPaths: [helper],
        execResult: { stdout: "delivered\n", stderr: "" },
      },
    },
  },
  {
    name: "reports macOS helper delivery failures for diagnostic sends",
    input: {
      api: "sendDesktopNotificationAndWait",
      payload: { title: "aimux", message: "agent waiting", sound: true },
      deps: {
        platform: "darwin",
        env: { AIMUX_NOTIFIER_HELPER: helper },
        existingPaths: [helper],
        execResult: {
          stdout: "authorization=denied\n",
          stderr: "",
          error: { message: "Command failed: notifications are denied", code: 77 },
        },
      },
    },
  },
  {
    name: "builds a macOS doctor report with helper check output",
    input: {
      api: "buildDesktopNotifierDoctorReport",
      deps: {
        platform: "darwin",
        env: { AIMUX_NOTIFIER_HELPER: helper },
        existingPaths: [helper],
        execResult: { stdout: "Aimux notifier ready (app.aimux.notifier)\n", stderr: "" },
      },
    },
  },
  {
    name: "builds a macOS doctor report for denied helper authorization",
    input: {
      api: "buildDesktopNotifierDoctorReport",
      deps: {
        platform: "darwin",
        env: { AIMUX_NOTIFIER_HELPER: helper },
        existingPaths: [helper],
        execResult: {
          stdout: "Aimux notifier ready (app.aimux.notifier); authorization=denied\n",
          stderr: "",
          error: { message: "Command failed: notifications are denied", code: 77 },
        },
      },
    },
  },
  {
    name: "renders missing helper candidates in the doctor report",
    input: {
      api: "renderDesktopNotifierDoctorReport",
      report: {
        platform: "darwin",
        transport: "node-notifier",
        helperPath: null,
        helperCandidates: ["/tmp/one", "/tmp/two"],
      },
    },
  },
  {
    name: "renders non-macOS doctor reports without helper details",
    input: {
      api: "renderDesktopNotifierDoctorReport",
      report: {
        platform: "linux",
        transport: "node-notifier",
        helperPath: null,
        helperCandidates: [],
      },
    },
  },
];

for (const [index, entry] of cases.entries()) {
  entry.id = `desktop-notifier-${String(index + 1).padStart(3, "0")}`;
  entry.source = "src/desktop-notifier.test.ts";
  entry.api = entry.input.api;
  entry.output = await run(entry.input);
  entry.inputSha256 = hash(entry.input);
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/desktop-notifier.test.ts",
  generatedBy: "scripts/capture-desktop-notifier-contract.mjs",
  description:
    "Desktop notification helper candidate selection, transport routing, diagnostic delivery, doctor-report construction, rendering, and side-effect calls captured by running TypeScript desktop-notifier helpers with mocked dependencies.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
