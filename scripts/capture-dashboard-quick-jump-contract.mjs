#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/quick-jump.json", ROOT);
const { buildDashboardQuickJumpWorktrees, resolveDashboardQuickJumpTarget } = await import(
  new URL("dist/dashboard/quick-jump.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function session(overrides) {
  return {
    index: overrides.index ?? 0,
    id: overrides.id ?? "session",
    command: overrides.command ?? "codex",
    status: overrides.status ?? "running",
    active: overrides.active ?? false,
    ...overrides,
  };
}

function service(overrides) {
  return {
    id: overrides.id ?? "service",
    command: overrides.command ?? "shell",
    args: overrides.args ?? [],
    status: overrides.status ?? "running",
    active: overrides.active ?? false,
    ...overrides,
  };
}

function group(overrides) {
  return {
    name: overrides.name,
    branch: overrides.branch,
    path: overrides.path,
    status: overrides.status ?? "active",
    sessions: overrides.sessions ?? [],
    services: overrides.services ?? [],
    ...overrides,
  };
}

function runQuickJump(input) {
  const worktrees = buildDashboardQuickJumpWorktrees(input.model);
  if (input.api === "buildDashboardQuickJumpWorktrees") {
    return worktrees;
  }
  if (input.api === "resolveDashboardQuickJumpTarget") {
    return {
      worktrees,
      targets: input.digits.map((digits) => ({ digits, target: resolveDashboardQuickJumpTarget(worktrees, digits) })),
    };
  }
  throw new Error(`unknown quick jump api ${input.api}`);
}

const cases = [
  {
    name: "numbers worktrees and entries in visual order including services",
    api: "buildDashboardQuickJumpWorktrees",
    model: {
      sessions: [
        session({ index: 0, id: "main-agent", command: "codex" }),
        session({
          index: 1,
          id: "wt-agent",
          command: "claude",
          worktreePath: "/repo/w1",
          worktreeName: "w1",
          worktreeBranch: "feat/w1",
        }),
      ],
      services: [
        service({ id: "main-service" }),
        service({ id: "wt-service", worktreePath: "/repo/w1", worktreeName: "w1", worktreeBranch: "feat/w1" }),
      ],
      worktreeGroups: [group({ name: "w1", branch: "feat/w1", path: "/repo/w1" })],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    },
  },
  {
    name: "resolves one digit to a worktree and two digits to an entry",
    api: "resolveDashboardQuickJumpTarget",
    digits: ["1", "12"],
    model: {
      sessions: [session({ index: 0, id: "agent-1", command: "codex" })],
      services: [service({ id: "service-1" })],
      worktreeGroups: [],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    },
  },
  {
    name: "keeps main first and sorts agents and services newest first inside each worktree",
    api: "buildDashboardQuickJumpWorktrees",
    model: {
      sessions: [
        session({ index: 0, id: "old-agent", worktreePath: "/repo/w1", createdAt: "2026-01-01T00:00:00.000Z" }),
        session({
          index: 1,
          id: "new-agent",
          command: "claude",
          worktreePath: "/repo/w1",
          createdAt: "2026-01-03T00:00:00.000Z",
        }),
      ],
      services: [
        service({ id: "old-service", worktreePath: "/repo/w1", createdAt: "2026-01-02T00:00:00.000Z" }),
        service({ id: "new-service", worktreePath: "/repo/w1", createdAt: "2026-01-04T00:00:00.000Z" }),
      ],
      worktreeGroups: [
        group({
          name: "older",
          branch: "older",
          path: "/repo/older",
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "offline",
        }),
        group({ name: "w1", branch: "feat/w1", path: "/repo/w1", createdAt: "2026-01-05T00:00:00.000Z" }),
      ],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    },
  },
  {
    name: "sorts main checkout entries by creation time even when the main group is explicit",
    api: "buildDashboardQuickJumpWorktrees",
    model: {
      sessions: [
        session({ index: 0, id: "old-main-agent", createdAt: "2026-01-01T00:00:00.000Z" }),
        session({ index: 1, id: "new-main-agent", command: "claude", createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
      services: [
        service({ id: "old-main-service", createdAt: "2026-01-02T00:00:00.000Z" }),
        service({ id: "new-main-service", createdAt: "2026-01-04T00:00:00.000Z" }),
      ],
      worktreeGroups: [group({ name: "Main Checkout", branch: "master" })],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    },
  },
  {
    name: "preserves ordered entries already attached to rendered worktree groups",
    api: "buildDashboardQuickJumpWorktrees",
    model: (() => {
      const oldAgent = session({ index: 0, id: "old-agent", worktreePath: "/repo/w1", createdAt: "2026-01-01T00:00:00.000Z" });
      const newAgent = session({
        index: 1,
        id: "new-agent",
        command: "claude",
        worktreePath: "/repo/w1",
        createdAt: "2026-01-03T00:00:00.000Z",
      });
      const oldService = service({ id: "old-service", worktreePath: "/repo/w1", createdAt: "2026-01-02T00:00:00.000Z" });
      const newService = service({ id: "new-service", worktreePath: "/repo/w1", createdAt: "2026-01-04T00:00:00.000Z" });
      return {
        sessions: [newAgent, oldAgent],
        services: [newService, oldService],
        worktreeGroups: [
          group({
            name: "w1",
            branch: "feat/w1",
            path: "/repo/w1",
            sessions: [oldAgent, newAgent],
            services: [oldService, newService],
          }),
        ],
        mainCheckout: { name: "Main Checkout", branch: "master" },
      };
    })(),
  },
];

const contractCases = cases.map((input, index) => ({
  id: `dashboard-quick-jump-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard/quick-jump.test.ts",
  input,
  output: runQuickJump(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/quick-jump.test.ts",
  sources: ["src/dashboard/quick-jump.test.ts", "src/dashboard/quick-jump.ts", "src/dashboard/sort.ts"],
  generatedBy: "scripts/capture-dashboard-quick-jump-contract.mjs",
  description:
    "Dashboard quick-jump worktree and entry numbering plus target resolution captured by running the TypeScript quick-jump helpers.",
  cases: contractCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${contractCases.length} cases`);
