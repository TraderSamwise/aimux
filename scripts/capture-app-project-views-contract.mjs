#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/project-views.json", ROOT);

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

async function importProjectViewsModule() {
  const projectApi = stripImports(await source("src/project-api-contract.ts"));
  let projectViews = stripImports(await source("app/stores/projectViews.ts"));
  projectViews = projectViews.replace(
    /export const projectApiViewRefreshNonceFamily[\s\S]*?const APP_PROJECT_API_VIEW_DEPENDENCIES/,
    "const APP_PROJECT_API_VIEW_DEPENDENCIES",
  );
  const combined = `${projectApi}\n${projectViews}`;
  const transpiled = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-project-views-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const views = await importProjectViewsModule();

const inputs = [
  {
    name: "classifies every shared project API view",
    source: "app/stores/projectViews.test.ts",
    api: "registryKeys",
  },
  {
    name: "keeps refresh dependencies explicit",
    source: "app/stores/projectViews.test.ts",
    api: "viewsByFlag",
    flags: ["projectApiViews", "desktopState", "notificationFeed"],
  },
  {
    name: "routes project update events to the right refresh channels",
    source: "app/stores/projectViews.test.ts",
    api: "projectUpdateTouches",
    cases: [
      { views: ["notifications"] },
      { views: ["agents", "services"] },
      { views: ["future-view"] },
    ],
  },
  {
    name: "maps project update views to view-scoped refreshes",
    source: "app/stores/projectViews.test.ts",
    api: "projectApiViewsForRefresh",
    cases: [
      ["threads", "tasks"],
      ["threads", "threads"],
      ["notifications"],
      ["plans"],
      ["desktop-state"],
      undefined,
      ["future-view"],
    ],
  },
];

function run(input) {
  switch (input.api) {
    case "registryKeys":
      return Object.keys(views.APP_PROJECT_API_VIEW_REGISTRY).sort();
    case "viewsByFlag":
      return Object.fromEntries(
        input.flags.map((flag) => [
          flag,
          Object.entries(views.APP_PROJECT_API_VIEW_REGISTRY)
            .filter(([, refresh]) => refresh[flag])
            .map(([view]) => view)
            .sort(),
        ]),
      );
    case "projectUpdateTouches":
      return input.cases.map((item) => ({
        views: item.views,
        projectApiViews: views.projectUpdateTouchesProjectApiView(item.views),
        desktopState: views.projectUpdateTouchesDesktopState(item.views),
        notificationFeed: views.projectUpdateTouchesNotificationFeed(item.views),
      }));
    case "projectApiViewsForRefresh":
      return input.cases.map((item) => views.projectApiViewsForRefresh(item));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-state-project-views-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/stores/projectViews.test.ts"],
  generatedBy: "scripts/capture-app-project-views-contract.mjs",
  description:
    "App project API view registry, refresh dependency expansion, and update-channel routing captured by running TypeScript projectViews helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
