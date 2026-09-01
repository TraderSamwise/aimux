import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_API_ROUTES, type WorkOutlineEntry } from "../project-api-contract.js";
import { registerWorkOutlineCommand, renderWorkOutlineEntries } from "./work-outline.js";

const entry: WorkOutlineEntry = {
  entryId: "outline-1",
  topicKey: "release",
  title: "Release",
  summary: "Cut the release.",
  status: "active",
  source: "scribe",
  sessionIds: ["codex-a"],
  worktreePath: "/repo/main",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  lastSeenAt: "2026-08-30T00:00:00.000Z",
};

function programWithDeps(deps: {
  prepareProjectContext?: ReturnType<typeof vi.fn>;
  getProjectServiceJson?: ReturnType<typeof vi.fn>;
  postProjectServiceJson?: ReturnType<typeof vi.fn>;
}) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerWorkOutlineCommand(program, {
    prepareProjectContext: deps.prepareProjectContext ?? vi.fn(async () => "/repo"),
    getProjectServiceJson: deps.getProjectServiceJson ?? vi.fn(async () => ({ entries: [entry], entry })),
    postProjectServiceJson: deps.postProjectServiceJson ?? vi.fn(async () => ({ entry })),
  });
  return program;
}

describe("scribe notes CLI", () => {
  it("renders compact human-readable entries", () => {
    expect(renderWorkOutlineEntries([entry])).toEqual([
      "outline-1 [active] Release · codex-a · /repo/main",
      "  Cut the release.",
    ]);
    expect(renderWorkOutlineEntries([])).toEqual(["No scribe notes."]);
  });

  it("lists through the project service with filters", async () => {
    const prepareProjectContext = vi.fn(async () => "/repo");
    const getProjectServiceJson = vi.fn(async () => ({ entries: [entry] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = programWithDeps({ prepareProjectContext, getProjectServiceJson });

    await program.parseAsync(
      [
        "outline",
        "list",
        "--project",
        "/repo",
        "--session",
        "codex-a",
        "--worktree",
        "/repo/main",
        "--status",
        "active",
        "--search",
        "release",
        "--limit",
        "25",
      ],
      { from: "user" },
    );

    expect(prepareProjectContext).toHaveBeenCalledWith("/repo");
    expect(getProjectServiceJson).toHaveBeenCalledWith(
      `${PROJECT_API_ROUTES.workOutline.list}?q=release&sessionId=codex-a&worktreePath=%2Frepo%2Fmain&status=active&limit=25`,
      { projectRoot: "/repo" },
    );
    log.mockRestore();
  });

  it("shows one entry by id", async () => {
    const getProjectServiceJson = vi.fn(async () => ({ entry }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = programWithDeps({ getProjectServiceJson });

    await program.parseAsync(["outline", "show", "outline-1"], { from: "user" });

    expect(getProjectServiceJson).toHaveBeenCalledWith(`${PROJECT_API_ROUTES.workOutline.list}?entryId=outline-1`, {
      projectRoot: "/repo",
    });
    log.mockRestore();
  });

  it("updates through the project service", async () => {
    const postProjectServiceJson = vi.fn(async () => ({ entry }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = programWithDeps({ postProjectServiceJson });

    await program.parseAsync(
      [
        "outline",
        "update",
        "--title",
        "Release",
        "--summary",
        "Cut the release.",
        "--topic-key",
        "release",
        "--session",
        "codex-a",
        "--worktree",
        "/repo/main",
        "--source",
        "scribe",
      ],
      { from: "user" },
    );

    expect(postProjectServiceJson).toHaveBeenCalledWith(
      PROJECT_API_ROUTES.workOutline.update,
      {
        title: "Release",
        summary: "Cut the release.",
        topicKey: "release",
        sessionId: "codex-a",
        worktreePath: "/repo/main",
        status: undefined,
        source: "scribe",
      },
      { projectRoot: "/repo" },
    );
    log.mockRestore();
  });
});
