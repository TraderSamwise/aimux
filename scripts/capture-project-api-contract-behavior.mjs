#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-api/behavior.json", ROOT);
const {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEW_INVALIDATIONS,
  PROJECT_API_VIEWS,
  projectApiMutationReasonForRoute,
  projectApiViewsForMutationRoute,
} = await import(new URL("dist/project-api-contract.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
function collectRoutes(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((entry) => collectRoutes(entry));
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `project-api-behavior-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-api-contract.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const routes = collectRoutes(PROJECT_API_ROUTES);
record("defines unique absolute routes", "routeInvariants", {}, {
  count: routes.length,
  allAbsolute: routes.every((route) => route.startsWith("/")),
  uniqueCount: new Set(routes).size,
});
record("keeps shared TUI/app screen routes stable", "sharedRoutes", {}, {
  desktopState: PROJECT_API_ROUTES.desktopState,
  diagnosticsLifecycle: PROJECT_API_ROUTES.diagnosticsLifecycle,
  coordinationWorklist: PROJECT_API_ROUTES.coordinationWorklist,
  projectObservability: PROJECT_API_ROUTES.projectObservability,
  topology: PROJECT_API_ROUTES.topology,
  library: PROJECT_API_ROUTES.library,
  resurrectWorktree: PROJECT_API_ROUTES.graveyardActions.resurrectWorktree,
  livePaneOutput: PROJECT_API_ROUTES.livePane.output,
  livePaneInput: PROJECT_API_ROUTES.livePane.input,
  livePaneInterrupt: PROJECT_API_ROUTES.livePane.interrupt,
  livePaneResize: PROJECT_API_ROUTES.livePane.resize,
  livePaneAttach: PROJECT_API_ROUTES.livePane.attach,
});
record("defines shared SSE event names and API-backed views", "eventsAndViews", {}, {
  projectUpdate: PROJECT_API_EVENT_NAMES.projectUpdate,
  agentOutput: PROJECT_API_EVENT_NAMES.agentOutput,
  views: PROJECT_API_VIEWS,
  containsCoordinationWorklist: PROJECT_API_VIEWS.includes("coordination-worklist"),
  containsDesktopState: PROJECT_API_VIEWS.includes("desktop-state"),
  containsNotifications: PROJECT_API_VIEWS.includes("notifications"),
  containsPlans: PROJECT_API_VIEWS.includes("plans"),
  containsInbox: PROJECT_API_VIEWS.includes("inbox"),
});
record("keeps invalidation groups within the shared view set", "invalidationGroups", {}, PROJECT_API_VIEW_INVALIDATIONS);
const mappingInputs = [
  ["PUT", "/plans/codex-1"],
  ["POST", PROJECT_API_ROUTES.notifications.read],
  ["POST", PROJECT_API_ROUTES.agents.spawn],
  ["POST", PROJECT_API_ROUTES.livePane.interrupt],
  ["POST", PROJECT_API_ROUTES.tasks.assign],
  ["GET", PROJECT_API_ROUTES.controls.switchNext],
  ["POST", "/future-mutation"],
  ["GET", PROJECT_API_ROUTES.agents.list],
];
record(
  "maps mutation routes to shared client invalidations",
  "viewsForMutationRoutes",
  { items: mappingInputs.map(([method, pathname]) => ({ method, pathname })) },
  mappingInputs.map(([method, pathname]) => ({
    method,
    pathname,
    views: projectApiViewsForMutationRoute(method, pathname),
  })),
);
const reasonInputs = [
  ["post", "/tasks/assign"],
  ["", ""],
  ["GET", "/control/switch-next"],
];
record(
  "formats mutation reasons",
  "mutationReasons",
  { items: reasonInputs.map(([method, pathname]) => ({ method, pathname })) },
  reasonInputs.map(([method, pathname]) => ({
    method,
    pathname,
    reason: projectApiMutationReasonForRoute(method, pathname),
  })),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-api-contract.test.ts",
  generatedBy: "scripts/capture-project-api-contract-behavior.mjs",
  description: "Project API route, event, view, and invalidation behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
