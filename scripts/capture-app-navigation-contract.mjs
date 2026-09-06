#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-navigation/navigation.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(path, stripImports = false) {
  const url = new URL(path, ROOT);
  let source = await readFile(url, "utf8");
  if (stripImports) source = source.replace(/^import .*;\n/gm, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const { initialMainRoute } = await importTypeScriptModule("app/lib/initial-main-route.ts");
const { buildMainTabHref, mainTabForPath, MAIN_TAB_ROUTES } = await importTypeScriptModule("app/lib/main-tabs.ts", true);
const { filterProjectPickerProjects, hasKnownOnlineAgents } = await importTypeScriptModule("app/lib/project-picker.ts");

function run(input) {
  if (input.api === "initialMainRoute") return initialMainRoute(input.value);
  if (input.api === "buildMainTabHref") return buildMainTabHref(input.tabId, input.projectPath);
  if (input.api === "mainTabForPath") return mainTabForPath(input.pathname);
  if (input.api === "MAIN_TAB_ROUTES") return MAIN_TAB_ROUTES[input.tabId];
  if (input.api === "filterProjectPickerProjects") return filterProjectPickerProjects(input.projects, input.options).map((project) => project.id);
  if (input.api === "hasKnownOnlineAgents") return hasKnownOnlineAgents(input.project);
  throw new Error(`unknown api ${input.api}`);
}

const routeBase = {
  isSignedIn: true,
  realSharedChatCount: 1,
  activeProjectCount: 1,
  projectDiscoverySynced: true,
  relayConfigured: true,
  relayStatus: "connected",
};
function project(input) {
  return {
    dashboardSessionName: `aimux-${input.id}`,
    path: `/repo/${input.id}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
    ...input,
  };
}

const pickerProjects = [
  project({ id: "active", name: "active", onlineAgentCount: 2 }),
  project({ id: "empty", name: "empty", onlineAgentCount: 0 }),
  project({ id: "unknown", name: "unknown" }),
];

const inputs = [
  { name: "initial route defaults to project when signed out", source: "app/lib/initial-main-route.test.ts", api: "initialMainRoute", value: { ...routeBase, isSignedIn: false } },
  { name: "initial route defaults to project without shared chats", source: "app/lib/initial-main-route.test.ts", api: "initialMainRoute", value: { ...routeBase, realSharedChatCount: 0 } },
  { name: "initial route waits for project discovery before shared fallback", source: "app/lib/initial-main-route.test.ts", api: "initialMainRoute", value: { ...routeBase, activeProjectCount: 0, projectDiscoverySynced: false, relayConfigured: false, relayStatus: "disconnected" } },
  { name: "initial route uses shared when no active projects remain", source: "app/lib/initial-main-route.test.ts", api: "initialMainRoute", value: { ...routeBase, activeProjectCount: 0 } },
  { name: "initial route uses shared when relay CLI lane is unavailable", source: "app/lib/initial-main-route.test.ts", api: "initialMainRoute", value: { ...routeBase, activeProjectCount: 2, relayStatus: "device_pending" } },
  { name: "builds project tab href with project param", source: "app/lib/main-tabs.test.ts", api: "buildMainTabHref", tabId: "project", projectPath: "/Users/sam/cs/tealstreet-next" },
  { name: "builds threads tab href", source: "app/lib/main-tabs.test.ts", api: "buildMainTabHref", tabId: "threads", projectPath: "/Users/sam/cs/aimux" },
  { name: "builds inbox internal notification tab href", source: "app/lib/main-tabs.test.ts", api: "buildMainTabHref", tabId: "inbox", projectPath: "/Users/sam/cs/aimux" },
  { name: "omits empty project params", source: "app/lib/main-tabs.test.ts", api: "buildMainTabHref", tabId: "project", projectPath: "" },
  { name: "keeps public threads route separate", source: "app/lib/main-tabs.test.ts", api: "MAIN_TAB_ROUTES", tabId: "threads" },
  { name: "maps notification paths to inbox tab", source: "app/lib/main-tabs.ts", api: "mainTabForPath", pathname: "/notifications" },
  { name: "maps settings paths to settings tab", source: "app/lib/main-tabs.ts", api: "mainTabForPath", pathname: "/settings/profile" },
  { name: "maps unknown paths to dashboard tab", source: "app/lib/main-tabs.ts", api: "mainTabForPath", pathname: "/unknown" },
  { name: "project picker defaults to projects with known online agents", source: "app/lib/project-picker.test.ts", api: "filterProjectPickerProjects", projects: pickerProjects, options: { showAll: false } },
  { name: "project picker can show every project", source: "app/lib/project-picker.test.ts", api: "filterProjectPickerProjects", projects: pickerProjects, options: { showAll: true } },
  { name: "known online agent count accepts unknown counts", source: "app/lib/project-picker.ts", api: "hasKnownOnlineAgents", project: { onlineAgentCount: undefined } },
  { name: "known online agent count rejects zero", source: "app/lib/project-picker.ts", api: "hasKnownOnlineAgents", project: { onlineAgentCount: 0 } },
];

const cases = inputs.map((input, index) => ({
  id: `app-navigation-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/initial-main-route.test.ts", "app/lib/main-tabs.test.ts", "app/lib/project-picker.test.ts"],
  generatedBy: "scripts/capture-app-navigation-contract.mjs",
  description:
    "App initial route selection, main tab href/path mapping, public/internal tab route separation, and project picker online-agent filtering captured by running TypeScript app navigation helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
