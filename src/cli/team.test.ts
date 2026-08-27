import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { TeamConfig } from "../project-api-contract.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { buildTeamCliPayload, registerTeamCommand, renderTeamInitLines, renderTeamShowLines } from "./team.js";

const config: TeamConfig = {
  defaultRole: "coder",
  roles: {
    coder: { description: "Write code", canEdit: true },
    reviewer: { description: "Review changes", reviewedBy: "lead" },
  },
};

describe("team CLI renderers", () => {
  it("renders team show output with role flags", () => {
    expect(renderTeamShowLines(config)).toEqual([
      "Team Roles:",
      "  coder: Write code (can edit)",
      "  reviewer: Review changes (reviewed by: lead)",
      "",
      "Default role: coder",
    ]);
  });

  it("renders team init output", () => {
    expect(renderTeamInitLines(config)).toEqual([
      "Team config initialized with default roles:",
      "  coder: Write code",
      "  reviewer: Review changes",
    ]);
  });

  it("builds JSON payloads with optional role", () => {
    expect(buildTeamCliPayload("/repo", config)).toEqual({ ok: true, projectRoot: "/repo", config });
    expect(buildTeamCliPayload("/repo", config, "coder")).toEqual({
      ok: true,
      projectRoot: "/repo",
      config,
      role: "coder",
    });
  });

  it("registers team add with the project-service route and payload", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    const prepareProjectContext = vi.fn(async () => "/repo");
    const postProjectServiceJson = vi.fn(async () => ({ config }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    registerTeamCommand(program, {
      prepareProjectContext,
      getProjectServiceJson: vi.fn(),
      postProjectServiceJson,
    });

    await program.parseAsync(
      [
        "team",
        "add",
        "reviewer",
        "--description",
        "Review changes",
        "--reviewed-by",
        "lead",
        "--can-edit",
        "--project",
        "/repo",
      ],
      { from: "user" },
    );

    expect(prepareProjectContext).toHaveBeenCalledWith("/repo");
    expect(postProjectServiceJson).toHaveBeenCalledWith(
      PROJECT_API_ROUTES.team.addRole,
      { role: "reviewer", description: "Review changes", reviewedBy: "lead", canEdit: true },
      { projectRoot: "/repo" },
    );
    expect(log).toHaveBeenCalledWith('Role "reviewer" saved.');
    log.mockRestore();
  });
});
