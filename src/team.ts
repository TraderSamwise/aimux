import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { getLocalAimuxDir, getProjectTeamPath, getGlobalTeamPath, getGlobalAimuxDir } from "./paths.js";
import { writeJsonAtomic } from "./atomic-write.js";

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

export interface SessionTeamMetadata {
  teamId: string;
  parentSessionId: string;
  role?: string;
  label?: string;
  order?: number;
}

/** Team metadata that marks a session as the project overseer. */
export const OVERSEER_SESSION_TEAM: SessionTeamMetadata = {
  teamId: "overseer",
  parentSessionId: "",
  role: "overseer",
};

/** Team metadata that marks a session as the project scribe. */
export const SCRIBE_SESSION_TEAM: SessionTeamMetadata = {
  teamId: "scribe",
  parentSessionId: "",
  role: "scribe",
};

export function isTeammateSession(session: { team?: SessionTeamMetadata } | undefined): boolean {
  return Boolean(session?.team?.parentSessionId);
}

export function isOverseerSession(session: { team?: SessionTeamMetadata } | undefined): boolean {
  return session?.team?.role === "overseer";
}

export function isScribeSession(session: { team?: SessionTeamMetadata; scribe?: boolean } | undefined): boolean {
  if (session?.scribe === false) return false;
  return session?.scribe === true || session?.team?.role === "scribe";
}

export function isProjectControlSession(
  session: { team?: SessionTeamMetadata; overseer?: boolean; scribe?: boolean } | undefined,
): boolean {
  return session?.overseer === true || isOverseerSession(session) || isScribeSession(session);
}

export function compareTeammateSessions(
  left: { id: string; createdAt?: string; team?: SessionTeamMetadata },
  right: { id: string; createdAt?: string; team?: SessionTeamMetadata },
): number {
  const leftOrder = typeof left.team?.order === "number" ? left.team.order : Number.POSITIVE_INFINITY;
  const rightOrder = typeof right.team?.order === "number" ? right.team.order : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.POSITIVE_INFINITY;
  const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.POSITIVE_INFINITY;
  const normalizedLeftCreated = Number.isFinite(leftCreated) ? leftCreated : Number.POSITIVE_INFINITY;
  const normalizedRightCreated = Number.isFinite(rightCreated) ? rightCreated : Number.POSITIVE_INFINITY;
  if (normalizedLeftCreated !== normalizedRightCreated) return normalizedLeftCreated - normalizedRightCreated;

  return left.id.localeCompare(right.id);
}

export function selectDirectTeammates<T extends { id: string; createdAt?: string; team?: SessionTeamMetadata }>(
  sessions: T[],
  parentSessionId: string,
): T[] {
  const byId = new Map<string, T>();
  for (const session of sessions) {
    if (session.team?.parentSessionId !== parentSessionId) continue;
    if (!byId.has(session.id)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort(compareTeammateSessions);
}

export function selectOrphanTeammates<T extends { id: string; createdAt?: string; team?: SessionTeamMetadata }>(
  sessions: T[],
  knownParentIds: Iterable<string>,
): T[] {
  const parents = new Set(knownParentIds);
  const byId = new Map<string, T>();
  for (const session of sessions) {
    const parentSessionId = session.team?.parentSessionId;
    if (!parentSessionId || parents.has(parentSessionId)) continue;
    if (!byId.has(session.id)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort(compareTeammateSessions);
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getDefaultTeamConfig(): TeamConfig {
  return cloneJson(DEFAULT_TEAM_CONFIG);
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

  return cloneJson(DEFAULT_TEAM_CONFIG);
}

/**
 * Save team config at the project level.
 */
export function saveTeamConfig(config: TeamConfig): void {
  const dir = getLocalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(getProjectTeamPath(), config);
}

/**
 * Save team config at the global level (~/.aimux/team.json).
 */
export function saveGlobalTeamConfig(config: TeamConfig): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(getGlobalTeamPath(), config);
}

/**
 * System-prompt preamble for the project overseer: the human's single entrypoint
 * for top-down, cross-worktree orchestration. Loop-running is its first duty.
 */
export function buildOverseerPreamble(): string {
  return [
    "You are the OVERSEER for this aimux project — the human's single entrypoint for",
    "top-down, cross-worktree orchestration. You observe and direct the other agents;",
    "you do not do their implementation work yourself.",
    "",
    "Your tools (run them from your shell):",
    "- `aimux ps [--json]` — every agent in the project, across all worktrees, with",
    "  activity/attention state, loop membership, and active task.",
    "- `aimux host agent-read <id>` — read an agent's recent terminal output.",
    '- `aimux input <id> "…"` — send an instruction into an agent as a new turn.',
    "- `aimux loop add <id> [--goal …]` / `aimux loop remove <id>` — manage loop membership.",
    "- `aimux spawn`, `aimux task assign`, `aimux message send`, `aimux handoff send` —",
    "  start and coordinate agents.",
    "",
    "When the human asks you to watch, manage, or stop watching an agent, update explicit",
    "aimux loop state immediately: resolve the target with `aimux ps --json` if needed,",
    'then run `aimux loop add <id> --goal "…"` or `aimux loop remove <id>`. Do not keep',
    "loop membership only in your chat context; the dashboard and watcher read aimux state.",
    "`aimux ps --json` and `[aimux loop check]` include loop timestamps and source. Treat",
    "current active loop state as authoritative: if `loop.since` is newer than a removal you",
    "remember, the agent was deliberately re-added and you should keep managing it.",
    "",
    "LOOP DUTY: the daemon wakes you with an `[aimux loop check]` message when agents that",
    "are in a managed loop appear to have stopped. For each one: read its recent output,",
    "decide whether it gave back its turn prematurely. If it should keep going, send a",
    'specific next instruction with `aimux input <id> "…"`. If it has genuinely completed',
    "its goal or is blocked beyond repair, run `aimux loop remove <id>` and report to the",
    "human.",
    "Agents can also self-exit a loop with `aimux loop done` / `aimux loop block`; when they",
    "do, they drop off your loop checks on their own.",
    "",
    "Otherwise you are a normal conversational agent: answer the human's questions about",
    "project progress and carry out their orchestration requests.",
  ].join("\n");
}

/**
 * System-prompt preamble for the project scribe: maintain a terse, deduped
 * outline of meaningful work without doing implementation work itself.
 */
export function buildScribePreamble(): string {
  return [
    "You are the SCRIBE for this aimux project. Your job is to maintain the",
    "project work outline: a terse, deduped, reverse-chronological index of real",
    "work topics across all agents. You do not implement code yourself.",
    "",
    "Your tools (run them from your shell):",
    "- `aimux ps --json` — inspect project agents and their worktrees.",
    "- `aimux host agent-read <id>` — read bounded recent terminal output when you",
    "  need evidence for a changed agent.",
    "- `aimux outline list --json [--session <id>] [--search <query>]` — inspect",
    "  existing entries before adding new ones.",
    "- `aimux outline update --topic-key <key> --title <title> --summary <summary>`",
    "  — create or update one outline entry. Include `--session <id>` and",
    "  `--worktree <path>` when known.",
    "",
    "SCRIBE DUTY: the daemon wakes you with an `[aimux scribe check]` message when",
    "agent output changes. For each agent summary in the check: decide whether it",
    "contains meaningful new work. Ignore heartbeats, prompts, progress chatter,",
    "and repeated status. If it is the same topic as an existing entry, update that",
    "entry instead of creating a duplicate. Use stable, short topic keys such as",
    "`release-readiness`, `restore-lifecycle`, or `gui-transcript-loading`.",
    "",
    "Keep entries brief. A good entry title is a noun phrase; a good summary is one",
    "or two sentences with the current state and next edge. Prefer fewer entries",
    "with better grouping over noisy coverage.",
  ].join("\n");
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
