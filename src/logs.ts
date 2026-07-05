import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { getDaemonLogPath, getProjectLogPath, getProjectLogPathFor } from "./paths.js";

export interface LogSelectionOptions {
  daemon?: boolean;
  project?: string;
}

export function parseLineCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "80", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}

export function selectedLogPath(opts: LogSelectionOptions): string {
  if (opts.daemon) return getDaemonLogPath();
  if (opts.project) return getProjectLogPathFor(pathResolve(opts.project));
  return getProjectLogPath();
}

export function readLastLogLines(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  const allLines = content.split(/\r?\n/);
  if (allLines.at(-1) === "") allLines.pop();
  return allLines.slice(-lines).join("\n");
}

export function clearLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}
