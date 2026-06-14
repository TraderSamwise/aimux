import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getGlobalAimuxDir,
  getGlobalConfigPath,
  getLocalAimuxDir,
  getConfigPath,
  getProjectStateDir,
} from "./paths.js";
import { quarantineCorruptFile, writeJsonAtomic } from "./atomic-write.js";

export interface NotificationConfig {
  enabled: boolean;
  /** Notify when an agent is waiting for input */
  onPrompt: boolean;
  /** Notify on errors */
  onError: boolean;
  /** Notify when an agent completes a task */
  onComplete: boolean;
}

export interface WorktreeConfig {
  /** Base directory for created worktrees. Relative paths are resolved from the main repo root. */
  baseDir: string;
}

export interface TmuxRuntimeConfig {
  /** Deterministic prefix for managed per-project tmux sessions. */
  sessionPrefix: string;
}

export interface StatuslineDefaultPluginConfig {
  enabled: boolean;
  line?: "top" | "bottom";
}

export interface StatuslineConfig {
  defaultPlugins: {
    transcriptLength: StatuslineDefaultPluginConfig;
  };
}

export interface RuntimeConfig {
  /** Whether aimux injects automatic session preamble instructions. */
  agentPreambleEnabled: boolean;
  tmux: TmuxRuntimeConfig;
}

export interface ExposeConfig {
  /** When true, the Exposé popup always shows agents across all worktrees, ignoring the current-worktree scope. */
  forceGlobalScope: boolean;
}

export interface LoopConfig {
  /** How often the daemon scans for in-loop agents that stopped early. */
  scanIntervalMs: number;
  /** Minimum gap between nudges/briefings for the same target. */
  nudgeCooldownMs: number;
  /** When no overseer exists, send a canned continue-nudge directly. */
  autoNudgeWithoutOverseer: boolean;
}

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LoggingConfig {
  enabled: boolean;
  level: LogLevel;
  /** Category names to include. "*" includes all categories. */
  categories: string[];
  /** Rotate the active log file after it reaches this size. */
  maxBytes: number;
  /** Number of rotated log files to keep. */
  maxFiles: number;
}

export interface GraveyardConfig {
  /** Whether automatic graveyard cleanup is enabled for this project. */
  cleanupEnabled: boolean;
  /** How long graveyarded agents and worktrees remain recoverable before cleanup. */
  retentionDays: number;
  /** How often the project service checks for expired graveyard entries. */
  cleanupIntervalMs: number;
}

export interface AimuxConfig {
  defaultTool: string;
  contextMaxEntries: number;
  liveWindowSize: number;
  compactEveryNTurns: number;
  logging: LoggingConfig;
  graveyard: GraveyardConfig;
  notifications: NotificationConfig;
  statusline: StatuslineConfig;
  runtime: RuntimeConfig;
  worktrees: WorktreeConfig;
  loop: LoopConfig;
  expose: ExposeConfig;
  tools: Record<string, ToolConfig>;
}

export interface ToolConfig {
  command: string;
  args: string[];
  enabled: boolean;
  /** User default extra args, appended after `args` and prefilled (editable) in the "o" options dialog. */
  defaultArgs?: string[];
  /** User default env vars, applied at launch and prefilled (editable) in the "o" options dialog. */
  defaultEnv?: Record<string, string>;
  /** Whether aimux should inject an automatic Claude hook wrapper/config for this tool. */
  wrapperEnabled?: boolean;
  /** Flag/args to inject system prompt preamble, e.g. ["--append-system-prompt"] */
  preambleFlag?: string[];
  /** Args to resume a specific session, with {sessionId} placeholder, e.g. ["--resume", "{sessionId}"] */
  resumeArgs?: string[];
  /**
   * Whether backendSessionId values tracked by aimux are valid inputs for resumeArgs.
   * Some tools expose a session-id flag without guaranteeing that the same value is later resumable.
   */
  resumeByBackendSessionId?: boolean;
  /** Fallback resume args when backendSessionId is unavailable, e.g. ["--continue"] */
  resumeFallback?: string[];
  /** Flag to set a session ID when starting, with {sessionId} placeholder, e.g. ["--session-id", "{sessionId}"] */
  sessionIdFlag?: string[];
  /** Optional file to write preamble instructions to; disabled by default to avoid surprise repo edits. */
  instructionsFile?: string;
  /** Codex config key used for durable standing instructions, e.g. "developer_instructions" */
  developerInstructionsConfigKey?: string | null;
  /** Regex patterns that indicate the tool is idle/waiting for input */
  promptPatterns?: string[];
  /** Regex patterns to detect user prompts in terminal output (for turn extraction) */
  turnPatterns?: string[];
  /** Command to use for LLM compaction (default: "claude --print --output-format text") */
  compactCommand?: string;
}

const DEFAULT_CONFIG: AimuxConfig = {
  defaultTool: "claude",
  contextMaxEntries: 20,
  liveWindowSize: 20,
  compactEveryNTurns: 50,
  logging: {
    enabled: false,
    level: "info",
    categories: ["*"],
    maxBytes: 10_000_000,
    maxFiles: 5,
  },
  graveyard: {
    cleanupEnabled: true,
    retentionDays: 14,
    cleanupIntervalMs: 86_400_000,
  },
  notifications: {
    enabled: true,
    onPrompt: true,
    onError: true,
    onComplete: true,
  },
  statusline: {
    defaultPlugins: {
      transcriptLength: {
        enabled: true,
        line: "top",
      },
    },
  },
  runtime: {
    agentPreambleEnabled: true,
    tmux: {
      sessionPrefix: "aimux",
    },
  },
  worktrees: {
    baseDir: ".aimux/worktrees",
  },
  loop: {
    scanIntervalMs: 15000,
    nudgeCooldownMs: 60000,
    autoNudgeWithoutOverseer: false,
  },
  expose: {
    forceGlobalScope: false,
  },
  tools: {
    claude: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      enabled: true,
      wrapperEnabled: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
      resumeArgs: ["--resume", "{sessionId}"],
      resumeByBackendSessionId: true,
      resumeFallback: ["--continue"],
      promptPatterns: ["^> $", "\\$ $"],
      turnPatterns: ["^[❯>]\\s*(.+)", "^❯\\s+(.+)", "^>\\s+(.+)"],
      compactCommand: "claude --print --output-format text",
    },
    codex: {
      command: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      enabled: true,
      resumeArgs: ["resume", "{sessionId}"],
      resumeByBackendSessionId: true,
      resumeFallback: ["resume", "--last"],
      developerInstructionsConfigKey: "developer_instructions",
      promptPatterns: ["^> $"],
      turnPatterns: ["^[>❯]\\s*(.+)"],
    },
    aider: {
      command: "aider",
      args: [],
      enabled: true,
      resumeFallback: ["--restore-chat-history"],
      promptPatterns: ["^aider> $", "^> $"],
      turnPatterns: ["^aider>\\s*(.+)", "^>\\s*(.+)"],
    },
  },
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasSessionPlaceholder(args?: string[]): boolean {
  return Boolean(args?.some((arg) => arg.includes("{sessionId}")));
}

function normalizeConfig(config: AimuxConfig): AimuxConfig {
  const claude = config.tools.claude;
  if (
    claude?.command === "claude" &&
    hasSessionPlaceholder(claude.sessionIdFlag) &&
    hasSessionPlaceholder(claude.resumeArgs)
  ) {
    // Current Claude Code supports pairing --session-id with --resume <id>.
    // Treat older generated configs that set this false as stale rather than
    // silently launching a fresh Claude under an existing aimux row.
    claude.resumeByBackendSessionId = true;
  }
  return config;
}

/**
 * Load config with hierarchy: defaults → global (~/.aimux/config.json) → project (.aimux/config.json)
 * Project settings override global, global overrides defaults.
 */
export function loadConfig(opts: { includeGlobal?: boolean } = {}): AimuxConfig {
  let config = cloneJson(DEFAULT_CONFIG);

  // Layer 1: global config
  const globalPath = getGlobalConfigPath();
  if (opts.includeGlobal !== false && existsSync(globalPath)) {
    try {
      const globalRaw = JSON.parse(readFileSync(globalPath, "utf-8"));
      config = deepMerge(config, globalRaw) as AimuxConfig;
    } catch {
      quarantineCorruptFile(globalPath);
    }
  }

  // Layer 2: project config
  const projectPath = getConfigPath();
  if (existsSync(projectPath)) {
    try {
      const projectRaw = JSON.parse(readFileSync(projectPath, "utf-8"));
      config = deepMerge(config, projectRaw) as AimuxConfig;
    } catch {
      quarantineCorruptFile(projectPath);
    }
  }

  return normalizeConfig(config);
}

/** Save config to project-level .aimux/config.json */
export function saveConfig(config: AimuxConfig): void {
  const dir = getLocalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(getConfigPath(), config);
}

/** Save config to global ~/.aimux/config.json */
export function saveGlobalConfig(config: Partial<AimuxConfig>): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(getGlobalConfigPath(), config);
}

const GITIGNORE_CONTENTS = `# Runtime-private service/project state (lives in ~/.aimux/projects/)
state.json

# Agent-facing shared artifacts
context/
history/
tasks/
status/
threads/

# Terminal recordings (large, machine-specific)
recordings/

# Agent plan files
plans/

# Managed git worktrees
worktrees/

`;

export function initProject(): void {
  // In-repo directory (agent-facing shared contract + config/team)
  const localDir = getLocalAimuxDir();
  mkdirSync(localDir, { recursive: true });
  for (const subdir of ["plans", "context", "history", "tasks", "status", "threads"]) {
    mkdirSync(join(localDir, subdir), { recursive: true });
  }

  if (!existsSync(getConfigPath())) {
    saveConfig(DEFAULT_CONFIG);
  }

  const gitignorePath = join(localDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENTS);
  }

  // Global runtime-private project state directory
  const stateDir = getProjectStateDir();
  for (const subdir of ["recordings"]) {
    mkdirSync(join(stateDir, subdir), { recursive: true });
  }
}

/** Deep merge b into a (b values override a). Handles nested objects, not arrays. */
function deepMerge(a: any, b: any): any {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    const aVal = a[key];
    const bVal = b[key];
    if (
      aVal &&
      bVal &&
      typeof aVal === "object" &&
      typeof bVal === "object" &&
      !Array.isArray(aVal) &&
      !Array.isArray(bVal)
    ) {
      result[key] = deepMerge(aVal, bVal);
    } else if (bVal !== undefined) {
      result[key] = bVal;
    }
  }
  return result;
}
