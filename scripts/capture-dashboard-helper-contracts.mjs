#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const ORDER_FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/order.json", ROOT);
const VISIBILITY_FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/visibility.json", ROOT);
const {
  MAIN_CHECKOUT_ORDER_KEY,
  applyDashboardOrder,
  dashboardOrderKey,
  moveDashboardOrder,
  normalizeDashboardOrder,
  orderDashboardWorktreeGroups,
} = await import(new URL("dist/dashboard/order.js", ROOT));
const { filterDashboardVisibleModel, isDashboardSessionOffline } = await import(new URL("dist/dashboard/visibility.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function runOrder(input) {
  switch (input.api) {
    case "dashboardOrderKey":
      return input.paths.map((path) => ({ path, key: dashboardOrderKey(path) }));
    case "normalizeDashboardOrder":
      return normalizeDashboardOrder(input.currentIds, input.savedOrder);
    case "applyDashboardOrder":
      return {
        orderedIds: applyDashboardOrder(input.items, input.savedOrder).map((item) => item.id),
        originalIds: input.items.map((item) => item.id),
      };
    case "moveDashboardOrder":
      return moveDashboardOrder(input.items, input.savedOrder, input.selectedId, input.direction);
    case "orderDashboardWorktreeGroups":
      return orderDashboardWorktreeGroups(input.groups, input.orderState);
    default:
      throw new Error(`unknown order api ${input.api}`);
  }
}

function session(overrides) {
  return { index: 0, id: overrides.id ?? "session", command: overrides.command ?? "codex", status: overrides.status ?? "running", active: overrides.active ?? true, ...overrides };
}

function service(overrides) {
  return { id: overrides.id ?? "service", command: overrides.command ?? "yarn dev", args: [], status: overrides.status ?? "running", active: overrides.active ?? true, ...overrides };
}

function group(overrides) {
  return { name: overrides.name ?? "main", branch: overrides.branch ?? "master", status: overrides.status ?? "active", sessions: overrides.sessions ?? [], services: overrides.services ?? [], ...overrides };
}

function runVisibility(input) {
  switch (input.api) {
    case "isDashboardSessionOffline":
      return input.sessions.map((entry) => ({ id: entry.id, offline: isDashboardSessionOffline(entry) }));
    case "filterDashboardVisibleModel":
      return filterDashboardVisibleModel(input.model);
    default:
      throw new Error(`unknown visibility api ${input.api}`);
  }
}

const orderInputs = [
  {
    name: "uses stable key for main checkout",
    api: "dashboardOrderKey",
    paths: [undefined, "/repo/.aimux/worktrees/demo"],
  },
  {
    name: "normalizes stale saved ids and appends new ids",
    api: "normalizeDashboardOrder",
    currentIds: ["a", "b", "c"],
    savedOrder: ["b", "missing", "b", "a"],
  },
  {
    name: "applies saved order without mutating input list",
    api: "applyDashboardOrder",
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    savedOrder: ["c", "a"],
  },
  {
    name: "moves selected id down within peers",
    api: "moveDashboardOrder",
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    savedOrder: ["c", "a", "b"],
    selectedId: "a",
    direction: "down",
  },
  {
    name: "does not move first selected id up",
    api: "moveDashboardOrder",
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    savedOrder: ["c", "a", "b"],
    selectedId: "c",
    direction: "up",
  },
  {
    name: "orders agents and services separately inside each worktree",
    api: "orderDashboardWorktreeGroups",
    groups: [
      {
        name: "Main Checkout",
        branch: "master",
        status: "active",
        sessions: [{ id: "agent-a" }, { id: "agent-b" }],
        services: [{ id: "service-a" }, { id: "service-b" }],
      },
    ],
    orderState: {
      agentOrderByWorktreeKey: { [MAIN_CHECKOUT_ORDER_KEY]: ["agent-b", "agent-a"] },
      serviceOrderByWorktreeKey: { [MAIN_CHECKOUT_ORDER_KEY]: ["service-b", "service-a"] },
    },
  },
];

const online = session({ id: "online", worktreePath: "/repo/.aimux/worktrees/live" });
const offline = session({ id: "offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/dead" });
const liveService = service({ id: "live-svc", worktreePath: "/repo/.aimux/worktrees/live" });
const deadService = service({ id: "dead-svc", worktreePath: "/repo/.aimux/worktrees/dead" });
const visibilityInputs = [
  {
    name: "classifies raw semantic and pending offline sessions",
    api: "isDashboardSessionOffline",
    sessions: [
      session({ id: "raw", status: "offline" }),
      session({ id: "semantic", status: "running", semantic: { user: { label: "offline" } } }),
      session({ id: "pending", status: "offline", pendingAction: "starting" }),
      session({ id: "exited", status: "exited" }),
    ],
  },
  {
    name: "returns original model when hide-offline toggle is off",
    api: "filterDashboardVisibleModel",
    model: {
      hideOfflineAgents: false,
      sessions: [session({ id: "offline", status: "offline" })],
      services: [service({ id: "svc" })],
      worktreeGroups: [group({ sessions: [session({ id: "offline", status: "offline" })] })],
    },
  },
  {
    name: "hides offline agents and worktrees with no online agents",
    api: "filterDashboardVisibleModel",
    model: {
      hideOfflineAgents: true,
      sessions: [online, offline],
      services: [liveService, deadService],
      worktreeGroups: [
        group({ name: "live", path: "/repo/.aimux/worktrees/live", sessions: [online], services: [liveService] }),
        group({ name: "dead", path: "/repo/.aimux/worktrees/dead", sessions: [offline], services: [deadService] }),
      ],
    },
  },
  {
    name: "keeps pending worktree operation rows visible without offline agents",
    api: "filterDashboardVisibleModel",
    model: {
      hideOfflineAgents: true,
      sessions: [session({ id: "offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/new" })],
      services: [],
      worktreeGroups: [
        group({
          name: "new",
          branch: "(creating)",
          path: "/repo/.aimux/worktrees/new",
          pending: true,
          pendingAction: "creating",
          sessions: [session({ id: "offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/new" })],
        }),
      ],
    },
  },
];

const orderCases = orderInputs.map((input, index) => ({
  id: `dashboard-order-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard/order.test.ts",
  api: input.api,
  input,
  output: runOrder(input),
  inputSha256: hash(input),
}));

const visibilityCases = visibilityInputs.map((input, index) => ({
  id: `dashboard-visibility-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard/visibility.test.ts",
  api: input.api,
  input,
  output: runVisibility(input),
  inputSha256: hash(input),
}));

await writeContractJson(ORDER_FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/order.test.ts",
  generatedBy: "scripts/capture-dashboard-helper-contracts.mjs",
  description: "Dashboard order helper contracts captured by running TypeScript dashboard/order helpers.",
  cases: orderCases,
});

await writeContractJson(VISIBILITY_FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/visibility.test.ts",
  generatedBy: "scripts/capture-dashboard-helper-contracts.mjs",
  description: "Dashboard visibility helper contracts captured by running TypeScript dashboard/visibility helpers.",
  cases: visibilityCases,
});

console.log(`${ORDER_FIXTURE_PATH.pathname}: ${orderCases.length} cases`);
console.log(`${VISIBILITY_FIXTURE_PATH.pathname}: ${visibilityCases.length} cases`);
