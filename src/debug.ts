import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { LoggingConfig, LogLevel } from "./config.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export interface LoggingRuntimeConfig extends LoggingConfig {
  path: string;
  processKind: "cli" | "daemon" | "project-service" | "test" | string;
  projectId?: string;
  projectRoot?: string;
}

export interface LoggingCliOptions {
  debug?: boolean;
  trace?: boolean;
  logLevel?: string;
  logCategory?: string;
}

export interface ResolveLoggingOptions {
  config: LoggingConfig;
  env?: Record<string, string | undefined>;
  cli?: LoggingCliOptions;
  path: string;
  processKind: LoggingRuntimeConfig["processKind"];
  projectId?: string;
  projectRoot?: string;
}

export interface LogFields {
  [key: string]: unknown;
}

interface LogRecord {
  ts: string;
  level: LogLevel;
  category: string;
  message: string;
  pid: number;
  processKind: string;
  projectId?: string;
  projectRoot?: string;
  fields?: LogFields;
}

const DEFAULT_RUNTIME_CONFIG: LoggingRuntimeConfig = {
  enabled: false,
  level: "info",
  categories: ["*"],
  maxBytes: 10_000_000,
  maxFiles: 5,
  path: "",
  processKind: "cli",
};

let runtimeConfig: LoggingRuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };

function normalizeLevel(level: string | undefined, fallback: LogLevel): LogLevel {
  return level === "error" || level === "warn" || level === "info" || level === "debug" || level === "trace"
    ? level
    : fallback;
}

function isExplicitFalse(value: string): boolean {
  return ["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

function normalizeCategories(categories: string[] | undefined): string[] {
  const normalized = (categories ?? ["*"]).map((category) => category.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : ["*"];
}

export function parseLogCategories(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return normalizeCategories(value.split(","));
}

export function resolveLoggingRuntimeConfig(options: ResolveLoggingOptions): LoggingRuntimeConfig {
  const env = options.env ?? process.env;
  const cli = options.cli ?? {};
  let enabled = options.config.enabled;
  let level = options.config.level;
  let categories = normalizeCategories(options.config.categories);

  const envLog = env.AIMUX_LOG;
  if (envLog !== undefined) {
    if (isExplicitFalse(envLog)) {
      enabled = false;
    } else {
      enabled = true;
      level = normalizeLevel(envLog, level);
    }
  }
  if (env.AIMUX_LOG_LEVEL) {
    enabled = true;
    level = normalizeLevel(env.AIMUX_LOG_LEVEL, level);
  }
  const envCategories = parseLogCategories(env.AIMUX_LOG_CATEGORIES);
  if (envCategories) {
    enabled = true;
    categories = envCategories;
  }

  if (cli.debug) {
    enabled = true;
    level = "debug";
  }
  if (cli.trace) {
    enabled = true;
    level = "trace";
  }
  if (cli.logLevel) {
    enabled = true;
    level = normalizeLevel(cli.logLevel, level);
  }
  const cliCategories = parseLogCategories(cli.logCategory);
  if (cliCategories) {
    enabled = true;
    categories = cliCategories;
  }

  return {
    enabled,
    level,
    categories,
    maxBytes: options.config.maxBytes,
    maxFiles: options.config.maxFiles,
    path: options.path,
    processKind: options.processKind,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
  };
}

export function configureLogging(config: Partial<LoggingRuntimeConfig>): LoggingRuntimeConfig {
  runtimeConfig = {
    ...runtimeConfig,
    ...config,
    enabled: config.enabled ?? runtimeConfig.enabled,
    level: normalizeLevel(config.level, runtimeConfig.level),
    categories: normalizeCategories(config.categories ?? runtimeConfig.categories),
    maxBytes: config.maxBytes ?? runtimeConfig.maxBytes,
    maxFiles: config.maxFiles ?? runtimeConfig.maxFiles,
    path: config.path ?? runtimeConfig.path,
    processKind: config.processKind ?? runtimeConfig.processKind,
  };
  return { ...runtimeConfig, categories: [...runtimeConfig.categories] };
}

export function getLoggingConfig(): LoggingRuntimeConfig {
  return { ...runtimeConfig, categories: [...runtimeConfig.categories] };
}

export function resetLoggingForTests(): void {
  runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG, categories: [...DEFAULT_RUNTIME_CONFIG.categories] };
}

function shouldLog(level: LogLevel, category: string): boolean {
  if (!runtimeConfig.enabled || !runtimeConfig.path) return false;
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[runtimeConfig.level]) return false;
  return runtimeConfig.categories.includes("*") || runtimeConfig.categories.includes(category);
}

function rotatedPath(path: string, index: number): string {
  return `${path}.${index}`;
}

function rotateIfNeeded(path: string, incomingBytes: number): void {
  if (runtimeConfig.maxBytes <= 0 || runtimeConfig.maxFiles <= 0 || !existsSync(path)) return;
  const size = statSync(path).size;
  if (size + incomingBytes <= runtimeConfig.maxBytes) return;

  rmSync(rotatedPath(path, runtimeConfig.maxFiles), { force: true });
  for (let i = runtimeConfig.maxFiles - 1; i >= 1; i -= 1) {
    const source = rotatedPath(path, i);
    if (existsSync(source)) {
      renameSync(source, rotatedPath(path, i + 1));
    }
  }
  renameSync(path, rotatedPath(path, 1));
}

function writeRecord(record: LogRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  try {
    mkdirSync(dirname(runtimeConfig.path), { recursive: true });
    rotateIfNeeded(runtimeConfig.path, Buffer.byteLength(line));
    appendFileSync(runtimeConfig.path, line);
  } catch {
    // Logging must never break aimux runtime behavior.
  }
}

export function logAt(level: LogLevel, message: string, category = "general", fields?: LogFields): void {
  if (!shouldLog(level, category)) return;
  writeRecord({
    ts: new Date().toISOString(),
    level,
    category,
    message,
    pid: process.pid,
    processKind: runtimeConfig.processKind,
    projectId: runtimeConfig.projectId,
    projectRoot: runtimeConfig.projectRoot,
    fields,
  });
}

export const log = {
  error: (message: string, category?: string, fields?: LogFields): void => logAt("error", message, category, fields),
  warn: (message: string, category?: string, fields?: LogFields): void => logAt("warn", message, category, fields),
  info: (message: string, category?: string, fields?: LogFields): void => logAt("info", message, category, fields),
  debug: (message: string, category?: string, fields?: LogFields): void => logAt("debug", message, category, fields),
  trace: (message: string, category?: string, fields?: LogFields): void => logAt("trace", message, category, fields),
};

export function debug(msg: string, category?: string): void {
  log.debug(msg, category);
}

export function debugContext(action: string, file: string, sizeBytes: number): void {
  const sizeKB = (sizeBytes / 1024).toFixed(1);
  const estTokens = Math.round(sizeBytes / 4);
  debug(`${action} ${file} (${sizeKB}KB, ~${estTokens} tokens)`, "context");
}

export function debugCompact(sessionCount: number, totalTurns: number): void {
  debug(`compacting ${totalTurns} turns across ${sessionCount} sessions`, "compact");
}

export function debugPreamble(tool: string, sizeBytes: number): void {
  const sizeKB = (sizeBytes / 1024).toFixed(1);
  const estTokens = Math.round(sizeBytes / 4);
  debug(`preamble for ${tool}: ${sizeKB}KB, ~${estTokens} tokens overhead`, "preamble");
}

export function debugTurn(sessionId: string, type: string, contentLen: number): void {
  debug(`${type} from ${sessionId} (${contentLen} chars)`, "turn");
}

export function debugGit(filesChanged: number, diffLen: number): void {
  debug(`git: ${filesChanged} files changed, diff ${diffLen} chars`, "git");
}

export function closeDebug(): void {
  log.info("--- aimux session ended ---", "lifecycle");
}
