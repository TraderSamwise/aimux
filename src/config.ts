import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AimuxConfig {
  defaultTool: string;
  contextMaxEntries: number;
  tools: Record<string, ToolConfig>;
}

export interface ToolConfig {
  command: string;
  args: string[];
  enabled: boolean;
  /** Flag/args to inject system prompt preamble, e.g. ["--append-system-prompt"] */
  preambleFlag?: string[];
}

const DEFAULT_CONFIG: AimuxConfig = {
  defaultTool: "claude",
  contextMaxEntries: 20,
  tools: {
    claude: {
      command: "claude",
      args: [],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
    },
    codex: {
      command: "codex",
      args: [],
      enabled: true,
    },
    aider: {
      command: "aider",
      args: [],
      enabled: true,
    },
  },
};

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

export function loadConfig(cwd?: string): AimuxConfig {
  const configPath = getConfigPath(cwd);
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(configPath, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(config: AimuxConfig, cwd?: string): void {
  const dir = getAimuxDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getConfigPath(cwd), JSON.stringify(config, null, 2) + "\n");
}

export function initProject(cwd?: string): void {
  const dir = getAimuxDir(cwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "context"), { recursive: true });
  mkdirSync(join(dir, "recordings"), { recursive: true });

  if (!existsSync(getConfigPath(cwd))) {
    saveConfig(DEFAULT_CONFIG, cwd);
  }
}
