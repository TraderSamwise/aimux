import type { Command } from "commander";
import { PROJECT_API_ROUTES, type TeamConfig } from "../project-api-contract.js";

export interface TeamCommandOptions {
  project?: string;
  json?: boolean;
}

export interface RegisterTeamCommandDeps {
  prepareProjectContext: (requestedProject?: string) => Promise<string>;
  getProjectServiceJson: (path: string, opts?: { projectRoot?: string }) => Promise<any>;
  postProjectServiceJson: (path: string, body: unknown, opts?: { projectRoot?: string }) => Promise<any>;
}

export function buildTeamCliPayload(projectRoot: string, config: TeamConfig, role?: string) {
  return {
    ok: true,
    projectRoot,
    config,
    ...(role ? { role } : {}),
  };
}

export function renderTeamShowLines(config: TeamConfig): string[] {
  const lines = ["Team Roles:"];
  for (const [name, role] of Object.entries(config.roles)) {
    const flags: string[] = [];
    if (role.reviewedBy) flags.push(`reviewed by: ${role.reviewedBy}`);
    if (role.canEdit) flags.push("can edit");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`  ${name}: ${role.description}${flagStr}`);
  }
  lines.push("", `Default role: ${config.defaultRole}`);
  return lines;
}

export function renderTeamInitLines(config: TeamConfig): string[] {
  const lines = ["Team config initialized with default roles:"];
  for (const [name, role] of Object.entries(config.roles)) {
    lines.push(`  ${name}: ${role.description}`);
  }
  return lines;
}

export function registerTeamCommand(program: Command, deps: RegisterTeamCommandDeps): void {
  const teamCmd = program.command("team").description("Manage agent team roles");

  teamCmd
    .command("show")
    .description("Show current team config")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(async (options: TeamCommandOptions) => {
      const projectRoot = await deps.prepareProjectContext(options.project);
      const result = await deps.getProjectServiceJson(PROJECT_API_ROUTES.team.config, { projectRoot });
      if (options.json) {
        console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config), null, 2));
        return;
      }
      renderTeamShowLines(result.config).forEach((line) => console.log(line));
    });

  teamCmd
    .command("add <role>")
    .description("Add or update a role")
    .option("-d, --description <desc>", "Role description")
    .option("--reviewed-by <role>", "Role that reviews this role's work")
    .option("--can-edit", "Whether this role can edit code directly")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(
      async (
        role: string,
        options: TeamCommandOptions & { description?: string; reviewedBy?: string; canEdit?: boolean },
      ) => {
        const projectRoot = await deps.prepareProjectContext(options.project);
        const result = await deps.postProjectServiceJson(
          PROJECT_API_ROUTES.team.addRole,
          {
            role,
            ...(options.description ? { description: options.description } : {}),
            ...(options.reviewedBy ? { reviewedBy: options.reviewedBy } : {}),
            ...(options.canEdit ? { canEdit: true } : {}),
          },
          { projectRoot },
        );
        if (options.json) {
          console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
          return;
        }
        console.log(`Role "${role}" saved.`);
      },
    );

  teamCmd
    .command("remove <role>")
    .description("Remove a role")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(async (role: string, options: TeamCommandOptions) => {
      const projectRoot = await deps.prepareProjectContext(options.project);
      const result = await deps.postProjectServiceJson(PROJECT_API_ROUTES.team.removeRole, { role }, { projectRoot });
      if (options.json) {
        console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
        return;
      }
      console.log(`Role "${role}" removed.`);
    });

  teamCmd
    .command("default <role>")
    .description("Set the default role for new agents")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(async (role: string, options: TeamCommandOptions) => {
      const projectRoot = await deps.prepareProjectContext(options.project);
      const result = await deps.postProjectServiceJson(PROJECT_API_ROUTES.team.defaultRole, { role }, { projectRoot });
      if (options.json) {
        console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
        return;
      }
      console.log(`Default role set to "${role}".`);
    });

  teamCmd
    .command("init")
    .description("Initialize project with default team structure")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(async (options: TeamCommandOptions) => {
      const projectRoot = await deps.prepareProjectContext(options.project);
      const result = await deps.postProjectServiceJson(PROJECT_API_ROUTES.team.init, {}, { projectRoot });
      if (options.json) {
        console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config), null, 2));
        return;
      }
      renderTeamInitLines(result.config).forEach((line) => console.log(line));
    });
}
