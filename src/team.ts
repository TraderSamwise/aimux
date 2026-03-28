import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getLocalAimuxDir, getProjectTeamPath, getGlobalTeamPath, getGlobalAimuxDir } from "./paths.js";

export interface RoleConfig {
  description: string;
  /** Role that reviews this role's work */
  reviewedBy?: string;
  /** Whether this role can directly edit code */
  canEdit?: boolean;
}

export interface TeamConfig {
  roles: Record<string, RoleConfig>;
  defaultRole: string;
}

const DEFAULT_TEAM_CONFIG: TeamConfig = {
  roles: {
    coder: {
      description: "Implements features and fixes bugs",
      reviewedBy: "reviewer",
    },
    reviewer: {
      description: "Reviews code changes, approves or requests changes",
      canEdit: true,
    },
  },
  defaultRole: "coder",
};

export function getDefaultTeamConfig(): TeamConfig {
  return structuredClone(DEFAULT_TEAM_CONFIG);
}

/**
 * Load team config: project .aimux/team.json → global ~/.aimux/team.json → built-in defaults.
 */
export function loadTeamConfig(): TeamConfig {
  const projectPath = getProjectTeamPath();
  if (existsSync(projectPath)) {
    try {
      return JSON.parse(readFileSync(projectPath, "utf-8"));
    } catch {
      // Fall through
    }
  }

  const globalPath = getGlobalTeamPath();
  if (existsSync(globalPath)) {
    try {
      return JSON.parse(readFileSync(globalPath, "utf-8"));
    } catch {
      // Fall through
    }
  }

  return structuredClone(DEFAULT_TEAM_CONFIG);
}

/**
 * Save team config at the project level.
 */
export function saveTeamConfig(config: TeamConfig): void {
  const dir = getLocalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getProjectTeamPath(), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Save team config at the global level (~/.aimux/team.json).
 */
export function saveGlobalTeamConfig(config: TeamConfig): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getGlobalTeamPath(), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Build a role-specific preamble string for injection into an agent's system prompt.
 */
export function buildRolePreamble(role: string, config: TeamConfig): string {
  const roleConfig = config.roles[role];
  if (!roleConfig) return "";

  const lines: string[] = [
    `You are assigned the "${role}" role in this aimux team.`,
    `Role: ${roleConfig.description}`,
  ];

  if (roleConfig.reviewedBy) {
    lines.push(`Your work will be reviewed by the "${roleConfig.reviewedBy}" role.`);
  }

  if (roleConfig.canEdit === false) {
    lines.push("You should NOT directly edit code files.");
  }

  const otherRoles = Object.entries(config.roles)
    .filter(([name]) => name !== role)
    .map(([name, rc]) => `  - ${name}: ${rc.description}`);

  if (otherRoles.length > 0) {
    lines.push("", "Other team roles:", ...otherRoles);
  }

  return lines.join("\n");
}
