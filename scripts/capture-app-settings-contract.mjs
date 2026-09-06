#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/settings.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function source(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

function stripImports(sourceText) {
  return sourceText.replace(/^import[\s\S]*?;\n/gm, "");
}

async function importSettingsPureModule() {
  const notificationSettings = stripImports(await source("app/lib/notification-settings.ts"));
  let settings = stripImports(await source("app/stores/settings.ts"));
  settings = settings.replace(/const settingsStorage[\s\S]*?export function desktopAppZoomScale/, "export function desktopAppZoomScale");
  const combined = `${notificationSettings}\n${settings}`;
  const transpiled = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-settings-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const settings = await importSettingsPureModule();

const share = {
  shareId: "share_1",
  ownerUserId: "user_owner",
  projectRoot: "/repo",
  sessionId: "claude-1",
  serviceEndpoint: { host: " 127.0.0.1 ", port: 43192 },
  acceptedAt: "2026-05-24T00:00:00.000Z",
};

const inputs = [
  {
    name: "keeps durable UI settings in one persisted settings object",
    source: "app/stores/settings.test.ts",
    api: "defaultSettings",
  },
  {
    name: "normalizes older persisted settings without notification keys",
    source: "app/stores/settings.test.ts",
    api: "normalizeAppSettings",
    value: { theme: "light" },
  },
  {
    name: "normalizes monitor camera viewport values",
    source: "app/stores/settings.test.ts",
    api: "normalizeAppSettings",
    value: {
      ...settings.defaultSettings,
      monitor: {
        ...settings.defaultSettings.monitor,
        cameraViewport: { centerX: 4, centerY: -2, zoom: 9 },
      },
    },
  },
  {
    name: "normalizes shares and monitor scalar fallbacks",
    source: "app/stores/settings.ts",
    api: "normalizeAppSettings",
    value: {
      ...settings.defaultSettings,
      desktopAppZoom: 133,
      acceptedShares: [
        { ...share, acceptedAt: "2026-05-20T00:00:00.000Z" },
        { ...share, acceptedAt: "2026-05-24T00:00:00.000Z" },
        { ...share, shareId: "", ownerUserId: "missing" },
      ],
      activeShare: { ...share, acceptedAt: "" },
      monitor: {
        intervalSeconds: 17,
        targetKind: "bad",
        captureMode: "bad",
        cameraViewport: null,
        speechToText: false,
        speechOnDeviceOnly: false,
        speechInterimResults: false,
        speechLanguage: "not a locale!",
        audioSampleRate: 12345,
        projectPath: " /repo ",
        sessionId: " ",
        shareOwnerUserId: " owner ",
        shareId: "",
      },
    },
  },
  {
    name: "steps desktop zoom inside bounds",
    source: "app/stores/settings.ts",
    api: "stepDesktopAppZoom",
    values: [
      { value: 80, direction: -1 },
      { value: 110, direction: 1 },
      { value: 150, direction: 1 },
      { value: 133, direction: 1 },
    ],
  },
  {
    name: "converts desktop zoom to scale",
    source: "app/stores/settings.ts",
    api: "desktopAppZoomScale",
    values: [80, 110, 150],
  },
];

function run(input) {
  switch (input.api) {
    case "defaultSettings":
      return settings.defaultSettings;
    case "normalizeAppSettings":
      return settings.normalizeAppSettings(input.value);
    case "stepDesktopAppZoom":
      return input.values.map((item) => settings.stepDesktopAppZoom(item.value, item.direction));
    case "desktopAppZoomScale":
      return input.values.map((value) => settings.desktopAppZoomScale(value));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-state-settings-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/stores/settings.test.ts", "app/stores/settings.ts"],
  generatedBy: "scripts/capture-app-settings-contract.mjs",
  description:
    "Durable app settings defaults, migration normalization, monitor viewport clamping, share normalization, and desktop zoom helpers captured by running TypeScript settings helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
