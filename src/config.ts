import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getGlobalAimuxDir,
  getGlobalConfigPath,
  getLocalAimuxDir,
  getConfigPath,
  getProjectStateDir,
} from "./paths.js";

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

export interface FooterConfig {
  /** Ordered built-in footer plugins to render in the focused TUI footer. */
  plugins: string[];
  /** Scope footer agent tabs and focused-session switching controls. */
  sessionScope: "worktree" | "project";
}

export interface TmuxRuntimeConfig {
  /** Deterministic prefix for managed per-project tmux sessions. */
  sessionPrefix: string;
}

export interface RuntimeConfig {
  tmux: TmuxRuntimeConfig;
}

export interface AimuxConfig {
  defaultTool: string;
  contextMaxEntries: number;
  liveWindowSize: number;
  compactEveryNTurns: number;
  notifications: NotificationConfig;
  footer: FooterConfig;
  runtime: RuntimeConfig;
  worktrees: WorktreeConfig;
  tools: Record<string, ToolConfig>;
}

export interface SessionCaptureConfig {
  /** Directory to watch for new files. Supports {home}, {yyyy}, {mm}, {dd} */
  dir: string;
  /** Regex to extract session ID from filename */
  pattern: string;
  /** Delay before first check in ms */
  delayMs: number;
}

export interface ToolConfig {
  command: string;
  args: string[];
  enabled: boolean;
  /** Flag/args to inject system prompt preamble, e.g. ["--append-system-prompt"] */
  preambleFlag?: string[];
  /** Args to resume a specific session, with {sessionId} placeholder, e.g. ["--resume", "{sessionId}"] */
  resumeArgs?: string[];
  /** Fallback resume args when backendSessionId is unavailable, e.g. ["--continue"] */
  resumeFallback?: string[];
  /** Flag to set a session ID when starting, with {sessionId} placeholder, e.g. ["--session-id", "{sessionId}"] */
  sessionIdFlag?: string[];
  /** How to capture backend session ID when sessionIdFlag isn't available */
  sessionCapture?: SessionCaptureConfig;
  /** File to write preamble instructions to (created on start, removed on exit), e.g. "AGENTS.md" */
  instructionsFile?: string;
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
  notifications: {
    enabled: true,
    onPrompt: true,
    onError: true,
    onComplete: true,
  },
  footer: {
    plugins: ["location", "github-pr"],
    sessionScope: "worktree",
  },
  runtime: {
    tmux: {
      sessionPrefix: "aimux",
    },
  },
  worktrees: {
    baseDir: ".aimux/worktrees",
  },
  tools: {
    claude: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
      resumeArgs: ["--resume", "{sessionId}"],
      resumeFallback: ["--continue"],
      promptPatterns: ["^> $", "\\$ $"],
      turnPatterns: ["^[❯>]\\s*(.+)", "^❯\\s*$"],
      compactCommand: "claude --print --output-format text",
    },
    codex: {
      command: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      enabled: true,
      resumeArgs: ["resume", "{sessionId}"],
      resumeFallback: ["resume", "--last"],
      instructionsFile: "AGENTS.md",
      sessionCapture: {
        dir: "{home}/.codex/sessions/{yyyy}/{mm}/{dd}",
        pattern: "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.jsonl$",
        delayMs: 2000,
      },
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

/**
 * Load config with hierarchy: defaults → global (~/.aimux/config.json) → project (.aimux/config.json)
 * Project settings override global, global overrides defaults.
 */
export function loadConfig(): AimuxConfig {
  let config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: global config
  const globalPath = getGlobalConfigPath();
  if (existsSync(globalPath)) {
    try {
      const globalRaw = JSON.parse(readFileSync(globalPath, "utf-8"));
      config = deepMerge(config, globalRaw) as AimuxConfig;
    } catch {}
  }

  // Layer 2: project config
  const projectPath = getConfigPath();
  if (existsSync(projectPath)) {
    try {
      const projectRaw = JSON.parse(readFileSync(projectPath, "utf-8"));
      config = deepMerge(config, projectRaw) as AimuxConfig;
    } catch {}
  }

  return config;
}

/** Save config to project-level .aimux/config.json */
export function saveConfig(config: AimuxConfig): void {
  const dir = getLocalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Save config to global ~/.aimux/config.json */
export function saveGlobalConfig(config: Partial<AimuxConfig>): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getGlobalConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

const GITIGNORE_CONTENTS = `# Ephemeral session state (now lives in ~/.aimux/projects/)
state.json
graveyard.json
sessions.json
instances.json

# Live context (regenerated each session)
context/live.md

# Terminal recordings (large, machine-specific)
recordings/

# Task delegation files
tasks/

# Agent status files (ephemeral, regenerated by agents)
status/

# Agent plan files
plans/

# Managed git worktrees
worktrees/

# Migration marker
.migrated
`;

export function initProject(): void {
  // In-repo directory (config + team.json only)
  const localDir = getLocalAimuxDir();
  mkdirSync(localDir, { recursive: true });
  mkdirSync(join(localDir, "plans"), { recursive: true });

  if (!existsSync(getConfigPath())) {
    saveConfig(DEFAULT_CONFIG);
  }

  const gitignorePath = join(localDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENTS);
  }

  // Global project state directory
  const stateDir = getProjectStateDir();
  for (const subdir of ["context", "history", "recordings", "tasks", "status"]) {
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
