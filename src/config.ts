import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface NotificationConfig {
  enabled: boolean;
  /** Notify when an agent is waiting for input */
  onPrompt: boolean;
  /** Notify on errors */
  onError: boolean;
  /** Notify when an agent completes a task */
  onComplete: boolean;
}

export interface AimuxConfig {
  defaultTool: string;
  contextMaxEntries: number;
  liveWindowSize: number;
  compactEveryNTurns: number;
  notifications: NotificationConfig;
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
      args: [],
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

/** Global config directory: ~/.aimux/ */
export function getGlobalAimuxDir(): string {
  return join(homedir(), ".aimux");
}

/** Global config path: ~/.aimux/config.json */
export function getGlobalConfigPath(): string {
  return join(getGlobalAimuxDir(), "config.json");
}

/** Project-level .aimux/ directory */
export function getAimuxDir(cwd: string = process.cwd()): string {
  return join(cwd, ".aimux");
}

export function getConfigPath(cwd?: string): string {
  return join(getAimuxDir(cwd), "config.json");
}

export function getContextDir(cwd?: string): string {
  return join(getAimuxDir(cwd), "context");
}

export function getContextPathForDate(date: Date, cwd?: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return join(getContextDir(cwd), `${yyyy}-${mm}-${dd}.md`);
}

/**
 * Load config with hierarchy: defaults → global (~/.aimux/config.json) → project (.aimux/config.json)
 * Project settings override global, global overrides defaults.
 */
export function loadConfig(cwd?: string): AimuxConfig {
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
  const projectPath = getConfigPath(cwd);
  if (existsSync(projectPath)) {
    try {
      const projectRaw = JSON.parse(readFileSync(projectPath, "utf-8"));
      config = deepMerge(config, projectRaw) as AimuxConfig;
    } catch {}
  }

  return config;
}

/** Save config to project-level .aimux/config.json */
export function saveConfig(config: AimuxConfig, cwd?: string): void {
  const dir = getAimuxDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getConfigPath(cwd), JSON.stringify(config, null, 2) + "\n");
}

/** Save config to global ~/.aimux/config.json */
export function saveGlobalConfig(config: Partial<AimuxConfig>): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getGlobalConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

const GITIGNORE_CONTENTS = `# Ephemeral session state
state.json
graveyard.json
sessions.json
instances.json

# Live context (regenerated each session)
context/live.md

# Terminal recordings (large, machine-specific)
recordings/
`;

export function initProject(cwd?: string): void {
  const dir = getAimuxDir(cwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "context"), { recursive: true });
  mkdirSync(join(dir, "recordings"), { recursive: true });
  mkdirSync(join(dir, "history"), { recursive: true });

  if (!existsSync(getConfigPath(cwd))) {
    saveConfig(DEFAULT_CONFIG, cwd);
  }

  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENTS);
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
